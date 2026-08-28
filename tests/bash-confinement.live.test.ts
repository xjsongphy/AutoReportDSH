import { spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SandboxBashExecutor } from '@deepseek-ai/dsh-bash-sandbox'
import { LocalSandboxProvider } from '@deepseek-ai/dsh-sandbox-local'
import { bwrapProfileArgs, seatbeltProfileArgs } from '@deepseek-ai/dsh-sandbox-local/src/profiles.ts'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import * as BashEnvPlugin from '@deepseek-ai/dsh-shell-env'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as ToolBash from '@deepseek-ai/dsh-tool-bash'
import { applyRoleSandbox } from '../src/policy/sandbox-roots.js'
import type { AutoReportRole } from '../src/roles.js'

/**
 * Keyless live integration: real `bash` through `dsh-tool-bash`, the
 * sandbox-consuming executor (`dsh-bash-sandbox`, not the non-confining
 * `dsh-bash-local`), `SandboxPolicyService`, and AutoReport
 * `applyRoleSandbox` writable-root overrides. Session cwd stays on the
 * experiment root; writes are confined to the role directory.
 */

const testToolSignal = new AbortController().signal
const requireFromHere = createRequire(import.meta.url)
const SANDBOX_DENIAL = /file access denied|access is denied|access to the path|permission denied|sandbox.*denied/i

function probeWindowsAcl(): boolean {
  const workspace = mkdtempSync(join(tmpdir(), 'autoreport-acl-ws-'))
  const temp = mkdtempSync(join(tmpdir(), 'autoreport-acl-tmp-'))
  try {
    const sandboxLocalPkg = requireFromHere.resolve('@deepseek-ai/dsh-sandbox-local/package.json')
    const requireSandbox = createRequire(sandboxLocalPkg)
    const runner = requireSandbox.resolve('@deepseek-ai/dsh-sandbox-windows-acl/runner')
    const probe = spawnSync(
      process.execPath,
      [runner, '--workspace', workspace, '--temp', temp, '--mode', 'read-only', '--', 'cmd', '/c', 'exit', '0'],
      { timeout: 10_000, stdio: 'ignore' },
    )
    return probe.status === 0
  } catch {
    return false
  } finally {
    rmSync(workspace, { recursive: true, force: true })
    rmSync(temp, { recursive: true, force: true })
  }
}

function sandboxUsable(): boolean {
  if (process.platform === 'win32') {
    const bash = spawnSync('bash', ['-lc', 'exit 0'], { timeout: 5_000, stdio: 'ignore' })
    return bash.status === 0 && probeWindowsAcl()
  }
  if (process.platform === 'darwin') {
    const probe = spawnSync(
      'sandbox-exec',
      [...seatbeltProfileArgs({ mode: 'read-only', workspaceRoot: '/' }), '--', 'true'],
      { timeout: 5_000, stdio: 'ignore' },
    )
    return probe.status === 0
  }
  if (process.platform === 'linux') {
    const bwrapProbe = spawnSync(
      'bwrap',
      [...bwrapProfileArgs({ mode: 'read-only', workspaceRoot: '/' }), '--', 'true'],
      { timeout: 5_000, stdio: 'ignore' },
    )
    if (bwrapProbe.status === 0) return true
    const landlockProbe = spawnSync('landlock-run', ['--probe'], { timeout: 5_000, encoding: 'utf8' })
    return landlockProbe.status === 0
  }
  return false
}

const cleanup: string[] = []
let ctx: Context | undefined
let spillDir: string | undefined

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
  spillDir = undefined
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true })
})

function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

function expectsSandboxDenial(output: string): void {
  expect(output).toMatch(SANDBOX_DENIAL)
}

async function setupHarness(experimentRoot: string): Promise<Context> {
  const next = new Context()
  await next.plugin(SystemPrompt)
  await next.plugin(ToolRuntime)
  await next.plugin(AgentRegistry)
  await next.plugin(LocalSubprocessRuntime)
  spillDir = mkdtempSync(join(tmpdir(), 'autoreport-bash-spill-'))
  cleanup.push(spillDir)
  ;(next.subprocess as LocalSubprocessRuntime).internals = { spillDir }
  await next.plugin(LocalSandboxProvider, {})
  if (process.platform === 'darwin') {
    ;(next.sandbox as LocalSandboxProvider).internals = {
      probeBwrap: () => false,
      probeLandlock: () => 'unusable',
    }
  }
  await next.plugin(SandboxPolicyService, { mode: 'workspace-write', workspaceRoot: experimentRoot })
  await next.plugin(BashEnvPlugin)
  await next.plugin(SandboxBashExecutor, { cwd: experimentRoot, timeoutMs: 30_000, graceMs: 200 })
  await next.plugin(ToolBash)
  ctx = next
  return next
}

function experimentWorkspace(): string {
  const root = mkdtempSync(join(homedir(), 'autoreport-bash-live-'))
  cleanup.push(root)
  for (const dir of ['Outline', 'Theory', 'Data/Processed', 'Plots', 'Report']) {
    mkdirSync(join(root, dir), { recursive: true })
  }
  return root
}

function registerAgent(harness: Context, session: Session): Agent {
  const scopeFiber = harness.plugin(() => {})
  const agent = {
    id: session.id,
    ctx: scopeFiber.ctx,
    inject: () => {},
    session,
  } as unknown as Agent
  harness.agents.register(agent)
  return agent
}

