import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SpecialistRole } from './roles.js'
import { resourcesRoot } from './workspace/init.js'

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
  return readFileSync(join(resourcesRoot(), 'personas', 'main_agent.md'), 'utf8')
}

/**
 * Load one specialist persona with the shared AutoReport collaboration rules.
 * @param role - fixed specialist role.
 * @returns shared plus role-specific instructions.
 */
export function loadSpecialistPersona(role: SpecialistRole): string {
  const directory = join(resourcesRoot(), 'personas')
  const common = readFileSync(join(directory, 'Common.md'), 'utf8')
  const roleText = readFileSync(join(directory, ROLE_FILES[role]), 'utf8')
  return `${common}\n\n${roleText}`
}
