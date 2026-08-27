/**
 * Role-scoped registration of AutoReport's bundled domain skills.
 *
 * The Main preset deliberately registers no domain skills. Each specialist
 * receives only the instructions that belong to its fixed responsibility when
 * the continuable child scope is created. DSH's normal user/project skill
 * providers remain independent of this narrow AutoReport catalog.
 * @module autoreportdsh-skills
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SkillRegistration } from '@deepseek-ai/dsh-skill'
import type { SpecialistRole } from './roles.js'
import { loadBundledSkills, type BundledSkill } from './workspace/skill-loader.js'

export const name = 'autoreportdsh-skills'
export const inject = ['skills' as const]

/** Language-specific compilation guidance selected for a REPORT child. */
export type ReportSkillLanguage = 'latex' | 'typst'

/**
 * Return the AutoReport-owned skills allowed to one specialist.
 *
 * MinerU is useful only to roles that consume reference PDFs: THEORY extracts
 * source material for derivations and REPORT extracts citation/template
 * material. It is intentionally invisible to MAIN, DATA_ANALYSIS, and
 * PLOTTING. REPORT alone receives writing and active-language compilation
 * guidance.
 * @param role - fixed specialist identity.
 * @param language - active report language for a REPORT child.
 * @returns exact allowed bundled skill names.
 */
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

function registration(skill: BundledSkill): SkillRegistration {
  return {
    name: skill.name,
    description: skill.description,
    content: skill.content,
    source: 'runtime',
  }
}

/**
 * Register only the domain skills permitted to a newly-created specialist
 * child. The registration belongs to the child scope and is disposed with it,
 * so one role cannot leak its catalog into another child or the MAIN preset.
 * @param ctx - unpublished specialist child context.
 * @param role - role recorded in the synchronous RoleRegistry.
 * @param language - frozen workflow report language.
 * @returns composite disposer for the child-scoped registrations.
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
      disposers.push(ctx.skills.register(registration(skill)))
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

/**
 * Compatibility entrypoint. Domain skills are no longer preset-wide; this is
 * intentionally a no-op so an old composition row cannot broaden visibility.
 */
export function apply(_ctx: Context): void {}
