/**
 * The fixed five-role AutoReport table and each role's explicit execution
 * policy dimensions (PLAN.md §2.2). Role identity is independent of DSH
 * Session identity; this table is the domain source for authorization and
 * process isolation.
 *
 * Every role reads the experiment workspace. Each role's output root is
 * enforced by DSH's file sandbox and the AutoReport write guard. Execution
 * names the general process capability the role receives.
 * @module
 */

/** The five fixed roles of the report workflow. */
export type AutoReportRole = 'MAIN' | 'THEORY' | 'DATA_ANALYSIS' | 'PLOTTING' | 'REPORT'

/** Roles that run as continuable specialist children (every role except MAIN). */
export type SpecialistRole = Exclude<AutoReportRole, 'MAIN'>

/** Explicit execution policy for one role (PLAN.md §2.2, execution-layer rev). */
export interface ReportRolePolicy {
  /** Workspace-relative role output directory. */
  readonly writableRoot: string
  /** General process capability; Main also has narrow coordination tools. */
  readonly execution: 'none' | 'shell' | 'compile'
}

const MAIN_POLICY: ReportRolePolicy = {
  writableRoot: 'Outline',
  execution: 'none',
}

const THEORY_POLICY: ReportRolePolicy = {
  writableRoot: 'Theory',
  execution: 'none',
}

const DATA_ANALYSIS_POLICY: ReportRolePolicy = {
  writableRoot: 'Data/Processed',
  execution: 'shell',
}

const PLOTTING_POLICY: ReportRolePolicy = {
  writableRoot: 'Plots',
  execution: 'shell',
}

const REPORT_POLICY: ReportRolePolicy = {
  writableRoot: 'Report',
  execution: 'compile',
}

const POLICIES: Readonly<Record<AutoReportRole, ReportRolePolicy>> = {
  MAIN: MAIN_POLICY,
  THEORY: THEORY_POLICY,
  DATA_ANALYSIS: DATA_ANALYSIS_POLICY,
  PLOTTING: PLOTTING_POLICY,
  REPORT: REPORT_POLICY,
}

const SPECIALIST_ROLES: readonly SpecialistRole[] = ['THEORY', 'DATA_ANALYSIS', 'PLOTTING', 'REPORT']

/**
 * Narrow an unknown value to {@link AutoReportRole}.
 * @param value - candidate role name.
 * @returns whether the value names one of the five fixed roles.
 */
export function isAutoReportRole(value: unknown): value is AutoReportRole {
  return typeof value === 'string' && value in POLICIES
}

/**
 * Narrow an unknown value to {@link SpecialistRole}.
 * @param value - candidate role name.
 * @returns whether the value names one of the four child roles.
 */
export function isSpecialistRole(value: unknown): value is SpecialistRole {
  return typeof value === 'string' && SPECIALIST_ROLES.includes(value as SpecialistRole)
}

/**
 * All specialist roles in dispatch order.
 * @returns the four continuable-child roles.
 */
export function allSpecialistRoles(): readonly SpecialistRole[] {
  return SPECIALIST_ROLES
}

/**
 * Resolve the immutable execution policy for one role.
 * @param role - one of the five fixed roles.
 * @returns the role's policy object.
 */
export function rolePolicy(role: AutoReportRole): ReportRolePolicy {
  return POLICIES[role]
}
