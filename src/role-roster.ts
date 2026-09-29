/** Concise, shared routing context for the five AutoReport roles. */
import { allSpecialistRoles, type AutoReportRole } from './roles.js'

const RESPONSIBILITIES: Readonly<Record<AutoReportRole, string>> = {
  MAIN: 'coordinates tasks, dependencies, reference extraction, and the selected Python environment',
  THEORY: 'develops physical assumptions, derivations, and reusable formulas',
  DATA_ANALYSIS: 'processes measurements and produces validated numerical results and uncertainties',
  PLOTTING: 'produces figures and plotting scripts from analyzed results',
  REPORT: 'integrates upstream evidence into the report and compiles the PDF',
}

/** Describe the other roles without repeating tool schemas or a role's own contract. */
export function otherRoleResponsibilities(role: AutoReportRole): string {
  const roles: readonly AutoReportRole[] = ['MAIN', ...allSpecialistRoles()]
  return [
    '## Other roles',
    ...roles.filter(other => other !== role).map(other => `- ${other}: ${RESPONSIBILITIES[other]}.`),
  ].join('\n')
}
