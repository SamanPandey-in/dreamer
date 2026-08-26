const fs = require('fs')
const path = require('path')
const { publishLog } = require('./redis')

const TEMPLATES_DIR = path.join(__dirname, 'dockerfile-templates')

// FRAMEWORK (Prisma enum value, forwarded as env var) -> template filename.
const FRAMEWORK_TEMPLATES = {
    NEXT_SSR: 'nextjs-standalone.dockerfile',
}

/**
 * Best-effort text search for `output: 'standalone'` in next.config — not a
 * real JS parse, and deliberately fails OPEN (warn, don't block). If it's
 * genuinely absent, the generated Dockerfile's COPY .next/standalone step
 * fails loudly in the user's logs anyway.
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
 * Renders the ARG/ENV block preceding `RUN __INSTALL_COMMAND__`. Next.js
 * reads process.env during `next build`, so each ARG must be re-exposed as
 * an ENV of the same name. Only NAMES are interpolated into the Dockerfile
 * text; VALUES travel separately as --build-args, so secrets never end up
 * written into Dockerfile.dreamer-generated inside the repo's build context.
 */
function renderBuildArgsBlock(userEnvVarNames) {
    if (userEnvVarNames.length === 0) return ''

    return (
        userEnvVarNames.map((name) => `ARG ${name}\nENV ${name}=$${name}`).join('\n') + '\n'
    )
}

/**
 * Returns the absolute path to the Dockerfile for `docker build`, writing a
 * generated one into buildContextPath when the repo doesn't ship its own
 * (repo-provided config wins over convention).
 *
 * userEnvVarNames are ignored when the repo has its own Dockerfile — values
 * still go through as --build-args, but are no-ops unless that file declares
 * matching ARGs (standard docker build behavior).
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
