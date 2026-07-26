const { spawn } = require('child_process')
const { publishLog } = require('./redis')

const KANIKO_EXECUTOR_PATH = '/kaniko/executor'

/**
 * Why Kaniko and not `docker build`: build-engine runs as an ECS FARGATE
 * task, and Fargate gives you no Docker daemon and no privileged
 * containers — `docker build`/`docker run` simply aren't available here.
 * Kaniko builds an OCI image layer-by-layer INSIDE this already-unprivileged
 * container and pushes straight to a registry, with no daemon of its own
 * required — it drops into the exact same "one Fargate RunTask per build"
 * model the STATIC path already uses, instead of needing a second AWS
 * service (e.g. CodeBuild) to hand the image-build step off to.
 *
 * Uses `spawn` (not the `exec`-based runShellCommand in script.js) because
 * the destination/context/dockerfile arguments are passed as a real argv
 * array — no shell string-interpolation, no quoting to get wrong for a
 * path that happens to contain a space.
 *
 * ECR auth: Kaniko's registry client picks up AWS credentials the exact
 * same way the AWS SDK already does for this task's S3 uploads —
 * AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_REGION, already present
 * in every build task's container environment (see deployment-engine.ts).
 * No separate `docker login`/credential-helper step needed.
 */
function runKanikoBuild({ dockerfilePath, contextPath, destination }) {
    return new Promise((resolve, reject) => {
        const args = [
            `--dockerfile=${dockerfilePath}`,
            `--context=dir://${contextPath}`,
            `--destination=${destination}`,
            // Kaniko can't reuse a persistent daemon-side layer cache across
            // separate Fargate tasks the way `docker build` can on a shared
            // host — leaving caching off is the honest default rather than
            // pointing --cache-repo at a second ECR repo this platform
            // doesn't provision yet.
            '--cache=false',
            '--compressed-caching=false',
            '--snapshot-mode=redo',
        ]

        publishLog(`Building image: kaniko ${args.join(' ')}`, 'SYSTEM', 'platform')

        const p = spawn(KANIKO_EXECUTOR_PATH, args)

        p.stdout.on('data', (data) => {
            console.log(data.toString())
            publishLog(data.toString(), 'INFO', 'kaniko')
        })

        p.stderr.on('data', (data) => {
            // Kaniko logs its own progress (layer push status, etc.) to
            // stderr by default — WARN, not ERROR, same reasoning as
            // script.js's own stderr handling for npm install/build.
            console.error(data.toString())
            publishLog(data.toString(), 'WARN', 'kaniko')
        })

        p.on('close', (code) => {
            if (code === 0) {
                resolve()
            } else {
                reject(new Error(`Kaniko exited with code ${code} — image build or ECR push failed`))
            }
        })

        p.on('error', (err) => {
            reject(new Error(`Failed to start Kaniko executor: ${err.message}`))
        })
    })
}

module.exports = { runKanikoBuild }
