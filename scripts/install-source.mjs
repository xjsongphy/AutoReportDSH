#!/usr/bin/env node

/**
 * Install the current AutoReportDSH checkout into the user's existing DSH.
 *
 * This installer never clones, checks out, patches, or builds DSH. It only
 * builds this plugin, installs its preset, and registers it in the user's
 * normal `web` profile.
 */

import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline/promises'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dshCommand = process.env.AUTOREPORT_DSH_COMMAND ?? 'dsh'
const profile = 'web'
const packageName = 'autoreportdsh'
const force = process.argv.includes('--yes') || process.argv.includes('-y') || process.argv.includes('--force')
const help = process.argv.includes('--help') || process.argv.includes('-h')
const interactive = process.stdin.isTTY === true && process.stdout.isTTY === true
const useColor = interactive && process.env.NO_COLOR === undefined
const STATUS_INDENT = '  '
const DETAIL_INDENT = '    '
const BOX_WIDTH = 54
const BOX_CONTENT_WIDTH = BOX_WIDTH - 4

const color = {
  reset: useColor ? '\x1b[0m' : '',
  bold: useColor ? '\x1b[1m' : '',
  dim: useColor ? '\x1b[2m' : '',
  cyan: useColor ? '\x1b[36m' : '',
  green: useColor ? '\x1b[32m' : '',
  yellow: useColor ? '\x1b[33m' : '',
  red: useColor ? '\x1b[31m' : '',
}

function paint(name, value) {
  return `${color[name]}${value}${color.reset}`
}

function duration(startedAt) {
  return `${((Date.now() - startedAt) / 1000).toFixed(1)}s`
}

function boxTop(title, colorName) {
  const prefix = `─ ${title} `
  return paint(colorName, `╭${prefix}${'─'.repeat(Math.max(0, BOX_WIDTH - 2 - prefix.length))}╮`)
}

function boxBody(parts) {
  let remaining = BOX_CONTENT_WIDTH
  const rendered = []
  for (const part of parts) {
    if (remaining <= 0) break
    const text = part.text.slice(0, remaining)
    rendered.push(part.color === undefined ? text : paint(part.color, text))
    remaining -= text.length
  }
  return `│ ${rendered.join('')}${' '.repeat(Math.max(0, remaining))} │`
}

function boxBottom(colorName) {
  return paint(colorName, `╰${'─'.repeat(BOX_WIDTH - 2)}╯`)
}

function printField(label, value) {
  console.log(`${DETAIL_INDENT}${paint('cyan', `${label}:`)} ${value}`)
}

function commandResult(bin, args, cwd) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(bin, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += String(chunk) })
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    child.once('error', reject)
    child.once('exit', (code, signal) => resolvePromise({
      code: code ?? 1,
      signal,
      stdout,
      stderr,
    }))
  })
}

function formatFailure(bin, args, result) {
  const output = `${result.stdout}${result.stderr}`.trim()
  const reason = result.signal === null ? `exit code ${result.code}` : `signal ${result.signal}`
  return new Error(`${bin} ${args.join(' ')} failed (${reason})${output.length > 0 ? `\n\n${output}` : ''}`)
}

async function step(label, bin, args, cwd) {
  const startedAt = Date.now()
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
  let frame = 0
  let spinner
  if (interactive) {
    process.stdout.write(`${STATUS_INDENT}${paint('cyan', frames[frame])} ${label}`)
    spinner = setInterval(() => {
      frame = (frame + 1) % frames.length
      process.stdout.write(`\r\x1b[2K${STATUS_INDENT}${paint('cyan', frames[frame])} ${label}`)
    }, 100)
  }
  let result
  try {
    result = await commandResult(bin, args, cwd)
  } catch (error) {
    if (spinner !== undefined) clearInterval(spinner)
    if (interactive) process.stdout.write('\r\x1b[2K')
    throw error
  }
  if (spinner !== undefined) clearInterval(spinner)
  if (result.code !== 0) {
    if (interactive) process.stdout.write('\r\x1b[2K')
    throw formatFailure(bin, args, result)
  }
  const line = `${STATUS_INDENT}${paint('green', '✓')} ${label} ${paint('dim', `(${duration(startedAt)})`)}\n`
  process.stdout.write(interactive ? `\r\x1b[2K${line}` : line)
  return result
}

function printHeader() {
  console.log('')
  console.log(boxTop('AutoReportDSH installer', 'bold'))
  console.log(boxBody([
    { text: 'Install into the existing DSH ' },
    { text: `${dshCommand} · ${profile} profile`, color: 'cyan' },
  ]))
  console.log(boxBottom('bold'))
  console.log('')
}

