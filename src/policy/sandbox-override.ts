/**
 * Per-role `workspace-write` confinement without modifying DSH: wrap the
 * host sandbox-policy singleton so every enforcement consumer (fs tools,
 * bash/pwsh executors, terminal) resolves an AutoReport-owned session to its
 * role directory as the writable root. Stock sessions resolve unchanged, so
 * loading the overlay never widens or narrows third-party confinement.
 *
 * DSH resolves the policy at call time through the singleton's `resolve`
 * method on every enforcing path, so an in-place method wrap covers all of
 * them — including executors that cache the service instance but call
 * `resolve` per invocation. The wrap is installed once at host activation
 * and self-checked there: if the host policy rejects the replacement or the
 * wrap cannot influence the resolved root, the plugin fails loud rather than
 * silently running roles on the unconfined workspace root.
 *
 * @module autoreportdsh/policy/sandbox-override
 */

/** Synthetic session id used only by the activation self-check. */
export const SANDBOX_OVERRIDE_PROBE = 'autoreportdsh:sandbox-override-probe'

/** Marker identifying an already-wrapped resolve function. */
const WRAPPED = Symbol.for('autoreportdsh.sandbox-override')

/** Structural subset of the host sandbox-policy service the wrap touches. */
export interface SandboxOverrideService {
  resolve(request?: { session?: { id: unknown; header?: { cwd?: string } } }): {
    workspaceRoot?: string
  } & Record<string, unknown>
}

/** Wiring for {@link installSandboxOverride}. */
export interface SandboxOverrideOptions {
  /**
   * Absolute writable root for one resolved session, or `undefined` to keep
   * the base policy. Called only for real sessions; the self-check probe
   * never reaches it.
   */
  roleRootOf: (session: { id: unknown; header?: { cwd?: string } }) => string | undefined
  /**
   * Root the self-check expects back from a probe resolution. Install
   * resolves the probe session through the wrapped policy and fails loud
   * unless this exact root comes back, proving the wrap is live.
   */
  probeRoot: string
}

/**
 * Wrap the sandbox policy's `resolve` in place. Idempotent: installing over
 * an already-wrapped service is a no-op, so re-activation (HMR, tests) never
 * stacks wrappers.
 * @param policy - host sandbox-policy service.
 * @param options - role-root callback and self-check expectation.
 * @throws when the service refuses the wrap (frozen owner, replaced class)
 *   or when the self-check resolves anything but `probeRoot`.
 */
export function installSandboxOverride(policy: SandboxOverrideService, options: SandboxOverrideOptions): void {
  const current = policy.resolve as SandboxOverrideService['resolve'] & { [WRAPPED]?: boolean }
  if (current[WRAPPED] === true) return

  const base = current.bind(policy)
  const wrapped = (request?: { session?: { id: unknown; header?: { cwd?: string } } }) => {
    const sessionId = request?.session === undefined ? undefined : String(request.session.id)
    if (sessionId === SANDBOX_OVERRIDE_PROBE) {
      // Resolve the base WITHOUT the synthetic session: the host service may
      // fold real session objects through projections, and the probe carries
      // only its id.
      return { ...base({}), workspaceRoot: options.probeRoot }
    }
    const resolved = base(request)
    const session = request?.session
    if (sessionId === undefined || session === undefined) return resolved
    const header = session.header
    const roleRoot = options.roleRootOf({ id: session.id, ...(header === undefined ? {} : { header }) })
    if (roleRoot === undefined) return resolved
    return { ...resolved, workspaceRoot: roleRoot }
  }
  try {
    wrapped[WRAPPED] = true
    policy.resolve = wrapped
  } catch (error: unknown) {
    throw new Error(
      'autoreportdsh: the host sandbox policy rejected the workspace-root override; install a DSH release that permits in-process policy wrapping',
      { cause: error },
    )
  }

  const probe = policy.resolve({ session: { id: SANDBOX_OVERRIDE_PROBE } })
  if (probe.workspaceRoot !== options.probeRoot) {
    throw new Error(
      `autoreportdsh: sandbox override self-check failed; the host policy resolved ${JSON.stringify(probe.workspaceRoot)} instead of ${JSON.stringify(options.probeRoot)}`,
    )
  }
}
