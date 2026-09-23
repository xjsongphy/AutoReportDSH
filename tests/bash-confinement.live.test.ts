import { spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SandboxBashExecutor } from '@deepseek-ai/dsh-bash-sandbox'
import { LocalSandboxProvider } from '@deepseek-ai/dsh-sandbox-local'
import { bwrapProfileArgs, seatbeltProfileArgs } from '@deepseek-ai/dsh-sandbox-local/src/profiles.ts'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import * as BashEnvPlugin from '@deepseek-ai/dsh-shell-env'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as ToolBash from '@deepseek-ai/dsh-tool-bash'
import { installSandboxOverride } from '../src/policy/sandbox-override.js'
import { applyRoleSandbox, roleWritableRoot } from '../src/policy/sandbox-roots.js'
import type { AutoReportRole } from '../src/roles.js'

/**
 * Keyless live integration: real `bash` through `dsh-tool-bash`, the
 * sandbox-consuming executor (`dsh-bash-sandbox`, not the non-confining
 * `dsh-bash-local`), `SandboxPolicyService`, and AutoReport
 * `applyRoleSandbox` writable-root overrides. Session cwd stays on the
 * experiment root; writes are confined to the role directory.
 */

const testToolSignal = new AbortController().signal
let liveRoleRoots: Map<string, AutoReportRole> = new Map()
const requireFromHere = createRequire(import.meta.url)
const SANDBOX_DENIAL = /file access denied|access is denied|access to the path|permission denied|sandbox.*denied/i

/**
 * Built windows-acl runner entry, resolved through `createRequire` rather than
 * `import.meta.resolve`: the vitest SSR transform rewrites `import.meta` to a
 * shim without `resolve`, so the provider's own resolution throws on Windows.
 * @returns the runner path, or undefined when the package cannot be resolved.
 */
function windowsAclRunnerEntry(): string | undefined {
  try {
    const sandboxLocalPkg = requireFromHere.resolve('@deepseek-ai/dsh-sandbox-local/package.json')
    return createRequire(sandboxLocalPkg).resolve('@deepseek-ai/dsh-sandbox-windows-acl/runner')
  } catch {
    return undefined
  }
}

function probeWindowsAcl(): boolean {
  const runner = windowsAclRunnerEntry()
  if (runner === undefined) return false
  const workspace = mkdtempSync(join(tmpdir(), 'autoreport-acl-ws-'))
  const temp = mkdtempSync(join(tmpdir(), 'autoreport-acl-tmp-'))
  try {
    const probe = spawnSync(
      process.execPath,
      [runner, '--workspace', workspace, '--temp', temp, '--mode', 'read-only', '--', 'cmd', '/c', 'exit', '0'],
      { timeout: 10_000, stdio: 'ignore' },
    )
    return probe.status === 0
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
  if (process.platform === 'win32') {
    // Pin the built runner entry so the provider never calls
    // `import.meta.resolve`, which the vitest SSR shim does not implement.
    const runner = windowsAclRunnerEntry()
    ;(next.sandbox as LocalSandboxProvider).internals = {
      ...(runner === undefined ? {} : { windowsAclRunnerEntry: runner }),
    }
  }
  await next.plugin(SessionProjectionRegistry)
  await next.plugin(SandboxPolicyService, { mode: 'workspace-write', workspaceRoot: experimentRoot })
  // Route each registered role session to its role directory at enforcement
  // time — the same in-process wrap the host plugin installs in production.
  const roleRoots = new Map<string, AutoReportRole>()
  liveRoleRoots = roleRoots
  installSandboxOverride(
    next.get('sandboxPolicy') as Parameters<typeof installSandboxOverride>[0],
    {
      roleRootOf: session => {
        const role = roleRoots.get(String(session.id))
        if (role === undefined) return undefined
        const root = typeof session.header?.cwd === 'string' ? session.header.cwd : undefined
        if (root === undefined || root.length === 0) return undefined
        return roleWritableRoot(root, role)
      },
      probeRoot: roleWritableRoot(experimentRoot, 'MAIN'),
    },
  )
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
    version: SESSION_FORMAT_VERSION,
    isSeeded: false,
    id: sessionId,
    createdAt: Date.now(),
    cwd: experimentRoot,
  })
  applyRoleSandbox(session, role, experimentRoot)
  liveRoleRoots.set(String(sessionId), role)
  return session
}

let callCounter = 0