function parseJsonArray(stdout) {
  const start = stdout.indexOf('[')
  const end = stdout.lastIndexOf(']')
  if (start < 0 || end < start) return []
  try {
    const value = JSON.parse(stdout.slice(start, end + 1))
    return Array.isArray(value) ? value : []
  } catch {
    return []
  }
}

function installedPackage(list) {
  for (const profileInfo of list) {
    for (const field of ['dependencies', 'devDependencies', 'unsavedDependencies']) {
      const value = profileInfo?.[field]?.[packageName]
      if (value !== undefined) {
        return {
          version: typeof value === 'object' ? value.version ?? value.from : value,
          path: profileInfo.path,
        }
      }
    }
  }
  return undefined
}

async function confirmOverwrite(existing) {
  console.log(`${STATUS_INDENT}${paint('yellow', '⚠')} ${paint('bold', 'AutoReportDSH is already installed')}`)
  printField('Profile', profile)
  printField('Current', existing.version ?? 'unknown version')
  if (existing.path !== undefined) printField('Location', existing.path)
  console.log('')
  if (force) {
    console.log(`${DETAIL_INDENT}${paint('dim', 'Continuing because --yes was provided.')}`)
    return true
  }
  if (!interactive) {
    throw new Error(`already installed in the ${profile} profile; rerun with --yes to overwrite it`)
  }
  const readline = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = await readline.question(`${DETAIL_INDENT}Overwrite this installation? [y/N] `)
    return /^(?:y|yes)$/iu.test(answer.trim())
  } finally {
    readline.close()
  }
}

async function detectDsh() {
  const result = await commandResult(dshCommand, ['--version'], repoRoot)
  if (result.code !== 0) {
    throw new Error(`could not run ${dshCommand}; install DSH first or set AUTOREPORT_DSH_COMMAND`)
  }
  return result.stdout.trim().split(/\r?\n/u).at(-1) ?? 'unknown version'
}

async function detectExistingPlugin() {
  const args = ['plugin', '--profile', profile, 'list', '--depth', '0', '--json']
  const result = await commandResult(dshCommand, args, repoRoot)
  if (result.code !== 0) throw formatFailure(dshCommand, args, result)
  return installedPackage(parseJsonArray(result.stdout))
}

async function installPlugin() {
  await step('Install plugin dependencies', 'pnpm', ['install', '--frozen-lockfile'], repoRoot)
  await step('Build AutoReportDSH', 'pnpm', ['run', 'build'], repoRoot)
  await step('Install the autoreport preset', 'pnpm', ['run', 'install:preset'], repoRoot)
  await step('Register plugin in the DSH web profile', dshCommand, ['plugin', '--profile', profile, 'add', repoRoot], repoRoot)
}

try {
  if (help) {
    console.log('Usage: pnpm run install:source [--yes]')
    console.log('Install or upgrade AutoReportDSH in the existing DSH web profile.')
    console.log('The installer never clones or modifies DSH.')
    process.exit(0)
  }
  if (!existsSync(repoRoot)) throw new Error(`plugin checkout not found: ${repoRoot}`)
  printHeader()
  const version = await detectDsh()
  console.log(`${STATUS_INDENT}${paint('green', '✓')} Found DSH ${paint('bold', version)}`)
  const existing = await detectExistingPlugin()
  if (existing !== undefined && !(await confirmOverwrite(existing))) {
    console.log(`\n${STATUS_INDENT}${paint('yellow', '⚠')} ${paint('bold', 'Installation cancelled.')} Existing installation was left unchanged.`)
    process.exit(0)
  }
  console.log('')
  await installPlugin()
  console.log('')
  console.log(boxTop('AutoReportDSH installed', 'green'))
  console.log(boxBody([
    { text: 'DSH: ', color: 'cyan' },
    { text: version },
    { text: '    profile: ', color: 'cyan' },
    { text: profile },
  ]))
  console.log(boxBody([
    { text: 'Start: ', color: 'cyan' },
    { text: `${dshCommand} web` },
  ]))
  console.log(boxBody([
    { text: 'Web UI: ', color: 'cyan' },
    { text: 'http://127.0.0.1:3080' },
  ]))
  console.log(boxBottom('green'))
} catch (error) {
  console.error(`\n${STATUS_INDENT}${paint('red', '✗')} ${paint('bold', 'Installation failed')}`)
  const details = String(error instanceof Error ? error.message : error)
  console.error(details.split('\n').map(line => `${DETAIL_INDENT}${line}`).join('\n'))
  process.exitCode = 1
}
