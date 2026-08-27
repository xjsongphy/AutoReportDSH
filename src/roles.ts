/**
 * The fixed five-role AutoReport table and each role's explicit execution
 * policy dimensions (PLAN.md §2.2). Role identity is independent of DSH
 * Session identity; this table is the domain source for authorization and
 * process isolation.
 *
 * Navigation cwd is always the experiment root (`'.'`). Writable roots are
 * narrower than the workspace and are enforced by DSH sandbox `workspaceRoot`
 * (independent of session cwd) plus a shrunk AutoReport guard. Network is
 * allowed: DSH sandbox is a file-effect boundary, not a network boundary.
 * @module
 */

/** The five fixed roles of the report workflow. */
export type AutoReportRole = 'MAIN' | 'THEORY' | 'DATA_ANALYSIS' | 'PLOTTING' | 'REPORT'

/** Roles that run as continuable specialist children (every role except MAIN). */
export type SpecialistRole = Exclude<AutoReportRole, 'MAIN'>

/** Explicit execution policy for one role (PLAN.md §2.2, execution-layer rev). */
export interface ReportRolePolicy {
  /** Navigation cwd, always the experiment root. Not a write-authorization boundary. */
  readonly cwd: string
  /** Directories the role may read; `'.'` is the whole workspace. */
  readonly readableRoots: readonly string[]
  /** Directories role mutations may target; DSH sandbox workspaceRoot. */
  readonly writableRoots: readonly string[]
  /** Network posture: allowed. File writes stay confined by sandbox. */
  readonly network: 'allow'
  /** Private temporary area per process; never a shared world-writable dir. */
  readonly temp: 'private'
}

const MAIN_POLICY: ReportRolePolicy = {
  cwd: '.',
  readableRoots: ['.'],
  writableRoots: ['Outline'],
  network: 'allow',
  temp: 'private',
}

const THEORY_POLICY: ReportRolePolicy = {
  cwd: '.',
  readableRoots: ['.'],
  writableRoots: ['Theory'],
  network: 'allow',
  temp: 'private',
}

const DATA_ANALYSIS_POLICY: ReportRolePolicy = {
  cwd: '.',
  readableRoots: ['.'],
  writableRoots: ['Data/Processed'],
  network: 'allow',
  temp: 'private',
}

const PLOTTING_POLICY: ReportRolePolicy = {
  cwd: '.',
  readableRoots: ['.'],
  writableRoots: ['Plots'],
  network: 'allow',
  temp: 'private',
}

const REPORT_POLICY: ReportRolePolicy = {
  cwd: '.',
  readableRoots: ['.'],
  writableRoots: ['Report'],
  network: 'allow',
  temp: 'private',
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
