/**
 * Cwd-sensitive skill provider for experiment `References/skills/`.
 *
 * Discovers DSH-shaped flat markdown and directory bundles under the current
 * workspace's References tree so experiment-local skills remain available to
 * AutoReport without importing project or user agent roots into its catalog.
 * @module autoreportdsh-skills-references
 */

import { lstat, readdir, readFile, realpath } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {
  SkillCandidate,
  SkillDefinition,
  SkillLookupOptions,
  SkillProvider,
} from '@deepseek-ai/dsh-skill'
import { parseBundledSkill } from './workspace/skill-loader.js'

export const REFERENCES_SKILL_PROVIDER = 'autoreport-references'
/** Project-local reference skills sit above custom roots and below runtime registrations. */
export const REFERENCES_SKILL_RANK = 280

const DEFAULT_INVOCATION = { modelInvocable: true, userInvocable: true } as const

interface SkillLocator {
  readonly path: string
  readonly directory: string
}

function referencesSkillRoot(cwd: string): string {
  return join(resolve(cwd), 'References', 'skills')
}

function isContained(root: string, target: string): boolean {
  const rel = relative(root, resolve(target))
  return rel !== '..' && !rel.startsWith('..')
}

async function resolveContainedEntry(root: string, name: string): Promise<{ path: string; kind: 'file' | 'directory' } | undefined> {
  if (name.startsWith('.')) return undefined
  const entryPath = join(root, name)
  let info
  try {
    info = await lstat(entryPath)
  } catch {
    return undefined
  }
  const resolved = info.isSymbolicLink() ? await realpath(entryPath) : resolve(entryPath)
  if (!isContained(root, resolved)) return undefined
  let resolvedInfo = info
  if (info.isSymbolicLink()) {
    try {
      resolvedInfo = await lstat(resolved)
    } catch {
      return undefined
    }
  }
  if (resolvedInfo.isDirectory()) return { path: resolved, kind: 'directory' }
  if (resolvedInfo.isFile()) return { path: resolved, kind: 'file' }
  return undefined
}

async function readParsedSkill(path: string): Promise<ReturnType<typeof parseBundledSkill>> {
  try {
    return parseBundledSkill(await readFile(path, 'utf8'))
  } catch {
    return undefined
  }
}

async function discoverReferencesSkills(cwd: string | undefined): Promise<SkillCandidate[]> {
  if (cwd === undefined || cwd.length === 0) return []
  const root = referencesSkillRoot(cwd)
  let names: string[]
  try {
    names = await readdir(root)
  } catch {
    return []
  }

  const candidates: SkillCandidate[] = []
  for (const name of names.sort()) {
    const entry = await resolveContainedEntry(root, name)
    if (entry === undefined) continue
    if (entry.kind === 'file' && !name.endsWith('.md')) continue
    const locator: SkillLocator = entry.kind === 'directory'
      ? { path: join(entry.path, 'SKILL.md'), directory: entry.path }
      : { path: entry.path, directory: root }
    const parsed = await readParsedSkill(locator.path)
    if (parsed === undefined) continue
    candidates.push({
      name: parsed.name,
      description: parsed.description,
      invocation: DEFAULT_INVOCATION,
      provider: REFERENCES_SKILL_PROVIDER,
      source: 'custom',
      rank: REFERENCES_SKILL_RANK,
      locator,
      path: locator.path,
      resourceBase: { kind: 'directory', path: locator.directory },
    })
  }
  return candidates
}

const referencesSkillProvider: SkillProvider = {
  name: REFERENCES_SKILL_PROVIDER,
  async list(options: SkillLookupOptions): Promise<readonly SkillCandidate[]> {
    return discoverReferencesSkills(options.cwd)
  },
  async get(candidate: SkillCandidate, _options: SkillLookupOptions): Promise<SkillDefinition | undefined> {
    const locator = candidate.locator as SkillLocator | undefined
    if (locator === undefined) return undefined
    const parsed = await readParsedSkill(locator.path)
    if (parsed === undefined) return undefined
    return {
      name: parsed.name,
      description: parsed.description,
      content: parsed.content,
      invocation: candidate.invocation,
      provider: REFERENCES_SKILL_PROVIDER,
      source: 'custom',
      path: locator.path,
      resourceBase: { kind: 'directory', path: locator.directory },
    }
  },
}

/**
 * Register the experiment References skill provider when the skills service exists.
 * @param ctx - host or preset context that exposes `ctx.skills`.
 * @returns disposer that unregisters the provider.
 */
export function installReferencesSkills(ctx: Context): () => void {
  const skills = typeof ctx.get === 'function'
    ? ctx.get('skills') as { registerProvider?: (create: () => SkillProvider) => () => void } | undefined
    : undefined
  if (typeof skills?.registerProvider !== 'function') return () => {}
  return skills.registerProvider(() => referencesSkillProvider)
}
