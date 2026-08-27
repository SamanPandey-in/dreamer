const { exec } = require('child_process')
const os = require('os')
const path = require('path')
const fs = require('fs')
const { publishLog, publishStatus } = require('./redis')

const GIT_REPOSITORY_URL = process.env.GIT_REPOSITORY_URL
const BRANCH = process.env.BRANCH || 'main'
// Set only for rollbacks — checkout this exact commit instead of branch HEAD.
const COMMIT_HASH = process.env.COMMIT_HASH
// Subdirectory of the clone containing this project's package.json
// (monorepo support; empty string = repo root).
const ROOT_DIRECTORY = (process.env.ROOT_DIRECTORY || '').replace(/^["']|["']$/g, '')
const NETRC_PATH = path.join(os.homedir(), '.netrc')

/**
 * Private repos: GIT_ACCESS_TOKEN is written to ~/.netrc rather than
 * embedded in the clone URL — if git ever echoes the URL it operates on
 * (it does, on several error paths), the echo is always the plain URL,
 * never one with a token baked in.
 */
function writeNetrcIfNeeded() {
    if (!process.env.GIT_ACCESS_TOKEN) return
    fs.writeFileSync(
        NETRC_PATH,
        `machine github.com\nlogin x-access-token\npassword ${process.env.GIT_ACCESS_TOKEN}\n`,
        { mode: 0o600 }
    )
}

/**
 * Scrubbed right after clone AND again in finally — without the early call,
 * the token would sit on disk through the entire npm install/build, where
 * any malicious package's postinstall could read it.
 */
function scrubNetrc() {
    fs.rm(NETRC_PATH, { force: true }, () => {})
}


const targetPath = '/home/app/output'

function runClone() {
    if (!GIT_REPOSITORY_URL) {
        return Promise.reject(new Error(
            'GIT_REPOSITORY_URL is not set — pass it as an env var (e.g. docker run -e GIT_REPOSITORY_URL=<url> ...)'
        ))
    }

    return new Promise((resolve, reject) => {
        const p = exec(`git clone --branch "${BRANCH}" --single-branch "${GIT_REPOSITORY_URL}" "${targetPath}"`)

        // Safe to publish verbatim — credentials come from ~/.netrc, never
        // the command line or URL, so git's output can't contain the token.
        p.stderr.on('data', (data) => publishLog(data.toString(), 'WARN', 'platform'))

        p.on('close', (code) => {
            if (code === 0) {
                resolve()
            } else {
                // GitHub returns the same 404 for "doesn't exist" and "no
                // access" — this message can't tell those apart either.
                reject(new Error(
                    `git clone exited with code ${code} — check the repository URL and branch, and (for private repos) that your GitHub connection still has access`
                ))
            }
        })
    })
}

/**
 * --single-branch (no --depth) still fetches the branch's FULL history, so
 * any previously-deployed commit stays checkoutable unless it was removed
 * from the branch's history by a force-push/rebase.
 */
function runCheckoutIfPinned() {
    if (!COMMIT_HASH) return Promise.resolve()

    return new Promise((resolve, reject) => {
        const p = exec(`git -C "${targetPath}" checkout "${COMMIT_HASH}"`)
        p.stderr.on('data', (data) => publishLog(data.toString(), 'WARN', 'platform'))

        p.on('close', (code) => {
            if (code === 0) {
                resolve()
            } else {
                reject(new Error(
                    `Could not check out commit ${COMMIT_HASH} on branch "${BRANCH}" — it may no longer be reachable on this branch (e.g. a force-push or rebase since this rollback target was originally deployed)`
                ))
            }
        })
    })
}

/**
 * Best-effort — a missing commit hash must never fail a build. %x1f is the
 * delimiter because commit messages can legally contain ':' or '|'.
 */
function getCommitInfo() {
    return new Promise((resolve) => {
        const p = exec(`git -C "${targetPath}" log -1 --format="%H%x1f%s%x1f%an"`)
        let out = ''
        p.stdout.on('data', (data) => (out += data.toString()))
        p.on('close', (code) => {
            if (code !== 0) return resolve(null)
            const [hash, message, author] = out.trim().split('\x1f')
            resolve(hash ? { hash, message, author } : null)
        })
    })
}

/**
 * Resolves where install/build should run — the clone root, or a
 * subdirectory for monorepo projects.
 *
 * The prefix check after path.join is a path-traversal guard:
 * ROOT_DIRECTORY originates from user input, and path.join will happily
 * resolve '../../etc' outside targetPath. Refusing out-of-bounds paths
 * outright (rather than sanitizing strings) is the robust guarantee — this
 * container briefly holds a live GitHub token on disk.
 */
function getBuildContextPath() {
    if (!ROOT_DIRECTORY) return targetPath

    const resolved = path.join(targetPath, ROOT_DIRECTORY)
    const normalizedTarget = path.normalize(targetPath + path.sep)

    if (!path.normalize(resolved + path.sep).startsWith(normalizedTarget)) {
        throw new Error(`Invalid root directory "${ROOT_DIRECTORY}" — resolves outside the cloned repository`)
    }

    return resolved
}

module.exports = { writeNetrcIfNeeded, scrubNetrc, runClone, runCheckoutIfPinned, getCommitInfo, getBuildContextPath }