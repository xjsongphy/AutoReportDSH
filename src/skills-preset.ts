/**
 * Role-scoped installation of AutoReport's bundled domain instructions.
 *
 * Continuable children expose only the tool and system-prompt services during
 * their unpublished setup window.  A runtime `ctx.skills.register()` call is
 * therefore unavailable there and would either fail or leak into the host
 * scope.  Install the bundled skill bodies as child-scoped system-prompt
 * sections instead; this retains the role boundary and disposes with the
 * child, without widening the shared skill catalogue.
 * @module autoreportdsh-skills
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-skill'
import type { SpecialistRole } from './roles.js'
import { loadBundledSkills, type BundledSkill } from './workspace/skill-loader.js'

export const name = 'autoreportdsh-skills'
export const inject = ['systemPrompt' as const]

/** Language-specific compilation guidance selected for a REPORT child. */
export type ReportSkillLanguage = 'latex' | 'typst'

/** MAIN-only bundled skills registered in the preset scope. */
export const MAIN_SKILL_NAMES: readonly string[] = ['pdf-reference-reader', 'mineru']

/** Return the AutoReport-owned instruction names permitted to one specialist. */
export function skillNamesForRole(role: SpecialistRole, language: ReportSkillLanguage): readonly string[] {
  switch (role) {
    case 'THEORY':
    case 'DATA_ANALYSIS':
    case 'PLOTTING':
      return []
    case 'REPORT':
      return ['experiment-report-writer', language === 'latex' ? 'latex-compile' : 'typst-compile']
  }
}

function section(skill: BundledSkill): { name: string; order: number; text: string } {
  return {
    name: `autoreport:skill:${skill.name}`,
    // Role instructions should follow the base persona but precede ordinary
    // deployment sections, and use deterministic ordering for stable prompts.
    order: 10,
    text: skill.content,
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

/**
 * Register MAIN-only bundled skills (`pdf-reference-reader` and `mineru` alias)
 * in the preset scope where `ctx.skills.register` is available.
 * @param ctx - `autoreport-main` preset context.
 * @returns composite disposer for registered skills.
 */
export function registerMainSkills(ctx: Context): () => void {
  const available = new Map(loadBundledSkills().map(skill => [skill.name, skill]))
  const disposers: (() => void)[] = []
  const registerSkill = ctx.skills?.register
  if (registerSkill === undefined) return () => {}

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
 * @returns composite disposer for the child-scoped prompt sections.
 */
export function registerRoleSkills(
  ctx: Context,
  role: SpecialistRole,
  language: ReportSkillLanguage,
): () => void {
  const available = new Map(loadBundledSkills().map(skill => [skill.name, skill]))
  const disposers: (() => void)[] = []
  try {
    for (const name of skillNamesForRole(role, language)) {
      const skill = available.get(name)
      if (skill === undefined) throw new Error(`AutoReport bundled skill ${name} is missing for ${role}`)
      disposers.push(ctx.systemPrompt.section(section(skill)))
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

/** Compatibility entrypoint: role instructions are installed per child only. */
export function apply(_ctx: Context): void {}
