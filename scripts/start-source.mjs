#!/usr/bin/env node

/** Start the user's existing DSH with the installed AutoReportDSH profile. */

import { spawn } from 'node:child_process'

const dshCommand = process.env.AUTOREPORT_DSH_COMMAND ?? 'dsh'
const child = spawn(dshCommand, ['web', ...process.argv.slice(2)], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
})

child.once('error', error => {
  console.error(`autoreportdsh: failed to start ${dshCommand}: ${String(error)}`)
  process.exitCode = 1
})
child.once('exit', (code, signal) => {
  if (signal !== null) process.kill(process.pid, signal)
  else process.exitCode = code ?? 1
})
