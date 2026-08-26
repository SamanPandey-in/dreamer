#!/usr/bin/env node
import {
  checkDocker,
  generateEnvFiles,
  buildBuildEngineImage,
  composeUp,
  runMigrations,
  composeDown,
  composeLogs,
  composePs,
  printSummary,
  log,
  fatal,
} from '../src/lib.js'

const [, , cmd, ...rest] = process.argv

function flag(name) {
  return rest.includes(`--${name}`)
}

function value(name, fallback) {
  const i = rest.indexOf(`--${name}`)
  return i !== -1 && rest[i + 1] ? rest[i + 1] : fallback
}

async function main() {
  switch (cmd) {
    case undefined:
    case 'up': {
      if (!checkDocker()) process.exit(1)
      generateEnvFiles({ domain: value('domain', 'localtest.me') })
      await buildBuildEngineImage()
      await composeUp()
      await runMigrations()
      printSummary()
      break
    }
    case 'down': {
      await composeDown(flag('volumes'))
      break
    }
    case 'logs': {
      await composeLogs(rest[0])
      break
    }
    case 'ps': {
      await composePs()
      break
    }
    case 'doctor': {
      checkDocker()
      break
    }
    case '--help':
    case '-h':
    case 'help': {
      console.log(`dreamer-local — run the Dreamer Local Engine on your own machine

Usage:
  npx dreamer-local up [--domain <domain>]   Build images, start the stack, run migrations
  npx dreamer-local down [--volumes]         Stop the stack (optionally wiping data)
  npx dreamer-local logs [service]           Tail logs
  npx dreamer-local ps                       Show container status
  npx dreamer-local doctor                   Check Docker is installed and running

Run with no arguments from inside the local-engine/ directory (or via
"npx dreamer-local" if the CLI is published) — it operates on the
local-engine checkout it ships alongside.`)
      break
    }
    default: {
      fatal(`Unknown command: ${cmd}. Run "dreamer-local help" for usage.`)
    }
  }
}

main().catch((err) => {
  log.error(err?.stack || String(err))
  process.exit(1)
})
