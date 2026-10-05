/** Materialize shared dist once, before parallel installer/boot tests start. */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../..')
const entries = ['src/index.js', 'src/tools/report-router.js', 'client.js']

export default function setup(): void {
  if (entries.every(entry => existsSync(resolve(root, 'dist', entry)))) return
  const build = spawnSync('pnpm', ['run', 'build'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 180_000,
    // Windows exposes pnpm.cmd; the command and its arguments are fixed.
    shell: process.platform === 'win32',
  })
  if (build.error !== undefined || build.status !== 0) {
    throw new Error(`AutoReport test build failed: ${build.error?.message ?? build.stderr?.slice(-2_000) ?? build.status}`)
  }
  if (!entries.every(entry => existsSync(resolve(root, 'dist', entry)))) {
    throw new Error('AutoReport test build did not produce all required dist entries')
  }
}
