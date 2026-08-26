/**
 * Real-API milestone e2e (PLAN.md §3): boots a real headless Loader
 * composition carrying the AutoReportDSH overlay rows (host + report router)
 * and an OpenRouter provider route, sends ONE trivial prompt to MAIN through
 * the real LLM adapter, and asserts only that A response happened — the
 * session transcript exists with assistant output. Model text is never
 * treated as evidence beyond its existence.
 *
 * Layered skips keep every keyless environment green:
 * 1. OPENROUTER_API_KEY unset            -> skip (the primary contract);
 * 2. harness checkout / tsconfig / tsx   -> skip with reason;
 * 3. built dist missing                  -> one bounded build attempt, else skip.
 *
 * The runtime itself is bounded (<120s wall clock incl. cleanup) and cleans
 * its temporary home. Credentials are read from the environment only and are
 * never written to disk by this test.
 * @module tests/e2e/openrouter.e2e
 */

import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = join(import.meta.dirname, '..', '..')
const HOST_ENTRY = join(REPO_ROOT, 'dist', 'src', 'host.js')
const ROUTER_ENTRY = join(REPO_ROOT, 'dist', 'src', 'tools', 'report-router.js')
const DRIVER = join(import.meta.dirname, 'fixtures', 'openrouter-driver.ts')

const TEST_TIMEOUT_MS = 115_000
const PROCESS_TIMEOUT_MS = 100_000

