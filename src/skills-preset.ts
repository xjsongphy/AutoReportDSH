/**
 * Preset-scoped registration of the bundled AutoReport skills.
 *
 * This module is mounted as a row of the `autoreport-main` preset
 * composition, so its registrations land in that preset's registry layer and
 * stay invisible to unrelated DSH sessions (PLAN.md §2.12). Specialist
 * children inherit the scope through parent composition.
 * @module autoreportdsh-skills
 */

import type { Context } from '@deepseek-ai/cordis'
// Importing the registry type also loads its `Context.skills` declaration merge.
import type { SkillRegistration } from '@deepseek-ai/dsh-skill'
import { loadBundledSkills } from './workspace/skill-loader.js'

export const name = 'autoreportdsh-skills'
export const inject = ['skills' as const]

/** Register every bundled skill into the calling context's scope layer. */
export function apply(ctx: Context): void {
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
