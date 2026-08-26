const { exec } = require('child_process')
const path = require('path')
const fs = require('fs')
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3')
const mime = require('mime-types')
const { publishLog, publishStatus, publishCommitInfo, publishImageReady, publisher } = require('./redis')
const { writeNetrcIfNeeded, scrubNetrc, runClone, runCheckoutIfPinned, getCommitInfo, getBuildContextPath } = require('./clone-repo')
const { resolveDockerfile } = require('./dockerfile-resolver')
const { runLocalDockerBuild } = require('./docker-build')

// MinIO (docker-compose.yml), not real S3 — same protocol, hence the AWS SDK
// client. forcePathStyle is required for MinIO.
const s3Client = new S3Client({
    region: process.env.AWS_REGION || 'us-east-1',
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
    },
    endpoint: process.env.S3_ENDPOINT_URL,
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true',
})

const DEPLOYMENT_ID = process.env.DEPLOYMENT_ID
const PROJECT_SLUG = process.env.PROJECT_SLUG
const GIT_REPOSITORY_URL = process.env.GIT_REPOSITORY_URL
const BRANCH = process.env.BRANCH || 'main'
const S3_BUCKET = process.env.S3_BUCKET || 'dreamer-outputs'
const BASE_DOMAIN = process.env.BASE_DOMAIN

