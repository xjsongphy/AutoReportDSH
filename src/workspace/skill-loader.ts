/**
 * Loader for the bundled AutoReport skill documents under `resources/`.
 *
 * Skill documents are markdown with `name`/`description` frontmatter followed
 * by a markdown body — the same shape DSH's filesystem provider expects. This
 * loader performs the same minimal parsing so the preset-scoped plugin can
 * register each document as a runtime skill without depending on the
 * filesystem provider's discovery roots.
 *
 * ## Layout decides whether a skill has resources
 *
 * A skill that ships sibling documents is a **directory bundle**
 * (`skills/<name>/SKILL.md` beside its references). A skill that ships nothing
 * is a **flat file** (`skills/<name>.md`). Registration forwards a bundle's
 * directory as DSH's `resourceBase`, and forwards nothing for a flat file.
 *
 * That distinction is load-bearing, because `resourceBase` is the only in-band
 * place the model is told what a body's relative paths resolve against: DSH
 * renders the body inside `<skill_instructions>` alongside a sibling
 * `<skill_resources>` line reading "Resolve relative paths mentioned by this
 * skill against the base directory before using them". A skill whose prose
 * talks about the experiment workspace (`Report/main.tex`, `../Plots/Fig/`)
 * must therefore NOT carry a base, or that instruction would send the model to
 * a path under `resources/` that cannot exist. Deriving the field from the
 * layout — rather than from a per-skill allowlist — keeps the two from
 * drifting: adding a sibling document means moving the file into a bundle, and
 * that one move turns the anchor on.
 * @module workspace/skill-loader
 */

import { readdirSync, readFileSync, type Dirent } from 'node:fs'
import { join } from 'node:path'
import { resourcesRoot, type ReportLanguage } from './init.js'

/** One parsed skill document: what the file says, with no location attached. */
export interface ParsedSkill {
  /** Kebab-case skill name from frontmatter. */
  readonly name: string
  /** Short routing description from frontmatter. */
  readonly description: string
  /** Markdown body after frontmatter removal. */
  readonly content: string
}

/** One parsed bundled skill at a known location, ready for `ctx.skills.register()`. */
export interface BundledSkill extends ParsedSkill {
  /**
   * Absolute directory holding this skill's sibling resources, forwarded as
   * DSH's `resourceBase`. Absent for a flat-file skill: it has no siblings, and
   * publishing a base would make the model resolve workspace paths against
   * `resources/`.
   */
  readonly directory?: string
  /** Absolute path of the skill file itself. */
  readonly path: string
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
export function parseBundledSkill(raw: string): ParsedSkill | undefined {
  const parsed = splitFrontmatter(raw)
  if (parsed === undefined) return undefined
  const name = parsed.data.get('name')
  const description = parsed.data.get('description')
  if (name === undefined || description === undefined || name.length === 0 || description.length === 0) return undefined
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(name)) return undefined
  if (parsed.body.trim().length === 0) return undefined
  return { name, description, content: parsed.body }
}

/** One skill discovery root: the directory whose children are skills. */
type SkillSite = { readonly skillsDir: string; readonly add: (skill: BundledSkill | undefined) => void }

/** Read one skill file if it exists at all; a missing file is skipped, not fatal. */
function readSkillFile(path: string, directory: string | undefined): BundledSkill | undefined {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  const parsed = parseBundledSkill(raw)
  if (parsed === undefined) return undefined
  return directory === undefined ? { ...parsed, path } : { ...parsed, path, directory }
}

/**
 * Collect every skill under one `skills/` directory: `*.md` flat files, plus
 * `<name>/SKILL.md` bundles whose directory becomes the skill's resource base.
 * @param site - the skills directory and the sink to add into.
 */
function collectSkills(site: SkillSite): void {
  let entries: Dirent[]
  try {
    entries = readdirSync(site.skillsDir, { withFileTypes: true })
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return
  }
  for (const entry of [...entries].sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.isDirectory()) {
      const directory = join(site.skillsDir, entry.name)
      site.add(readSkillFile(join(directory, 'SKILL.md'), directory))
      continue
    }
    if (!entry.name.endsWith('.md')) continue
    site.add(readSkillFile(join(site.skillsDir, entry.name), undefined))
  }
}

/**
 * Load every bundled AutoReport skill: `resources/skills/` (flat documents and
 * bundles) and `resources/<language>/skills/` (bundles such as `typst`, whose
 * reference documents sit beside SKILL.md and are addressed relative to it).
 *
 * Report-language guidance under `resources/report-languages/` is deliberately
 * NOT a skill: it is fixed prose appended to every REPORT child's system prompt
 * by {@link loadReportLanguageGuidance}, so no model decision and no gate
 * depends on loading it.
 * @returns located skills with unique names, sorted by name.
 */
export function loadBundledSkills(): BundledSkill[] {
  const skills: BundledSkill[] = []
  const seen = new Set<string>()

  const add = (skill: BundledSkill | undefined): void => {
    if (skill === undefined) return
    if (seen.has(skill.name)) throw new Error(`AutoReport bundled skill ${skill.name} is duplicated at ${skill.path}`)
    seen.add(skill.name)
    skills.push(skill)
  }

  const root = resourcesRoot()
  collectSkills({ skillsDir: join(root, 'skills'), add })
  for (const language of ['latex', 'typst'] as const) {
    collectSkills({ skillsDir: join(root, language, 'skills'), add })
  }
  return skills.sort((left, right) => left.name.localeCompare(right.name))
}

/**
 * Read one report-language guidance document.
 *
 * These files carry no frontmatter, unlike the skill documents: frontmatter is
 * what makes a document a catalog entry, and this text deliberately is not one.
 * A missing or empty file is a packaging error and throws rather than silently
 * shipping a REPORT child without its language rules.
 * @param language - frozen workflow report language.
 * @returns the guidance text, trimmed.
 */
export function loadReportLanguageGuidance(language: ReportLanguage): string {
  const path = join(resourcesRoot(), 'report-languages', `${language}.md`)
  const body = readFileSync(path, 'utf8').trim()
  if (body.length === 0) throw new Error(`AutoReport report-language guidance ${path} is empty`)
  return body
}
