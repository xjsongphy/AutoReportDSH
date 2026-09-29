import { describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { createGrepTool, type GrepOutput, type SearchFileSystem } from '../src/tools/grep.js'

function fakeWorkspaceFs(files: Readonly<Record<string, string>>): SearchFileSystem & { readonly streamed: string[] } {
  const root = '/grep-workspace'
  const nodes = new Map<string, { type: string; content?: string }>([[root, { type: 'directory' }]])
  const ensureDirectory = (path: string): void => {
    const parent = resolve(path, '..')
    if (parent !== path && !nodes.has(parent)) ensureDirectory(parent)
    if (!nodes.has(path)) nodes.set(path, { type: 'directory' })
  }
  for (const [path, content] of Object.entries(files)) {
    const absolute = resolve(root, path)
    ensureDirectory(resolve(absolute, '..'))
    nodes.set(absolute, { type: 'file', content })
  }
  const streamed: string[] = []
  const contains = (parent: string, child: string): boolean => {
    const path = relative(parent, child)
    return path === '' || (path !== '..' && !path.startsWith('..' + sep) && !isAbsolute(path))
  }
  const fs: SearchFileSystem & { readonly streamed: string[] } = {
    streamed,
    async resolve(path, opts) {
      return { displayPath: resolve(opts?.cwd ?? root, path) }
    },
    contains(parent, child) {
      return contains(parent.displayPath, child.displayPath)
    },
    async stat(target) {
      const node = nodes.get(target.displayPath)
      return node === undefined
        ? undefined
        : { type: node.type, ...(node.content === undefined ? {} : { size: Buffer.byteLength(node.content) }) }
    },
    async lstat(path, opts) {
      const node = nodes.get(resolve(opts?.cwd ?? root, path))
      return node === undefined ? undefined : { type: node.type }
    },
    async listDir(target) {
      const prefix = target.displayPath.endsWith(sep) ? target.displayPath : target.displayPath + sep
      return [...nodes.entries()]
        .filter(([path]) => path.startsWith(prefix) && !path.slice(prefix.length).includes(sep))
        .map(([path, node]) => ({
          name: path.slice(prefix.length),
          type: node.type,
          target: { displayPath: path },
        }))
    },
    async streamText(target) {
      streamed.push(target.displayPath)
      const content = nodes.get(target.displayPath)?.content ?? ''
      return (async function* () {
        for (let index = 0; index < content.length; index += 5) yield content.slice(index, index + 5)
      })()
    },
  }
  return fs
}

describe('AutoReport provider-backed grep', () => {
  it('searches the whole workspace from the workspace root — read scope is not a role boundary', async () => {
    const fs = fakeWorkspaceFs({
      'References/handout.md': 'fit theory follows',
      'Outline/report_outline.md': 'fit coverage',
      'Theory/formulas.md': 'fit formula',
      'Data/Processed/result.csv': 'fit,uncertainty\n1,0.1\n',
      'Data/Raw/source.csv': 'fit raw secret\n',
      'Plots/Fig/plot.md': 'fit figure',
      'Report/main.tex': 'fit report',
    })
    const owner = { id: 'main' } as Agent
    const tool = createGrepTool('/grep-workspace', owner, fs)
    const result = await tool.execute({ pattern: 'fit' }, {
      agent: owner,
      signal: new AbortController().signal,
    } as never) as unknown as GrepOutput

    expect(result.matches.map(match => match.path)).toEqual([
      'Data/Processed/result.csv',
      'Data/Raw/source.csv',
      'Outline/report_outline.md',
      'Plots/Fig/plot.md',
      'References/handout.md',
      'Report/main.tex',
      'Theory/formulas.md',
    ])
  })

  it('honors include globs and direct paths anywhere in the workspace', async () => {
    const fs = fakeWorkspaceFs({
      'Data/Processed/result.csv': 'Fit,uncertainty\n',
      'Data/Raw/source.csv': 'Fit raw value\n',
      'Report/main.tex': 'fit report\n',
    })
    const owner = { id: 'main' } as Agent
    const tool = createGrepTool('/grep-workspace', owner, fs)

    const raw = await tool.execute({ pattern: 'fit', path: 'Data/Raw' }, {
      agent: owner,
      signal: new AbortController().signal,
    } as never) as unknown as GrepOutput
    expect(raw.matches.map(match => match.path)).toEqual(['Data/Raw/source.csv'])

    const csv = await tool.execute({ pattern: 'fit', include: '**/*.csv' }, {
      agent: owner,
      signal: new AbortController().signal,
    } as never) as unknown as GrepOutput
    expect(csv.matches.map(match => match.path)).toEqual(['Data/Processed/result.csv', 'Data/Raw/source.csv'])
  })

  it('returns bounded-search metadata and rejects access when no DSH fs provider exists', async () => {
    const owner = { id: 'main' } as Agent
    const tool = createGrepTool('/grep-workspace', owner)
    await expect(tool.execute({ pattern: 'fit' }, {
      agent: owner,
      signal: new AbortController().signal,
    } as never)).rejects.toThrow(/DSH filesystem provider/u)
  })
})
