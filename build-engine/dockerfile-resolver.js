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
 * Returns the ABSOLUTE PATH to the Dockerfile `docker build` should use,
 * and as a side effect, writes a generated one into buildContextPath if
 * the repo doesn't already ship its own — same "config wins over
 * convention" precedent as Project.buildCommand/outputDirectory
 * overriding script.js's own defaults elsewhere in this file.
 */
function resolveDockerfile(buildContextPath, { framework, installCommand, buildCommand }) {
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
        .replaceAll('__INSTALL_COMMAND__', installCommand)
        .replaceAll('__BUILD_COMMAND__', buildCommand)

    const generatedPath = path.join(buildContextPath, 'Dockerfile.dreamer-generated')
    fs.writeFileSync(generatedPath, rendered)
    return generatedPath
}

module.exports = { resolveDockerfile }
