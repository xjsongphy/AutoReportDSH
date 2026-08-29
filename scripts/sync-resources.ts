/**
 * CLI: incrementally sync managed remotes into `$DSH_HOME/autoreport/resources`.
 * Runtime plugin apply performs the same refresh; this script is for an
 * explicit refresh without booting DSH.
 */

import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { syncManagedResources, syncedResourcesRoot } from '../src/workspace/resource-sync.js'

async function main(): Promise<void> {
  const overlayRoot = syncedResourcesRoot(resolveDshHome())
  const outcomes = await syncManagedResources({ overlayRoot })
  let failed = 0
  for (const outcome of outcomes) {
    const extra = outcome.detail === undefined ? '' : ` — ${outcome.detail}`
    console.log(`${outcome.status}: ${outcome.destination} (${outcome.blob || '—'})${extra}`)
    if (outcome.status === 'failed') failed += 1
  }
  console.log(`overlay: ${overlayRoot}`)
  if (failed > 0) process.exitCode = 1
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
