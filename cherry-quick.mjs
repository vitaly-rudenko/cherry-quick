#!/usr/bin/env node

import { parseArgs } from 'node:util'
import { execSync } from 'child_process'
import clipboardy from 'clipboardy'
import Enquirer from 'enquirer'
import c from 'ansi-colors'

const DEFAULT_FROM_BRANCH = process.env.CHERRY_QUICK_DEFAULT_FROM_BRANCH || 'dev'
const DEFAULT_INCLUDE_BRANCH = process.env.CHERRY_QUICK_DEFAULT_INCLUDE_BRANCH
const DEFAULT_TO_BRANCH = process.env.CHERRY_QUICK_DEFAULT_TO_BRANCH || 'master'
const DEFAULT_ROWS = process.env.CHERRY_QUICK_DEFAULT_ROWS || 20

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    from: { type: 'string', short: 'f' },
    to: { type: 'string', short: 't' },
    include: { type: 'string', short: 'i' },
    branch: { type: 'string', short: 'b' },
    help: { type: 'boolean', short: 'h' },
  },
})

if (values.help) {
  console.log([
    '',
    'Quickly select commits to cherry-pick.',
    'Search commits by typing part of message or author\'s name.',
    '',
    'This command automatically prepends each branch with \'origin/\' prefix.',
    'This command does not perform any modification actions.',
    '',
    'Arguments:',
    `  --from, -f: branch to pick commits from (default: ${DEFAULT_FROM_BRANCH})`,
    `  --to, -t: name of the target branch (default: ${DEFAULT_TO_BRANCH})`,
    `  --include, -i: mark commits that are already merged to this branch (${DEFAULT_INCLUDE_BRANCH ? `default: ${DEFAULT_INCLUDE_BRANCH}` : 'optional'})`,
    '  --branch, -b: name of a cherry-pick branch (optional)',
    '',
    'Usage:',
    `  Pick commits from '${DEFAULT_FROM_BRANCH}' branch that are not in the '${DEFAULT_TO_BRANCH}' branch:'`,
    '  $ cherry-quick',
    '',
    '  Specify \'from\' and \'to\' branches:',
    '  $ cherry-quick --from release-dev',
    '  $ cherry-quick --to release-dev',
    '',
    '  Mark commits that were already merged into \'release-dev\':',
    '  $ cherry-quick --include release-dev',
    '',
    '  Generate commands for creating a new branch and PR on GitHub:',
    '  $ cherry-quick --branch HRIS-123-CP-PROD',
    '',
  ].join('\n'))

  process.exit(0)
}

const fromBranch = values.from || DEFAULT_FROM_BRANCH
const toBranch = values.to || DEFAULT_TO_BRANCH
const includeBranch = values.include || DEFAULT_INCLUDE_BRANCH
const cherryPickBranch = values.branch || undefined
const rows = DEFAULT_ROWS

const fromBranchCherryPickableFullHashes = getCherryPickableFullHashes(fromBranch, toBranch)
const includeBranchCherryPickableFullHashes = includeBranch ? getCherryPickableFullHashes(fromBranch, includeBranch) : []

const fromBranchCommits = getLatestCommits(fromBranch, toBranch)

const fromBranchCherryPickableCommits = fromBranchCherryPickableFullHashes
  .map(fullHash => {
    const commit = fromBranchCommits.find(c => c.fullHash === fullHash)
    if (!commit) throw new Error(`Missing commit: ${fullHash}`)
    return commit
  })
  .reverse()

if (fromBranchCherryPickableCommits.length === 0) {
  console.log('No commits to pick from')
  process.exit(0)
}

