#!/usr/bin/env node

/**
 * Cross-platform source installer for AutoReportDSH.
 *
 * It prepares the pinned DSH checkout, applies only the two temporary
 * compatibility patches, builds both repositories, installs the AutoReport
 * preset, and adds the package to DSH's normal `web` profile. The final
 * launch therefore uses the ordinary DSH Web entry point (default port 3080)
 * and does not need a hand-written `--patch` flag.
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname, resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const parentDir = resolve(repoRoot, '..')
const harnessDir = resolve(process.env.AUTOREPORT_DSH_DIR ?? join(parentDir, 'deepseek-harness'))
const dshRef = readFileSync(join(repoRoot, '.github', 'workflows', 'ci.yml'), 'utf8')
  .match(/\n\s*DSH_REF:\s*'([^']+)'/)?.[1]

if (dshRef === undefined) throw new Error('autoreportdsh: could not read DSH_REF from .github/workflows/ci.yml')

const patches = [
  'patches/deepseek-harness-ignorable-append.patch',
  'patches/deepseek-harness-sandbox-workspace-root.patch',
]

function command(bin, args, cwd, extra = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(bin, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32', ...extra })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) resolvePromise()
      else reject(new Error(`autoreportdsh: ${bin} ${args.join(' ')} failed (${signal ?? code})`))
    })
  })
}

async function commandResult(bin, args, cwd) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(bin, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += String(chunk) })
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    child.once('error', reject)
    child.once('exit', (code, signal) => resolvePromise({ code: code ?? 1, signal, stdout, stderr }))
  })
}

async function ensureHarness() {
  if (!existsSync(join(harnessDir, '.git'))) {
    await mkdir(dirname(harnessDir), { recursive: true })
    await command('git', ['clone', 'https://github.com/deepseek-ai/deepseek-harness.git', harnessDir], parentDir)
  }
  if (!statSync(harnessDir).isDirectory()) throw new Error(`autoreportdsh: DSH path is not a directory: ${harnessDir}`)
  const head = await commandResult('git', ['rev-parse', 'HEAD'], harnessDir)
  const clean = await commandResult('git', ['status', '--porcelain'], harnessDir)
  if (head.code !== 0 || clean.code !== 0) throw new Error(`autoreportdsh: cannot inspect DSH checkout at ${harnessDir}`)
  if (clean.stdout.trim() !== '') {
    if (head.stdout.trim() !== dshRef) {
      throw new Error(`autoreportdsh: DSH checkout is dirty; commit or stash changes before installing: ${harnessDir}`)
    }
    for (const patch of patches) {
      const patchPath = resolve(repoRoot, patch)
      const reverse = await commandResult('git', ['apply', '--ignore-whitespace', '--reverse', '--check', patchPath], harnessDir)
      if (reverse.code !== 0) {
        throw new Error(`autoreportdsh: DSH checkout contains unrecognized changes; commit or stash them before installing: ${harnessDir}`)
      }
    }
  } else {
    await command('git', ['checkout', '--detach', dshRef], harnessDir)
  }
  for (const patch of patches) {
    const patchPath = resolve(repoRoot, patch)
    const check = await commandResult('git', ['apply', '--ignore-whitespace', '--check', patchPath], harnessDir)
    if (check.code === 0) {
      await command('git', ['apply', '--ignore-whitespace', patchPath], harnessDir)
      continue
    }
    const reverse = await commandResult('git', ['apply', '--ignore-whitespace', '--reverse', '--check', patchPath], harnessDir)
    if (reverse.code !== 0) {
      throw new Error(`autoreportdsh: compatibility patch does not apply cleanly: ${patchPath}\n${check.stderr}`)
    }
    console.log(`autoreportdsh: compatibility patch already applied: ${patch}`)
  }
  await command('corepack', ['enable'], harnessDir)
  await command('pnpm', ['install', '--frozen-lockfile'], harnessDir)
  await command('pnpm', ['run', 'build'], harnessDir)
}

async function installPlugin() {
  await command('pnpm', ['install', '--frozen-lockfile'], repoRoot)
  await command('pnpm', ['run', 'build'], repoRoot)
  await command('pnpm', ['run', 'install:preset'], repoRoot)
  await command('pnpm', ['dsh', 'plugin', '--profile', 'web', 'add', repoRoot], harnessDir)
}

try {
  console.log(`autoreportdsh: using DSH ${dshRef}`)
  await ensureHarness()
  await installPlugin()
  console.log('')
  console.log('AutoReportDSH is installed in the DSH web profile.')
  console.log(`Start it with: cd ${harnessDir} && pnpm dsh web`)
  console.log('The Web UI uses the normal http://127.0.0.1:3080 address unless you choose another port.')
} catch (error) {
  console.error(String(error instanceof Error ? error.message : error))
  process.exitCode = 1
}
