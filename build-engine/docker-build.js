const { spawn } = require('child_process')
const { publishLog } = require('./redis')

/**
 * Builds a container image with a plain `docker build` — no daemon-less
 * builder needed: the local engine's build-engine container has the
 * host's Docker socket mounted in (docker-compose.yml), so a real
 * daemon is right there. And critically, there's no registry push step
 * needed at all: build and run happen on the SAME daemon, so the image
 * tag built here is immediately visible to DockerDeploymentEngine's
 * later `docker run` — no registry, no push, no pull-back-down.
 *
 * Uses `spawn` with a real argv array (not `exec`'s shell string), same
 * reasoning as kaniko-build.js: contextPath/dockerfilePath can contain
 * characters a shell would need quoting for. Same reasoning is why
 * buildArgs below are appended as individual argv entries, not joined
 * into one string.
 *
 * buildArgs: the project's configured env vars as {name, value} pairs —
 * forwarded as `--build-arg NAME=value` so a generated Dockerfile's
 * ARG/ENV lines (see dockerfile-resolver.js) actually receive real
 * values, and so a project's OWN Dockerfile can opt in too by declaring
 * matching ARGs. `docker build` silently ignores a --build-arg whose
 * name has no matching ARG in the Dockerfile being built, so passing
 * all of them unconditionally is safe either way. This build's own
 * process env (this container's REDIS_URL, AWS_* MinIO creds, etc.) is
 * NOT what's being forwarded here — those were never the problem, since
 * runStaticBuild's plain child_process already inherits them fine. This
 * is specifically for the project's OWN vars reaching a `next build`
 * that runs inside a build that this process's own env is invisible to.
 */
function runLocalDockerBuild({ dockerfilePath, contextPath, destination, buildArgs = [] }) {
    return new Promise((resolve, reject) => {
        const args = [
            'build',
            '-f', dockerfilePath,
            '-t', destination,
            ...buildArgs.map(({ name, value }) => `--build-arg=${name}=${value}`),
            contextPath,
        ]

        // Redacted before logging — this line previously would have put
        // every --build-arg value, secrets included, straight into
        // Redis-published build logs the first time a project actually
        // configured one.
        const redactedArgs = args.map((arg) =>
            arg.startsWith('--build-arg=') ? `--build-arg=${arg.split('=')[1]}=***` : arg
        )
        publishLog(`Building image: docker ${redactedArgs.join(' ')}`, 'SYSTEM', 'platform')

        const p = spawn('docker', args)

        p.stdout.on('data', (data) => {
            console.log(data.toString())
            publishLog(data.toString(), 'INFO', 'docker')
        })

        p.stderr.on('data', (data) => {
            // `docker build`'s own progress output goes to stderr by
            // default (BuildKit) — WARN, not ERROR, same reasoning as
            // script.js's stderr handling elsewhere.
            console.error(data.toString())
            publishLog(data.toString(), 'WARN', 'docker')
        })

        p.on('close', (code) => {
            if (code === 0) {
                resolve()
            } else {
                reject(new Error(`docker build exited with code ${code}`))
            }
        })

        p.on('error', (err) => {
            reject(new Error(`Failed to start docker build: ${err.message}`))
        })
    })
}

module.exports = { runLocalDockerBuild }