// @ts-ignore
const cherryPickCommitsFullHashes = await new Enquirer.AutoComplete({
  name: 'commits',
  message: 'Select commits to cherry-pick',
  multiple: true,
  rows,
  suggest: (typed, choices) => {
    return choices
      .filter((choice) => {
        if (choice.role === 'separator') return true
        return choice.query.includes(typed.toLowerCase())
      })
      .filter((choice, i, choices) => {
        if (choice.role !== 'separator') return true
        if (!choices[i + 1] || choices[i + 1]?.role === 'separator') return false
        return true
      })
  },
  choices: [
    ...fromBranchCherryPickableCommits.flatMap((commit, i, commits) => {
      const message = [
        includeBranch
          ? includeBranchCherryPickableFullHashes.includes(commit.fullHash)
            ? c.dim(includeBranch)
            : c.green(includeBranch)
          : undefined,
        c.dim(commit.hash),
        truncate(commit.message, 80),
        c.dim(truncate(commit.author, 20)),
      ].filter(Boolean).join(' ')

      const prevCommitDate = commits[i - 1] ? new Date(commits[i - 1].timestamp) : undefined
      const currCommitDate = new Date(commit.timestamp)

      return [
        (!prevCommitDate || currCommitDate.getDate() !== prevCommitDate.getDate())
          && { role: 'separator', message: formatDate(prevCommitDate || currCommitDate) },
        {
          name: commit.fullHash,
          message,
          query: `${commit.hash} ${commit.message} by ${commit.author}`.replaceAll(/[^\w]/g, '').toLowerCase(),
          indicator: '>',
        }
      ]
    }),
    { role: 'separator' },
  ].filter(Boolean)
}).run().catch(() => {
  console.log('Operation aborted by user')
  process.exit(0)
})

const cherryPickCommits = cherryPickCommitsFullHashes
  .map((fullHash) => fromBranchCherryPickableCommits.find(c => c.fullHash === fullHash))
  .sort((a, b) => a.timestamp - b.timestamp)

if (cherryPickCommits.length === 0) {
  console.log('No commits were picked')
  process.exit(0)
}

const command = [
  ...cherryPickBranch ? [
    `git switch -c ${cherryPickBranch} origin/${toBranch}`,
  ] : [],
  ...cherryPickCommits.map(c => `git cherry-pick ${c.fullHash}`),
  ...cherryPickBranch ? [
    `git push -u origin ${cherryPickBranch}`,
    `gh pr create -a @me -t "${generatePullRequestTitleFromBranch(cherryPickBranch)}" -B ${toBranch} -H ${cherryPickBranch} -w`,
  ]: [],
].join(' && \\\n').trim()

console.log('')
console.log(command)
console.log('')

// @ts-ignore
const shouldCopyToClipboard = await new Enquirer.Confirm({
  name: 'shouldCopyToClipboard',
  message: 'Copy generated command to clipboard?',
  initial: true,
}).run()

if (shouldCopyToClipboard) {
  clipboardy.writeSync(command)
  console.log('Copied to clipboard!')
}

// --- utils

/** @param {string} fromBranch @param {string} toBranch */
function getCherryPickableFullHashes(fromBranch, toBranch) {
  return executeShellCommand(`git cherry origin/${toBranch} origin/${fromBranch}`)
    .split('\n')
    .filter(line => line.startsWith('+'))
    .map(line => line.slice(2))
}

/** @param {string} fromBranch @param {string} toBranch */
function getLatestCommits(fromBranch, toBranch) {
  const delimiter = ':;:'
  return executeShellCommand(`git --no-pager log --pretty=format:"%at${delimiter}%h${delimiter}%H${delimiter}%an${delimiter}%s" origin/${fromBranch} --not origin/${toBranch}`)
    .split('\n')
    .map(line => {
      const [timestamp, hash, fullHash, author, ...message] = line.split(delimiter)
      return {
        branch: fromBranch,
        timestamp: Number(timestamp) * 1000, // it's in seconds
        hash,
        fullHash,
        author,
        message: message.join(delimiter),
      }
    })
}

/** @param {string} branch */
function generatePullRequestTitleFromBranch(branch) {
  const firstDashIndex = branch.indexOf('-')
  return branch.replaceAll('-', (_, index) => index !== firstDashIndex ? ' ' : '-')
}

function executeShellCommand(command) {
  console.log('>', command)
  const startedAt = performance.now()
  const result = execSync(command, { encoding: 'utf-8', maxBuffer: 1024 * 1024 })
  console.log(`  Returned ${result.split('\n').length} lines in ${Math.round(performance.now() - startedAt)}ms`)
  return result
}

/** @param {Date} date */
function formatDate(date) {
  return date.toDateString()
}

/** @param {string} text @param {number} length */
function truncate(text, length) {
  if (text.length > length) {
    return text.slice(0, length - 1).trim() + '…'
  }

  return text
}
