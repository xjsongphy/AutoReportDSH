import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SpecialistRole } from './roles.js'
import { resourcesRoot } from './workspace/init.js'
import { otherRoleResponsibilities } from './role-roster.js'

const ROLE_FILES: Readonly<Record<SpecialistRole, string>> = {
  THEORY: 'theory_agent.md',
  DATA_ANALYSIS: 'data_analysis_agent.md',
  PLOTTING: 'plotting_agent.md',
  REPORT: 'report_agent.md',
}

/**
 * Load the immutable Main persona bundled with this plugin.
 * @returns Main coordination instructions.
 */
export function loadMainPersona(): string {
  const main = readFileSync(join(resourcesRoot(), 'personas', 'main_agent.md'), 'utf8')
  return `${main.trimEnd()}\n\n${otherRoleResponsibilities('MAIN')}\n`
}

/**
 * Load one specialist persona with its role contract first, followed by shared rules.
 * @param role - fixed specialist role.
 * @returns role-specific instructions followed by shared rules.
 */
export function loadSpecialistPersona(role: SpecialistRole): string {
  const directory = join(resourcesRoot(), 'personas')
  const common = readFileSync(join(directory, 'Common.md'), 'utf8')
  const roleText = readFileSync(join(directory, ROLE_FILES[role]), 'utf8')
  return `${roleText.trimEnd()}\n\n${otherRoleResponsibilities(role)}\n\n${common}`
}
