/**
 * The fixed five-role AutoReport table. The permission model is deliberately
 * minimal (three facts per role):
 *
 * 1. Read permission does not express role boundaries — every role can read
 *    the whole experiment workspace. Whether a role "should" analyze data or
 *    write the report is persona guidance, not an ACL.
 * 2. The single writable root is the real sandbox boundary. DSH's native
 *    `workspace-write` sandbox (rooted at the writable root) enforces it for
 *    processes and file tools; `write`/`edit` re-check the target once.
 * 3. Tools differ only by "does this role need to execute code": THEORY and
 *    MAIN get no process tool; the other specialists get the platform shell.
 *
 * All model-facing paths are experiment-workspace-relative, including shell
 * CWD, which starts at the workspace root. The writable root is enforcement,
 * not navigation.
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
export const DSH_ROLE_ESCAPE_TOOL_NAMES = [...DSH_ROLE_CONTROL_TOOL_NAMES, 'glob', 'pwsh', 'bash', 'install_python_package'] as const

/** DSH's base composition mounts Bash on Unix and PowerShell on Windows. */
export const ROLE_PROCESS_TOOL = process.platform === 'win32' ? 'pwsh' : 'bash'

/** File tools every role receives; paths are workspace-relative. */
export const BASE_TOOLS = [
  'read', 'list', 'grep', 'read_image', 'write', 'edit',
] as const

/**
 * DSH's skill-catalog loader. Only roles whose scope registers bundled skills
 * keep it (`skillNamesForRole`): a loader over an empty catalog can only
 * invite invented skill names.
 */
export const SKILL_TOOL = 'skill'

/** Coordination/protocol tools MAIN uses to orchestrate the workflow. */
const MAIN_COORDINATOR_TOOLS = [
  'manifest', 'workflow_task', 'send_to_agent', 'ask_user_question',
  'extract_pdf', 'install_python_package',
] as const

/** Shared handoff-protocol tools for specialist roles. */
const SPECIALIST_PROTOCOL_TOOLS = ['manifest', 'report_workflow'] as const

/** Explicit policy for one role: the whole authorization surface. */
export interface ReportRolePolicy {
  /** The role's only writable directory (workspace-relative); the DSH sandbox root. */
  readonly writableRoot: string
  /** Whether this role may execute code through the platform shell. */
  readonly hasProcessTool: boolean
  /** DSH tool names exposed to this role after AutoReport compositions are joined. */
  readonly tools: readonly string[]
}

const MAIN_POLICY: ReportRolePolicy = {
  writableRoot: 'Outline',
  hasProcessTool: false,
  tools: [...BASE_TOOLS, SKILL_TOOL, ...MAIN_COORDINATOR_TOOLS],
}

const THEORY_POLICY: ReportRolePolicy = {
  writableRoot: 'Theory',
  hasProcessTool: false,
  tools: [...BASE_TOOLS, ...SPECIALIST_PROTOCOL_TOOLS],
}

const DATA_ANALYSIS_POLICY: ReportRolePolicy = {
  writableRoot: 'Data/Processed',
  hasProcessTool: true,
  tools: [...BASE_TOOLS, ...SPECIALIST_PROTOCOL_TOOLS, ROLE_PROCESS_TOOL],
}

const PLOTTING_POLICY: ReportRolePolicy = {
  writableRoot: 'Plots',
  hasProcessTool: true,
  tools: [...BASE_TOOLS, SKILL_TOOL, ...SPECIALIST_PROTOCOL_TOOLS, ROLE_PROCESS_TOOL],
}

const REPORT_POLICY: ReportRolePolicy = {
  writableRoot: 'Report',
  hasProcessTool: false,
  tools: [...BASE_TOOLS, SKILL_TOOL, ...SPECIALIST_PROTOCOL_TOOLS, 'compile_report', 'render_report_page'],
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
