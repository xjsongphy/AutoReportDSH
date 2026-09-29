/**
 * The fixed five-role AutoReport table and each role's explicit execution
 * policy dimensions (PLAN.md §2.2). Role identity is independent of DSH
 * Session identity; this table is the domain source for authorization and
 * process isolation.
 *
 * `cwd: '.'` is the logical workspace/session base, not the subprocess CWD and
 * is not currently consumed by runtime code. MAIN and THEORY have no general
 * process tool. DATA_ANALYSIS, PLOTTING, and REPORT get role-aware Bash on
 * Linux/macOS and role-constrained PowerShell on Windows. The Unix wrapper
 * exposes role-readable workspace roots; Windows uses DSH's partial write ACL
 * sandbox plus AutoReport command/path preflight, without process read isolation.
 * Network is allowed.
 * @module
 */

/** The five fixed roles of the report workflow. */
export type AutoReportRole = 'MAIN' | 'THEORY' | 'DATA_ANALYSIS' | 'PLOTTING' | 'REPORT'

/** Roles that run as continuable specialist children (every role except MAIN). */
export type SpecialistRole = Exclude<AutoReportRole, 'MAIN'>

/** DSH orchestration/control names that AutoReport role policy classifies explicitly. */
export const DSH_ROLE_CONTROL_TOOL_NAMES = [
  'send_to_agent', 'ask_user_question', 'workflow', 'subagent', 'subagent_fork',
  'send_message', 'interrupt_agent', 'list_agents', 'todo_write',
] as const

/** Additional DSH execution/search names whose visibility must follow role policy. */
export const DSH_ROLE_ESCAPE_TOOL_NAMES = [...DSH_ROLE_CONTROL_TOOL_NAMES, 'glob', 'pwsh', 'bash'] as const

/** Explicit execution policy for one role (PLAN.md §2.2, execution-layer rev). */
export interface ReportRolePolicy {
  /** Logical workspace base (`.`); not the operating-system process CWD. */
  readonly cwd: string
  /** Directories the role may list names from; `'.'` is the whole workspace. */
  readonly discoverableRoots: readonly string[]
  /** Directories whose file contents the role may read. */
  readonly readableRoots: readonly string[]
  /** Directories role mutations may target; DSH sandbox workspaceRoot. */
  readonly writableRoots: readonly string[]
  /** Whether this role may use the role-aware foreground process tool. */
  readonly process: 'none' | 'role-aware'
  /** Additional executables allowed by the process preflight for this role. */
  readonly processCommands: readonly string[]
  /** DSH tool names exposed to this role after AutoReport compositions are joined. */
  readonly tools: readonly string[]
  /** Network posture: allowed. File writes stay confined by sandbox. */
  readonly network: 'allow'
  /** Private temporary area per process; never a shared world-writable dir. */
  readonly temp: 'private'
}

const MAIN_POLICY: ReportRolePolicy = {
  cwd: '.',
  // MAIN inventories the whole workspace and reviews outputs, but does not
  // read raw measurements or mutate specialist-owned results.
  discoverableRoots: ['.'],
  readableRoots: ['References', 'Outline', 'Theory', 'Data/Processed', 'Plots', 'Report'],
  writableRoots: ['Outline'],
  process: 'none',
  processCommands: [],
  tools: ['read', 'read_image', 'write', 'edit', 'delete', 'apply_patch', 'str_replace_editor', 'list', 'grep', 'skill', 'manifest', 'workflow_task', 'send_to_agent', 'ask_user_question', 'python_environment', 'reference_extract'],
  network: 'allow',
  temp: 'private',
}

const THEORY_POLICY: ReportRolePolicy = {
  cwd: '.',
  discoverableRoots: ['References', 'Outline', 'Theory'],
  readableRoots: ['References', 'Outline', 'Theory'],
  writableRoots: ['Theory'],
  process: 'none',
  processCommands: [],
  tools: ['read', 'read_image', 'write', 'edit', 'delete', 'apply_patch', 'str_replace_editor', 'list', 'grep', 'skill', 'manifest', 'report_workflow'],
  network: 'allow',
  temp: 'private',
}

const DATA_ANALYSIS_POLICY: ReportRolePolicy = {
  cwd: '.',
  discoverableRoots: ['References', 'Outline', 'Theory', 'Data'],
  readableRoots: ['References', 'Outline', 'Theory', 'Data'],
  writableRoots: ['Data/Processed'],
  process: 'role-aware',
  processCommands: ['node', 'pdfinfo', 'pdftotext', 'python', 'python3', 'uv'],
  tools: ['read', 'read_image', 'write', 'edit', 'delete', 'apply_patch', 'str_replace_editor', 'list', 'grep', 'skill', 'manifest', 'report_workflow', 'bash'],
  network: 'allow',
  temp: 'private',
}

const PLOTTING_POLICY: ReportRolePolicy = {
  cwd: '.',
  discoverableRoots: ['References', 'Outline', 'Theory', 'Data/Processed', 'Plots'],
  readableRoots: ['References', 'Outline', 'Theory', 'Data/Processed', 'Plots'],
  writableRoots: ['Plots'],
  process: 'role-aware',
  processCommands: ['gnuplot', 'node', 'pdfinfo', 'pdftotext', 'python', 'python3', 'uv'],
  tools: ['read', 'read_image', 'write', 'edit', 'delete', 'apply_patch', 'str_replace_editor', 'list', 'grep', 'skill', 'manifest', 'report_workflow', 'bash'],
  network: 'allow',
  temp: 'private',
}

const REPORT_POLICY: ReportRolePolicy = {
  cwd: '.',
  discoverableRoots: ['References', 'Outline', 'Theory', 'Data/Processed', 'Plots', 'Report'],
  readableRoots: ['References', 'Outline', 'Theory', 'Data/Processed', 'Plots', 'Report'],
  writableRoots: ['Report'],
  process: 'role-aware',
  processCommands: ['latexmk', 'pandoc', 'pdfinfo', 'pdflatex', 'pdftoppm', 'pdftotext', 'python', 'python3', 'qpdf', 'tectonic', 'typst', 'uv', 'xelatex'],
  tools: ['read', 'read_image', 'write', 'edit', 'delete', 'apply_patch', 'str_replace_editor', 'list', 'grep', 'skill', 'manifest', 'report_workflow', 'bash'],
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
