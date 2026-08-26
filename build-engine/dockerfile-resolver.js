const fs = require('fs')
const path = require('path')
const { publishLog } = require('./redis')

const TEMPLATES_DIR = path.join(__dirname, 'dockerfile-templates')

// FRAMEWORK (the Prisma `Framework` enum value, forwarded verbatim as an
// env var by deployment-engine.ts's launchBuildTask) -> template filename.
// Only NEXT_SSR has a template today — see script.js's own comment on why
// EXPRESS/FASTIFY/HONO aren't wired up yet even though the enum already
// has room for them. nextjs-standalone.dockerfile runs the Next.js
// standalone server directly as a plain container — see that template's
// own comment.
const FRAMEWORK_TEMPLATES = {
    NEXT_SSR: 'nextjs-standalone.dockerfile',
}

/**
 * Best-effort check for `output: 'standalone'` in the repo's own
 * next.config.{js,mjs,ts}. This is NOT a full JS/TS parse (that would mean
 * shipping a JS parser into build-engine for one boolean) — it's a text
 * search, which is exactly as reliable as it sounds and deliberately
 * fails OPEN (missing/unreadable config -> warn, don't block) rather than
 * risking a false-positive block on a config file with unusual formatting
 * this regex doesn't anticipate. The REAL failure mode this is meant to
 * catch — `output: 'standalone'` well and truly absent — still gets
 * caught later, just later: the COPY .next/standalone step in the
 * generated Dockerfile fails loudly, and that failure's stderr is what
 * actually reaches the user's build logs either way.
 */
function warnIfNotStandalone(buildContextPath) {
    const candidates = ['next.config.js', 'next.config.mjs', 'next.config.ts']
    for (const filename of candidates) {
        const configPath = path.join(buildContextPath, filename)
        if (!fs.existsSync(configPath)) continue

        const contents = fs.readFileSync(configPath, 'utf8')
        if (!/output\s*:\s*['"]standalone['"]/.test(contents)) {
            publishLog(
                `Warning: ${filename} does not appear to set output: 'standalone'. ` +
                `The container image build will likely fail at the ".next/standalone" copy step — ` +
                `add "output: 'standalone'" to your Next.js config and redeploy.`,
                'WARN',
                'platform'
            )
        }
        return
    }
    publishLog(
        'Warning: no next.config.{js,mjs,ts} found — could not verify output: "standalone" is set.',
        'WARN',
        'platform'
    )
}

/**
 * Renders the ARG/ENV block that goes in front of `RUN __INSTALL_COMMAND__`
 * in the generated Dockerfile — one ARG + one ENV per user-configured env
 * var name. ARG alone only makes a value available as a build-time
 * parameter; Next.js reads `process.env` from inside Node during
 * `next build`, which only ever sees real environment variables — hence
 * re-exposing every ARG as an ENV of the same name right after declaring
 * it. Only NAMES are interpolated into the Dockerfile text itself; the
 * VALUES travel separately as `docker build --build-arg`s (see
 * docker-build.js) so a project's secret value never ends up written into
 * Dockerfile.dreamer-generated, which sits inside the cloned repo's own
 * build context on this machine's disk.
 */
function renderBuildArgsBlock(userEnvVarNames) {
    if (userEnvVarNames.length === 0) return ''

    return (
        userEnvVarNames.map((name) => `ARG ${name}\nENV ${name}=$${name}`).join('\n') + '\n'
    )
}

/**
 * Returns the ABSOLUTE PATH to the Dockerfile `docker build` should use,
 * and as a side effect, writes a generated one into buildContextPath if
 * the repo doesn't already ship its own — same "config wins over
 * convention" precedent as Project.buildCommand/outputDirectory
 * overriding script.js's own defaults elsewhere in this file.
 *
 * userEnvVarNames: the project's configured env var NAMES (values are
 * never interpolated into the Dockerfile text — see renderBuildArgsBlock).
 * Ignored when the repo brings its own Dockerfile: that file is used
 * as-is, so a project that wants its own Dockerfile to receive these
 * vars needs its own matching ARG/ENV lines — docker-build.js still
 * passes the values as --build-args either way, it's just a no-op unless
 * the Dockerfile declares a matching ARG to receive it (same behavior as
 * a plain `docker build --build-arg` against any Dockerfile).
 */
function resolveDockerfile(buildContextPath, { framework, installCommand, buildCommand, userEnvVarNames = [] }) {
    const ownDockerfile = path.join(buildContextPath, 'Dockerfile')
    if (fs.existsSync(ownDockerfile)) {
        publishLog('Found a Dockerfile in the repository — using it as-is.', 'SYSTEM', 'platform')
        return ownDockerfile
    }

    const templateFile = FRAMEWORK_TEMPLATES[framework]
    if (!templateFile) {
        throw new Error(
            `No Dockerfile was found in the repository, and "${framework}" has no generated-Dockerfile ` +
            `template yet (only NEXT_SSR does). Add a Dockerfile to the repository root, or deploy a ` +
            `Next.js SSR project instead.`
        )
    }

    if (framework === 'NEXT_SSR') {
        warnIfNotStandalone(buildContextPath)
    }

    publishLog(`No Dockerfile found — generating one from the ${framework} template.`, 'SYSTEM', 'platform')

    const template = fs.readFileSync(path.join(TEMPLATES_DIR, templateFile), 'utf8')
    const rendered = template
        .replaceAll('__BUILD_ARGS__', renderBuildArgsBlock(userEnvVarNames))
        .replaceAll('__INSTALL_COMMAND__', installCommand)
        .replaceAll('__BUILD_COMMAND__', buildCommand)

    const generatedPath = path.join(buildContextPath, 'Dockerfile.dreamer-generated')
    fs.writeFileSync(generatedPath, rendered)
    return generatedPath
}

module.exports = { resolveDockerfile }