/** Locate the deepseek-harness checkout through our linked dependencies. */
function findHarnessRoot(): string | undefined {
  try {
    let dir = realpathSync(join(REPO_ROOT, 'node_modules', '@deepseek-ai', 'dsh-session'))
    while (dir !== '/' && dirnameOf(dir) !== dir) {
      if (existsSync(join(dir, 'tsconfig.json')) && existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir
      dir = dirnameOf(dir)
    }
    return undefined
  } catch {
    return undefined
  }
}

function dirnameOf(path: string): string {
  const normalized = path.replaceAll('\\', '/')
  const cut = normalized.lastIndexOf('/')
  return cut <= 0 ? '/' : normalized.slice(0, cut)
}

/** One bounded `pnpm run build` when dist entries are missing. */
function ensureBuilt(): string | undefined {
  if (existsSync(HOST_ENTRY) && existsSync(ROUTER_ENTRY)) return undefined
  const build = spawnSync('pnpm', ['run', 'build'], {
    cwd: REPO_ROOT, encoding: 'utf8', timeout: 180_000,
    env: { ...process.env, CI: process.env['CI'] ?? 'true' },
  })
  if (!existsSync(HOST_ENTRY) || !existsSync(ROUTER_ENTRY)) {
    return `skipping: built dist unavailable (build status ${String(build.status)})`
  }
  return undefined
}

/** Resolve every environmental precondition; returns the first skip reason. */
function skipReason(): string | undefined {
  if ((process.env['OPENROUTER_API_KEY'] ?? '').trim() === '') {
    return 'OPENROUTER_API_KEY is not set'
  }
  const harnessRoot = findHarnessRoot()
  if (harnessRoot === undefined) return 'deepseek-harness checkout not resolvable through linked dependencies'
  if (!existsSync(join(harnessRoot, 'tsconfig.base.json'))) return 'harness tsconfig.base.json missing'
  try {
    createRequire(join(REPO_ROOT, 'package.json')).resolve('tsx/package.json')
  } catch {
    return 'tsx is not resolvable for the driver subprocess'
  }
  return ensureBuilt()
}

const reason = skipReason()
if (reason !== undefined) console.warn(`openrouter e2e ${reason}`)

describe.skipIf(reason !== undefined)('integration: OpenRouter headless boot (real API)', () => {
  it('boots the overlay + provider route, gets one assistant response, and persists a transcript', async () => {
    expect(reason).toBeUndefined()
    const harnessRoot = findHarnessRoot()!
    const apiKey = process.env['OPENROUTER_API_KEY']!

    const runDir = mkdtempSync(join(tmpdir(), 'autoreport-openrouter-'))
    const workspaceDir = join(runDir, 'workspace')
    const sessionsDir = join(runDir, '.sessions')
    try {
      writeFileSync(workspaceDir + '.placeholder', '') // workspace created below via spine cwd
      rmSync(workspaceDir + '.placeholder')
      // The experiment workspace MAIN starts in; empty is fine for a trivial turn.
      const { mkdirSync } = await import('node:fs')
      mkdirSync(workspaceDir, { recursive: true })

      // The generated composition mirrors cordis.overlay.generated.yml rows
      // (host entry + report router, stock tool-subagent-report disabled by
      // absence in this minimal composition) plus the OpenRouter provider
      // route and one MAIN agent pinned to it.
      const config = [
        `- id: subprocess\n  name: '@deepseek-ai/dsh-subprocess-local'`,
        `- id: llm\n  name: '@deepseek-ai/dsh-llm-pi-ai'\n  config:\n    providers:\n      openrouter:\n        apiKeyEnv: OPENROUTER_API_KEY\n        api: anthropic-messages\n        baseURL: https://openrouter.ai/api\n        models:\n          - id: 'stealth/ox-alpha'\n            name: Ox Alpha\n            contextWindow: 262144\n            maxTokens: 8192`,
        `- id: persistence\n  name: '@deepseek-ai/dsh-session-persistence-jsonl'\n  config:\n    root: '${sessionsDir}'\n    compression: 'none'`,
        `- id: subagents\n  name: '@deepseek-ai/dsh-subagent'`,
        `- id: autoreportdsh-host\n  name: '${HOST_ENTRY}'`,
        `- id: autoreportdsh-report-router\n  name: '${ROUTER_ENTRY}'`,
        `- id: agent-spine\n  name: '@deepseek-ai/dsh-agent-spine-demo'\n  config:\n    agents:\n      - id: main\n        provider: openrouter\n        model: 'stealth/ox-alpha'\n        cwd: '${workspaceDir}'\n    persona: 'You are MAIN of an AutoReport physics-report workflow. Answer briefly.'\n    workspaceContext: false`,
      ].join('\n')
      const configFile = join(runDir, 'openrouter.cordis.yml')
      writeFileSync(configFile, config)

      const run = spawnSync(process.execPath, [
        '--import', createRequire(join(REPO_ROOT, 'package.json')).resolve('tsx'),
        DRIVER,
        configFile,
        'Reply with exactly: ACK',
      ], {
        encoding: 'utf8',
        timeout: PROCESS_TIMEOUT_MS,
        killSignal: 'SIGKILL',
        env: {
          ...process.env,
          OPENROUTER_API_KEY: apiKey,
          DSH_HOME: join(runDir, '.dsh'),
          DSH_AGENTS_HOME: join(runDir, '.agents'),
          TSX_TSCONFIG_PATH: join(harnessRoot, 'tsconfig.json'),
        },
      })

      // Diagnostics first: any non-zero exit fails WITH both streams attached.
      if (run.status !== 0 || run.error !== undefined) {
        throw new Error(`driver exited ${String(run.status)} (${String(run.error)}).\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`)
      }

      // Exactly ONE response happened: parse the trailing result envelope and
      // require a non-empty assistant output — content itself stays unasserted.
      const resultLine = run.stdout.trimEnd().split('\n').at(-1) ?? ''
      const envelope = JSON.parse(resultLine) as { type?: string; output?: string; sessionId?: string }
      expect(envelope.type).toBe('result')
      expect(typeof envelope.output).toBe('string')
      expect(envelope.output!.length).toBeGreaterThan(0)

      // The durable transcript exists and records assistant output.
      const logs = readdirSync(sessionsDir).filter(name => name.endsWith('.jsonl'))
      expect(logs.length).toBeGreaterThanOrEqual(1)
      const transcript = readFileSync(join(sessionsDir, logs[0]!), 'utf8')
      expect(transcript).toContain('"assistant/message"')

      // Coexistence gate: this session never selected the autoreport-main
      // preset, so the loaded AutoReport overlay must have left it entirely
      // stock — no workflow initialization, no role bindings, no artifacts.
      expect(transcript).not.toContain('"autoreport/')
    } finally {
      rmSync(runDir, { recursive: true, force: true })
    }
  }, TEST_TIMEOUT_MS)
})
