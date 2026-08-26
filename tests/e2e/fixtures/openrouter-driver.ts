#!/usr/bin/env node
/**
 * One-shot OpenRouter e2e driver (mirrors the deepseek-harness headless-agent
 * fixture driver): boot a real Loader composition through @deepseek-ai/dsh-app-boot,
 * drive ONE trivial turn through the real LLM adapter with runFixtureTurn,
 * print the result envelope as the last stdout line, and dispose cleanly.
 *
 * This file runs OUTSIDE this package's vitest pipeline (spawned as a child
 * process by ../openrouter.e2e.test.ts) so its harness-only imports resolve
 * through TSX_TSCONFIG_PATH instead of this package's dependencies.
 *
 * argv: <config-path> <task...>
 */

import { boot, resolveConfigPath } from '@deepseek-ai/dsh-app-boot'
import { runFixtureTurn } from '@deepseek-ai/dsh-loader-smoke'

const NAME = 'autoreportdsh-openrouter-e2e'
const [configPath, ...taskParts] = process.argv.slice(2)
if (configPath === undefined || taskParts.length === 0 || taskParts.every(part => part.trim() === '')) {
  throw new Error(`${NAME}: expected <config-path> <task...>`)
}

let ctx: Awaited<ReturnType<typeof boot>> | undefined
try {
  ctx = await boot(NAME, resolveConfigPath(configPath, undefined))
  const events: string[] = []
  const result = await runFixtureTurn(ctx, {
    task: taskParts.join(' '),
    onEvent: (_sessionId, event) => {
      if (event.type === 'llm/retry') {
        // Test diagnostics only: retry failure fields are already sanitized by
        // DSH before they enter the durable session log.
        events.push(`llm/retry:${event.data.failure.code}:${event.data.failure.message}`)
        return
      }
      if (event.type === 'assistant/chunk' && event.data.chunk.type === 'error') {
        events.push(`assistant/error:${event.data.chunk.error.message}`)
        return
      }
      events.push(event.type)
    },
  })
  process.stdout.write(`${JSON.stringify({ ...result, events })}\n`)
} catch (error: unknown) {
  process.stderr.write(`${NAME}: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
} finally {
  await ctx?.fiber.dispose()
}