// Project build config from the Project row; defaults keep pre-existing
// projects building identically.
const INSTALL_COMMAND = (process.env.INSTALL_COMMAND || 'npm ci --legacy-peer-deps').replace(/^["']|["']$/g, '')
const BUILD_COMMAND = (process.env.BUILD_COMMAND || 'npm run build').replace(/^["']|["']$/g, '')
const OUTPUT_DIRECTORY = (process.env.OUTPUT_DIRECTORY || 'dist').replace(/^["']|["']$/g, '')

// DEPLOYMENT_TYPE decides which pipeline init() takes after the preamble.
const DEPLOYMENT_TYPE = process.env.DEPLOYMENT_TYPE || 'STATIC'
const FRAMEWORK = process.env.FRAMEWORK || 'UNKNOWN'

/**
 * The project's own env vars as JSON — only meaningful for DYNAMIC builds.
 * The vars arrive twice: flat into this container's env (what a STATIC
 * build's child_process inherits) AND as this blob, because the nested
 * `docker build` runs in an isolated context and inherits nothing from this
 * container. Without it, NEXT_PUBLIC_* inlining and build-time process.env
 * reads inside `next build` would silently see nothing.
 */
let USER_ENV_VARS = []
try {
    USER_ENV_VARS = JSON.parse(process.env.USER_ENV_VARS_JSON || '[]')
} catch (parseError) {
    // Fail open — a build without its env vars is a visible-in-UI problem;
    // a build that never runs is worse.
    publishLog(`Warning: could not parse USER_ENV_VARS_JSON — env vars will not be available at build time: ${parseError.message}`, 'WARN', 'platform')
}

/**
 * Install and build run as separate steps (not one chained command) so a
 * failure can be attributed to INSTALL vs BUILD via Deployment.errorStep.
 * Commands still go through a shell (they're arbitrary command strings);
 * `cwd` does the directory change instead of an interpolated `cd`, since
 * dirPath can contain a user-influenced root-directory segment.
 */
function runShellCommand(command, cwd) {
    return new Promise((resolve, reject) => {
        const p = exec(command, { cwd })

        p.stdout.on('data', function (data) {
            console.log(data.toString())
            publishLog(data.toString())
        })

        // stderr is mostly npm chatter and progress output, not fatal —
        // the exit code is the pass/fail signal.
        p.stderr.on('data', function (data) {
            console.error(data.toString())
            publishLog(data.toString(), 'WARN')
        })

        p.on('close', function (code) {
            if (code === 0) {
                resolve()
            } else {
                reject(new Error(`Command "${command}" exited with code ${code}`))
            }
        })
    })
}

async function runStaticBuild(buildContextPath) {
    publishLog(`Installing dependencies: ${INSTALL_COMMAND}`, 'SYSTEM', 'platform')
    try {
        await runShellCommand(INSTALL_COMMAND, buildContextPath)
    } catch (installError) {
        installError.step = 'install'
        throw installError
    }

    publishLog(`Building: ${BUILD_COMMAND}`, 'SYSTEM', 'platform')
    try {
        await runShellCommand(BUILD_COMMAND, buildContextPath)
    } catch (buildError) {
        buildError.step = 'build'
        throw buildError
    }

    console.log('Build Complete')
    publishLog('Build complete', 'SYSTEM')

    const distFolderPath = path.join(buildContextPath, OUTPUT_DIRECTORY)

    if (!fs.existsSync(distFolderPath)) {
        const notFoundError = new Error(
            `Build finished but expected output directory "${OUTPUT_DIRECTORY}" was not found at ${distFolderPath} — ` +
            `check that the project's Output Directory setting matches what "${BUILD_COMMAND}" actually produces`
        )
        notFoundError.step = 'build'
        throw notFoundError
    }

    publishStatus('UPLOADING')
    publishLog('Starting upload to S3', 'SYSTEM', 'platform')

    const distFolderContents = fs.readdirSync(distFolderPath, { recursive: true })
    let uploadedCount = 0

    for (const file of distFolderContents) {
        const filePath = path.join(distFolderPath, file)
        if (fs.lstatSync(filePath).isDirectory()) continue;

        console.log('uploading', filePath)
        publishLog(`uploading ${file}`, 'INFO', 'platform')

        // Keyed by PROJECT slug, not deployment id: every deployment of a
        // project overwrites the same prefix on purpose, and reverse-proxy
        // already serves __outputs/{subdomain} where subdomain == slug.
        const command = new PutObjectCommand({
            Bucket: S3_BUCKET,
            Key: `__outputs/${PROJECT_SLUG}/${file}`,
            Body: fs.createReadStream(filePath),
            ContentType: mime.lookup(filePath) || 'application/octet-stream'
        })

        await s3Client.send(command)
        uploadedCount++
        publishLog(`uploaded ${file}`, 'INFO', 'platform')
    }

    const url = `https://${PROJECT_SLUG}.${BASE_DOMAIN}`
    publishLog(`Done — ${uploadedCount} files uploaded`, 'SYSTEM')
    publishStatus('RUNNING', { url, uploadedFileCount: uploadedCount })
}

/**
 * DYNAMIC pipeline: resolve a Dockerfile (repo's own or generated), build it
 * locally against the host daemon, then publish `image_ready`. Deliberately
 * does NOT publish RUNNING/STARTING itself — turning the image into a live
 * container is api-server's job (deployDynamicApp, triggered by image_ready).
 */
async function runDynamicBuild(buildContextPath) {
    let dockerfilePath
    try {
        dockerfilePath = resolveDockerfile(buildContextPath, {
            framework: FRAMEWORK,
            installCommand: INSTALL_COMMAND,
            buildCommand: BUILD_COMMAND,
            // Names only — values travel separately as --build-args, never
            // into the Dockerfile text.
            userEnvVarNames: USER_ENV_VARS.map((v) => v.name),
        })
    } catch (resolveError) {
        resolveError.step = 'build'
        throw resolveError
    }

    // Tagged per PROJECT (a redeploy replaces it), matching how STATIC
    // shares one output prefix per project. deployDynamicApp reads this
    // exact tag back to `docker run` it.
    const destination = `dreamer-app:${PROJECT_SLUG}`

    publishLog(`Building container image for ${FRAMEWORK} as ${destination}`, 'SYSTEM', 'platform')
    try {
        await runLocalDockerBuild({ dockerfilePath, contextPath: buildContextPath, destination, buildArgs: USER_ENV_VARS })
    } catch (buildError) {
        buildError.step = 'build'
        throw buildError
    }

    console.log('Image build complete')
    publishLog('Image built', 'SYSTEM')

    const url = `https://${PROJECT_SLUG}.${BASE_DOMAIN}`
    publishImageReady({ imageUri: destination, imageSizeBytes: null, url })
}

async function init() {
    console.log('Executing script.js')
    publishLog('Build started', 'SYSTEM')
    publishStatus('BUILDING')

    try {
        writeNetrcIfNeeded()
        publishLog(`Cloning ${GIT_REPOSITORY_URL} (branch: ${BRANCH})`, 'SYSTEM', 'platform')
        await runClone()

        // Rollback pin BEFORE credential scrub and commit-info read, so
        // getCommitInfo reports the pinned commit, not branch HEAD.
        await runCheckoutIfPinned()
        scrubNetrc() // before npm touches a single dependency

        const commitInfo = await getCommitInfo()
        if (commitInfo) {
            publishCommitInfo({ commitHash: commitInfo.hash, commitMessage: commitInfo.message, commitAuthor: commitInfo.author })
        }

        const buildContextPath = getBuildContextPath()

        // Branch BEFORE install/build: a DYNAMIC app's install+build happens
        // INSIDE its `docker build` (builder stage) — running both here and
        // in the image build would double the wall-clock time for nothing.
        if (DEPLOYMENT_TYPE === 'DYNAMIC') {
            await runDynamicBuild(buildContextPath)
        } else {
            await runStaticBuild(buildContextPath)
        }

        console.log('Done...')
    } catch (error) {
        console.error('Fatal execution error:', error.message)
        publishLog(`Fatal error: ${error.message}`, 'ERROR', 'platform')
        // errorStep reflects the phase that actually failed; anything thrown
        // before a step ran falls back to 'build' as best guess.
        publishStatus('FAILED', { errorMessage: error.message, errorCode: 'BUILD_FAILED', errorStep: error.step || 'build' })
        process.exitCode = 1
    } finally {
        // Covers the case where the clone itself threw.
        scrubNetrc()
        // Give the last fire-and-forget publish a moment to flush before
        // the process/container exits.
        setTimeout(() => publisher.quit(), 250)
    }
}

init()
