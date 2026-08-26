const { spawn } = require('child_process')
const { publishLog } = require('./redis')

/**
 * Builds an image with plain `docker build` against the host daemon (the
 * Docker socket is mounted in by docker-compose.yml). No registry step:
 * build and run share the same daemon, so the tag built here is directly
 * runnable by api-server's later `docker run`.
 *
 * `spawn` with a real argv array (not exec's shell string) — paths and
 * build-arg values can contain characters a shell would need quoting for.
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

        // Redact --build-arg values (project secrets included) before this
        // goes into Redis-published build logs.
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
            // BuildKit's progress output goes to stderr — WARN, not ERROR;
            // pass/fail is the exit code.
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
