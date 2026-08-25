/**
 * Synchronous authorization projection over role bindings (PLAN.md §2.3).
 * The registry is the ONLY thing the tool guard consults at execution time:
 * it answers from memory, never persistence, and fails closed on unknown
 * children.
 *
 * A RESERVED binding authorizes immediately — `startContinuable()` may begin
 * the child's first turn before the caller sees its acceptance result, so
 * waiting for an "active" phase inside a guard would race the first tool call.
 * Failed provisioning revokes; rebind swaps atomically.
 * @module
 */

import type { SessionId } from '@deepseek-ai/dsh-session'
import type { ReportRolePolicy, SpecialistRole } from '../roles.js'
import { rolePolicy } from '../roles.js'
import type { RoleBindingSnapshot, WorkflowMetaSnapshot } from './events.js'
import type { WorkflowState } from './service.js'

/** One authorization entry: durable identity plus resolved policy. */
export interface RegistryEntry {
  /** The binding snapshot backing this entry. */
  readonly binding: RoleBindingSnapshot
  /** The fixed policy for the entry's role. */
  readonly policy: ReportRolePolicy
}

/**
 * Child-id → role authorization map. All operations are synchronous and
 * side-effect-free beyond the map itself.
 */
export class RoleRegistry {
  private readonly entries = new Map<string, RegistryEntry>()

  /**
   * Install a reserved binding BEFORE child materialization.
   * @param binding - reservation snapshot (provisioning must not be `failed`).
   * @param policy - optional explicit policy override; defaults to the role's fixed table entry.
   * @throws when the child id already holds an entry or the binding is failed.
   */
  registerReserved(binding: RoleBindingSnapshot, policy?: ReportRolePolicy): void {
    if (binding.provisioning === 'failed') {
      throw new Error(`role-registry: refusing to register failed binding for ${binding.childSessionId}`)
    }
    if (this.entries.has(binding.childSessionId)) {
      throw new Error(`role-registry: child ${binding.childSessionId} already registered`)
    }
    this.entries.set(binding.childSessionId, {
      binding,
      policy: policy ?? rolePolicy(binding.role),
    })
  }

  /**
   * Transition one binding's provisioning to active after accepted start.
   * @param childSessionId - bound child id.
   * @throws when no entry exists.
   */
  markActive(childSessionId: SessionId): void {
    const entry = this.entries.get(childSessionId)
    if (entry === undefined) throw new Error(`role-registry: unknown child ${childSessionId}`)
    if (entry.binding.provisioning === 'active') return
    this.entries.set(childSessionId, {
      ...entry,
      binding: { ...entry.binding, provisioning: 'active' },
    })
  }

  /**
   * Remove authorization (failed provisioning, shutdown).
   * @param childSessionId - child id to revoke.
   * @returns whether an entry was removed.
   */
  revoke(childSessionId: SessionId): boolean {
    return this.entries.delete(childSessionId)
  }

  /**
   * Fail-closed lookup used by guards.
   * @param childSessionId - live child session id.
   * @returns the entry, or undefined when the child is unbound.
   */
  lookup(childSessionId: SessionId | string): RegistryEntry | undefined {
    return this.entries.get(childSessionId)
  }

  /**
   * Atomic rebind per the PLAN recovery rule: install the replacement before
   * dropping the old id, so the role is never unbound mid-swap. The old child
   * loses authorization in the same synchronous step.
   * @param role - specialist role being rebound.
   * @param oldChildId - previous child id (must currently be registered for `role`).
   * @param newBinding - replacement reservation.
   * @throws when the old id is absent or bound to another role.
   */
  rebind(role: SpecialistRole, oldChildId: SessionId, newBinding: RoleBindingSnapshot): void {
    const old = this.entries.get(oldChildId)
    if (old === undefined) throw new Error(`role-registry: cannot rebind unknown child ${oldChildId}`)
    if (old.binding.role !== role) {
      throw new Error(`role-registry: child ${oldChildId} is bound to ${old.binding.role}, not ${role}`)
    }
    if (this.entries.has(newBinding.childSessionId)) {
      throw new Error(`role-registry: replacement child ${newBinding.childSessionId} already registered`)
    }
    this.entries.set(newBinding.childSessionId, {
      binding: newBinding,
      policy: rolePolicy(newBinding.role),
    })
    this.entries.delete(oldChildId)
  }

  /**
   * Rebuild the registry from folded state after cold load/resume. Failed
   * bindings authorize nothing and are skipped; superseded bindings were
   * already replaced in {@link WorkflowState} by their successors.
   * @param state - folded workflow state.
   * @param meta - workflow metadata supplying the expected workflowId filter; undefined accepts all.
   * @returns a fresh registry.
   */
  static reconstruct(state: WorkflowState, meta?: WorkflowMetaSnapshot | undefined): RoleRegistry {
    const registry = new RoleRegistry()
    for (const binding of state.projection().bindingsByRole.values()) {
      if (binding.provisioning === 'failed') continue
      if (meta !== undefined && binding.workflowId !== meta.workflowId) continue
      registry.registerReserved(binding)
    }
    return registry
  }
}
