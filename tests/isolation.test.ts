import { existsSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildDarwinSeatbeltCommand,
  buildLinuxBwrapCommand,
  buildSeatbeltProfile,
  createPlatformIsolationBackend,
  IsolationUnavailableError,
  type IsolationRequest,
} from '../src/policy/isolation/index.js'

const cleanup: string[] = []
afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true })
})

function request(): IsolationRequest {
  const root = mkdtempSync(join(tmpdir(), 'autoreport-isolation-'))
  cleanup.push(root)
  const writable = join(root, 'Theory')
  const temp = join(root, 'private-temp')
  mkdirSync(writable)
  mkdirSync(temp)
  return {
    argv: ['/usr/bin/true'],
    cwd: writable,
    readableRoots: [root],
    writableRoots: [writable],
    tempRoot: temp,
  }
}

describe('report isolation builders', () => {
  it('builds the established DSH bwrap file profile plus network isolation', () => {
    const input = request()
    const command = buildLinuxBwrapCommand(input, '/usr/bin/bwrap')
    expect(command.argv.slice(0, 3)).toEqual(['/usr/bin/bwrap', '--ro-bind', '/'])
    expect(command.argv).toContain('--unshare-net')
    expect(command.argv).toContain('--unshare-pid')
    expect(command.argv).toContain('--die-with-parent')
    expect(command.argv).toContain('--tmpfs')
    expect(command.argv).toContain(input.tempRoot)
    expect(command.argv).toContain(input.writableRoots[0])
    expect(command.argv.slice(-2)).toEqual(['--', '/usr/bin/true'])
    expect(command.env['TMPDIR']).toBe(input.tempRoot)
  })

  it('builds a Seatbelt profile with narrow writes and mandatory network denial', () => {
    const input = request()
    const profile = buildSeatbeltProfile(input)
    expect(profile).toContain('(deny network*)')
    expect(profile).toContain('(deny file-write*)')
    expect(profile).toContain(input.writableRoots[0])
    expect(profile).toContain(input.tempRoot)
    const command = buildDarwinSeatbeltCommand(input)
    expect(command.argv[0]).toBe('/usr/bin/sandbox-exec')
    expect(command.argv).toContain(profile)
    expect(command.argv.slice(-2)).toEqual(['--', '/usr/bin/true'])
  })

  it('fails closed for an unsupported platform and missing runner', async () => {
    const unsupported = createPlatformIsolationBackend(async () => '/runner', 'win32')
    await expect(unsupported.wrap(request())).rejects.toBeInstanceOf(IsolationUnavailableError)
    const missing = createPlatformIsolationBackend(async () => { throw new Error('ENOENT') }, 'linux')
    await expect(missing.wrap(request())).rejects.toThrow(/bubblewrap is missing/u)
  })
})

const currentBackendAvailable = process.platform === 'darwin'
  ? existsSync('/usr/bin/sandbox-exec')
  : process.platform === 'linux' && process.env['PATH']?.split(':').some(dir => existsSync(resolve(dir, 'bwrap'))) === true

it.skipIf(!currentBackendAvailable)('denies a deterministic localhost TCP connection in the live platform sandbox', async () => {
  const input = request()
  const server = createServer(socket => socket.end())
  await new Promise<void>((accept, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', accept)
  })
  try {
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('test server has no TCP port')
    const script = `
      const net = require('node:net');
      const socket = net.connect(${address.port}, '127.0.0.1');
      socket.on('connect', () => process.exit(2));
      socket.on('error', () => process.exit(0));
      setTimeout(() => process.exit(0), 2000);
    `
    const liveRequest = { ...input, argv: [process.execPath, '-e', script] }
    const command = process.platform === 'darwin'
      ? buildDarwinSeatbeltCommand(liveRequest)
      : buildLinuxBwrapCommand(liveRequest)
    const code = await new Promise<number | null>((accept, reject) => {
      const child = spawn(command.argv[0]!, command.argv.slice(1), {
        cwd: input.cwd,
        env: { ...process.env, ...command.env },
        stdio: 'ignore',
      })
      child.once('error', reject)
      child.once('exit', accept)
    })
    expect(code).toBe(0)
  } finally {
    await new Promise<void>(accept => server.close(() => accept()))
  }
})
