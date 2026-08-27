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
import type { SpecialistRole } from './roles.js'
import { loadBundledSkills, type BundledSkill } from './workspace/skill-loader.js'

export const name = 'autoreportdsh-skills'
export const inject = ['systemPrompt' as const]

/** Language-specific compilation guidance selected for a REPORT child. */
export type ReportSkillLanguage = 'latex' | 'typst'

/** Return the AutoReport-owned instruction names permitted to one specialist. */
export function skillNamesForRole(role: SpecialistRole, language: ReportSkillLanguage): readonly string[] {
  switch (role) {
    case 'THEORY':
      return ['mineru']
    case 'REPORT':
      return ['experiment-report-writer', language === 'latex' ? 'latex-compile' : 'typst-compile', 'mineru']
    case 'DATA_ANALYSIS':
    case 'PLOTTING':
      return []
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
