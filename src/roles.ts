/**
 * The fixed five-role AutoReport table and each role's explicit execution
 * policy dimensions (PLAN.md §2.2). Role identity is independent of DSH
 * Session identity; this table is the domain source for authorization and
 * process isolation.
 *
 * `cwd` controls relative-path behavior only — it is never an authorization
 * boundary. Readable roots are workspace-relative; `'.'` denotes the whole
 * experiment workspace. Writable roots are narrower than the workspace root
 * and are enforced independently by the tool guard and the isolation backend.
 * @module
 */

/** The five fixed roles of the report workflow. */
export type AutoReportRole = 'MAIN' | 'THEORY' | 'DATA_ANALYSIS' | 'PLOTTING' | 'REPORT'

/** Roles that run as continuable specialist children (every role except MAIN). */
export type SpecialistRole = Exclude<AutoReportRole, 'MAIN'>

/** Explicit execution policy for one role (PLAN.md §2.2). */
export interface ReportRolePolicy {
  /** Working directory for report processes, workspace-relative. */
  readonly cwd: string
  /** Directories report processes may read; `'.'` is the whole workspace. */
  readonly readableRoots: readonly string[]
  /** Directories role mutations may target and processes may write. */
  readonly writableRoots: readonly string[]
  /** Immutable v1 network posture. */
  readonly network: 'deny'
  /** Private temporary area per process; never a shared world-writable dir. */
  readonly temp: 'private'
}

const MAIN_POLICY: ReportRolePolicy = {
  cwd: '.',
  readableRoots: ['.'],
  writableRoots: ['Outline'],
  network: 'deny',
  temp: 'private',
}

const THEORY_POLICY: ReportRolePolicy = {
  cwd: 'Theory',
  readableRoots: ['.'],
  writableRoots: ['Theory'],
  network: 'deny',
  temp: 'private',
}

const DATA_ANALYSIS_POLICY: ReportRolePolicy = {
  cwd: 'Data',
  readableRoots: ['.'],
  writableRoots: ['Data/Processed'],
  network: 'deny',
  temp: 'private',
}

const PLOTTING_POLICY: ReportRolePolicy = {
  cwd: 'Plots',
  readableRoots: ['.'],
  writableRoots: ['Plots'],
  network: 'deny',
  temp: 'private',
}

const REPORT_POLICY: ReportRolePolicy = {
  cwd: 'Report',
  readableRoots: ['.'],
  writableRoots: ['Report'],
  network: 'deny',
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
