/**
 * Loader for the bundled AutoReport skill documents under `resources/`.
 *
 * Skill files are markdown with `name`/`description` frontmatter followed by a
 * markdown body — the same shape DSH's filesystem provider expects from
 * SKILL.md files. This loader performs the same minimal parsing so the
 * preset-scoped plugin can register each document as a runtime skill without
 * depending on the filesystem provider's discovery roots.
 * @module workspace/skill-loader
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { resourcesRoot } from './init.js'

/** One parsed bundled skill ready for `ctx.skills.register()`. */
export interface BundledSkill {
  /** Kebab-case skill name from frontmatter. */
  readonly name: string
  /** Short routing description from frontmatter. */
  readonly description: string
  /** Markdown body after frontmatter removal. */
  readonly content: string
}

/** Split one `---`-fenced YAML frontmatter block from the markdown body. */
function splitFrontmatter(raw: string): { data: Map<string, string>; body: string } | undefined {
  const normalized = raw.replace(/\r\n/gu, '\n')
  if (!normalized.startsWith('---\n')) return undefined
  const end = normalized.indexOf('\n---', 4)
  if (end === -1) return undefined
  const block = normalized.slice(4, end)
  const body = normalized.slice(end + 4).replace(/^\n+/u, '')
  const data = new Map<string, string>()
  for (const line of block.split('\n')) {
    const separator = line.indexOf(':')
    if (separator === -1) continue
    const key = line.slice(0, separator).trim()
    let value = line.slice(separator + 1).trim()
    // Strip one level of matching quotes; values here are single-line strings.
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    if (key.length > 0) data.set(key, value)
  }
  return { data, body }
}

/**
 * Parse one SKILL.md-shaped document. Returns `undefined` for missing or
 * invalid frontmatter rather than throwing: a malformed bundled file must be
 * detectable by tests, not crash registration.
 * @param raw - full file content.
 * @returns the parsed skill, or `undefined` when unparseable.
 */
export function parseBundledSkill(raw: string): BundledSkill | undefined {
  const parsed = splitFrontmatter(raw)
  if (parsed === undefined) return undefined
  const name = parsed.data.get('name')
  const description = parsed.data.get('description')
  if (name === undefined || description === undefined || name.length === 0 || description.length === 0) return undefined
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(name)) return undefined
  if (parsed.body.trim().length === 0) return undefined
  return { name, description, content: parsed.body }
}

function collectSkillsFromRoot(root: string, add: (skill: BundledSkill | undefined, path: string) => void): void {
  for (const directory of ['skills', 'report-languages'] as const) {
    let entries: string[]
    try {
      entries = readdirSync(join(root, directory)).sort()
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      entries = []
    }
    for (const entry of entries) {
      if (!entry.endsWith('.md')) continue
      const path = join(root, directory, entry)
      add(parseBundledSkill(readFileSync(path, 'utf8')), path)
    }
  }
  for (const language of ['latex', 'typst'] as const) {
    const nestedRoot = join(root, language, 'skills')
    let entries: string[]
    try {
      entries = readdirSync(nestedRoot, { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .map(entry => entry.name)
        .sort()
    } catch {
      continue
    }
    for (const name of entries) {
      const path = join(nestedRoot, name, 'SKILL.md')
      try {
        add(parseBundledSkill(readFileSync(path, 'utf8')), path)
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
  }
}

/**
 * Load every skill: package-bundled files under `resources/skills`, plus the
 * global overlay (`$DSH_HOME/autoreport/resources`) for synced remotes such as
 * `latex-compile` and `typst`. Overlay names replace a bundled file of the
 * same name. Report-language guidance files under `report-languages/` are
 * bundled runtime skills too; role routing decides which one a REPORT child
 * receives.
 * @param overlayRoot - global synced overlay directory.
 * @returns parsed skills with unique names, sorted by name.
 */
export function loadBundledSkills(overlayRoot?: string): BundledSkill[] {
  const skills: BundledSkill[] = []
  const seen = new Set<string>()

  const add = (skill: BundledSkill | undefined, path: string, replace: boolean): void => {
    if (skill === undefined) return
    if (seen.has(skill.name)) {
      if (!replace) throw new Error(`AutoReport bundled skill ${skill.name} is duplicated at ${path}`)
      const index = skills.findIndex(entry => entry.name === skill.name)
      if (index !== -1) skills.splice(index, 1)
    }
    seen.add(skill.name)
    skills.push(skill)
  }

  collectSkillsFromRoot(resourcesRoot(), (skill, path) => add(skill, path, false))
  if (overlayRoot !== undefined) collectSkillsFromRoot(overlayRoot, (skill, path) => add(skill, path, true))
  return skills.sort((left, right) => left.name.localeCompare(right.name))
}
