#!/usr/bin/env node

/** Start the sibling DSH checkout prepared by install-source.mjs. */

import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const harnessDir = resolve(process.env.AUTOREPORT_DSH_DIR ?? join(repoRoot, '..', 'deepseek-harness'))

if (!existsSync(join(harnessDir, 'package.json'))) {
  console.error(`autoreportdsh: DSH checkout not found at ${harnessDir}; run pnpm run install:source first`)
  process.exitCode = 1
} else {
  const child = spawn('pnpm', ['dsh', 'web', ...process.argv.slice(2)], {
    cwd: harnessDir,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  })
  child.once('error', error => {
    console.error(`autoreportdsh: failed to start DSH: ${String(error)}`)
    process.exitCode = 1
  })
  child.once('exit', (code, signal) => {
    if (signal !== null) process.kill(process.pid, signal)
    else process.exitCode = code ?? 1
  })
}
