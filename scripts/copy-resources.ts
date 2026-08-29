/** Copy runtime assets into dist/ after TypeScript compilation. */

import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const source = resolve(root, 'resources')
const target = resolve(root, 'dist/resources')

if (!existsSync(source)) throw new Error(`autoreportdsh: bundled resources missing at ${source}`)
mkdirSync(dirname(target), { recursive: true })
rmSync(target, { recursive: true, force: true })
cpSync(source, target, { recursive: true })
