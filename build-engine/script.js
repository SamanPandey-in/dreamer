const { exec } = require('child_process')
const path = require('path')
const fs = require('fs')
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3')
const mime = require('mime-types')
const { publishLog, publishStatus, publishCommitInfo, publishImageReady, publisher } = require('./redis')
const { writeNetrcIfNeeded, scrubNetrc, runClone, runCheckoutIfPinned, getCommitInfo, getBuildContextPath } = require('./clone-repo')
const { resolveDockerfile } = require('./dockerfile-resolver')
const { runLocalDockerBuild } = require('./docker-build')

// Talks to MinIO (docker-compose.yml), not real AWS S3 — MinIO just
// speaks the same protocol, which is why @aws-sdk/client-s3 is still the
// right client. forcePathStyle is required for MinIO (see api-server's
// lib/s3-client.ts for the matching client-side comment).
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

// Resolved project build config, forwarded by deployment-engine.ts's
// DockerDeploymentEngine from the Project row (project.service.ts). Each
// falls back to exactly what this file hardcoded before this feature
// existed, so a project created before it shipped (every one of these
// env vars absent) builds identically — no migration, no behavior
// change, for existing projects that have never touched their build
// settings.
const INSTALL_COMMAND = (process.env.INSTALL_COMMAND || 'npm ci --legacy-peer-deps').replace(/^["']|["']$/g, '')
const BUILD_COMMAND = (process.env.BUILD_COMMAND || 'npm run build').replace(/^["']|["']$/g, '')
const OUTPUT_DIRECTORY = (process.env.OUTPUT_DIRECTORY || 'dist').replace(/^["']|["']$/g, '')

// Decides which branch init() takes after the clone/checkout preamble.
// Forwarded by deployment-engine.ts's launchBuildTask, straight off
// Project.detectedDeploymentType. A build task that predates this
// feature (or a STATIC project) never sets this, and the `|| 'STATIC'`
// fallback below means it behaves exactly as it always did.
const DEPLOYMENT_TYPE = process.env.DEPLOYMENT_TYPE || 'STATIC'
const FRAMEWORK = process.env.FRAMEWORK || 'UNKNOWN'

/**
 * Runs install and build as two separate sequential steps (not one chained
 * `&&` shell command) specifically so a failure can be attributed to
 * INSTALL vs BUILD — Deployment.errorStep exists precisely to answer "which
 * step failed: install | build | upload | start" (see schema.prisma), and
 * collapsing both into a single exec() makes that column impossible to
 * populate correctly. Each still runs through a shell (needed since
 * INSTALL_COMMAND/BUILD_COMMAND are themselves arbitrary shell command
 * strings — "npm run build", "pnpm install --frozen-lockfile", etc.), with
 * `cwd` doing the directory change instead of a string-interpolated `cd` —
 * safer once dirPath can contain a user-influenced root-directory segment.
 */
function runShellCommand(command, cwd) {
    return new Promise((resolve, reject) => {
        const p = exec(command, { cwd })

        p.stdout.on('data', function (data) {
            console.log(data.toString())
            publishLog(data.toString())
        })

        // stderr is mostly npm warning chatter and build-tool progress
        // output, not necessarily a fatal error — WARN, not ERROR. The
        // build's actual pass/fail signal is the exit code in p.on('close'),
        // not which stream a given line happened to print to.
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

/**
 * The original, unchanged STATIC pipeline — install, build, verify the
 * output directory exists, upload it to S3. Extracted out of init() as its
 * own function (rather than left inline) purely so DEPLOYMENT_TYPE can pick
 * between this and runDynamicBuild() with a plain if/else instead of a much
 * larger branch buried in the middle of one function.
 */
async function runStaticBuild(buildContextPath) {
    // 1. Install dependencies.
    publishLog(`Installing dependencies: ${INSTALL_COMMAND}`, 'SYSTEM', 'platform')
    try {
        await runShellCommand(INSTALL_COMMAND, buildContextPath)
    } catch (installError) {
        installError.step = 'install'
        throw installError
    }

    // 2. Run the build.
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

    // Safety check to ensure the framework actually built the expected output folder.
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

        // __outputs/{PROJECT_SLUG}/... — keyed by the PROJECT's slug,
        // not this deployment's own random one. Every deployment of the
        // same project writes to, and overwrites, the same prefix — on
        // purpose. apps/reverse-proxy needs NO changes: it already
        // proxies subdomain -> __outputs/{subdomain}, and the subdomain
        // a user visits IS the project's slug.
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
    // CHANGED — uploadedCount was computed and logged, but never sent
    // here, so Deployment.uploadedFileCount stayed null forever. This is
    // the one-line fix the Build Summary card (Part 7) depends on.
    publishStatus('RUNNING', { url, uploadedFileCount: uploadedCount })
}

/**
 * The DYNAMIC pipeline: resolve a Dockerfile (the repo's own, or a
 * generated one for the detected framework), build it locally with
 * `docker build` against the host daemon (see docker-build.js — reached
 * via the socket docker-compose.yml mounts into this container), publish
 * `image_ready`. Deliberately does NOT publish a RUNNING (or even
 * STARTING) status itself — this task's job ends the moment the image
 * exists locally. Turning that image into a live running container is
 * api-server's job (deployDynamicApp() in deployment-engine.ts, triggered
 * by handleImageReady() in deployment.service.ts) — no registry push,
 * no pull-back-down: build and run share the same Docker daemon.
 */
async function runDynamicBuild(buildContextPath) {
    let dockerfilePath
    try {
        dockerfilePath = resolveDockerfile(buildContextPath, {
            framework: FRAMEWORK,
            installCommand: INSTALL_COMMAND,
            buildCommand: BUILD_COMMAND,
        })
    } catch (resolveError) {
        resolveError.step = 'build'
        throw resolveError
    }

    // Tagged by PROJECT slug (not this deployment's own id) — same "one
    // live thing per PROJECT, a redeploy replaces it" model STATIC's
    // output prefix already uses. deployDynamicApp() in
    // deployment-engine.ts reads this exact tag back to `docker run` it.
    const destination = `dreamer-app:${PROJECT_SLUG}`

    publishLog(`Building container image for ${FRAMEWORK} as ${destination}`, 'SYSTEM', 'platform')
    try {
        await runLocalDockerBuild({ dockerfilePath, contextPath: buildContextPath, destination })
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
        // 0. Clone — now INSIDE this try/catch, unlike the original
        // prototype where main.sh ran it before this process even started
        // (see the note above Part 6.1 for why that made clone failures
        // invisible to the dashboard).
        writeNetrcIfNeeded()
        publishLog(`Cloning ${GIT_REPOSITORY_URL} (branch: ${BRANCH})`, 'SYSTEM', 'platform')
        await runClone()

        // NEW — if this build is a rollback (COMMIT_HASH set), pin the
        // checkout to that exact commit BEFORE scrubbing credentials and
        // BEFORE reading commit info, so getCommitInfo() below reports the
        // pinned commit, not the branch's current HEAD.
        await runCheckoutIfPinned()
        scrubNetrc() // before npm touches a single dependency — see the comment on scrubNetrc()

        // NEW — best-effort; a null result just means the commit fields
        // stay null on this deployment, same as they already do for every
        // deployment created before this change.
        const commitInfo = await getCommitInfo()
        if (commitInfo) {
            publishCommitInfo({ commitHash: commitInfo.hash, commitMessage: commitInfo.message, commitAuthor: commitInfo.author })
        }

        // NEW — resolves to the cloned repo root, or a subdirectory of it
        // for a monorepo project (Project.rootDirectory). Throws (caught
        // below, reported as errorStep: 'build') if ROOT_DIRECTORY would
        // resolve outside the clone — see the guard in clone-repo.js.
        const buildContextPath = getBuildContextPath()

        // DYNAMIC apps' install+build happens INSIDE the `docker build`
        // (see the generated Dockerfile's own `builder` stage), not out
        // here on the host — running `npm install`/`npm run build` twice
        // (once here, once again inside the image build) would waste the
        // bulk of a build's wall-clock time for no benefit. So the branch
        // happens BEFORE step 1, not after — the two paths only share the
        // clone/checkout/commit-info preamble above this line.
        if (DEPLOYMENT_TYPE === 'DYNAMIC') {
            await runDynamicBuild(buildContextPath)
        } else {
            await runStaticBuild(buildContextPath)
        }

        console.log('Done...')
    } catch (error) {
        console.error('Fatal execution error:', error.message)
        publishLog(`Fatal error: ${error.message}`, 'ERROR', 'platform')
        // CHANGED — errorStep now reflects which phase actually failed
        // (install vs build vs upload) instead of being hardcoded to
        // 'build' for every failure. installError/buildError above attach
        // `.step` before rethrowing; an upload failure (thrown directly
        // inside the for-loop, no .step attached) and anything thrown
        // before either step ran both correctly fall back to 'build' as
        // the most accurate remaining guess.
        publishStatus('FAILED', { errorMessage: error.message, errorCode: 'BUILD_FAILED', errorStep: error.step || 'build' })
        process.exitCode = 1
    } finally {
        // Guarantees cleanup even if the clone itself is what threw — the
        // success-path call above is the one that matters for the
        // npm-install threat model, but this one matters for "the process
        // is about to exit no matter what, leave nothing behind."
        scrubNetrc()
        // publisher.publish() is fire-and-forget over an already-open
        // connection — give the last message a moment to actually flush
        // over the socket before the process (and this whole container)
        // exits.
        setTimeout(() => publisher.quit(), 250)
    }
}

init()
