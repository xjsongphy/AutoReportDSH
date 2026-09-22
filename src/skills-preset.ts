/**
 * Role-scoped installation of AutoReport's bundled domain instructions.
 *
 * MAIN registers catalog skills in the preset scope. Specialist children register
 * permitted bundled skills as runtime entries on the child context so bodies are
 * loaded on demand instead of bloating every REPORT system prompt.
 * @module autoreport-skills
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SkillRegistration } from '@deepseek-ai/dsh-skill'
import type { SpecialistRole } from './roles.js'
import { loadBundledSkills, type BundledSkill } from './workspace/skill-loader.js'
import type { ReportLanguage } from './workspace/init.js'

export const name = 'autoreport-skills'
export const inject = ['skills' as const]

/**
 * Report language whose skill set one REPORT child receives. An alias of the
 * workspace language rather than a second union, so the language that selects
 * the asset set, the guidance prose, the skills, and the gates cannot drift.
 */
export type ReportSkillLanguage = ReportLanguage

/** MAIN-only bundled skills registered in the preset scope. */
export const MAIN_SKILL_NAMES: readonly string[] = ['pdf-reference-reader']

/** The language-neutral report-authoring skill every REPORT child receives. */
export const REPORT_WRITER_SKILL = 'experiment-report-writer'

/**
 * Bundled skills a REPORT child must hold before it may act, split by the
 * action each governs.
 *
 * Registering a skill only publishes a catalog line; its body arrives when the
 * model loads it. Two actions therefore gate on a body that must already be
 * present: authoring report content (`writing`) and running the compiler
 * (`compile`). `references` are consulted on demand and gate nothing.
 *
 * The active language's own layout rules are NOT here. They ship as fixed
 * prompt prose (`resources/report-languages/<language>.md`, appended by the
 * report router), so they are present before the child's first step and there
 * is nothing left to gate on.
 */
export interface ReportSkillRequirements {
  /** Required before a mutation in the report workspace. */
  readonly writing: readonly string[]
  /** Required before the active language's compiler runs under bash/pwsh. */
  readonly compile: string
  /** Registered for the role but never a precondition for acting. */
  readonly references: readonly string[]
}

interface ReportSkillVariants {
  readonly compile: string
  readonly references: readonly string[]
}

const REPORT_SKILL_VARIANTS: Readonly<Record<ReportSkillLanguage, ReportSkillVariants>> = {
  latex: { compile: 'latex-compile', references: [] },
  typst: { compile: 'typst-compile', references: ['typst'] },
}

/**
 * The skills a REPORT child must load before writing or compiling.
 * @param language - frozen workflow report language.
 * @returns the gated and reference-only skill names.
 */
export function reportSkillRequirements(language: ReportSkillLanguage): ReportSkillRequirements {
  const variant = REPORT_SKILL_VARIANTS[language]
  return {
    writing: [REPORT_WRITER_SKILL],
    compile: variant.compile,
    references: variant.references,
  }
}

/** Return the AutoReport-owned instruction names permitted to one specialist. */
export function skillNamesForRole(role: SpecialistRole, language: ReportSkillLanguage): readonly string[] {
  switch (role) {
    case 'THEORY':
    case 'DATA_ANALYSIS':
    case 'PLOTTING':
      return []
    case 'REPORT': {
      const required = reportSkillRequirements(language)
      return [...required.writing, ...required.references, required.compile]
    }
  }
}

/**
 * Register one bundled skill, carrying the resource anchor only when the skill
 * actually has sibling resources.
 *
 * `resourceBase` is the whole point: DSH renders a `skill` body as
 * `<skill_instructions>` with the base as a sibling `<skill_resources>` line,
 * and that line is the only in-band statement of what the body's relative paths
 * resolve against. A runtime registration without it renders "Resources for
 * this skill are managed by provider \"runtime\"." — which is correct for a
 * flat document whose prose talks about the experiment workspace, and wrong for
 * a bundle whose body says `[basics.md](basics.md)`.
 */
function registerBundledSkill(
  skill: BundledSkill,
  registerSkill: (registration: SkillRegistration) => () => void,
): () => void {
  return registerSkill({
    name: skill.name,
    description: skill.description,
    source: 'runtime',
    content: skill.content,
    path: skill.path,
    ...skill.directory === undefined
      ? {}
      : { resourceBase: { kind: 'directory' as const, path: skill.directory } },
  })
}

function requireSkillRegister(ctx: Context, owner: string): (registration: SkillRegistration) => () => void {
  const skills = ctx.skills
  if (skills?.register === undefined) {
    throw new Error(`AutoReport ${owner} skills require ctx.skills.register`)
  }
  // Call through the service object. Extracting `register` as a free function
  // drops `this`, and DSH's SkillService reads `this.ctx`.
  return registration => skills.register(registration)
}

/**
 * Register MAIN-only bundled skills (`pdf-reference-reader`) in the preset scope
 * where `ctx.skills.register` is available.
 * @param ctx - `autoreport` preset context.
 * @returns composite disposer for registered skills.
 */
export function registerMainSkills(ctx: Context): () => void {
  const available = new Map(loadBundledSkills().map(skill => [skill.name, skill]))
  const disposers: (() => void)[] = []
  const registerSkill = requireSkillRegister(ctx, 'MAIN')

  try {
    for (const name of MAIN_SKILL_NAMES) {
      const skill = available.get(name)
      if (skill === undefined) throw new Error(`AutoReport bundled skill ${name} is missing for MAIN`)
      disposers.push(registerBundledSkill(skill, registerSkill))
    }
  } catch (error: unknown) {
    for (const dispose of disposers.reverse()) dispose()
    throw error
  }

  return () => {
    const failures: unknown[] = []
    for (const dispose of disposers.reverse()) {
      try {
        dispose()
      } catch (error: unknown) {
        failures.push(error)
      }
    }
    if (failures.length > 0) throw new AggregateError(failures, 'failed to dispose AutoReport MAIN skills')
  }
}

/**
 * Install only the domain instructions permitted to a newly-created specialist
 * child. The registration belongs to the child scope and is disposed with it,
 * so one role cannot leak its instructions into another child or MAIN.
 * @param ctx - unpublished specialist child context.
 * @param role - role recorded in the synchronous RoleRegistry.
 * @param language - frozen workflow report language.
 * @returns composite disposer for the child-scoped skill registrations.
 */
export function registerRoleSkills(
  ctx: Context,
  role: SpecialistRole,
  language: ReportSkillLanguage,
): () => void {
  const available = new Map(loadBundledSkills().map(skill => [skill.name, skill]))
  const disposers: (() => void)[] = []
  const registerSkill = requireSkillRegister(ctx, role)
  try {
    for (const name of skillNamesForRole(role, language)) {
      const skill = available.get(name)
      if (skill === undefined) throw new Error(`AutoReport bundled skill ${name} is missing for ${role}`)
      disposers.push(registerBundledSkill(skill, registerSkill))
    }
  } catch (error: unknown) {
    for (const dispose of disposers.reverse()) dispose()
    throw error
  }
  return () => {
    const failures: unknown[] = []
    for (const dispose of disposers.reverse()) {
      try {
        dispose()
      } catch (error: unknown) {
        failures.push(error)
      }
    }
    if (failures.length > 0) throw new AggregateError(failures, 'failed to dispose AutoReport role skills')
  }
}
