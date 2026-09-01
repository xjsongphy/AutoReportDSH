/**
 * Role-scoped installation of AutoReport's bundled domain instructions.
 *
 * MAIN registers catalog skills in the preset scope. Specialist children register
 * permitted bundled skills as runtime entries on the child context so bodies are
 * loaded on demand instead of bloating every REPORT system prompt.
 * @module autoreportdsh-skills
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-skill'
import type { SpecialistRole } from './roles.js'
import { loadBundledSkills, type BundledSkill } from './workspace/skill-loader.js'

export const name = 'autoreportdsh-skills'
export const inject = ['skills' as const]

/** Language-specific report guidance selected for a REPORT child. */
export type ReportSkillLanguage = 'latex' | 'typst'

/** MAIN-only bundled skills registered in the preset scope. */
export const MAIN_SKILL_NAMES: readonly string[] = ['pdf-reference-reader']

/** Return the AutoReport-owned instruction names permitted to one specialist. */
export function skillNamesForRole(role: SpecialistRole, language: ReportSkillLanguage): readonly string[] {
  switch (role) {
    case 'THEORY':
    case 'DATA_ANALYSIS':
    case 'PLOTTING':
      return []
    case 'REPORT':
      return language === 'latex'
        ? ['experiment-report-writer', 'report-language-latex', 'latex-compile']
        : ['experiment-report-writer', 'report-language-typst', 'typst', 'typst-compile']
  }
}

function registerBundledSkill(
  skill: BundledSkill,
  registerSkill: (registration: { name: string; description: string; source: string; content: string }) => () => void,
): () => void {
  return registerSkill({
    name: skill.name,
    description: skill.description,
    source: 'runtime',
    content: skill.content,
  })
}

function requireSkillRegister(ctx: Context, owner: string): (registration: {
  name: string
  description: string
  source: string
  content: string
}) => () => void {
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
export function registerMainSkills(ctx: Context, overlayRoot?: string): () => void {
  const available = new Map(loadBundledSkills(overlayRoot).map(skill => [skill.name, skill]))
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
  overlayRoot?: string,
): () => void {
  const available = new Map(loadBundledSkills(overlayRoot).map(skill => [skill.name, skill]))
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