function sessionForRole(experimentRoot: string, role: AutoReportRole, label: string): Session {
  const sessionId = SessionId(`bash-live-${label}`)
  const session = Session.create(sessionId, undefined, {
    version: 0,
    id: sessionId,
    createdAt: Date.now(),
    cwd: experimentRoot,
  })
  applyRoleSandbox(session, role, experimentRoot)
  return session
}

let callCounter = 0

function callBash(harness: Context, command: string, agent: Agent) {
  // Pin navigation to session.header.cwd (experiment root). Writable-root
  // confinement comes from applyRoleSandbox via SandboxPolicyService.resolve().
  const workdir = agent.session.header.cwd
  return harness.tools.execute({
    signal: testToolSignal,
    callId: CallId(`call-${++callCounter}`),
    name: 'bash',
    arguments: {
      command,
      description: 'role write confinement probe',
      ...(workdir !== undefined ? { workdir } : {}),
    },
    agent,
  })
}

const SANDBOX_USABLE = sandboxUsable()
const CURL_AVAILABLE = spawnSync('curl', ['--version'], { timeout: 5_000, stdio: 'ignore' }).status === 0

describe('bash role write confinement (live)', () => {
  it.skipIf(process.env.CI !== 'true')(
    'CI provides a working OS sandbox so confinement cases are not skipped',
    () => {
      expect(SANDBOX_USABLE).toBe(true)
    },
  )

  // Local machines without a sandbox skip the probes. CI must not: the
  // availability test above fails instead of silently skipping.
  // DSH disables bash-sandbox / tool-bash on win32 (pwsh + ACL is the
  // Windows shell). Role-root bash probes run on Linux/macOS only. Windows
  // CI still asserts ACL runner availability via SANDBOX_USABLE; that is
  // not an AutoReport role-writable-root end-to-end case.
  describe.skipIf(!SANDBOX_USABLE || process.platform === 'win32')('role writable roots', () => {
  it('DATA_ANALYSIS writes inside Data/Processed and denies Report', async () => {
    const experimentRoot = experimentWorkspace()
    const harness = await setupHarness(experimentRoot)
    const agent = registerAgent(harness, sessionForRole(experimentRoot, 'DATA_ANALYSIS', 'data'))

    const allowed = await callBash(harness, 'echo ok > Data/Processed/a.txt', agent)
    expect(allowed.isError).toBe(false)
    expect(text(allowed)).not.toMatch(SANDBOX_DENIAL)
    expect(existsSync(join(experimentRoot, 'Data/Processed/a.txt'))).toBe(true)

    const denied = await callBash(harness, 'echo blocked > Report/a.txt', agent)
    expectsSandboxDenial(text(denied))
    expect(existsSync(join(experimentRoot, 'Report/a.txt'))).toBe(false)
  }, 30_000)

  it('REPORT writes inside Report', async () => {
    const experimentRoot = experimentWorkspace()
    const harness = await setupHarness(experimentRoot)
    const agent = registerAgent(harness, sessionForRole(experimentRoot, 'REPORT', 'report'))

    const allowed = await callBash(harness, 'echo ok > Report/a.txt', agent)
    expect(allowed.isError).toBe(false)
    expect(text(allowed)).not.toMatch(SANDBOX_DENIAL)
    expect(existsSync(join(experimentRoot, 'Report/a.txt'))).toBe(true)
  }, 30_000)

  it('MAIN writes inside Outline and denies Theory', async () => {
    const experimentRoot = experimentWorkspace()
    const harness = await setupHarness(experimentRoot)
    const agent = registerAgent(harness, sessionForRole(experimentRoot, 'MAIN', 'main'))

    const allowed = await callBash(harness, 'echo ok > Outline/cache.txt', agent)
    expect(allowed.isError).toBe(false)
    expect(text(allowed)).not.toMatch(SANDBOX_DENIAL)
    expect(existsSync(join(experimentRoot, 'Outline/cache.txt'))).toBe(true)

    const denied = await callBash(harness, 'echo blocked > Theory/foo.md', agent)
    expectsSandboxDenial(text(denied))
    expect(existsSync(join(experimentRoot, 'Theory/foo.md'))).toBe(false)
  }, 30_000)

  it('MAIN bash can reach localhost (network allowed)', async ctx => {
    if (!CURL_AVAILABLE) {
      ctx.skip('curl not found in PATH; skipping MAIN network probe')
      return
    }

    const experimentRoot = experimentWorkspace()
    const harness = await setupHarness(experimentRoot)
    const agent = registerAgent(harness, sessionForRole(experimentRoot, 'MAIN', 'main-network'))

    const server = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      res.end('ok')
    })

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => resolve())
    })

    const address = server.address()
    if (address === null || typeof address === 'string') {
      await new Promise<void>((resolve, reject) => server.close(err => (err ? reject(err) : resolve())))
      throw new Error('expected TCP server address')
    }

    try {
      const result = await callBash(
        harness,
        `curl -sf --max-time 5 http://127.0.0.1:${address.port}/`,
        agent,
      )
      expect(result.isError).toBe(false)
      expect(text(result)).not.toMatch(SANDBOX_DENIAL)
      expect(text(result)).toContain('ok')
    } finally {
      await new Promise<void>((resolve, reject) => server.close(err => (err ? reject(err) : resolve())))
    }
  }, 30_000)
  })
})
