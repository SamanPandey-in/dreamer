const { exec } = require('child_process')
const os = require('os')
const path = require('path')
const fs = require('fs')
const { publishLog, publishStatus } = require('./redis')

const GIT_REPOSITORY_URL = process.env.GIT_REPOSITORY_URL
const BRANCH = process.env.BRANCH || 'main'
//  NEW — set only for a rollback (api-server's EcsDeploymentEngine passes this
// through from BuildJob.commitHash). When present, runCheckoutIfPinned() below
// checks the clone out to this exact commit instead of leaving it at the
// branch's current HEAD.
const COMMIT_HASH = process.env.COMMIT_HASH
const NETRC_PATH = path.join(os.homedir(), '.netrc')

/**
 * For private repos, EcsDeploymentEngine (api-server's deployment-engine.ts)
 * hands this container a GIT_ACCESS_TOKEN env var — the project owner's
 * decrypted GitHub token, scoped for exactly this one task run. We write it
 * to ~/.netrc rather than embedding it in the clone URL: if git ever echoes
 * the URL it's operating on (it does, on several error paths), a
 * netrc-based credential means that echo is always the plain
 * https://github.com/... URL, never one with a token baked into it.
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
 * Best-effort, fire-and-forget cleanup — called right after a successful
 * clone AND again in `finally`, so the token can't outlive the one git
 * operation that needed it. The first call matters more than it looks:
 * without it, the token would still be sitting on disk for the ENTIRE
 * `npm install && npm run build` that follows — meaning any compromised or
 * malicious package's postinstall script could read a live GitHub token
 * straight off the filesystem. Scrubbing it before npm ever runs closes
 * that window completely, not just eventually.
 */
function scrubNetrc() {
    fs.rm(NETRC_PATH, { force: true }, () => {})
}


const targetPath = '/home/app/output'

function runClone() {
    return new Promise((resolve, reject) => {
        const p = exec(`git clone --branch "${BRANCH}" --single-branch "${GIT_REPOSITORY_URL}" "${targetPath}"`)

        // Safe to publish verbatim — git only ever sees the plain repo URL
        // (credentials come from ~/.netrc, never the command line or the
        // URL string), so nothing it prints to stderr can contain the token.
        p.stderr.on('data', (data) => publishLog(data.toString(), 'WARN', 'platform'))

        p.on('close', (code) => {
            if (code === 0) {
                resolve()
            } else {
                // GitHub returns the same 404 for "doesn't exist" and "you
                // don't have access" — deliberately, to avoid leaking which
                // private repos exist. This message can't tell those apart
                // either; the dashboard surfaces it as a hint to check the
                // GitHub connection rather than asserting the repo is missing.
                reject(new Error(
                    `git clone exited with code ${code} — check the repository URL and branch, and (for private repos) that your GitHub connection still has access`
                ))
            }
        })
    })
}

/**
 * NEW. `--single-branch` (no `--depth`) still fetches the FULL history of
 * that one branch — so any commit that was ever reachable from the branch's
 * tip at clone time is checkoutable, no extra fetch needed. This breaks only
 * if the target commit was later removed from the branch's history entirely
 * (a force-push/rebase) — the rejected promise's message says so explicitly,
 * rather than leaving someone to guess why a rollback to a "valid-looking"
 * commit failed.
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
 * NEW. Best-effort by design — if `git log` somehow fails (corrupted
 * shallow state, empty repo), a missing commit hash should never fail the
 * whole build over a metadata nicety. `%x1f` (the ASCII unit separator) is
 * the delimiter, not `:` or `|`, specifically because a real commit message
 * can legally contain either of those.
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

module.exports = { writeNetrcIfNeeded, scrubNetrc, runClone, runCheckoutIfPinned, getCommitInfo }