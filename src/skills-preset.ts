/**
 * Preset-scoped registration of the bundled AutoReport skills.
 *
 * `src/preset.ts` calls this helper from the single `autoreport-main` preset
 * contribution, so registrations land in that preset's registry layer and stay
 * invisible to unrelated DSH sessions (PLAN.md §2.12). Specialist children
 * inherit the scope through parent composition.
 * @module autoreportdsh-skills
 */

import type { Context } from '@deepseek-ai/cordis'
// Importing the registry type also loads its `Context.skills` declaration merge.
import type { SkillRegistration } from '@deepseek-ai/dsh-skill'
import { loadBundledSkills } from './workspace/skill-loader.js'

export const name = 'autoreportdsh-skills'
export const inject = ['skills' as const]

/**
 * Register every bundled skill into the calling context's scope layer.
 * @param ctx - The AutoReport preset context whose skill layer receives them.
 */
export function registerBundledSkills(ctx: Context): void {
  for (const skill of loadBundledSkills()) {
    const registration: SkillRegistration = {
      name: skill.name,
      description: skill.description,
      content: skill.content,
      source: 'runtime',
    }
    ctx.skills.register(registration)
  }
}

/** Preset-plugin compatibility entry; `src/preset.ts` uses the same helper. */
export function apply(ctx: Context): void {
  registerBundledSkills(ctx)
}
