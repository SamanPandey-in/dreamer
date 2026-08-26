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
 * characters a shell would need quoting for.
 */
function runLocalDockerBuild({ dockerfilePath, contextPath, destination }) {
    return new Promise((resolve, reject) => {
        const args = ['build', '-f', dockerfilePath, '-t', destination, contextPath]

        publishLog(`Building image: docker ${args.join(' ')}`, 'SYSTEM', 'platform')

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
