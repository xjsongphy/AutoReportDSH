/**
 * The role policy table and the role skill registry must agree on which
 * specialist roles carry a skill catalog: the `skill` loader tool is only
 * granted where `skillNamesForRole` registers skills. A role with the loader
 * but an empty catalog can only invent skill names (session 48970218's
 * "data-analysis" unknown-skill error); a role with skills but no loader
 * cannot reach its own gates.
 */

import { describe, expect, it } from 'vitest'
import { skillNamesForRole, type ReportSkillLanguage } from '../src/skills-preset.js'
import { allSpecialistRoles, rolePolicy, SKILL_TOOL } from '../src/roles.js'

const LANGUAGES: readonly ReportSkillLanguage[] = ['latex', 'typst']

describe('role policy ↔ role skills alignment', () => {
  for (const role of allSpecialistRoles()) {
    it(`grants ${SKILL_TOOL} to ${role} exactly when it has bundled skills`, () => {
      for (const language of LANGUAGES) {
        const hasSkills = skillNamesForRole(role, language).length > 0
        expect(rolePolicy(role).tools.includes(SKILL_TOOL), `${role} (${language})`).toBe(hasSkills)
      }
    })
  }

  it('keeps the skill loader for MAIN, whose preset mounts its catalog', () => {
    expect(rolePolicy('MAIN').tools).toContain(SKILL_TOOL)
  })
})