function callBash(harness: Context, command: string, agent: Agent) {
  // Pin navigation to session.header.cwd (experiment root). Writable-root
  // confinement comes from applyRoleSandbox via SandboxPolicyService.resolve().
  const workdir = agent.session.header.cwd
  return harness.tools.execute({
    signal: testToolSignal,
    callId: ToolCallId(`call-${++callCounter}`),
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

/**
 * Register one confinement case. On Windows the cases are expected to fail:
 * `windows-latest` resolves `bash` to the WSL stub, and creating a WSL
 * instance under the windows-acl restricted token fails with
 * `Bash/Service/CreateInstance/E_ACCESSDENIED`, so the shell the suite probes
 * never runs. Keeping them as `it.fails` (not a skip) leaves the executor
 * exercised and visible; when a real fix lands, vitest fails with "Expect
 * test to fail" and the marker is removed.
 */
function confinementTest(name: string, fn: () => void | Promise<void>, timeout?: number): void {
  if (process.platform === 'win32') it.fails(name, fn, timeout)
  else it(name, fn, timeout)
}

describe('bash role write confinement (live)', () => {
  it.skipIf(process.env.CI !== 'true')(
    'CI provides a working OS sandbox so confinement cases are not skipped',
    () => {
      expect(SANDBOX_USABLE).toBe(true)
    },
  )

  // Local machines without a usable sandbox skip the probes. CI must not: the
  // availability test above fails instead of silently skipping.
  //
  // The gate is the sandbox, not the platform. On win32 `sandboxUsable()`
  // requires BOTH a working `bash -lc` and the windows-acl runner probe, and
  // `dsh-bash-sandbox` carries no platform gate of its own: it hands the
  // resolved policy to `ctx.sandbox`, whose win32 rung is the windows-acl
  // restricted-token runner. Those probes only prove the runner can START.
  // The windows-latest image resolves `bash` to the WSL stub, and starting a
  // WSL instance under the restricted token is denied
  // (`Bash/Service/CreateInstance/E_ACCESSDENIED`), so the suite's own shell
  // never runs and the cases cannot pass yet — see `confinementTest`.
  describe.skipIf(!SANDBOX_USABLE)('role writable roots', () => {
  confinementTest('DATA_ANALYSIS writes inside Data/Processed and denies Report', async () => {
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

  confinementTest('REPORT writes inside Report', async () => {
    const experimentRoot = experimentWorkspace()
    const harness = await setupHarness(experimentRoot)
    const agent = registerAgent(harness, sessionForRole(experimentRoot, 'REPORT', 'report'))

    const allowed = await callBash(harness, 'echo ok > Report/a.txt', agent)
    expect(allowed.isError).toBe(false)
    expect(text(allowed)).not.toMatch(SANDBOX_DENIAL)
    expect(existsSync(join(experimentRoot, 'Report/a.txt'))).toBe(true)
  }, 30_000)

  confinementTest('MAIN writes inside Outline and denies Theory', async () => {
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

  confinementTest('MAIN bash can reach localhost (network allowed)', async ctx => {
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

  confinementTest('every role reads shared workspace inputs while writes stay confined', async () => {
    const experimentRoot = experimentWorkspace()
    // Inputs another role produced. A role must be able to read these without
    // being able to write them: that pair IS the declared policy, and until now
    // only the write half had a probe.
    const shared = ['Theory/theory.md', 'Data/Processed/out.csv', 'Plots/Fig/fig1.png', 'Outline/cache.txt']
    for (const relative of shared) {
      mkdirSync(dirname(join(experimentRoot, relative)), { recursive: true })
      writeFileSync(join(experimentRoot, relative), `shared:${relative}\n`)
    }

    const harness = await setupHarness(experimentRoot)
    const agent = registerAgent(harness, sessionForRole(experimentRoot, 'REPORT', 'report-read'))

    for (const relative of shared) {
      const read = await callBash(harness, `cat ${relative}`, agent)
      expect(read.isError, text(read)).toBe(false)
      expect(text(read)).not.toMatch(SANDBOX_DENIAL)
      expect(text(read)).toContain(`shared:${relative}`)
    }

    // Same session, same policy: the write half stays confined to Report/.
    const allowed = await callBash(harness, 'echo ok > Report/read-probe.txt', agent)
    expect(allowed.isError, text(allowed)).toBe(false)
    expect(text(allowed)).not.toMatch(SANDBOX_DENIAL)
    expect(existsSync(join(experimentRoot, 'Report/read-probe.txt'))).toBe(true)

    const denied = await callBash(harness, 'echo blocked > Theory/read-probe.txt', agent)
    expectsSandboxDenial(text(denied))
    expect(existsSync(join(experimentRoot, 'Theory/read-probe.txt'))).toBe(false)
  }, 30_000)
  })
})
