/**
 * Staged settings-card form. Copied in spirit from DSH's plugin-card form:
 * out-of-tree cards cannot value-import that module (bundle-purity gate).
 *
 * Nested keys (`parent.child`) stage independently but save as one parent
 * object write, which is how `specialistModel` is edited without flattening
 * the Host schema.
 */

import type { SettingsScope, SettingsScopeSnapshot, SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'

/** The write one field's staged text performs when the card is saved. */
export type FieldWrite =
  | { kind: 'set'; value: unknown }
  | { kind: 'clear' }

/** How one section field converts between its stored value and its draft text. */
export interface CardFieldSpec {
  /** Field name inside the namespace section, or `parent.child` for a nested key. */
  field: string
  /** Render a stored value as draft text; the empty string when the section carries none. */
  format: (value: unknown) => string
  /**
   * The write this draft text stages, or undefined when the text is not a
   * value this field accepts — which blocks the save rather than discarding it.
   */
  parse: (text: string) => FieldWrite | undefined
}

/** One field as a card's control renders it. */
export interface CardFieldState {
  /** Draft text the control renders. */
  text: string
  /** Whether saving would leave a user-layer entry for this field. */
  overridden: boolean
  /** Whether the draft is not a value this field accepts, which blocks saving. */
  invalid: boolean
}

/** Form state every plugin card shares. */
export interface CardShell {
  /** False while the namespace is not served to this client; the card renders nothing. */
  available: boolean
  /** Whether the Host document accepts writes. */
  writable: boolean
  /** Whether the form holds edits that a save would write. */
  dirty: boolean
  /** Whether any staged draft is invalid, which blocks the save. */
  invalid: boolean
  /** Whether a save is crossing the wire. */
  saving: boolean
  /** Whether the last save did not land as staged; cleared by the next edit or save. */
  failed: boolean
}

/** The write actions every plugin card's slot entry injects. */
export interface CardActions {
  /** Stage draft text for one field. */
  edit: (field: string, text: string) => void
  /** Stage a clear, so saving lets the field re-inherit the composition layer. */
  resetField: (field: string) => void
  /** Write every staged edit, then re-seed from what the Host accepted. */
  save: () => void
  /** Drop every staged edit. */
  discard: () => void
}

/** One field's staged edit. */
interface StagedEdit {
  /** Draft text the control renders. */
  text: string
  /** True when this edit clears the field whatever text it shows. */
  clear: boolean
}

/** One staged edit resolved into the write a save performs. */
interface PlannedWrite {
  /** Field this entry writes (top-level namespace key). */
  field: string
  /**
   * Perform the write and report whether the Host holds the staged value
   * afterwards; undefined when the draft is not a value the field accepts.
   */
  run: (() => Promise<boolean>) | undefined
}

/**
 * A whole-number field. An empty draft clears the field; any other draft that
 * is not a positive integer blocks the save.
 * @param field - field name inside the namespace section.
 * @returns the field's conversion spec.
 */
export function numberField(field: string): CardFieldSpec {
  return {
    field,
    format: value => typeof value === 'number' ? String(value) : '',
    parse: (text) => {
      const trimmed = text.trim()
      if (trimmed === '') return { kind: 'clear' }
      const parsed = Number(trimmed)
      return Number.isSafeInteger(parsed) && parsed >= 1 ? { kind: 'set', value: parsed } : undefined
    },
  }
}

/**
 * A free-text field. An empty draft clears the field, so emptying the control
 * and saving is the same gesture as resetting it.
 * @param field - field name inside the namespace section.
 * @returns the field's conversion spec.
 */
export function textField(field: string): CardFieldSpec {
  return {
    field,
    format: value => typeof value === 'string' ? value : '',
    parse: (text) => {
      const trimmed = text.trim()
      return trimmed === '' ? { kind: 'clear' } : { kind: 'set', value: trimmed }
    },
  }
}

/**
 * A closed-set field. An empty draft clears the field; any other draft that
 * is not in `allowed` blocks the save.
 * @param field - field name inside the namespace section.
 * @param allowed - accepted stored values.
 * @returns the field's conversion spec.
 */
export function enumField(field: string, allowed: readonly string[]): CardFieldSpec {
  return {
    field,
    format: value => typeof value === 'string' ? value : '',
    parse: (text) => {
      const trimmed = text.trim()
      if (trimmed === '') return { kind: 'clear' }
      return allowed.includes(trimmed) ? { kind: 'set', value: trimmed } : undefined
    },
  }
}

/**
 * A snapshot store that does not pull DSH's lazy-CJS `/client` bundle.
 * Node tests cannot evaluate `window.__ModuleLoader__`; the card only needs
 * subscribe / getSnapshot / set.
 * @param init - initial projected state.
 * @returns a writable snapshot store.
 */
function createProjectionStore<S>(init: S): SnapshotStore<S> {
  let snapshot = init
  const listeners = new Set<() => void>()
  const notify = (): void => {
    for (const listener of [...listeners]) listener()
  }
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    set: (next) => {
      snapshot = next
      notify()
    },
    update: (mutator) => {
      const draft = { ...snapshot }
      mutator(draft)
      snapshot = draft
      notify()
    },
  }
}

/** Split a `parent.child` field name; undefined when the name is top-level. */
function nestedParts(field: string): { parent: string; key: string } | undefined {
  const dot = field.indexOf('.')
  if (dot <= 0 || dot === field.length - 1) return undefined
  return { parent: field.slice(0, dot), key: field.slice(dot + 1) }
}

/**
 * Stages one card's edits over one settings namespace and writes them on save.
 */
export class CardForm<T> {
  private readonly specs: Map<string, CardFieldSpec>
  private readonly staged = new Map<string, StagedEdit>()
  private readonly listeners = new Set<() => void>()
  private saving = false
  private failed = false

  /**
   * @param scope - the bound settings scope for this card's namespace.
   * @param specs - the section fields this card edits.
   */
  constructor(
    private readonly scope: SettingsScope<T>,
    specs: CardFieldSpec[],
  ) {
    this.specs = new Map(specs.map(spec => [spec.field, spec]))
    scope.subscribe(() => { this.publish() })
  }

  /**
   * Publish a projection of this form, rebuilt whenever the scope or a draft changes.
   * @param project - build the card's state from the form's current reads.
   * @returns the store the card's component reads through its bound selector.
   */
  bind<S>(project: () => S): SnapshotStore<S> {
    const store = createProjectionStore(project())
    this.listeners.add(() => { store.set(project()) })
    return store
  }

  /**
   * Read the card-level state: what the Host serves, and what a save would do.
   * @returns the form state every card shares.
   */
  shell(): CardShell {
    const snapshot = this.scope.getSnapshot()
    const plan = this.plan()
    return {
      available: snapshot.status === 'ready',
      writable: snapshot.writable,
      dirty: plan.length > 0,
      invalid: plan.some(item => item.run === undefined),
      saving: this.saving,
      failed: this.failed,
    }
  }

  /**
   * Read one control's state.
   * @param field - field name of a section field.
   * @returns the draft text, whether a save would leave an override, and whether it is invalid.
   */
  field(field: string): CardFieldState {
    const spec = this.spec(field)
    const staged = this.staged.get(field)
    if (staged === undefined) {
      return { text: spec.format(this.sectionValue(field)), overridden: this.stored(field), invalid: false }
    }
    const write = staged.clear ? { kind: 'clear' as const } : spec.parse(staged.text)
    return {
      text: staged.text,
      overridden: write?.kind === 'set',
      invalid: write === undefined,
    }
  }

  /**
   * Build the edit, reset, save, and discard actions bound to this form.
   * @returns the actions a card's slot entry injects.
   */
  actions(): CardActions {
    return {
      edit: (field, text) => { this.stage(field, { text, clear: false }) },
      resetField: (field) => {
        const nested = nestedParts(field)
        if (nested === undefined) {
          this.stage(field, { text: this.spec(field).format(this.baseValue(field)), clear: true })
          return
        }
        // Nested keys share one user-layer object. Resetting any child
        // stages a clear of the whole parent so the route re-inherits.
        for (const spec of this.specs.values()) {
          const parts = nestedParts(spec.field)
          if (parts?.parent !== nested.parent) continue
          this.stage(spec.field, { text: spec.format(this.baseValue(spec.field)), clear: true })
        }
      },
      save: () => { void this.save() },
      discard: () => {
        if (this.staged.size === 0 && !this.failed) return
        this.staged.clear()
        this.failed = false
        this.publish()
      },
    }
  }

  /**
   * Write every staged edit, then re-seed from what the Host accepted.
   * @returns settlement after every write and the read-back.
   */
  async save(): Promise<void> {
    const plan = this.plan()
    const writes = plan.flatMap(item => item.run === undefined ? [] : [item.run])
    if (plan.length === 0 || this.saving || writes.length !== plan.length) return
    this.saving = true
    this.failed = false
    this.publish()
    let landed = true
    for (const write of writes) {
      landed = await write() && landed
    }
    if (landed) this.staged.clear()
    this.saving = false
    this.failed = !landed
    this.publish()
  }

  /**
   * Every staged edit a save would write. Nested children of one parent
   * collapse into a single parent-object write.
   * @returns the planned writes, in the order the fields were staged.
   */
  private plan(): PlannedWrite[] {
    const plan: PlannedWrite[] = []
    const nestedParents = new Set<string>()
    for (const [field, staged] of this.staged) {
      const nested = nestedParts(field)
      if (nested !== undefined) {
        nestedParents.add(nested.parent)
        continue
      }
      const spec = this.spec(field)
      if (staged.clear) {
        if (this.stored(field)) plan.push({ field, run: () => this.clear(field) })
        continue
      }
      if (staged.text === spec.format(this.sectionValue(field))) continue
      const write = spec.parse(staged.text)
      if (write === undefined) plan.push({ field, run: undefined })
      else if (write.kind === 'clear') plan.push({ field, run: () => this.clear(field) })
      else plan.push({ field, run: () => this.store(field, write.value) })
    }
    for (const parent of nestedParents) {
      plan.push(this.planNested(parent))
    }
    return plan
  }

  /**
   * Collapse every staged child of `parent` into one object write or clear.
   * @param parent - top-level object field name.
   * @returns the planned parent write.
   */
  private planNested(parent: string): PlannedWrite {
    const next: Record<string, unknown> = {}
    const current = this.topLevelValue(parent)
    if (current !== undefined && typeof current === 'object' && current !== null && !Array.isArray(current)) {
      Object.assign(next, current)
    }
    let invalid = false
    let clearing = true
    for (const spec of this.specs.values()) {
      const nested = nestedParts(spec.field)
      if (nested?.parent !== parent) continue
      const staged = this.staged.get(spec.field)
      if (staged === undefined) {
        if (next[nested.key] !== undefined && next[nested.key] !== '') clearing = false
        continue
      }
      if (staged.clear) {
        delete next[nested.key]
        continue
      }
      const write = spec.parse(staged.text)
      if (write === undefined) {
        invalid = true
        continue
      }
      if (write.kind === 'clear') delete next[nested.key]
      else {
        next[nested.key] = write.value
        clearing = false
      }
    }
    if (invalid) return { field: parent, run: undefined }
    const compact = Object.fromEntries(
      Object.entries(next).filter(([, value]) => value !== undefined && value !== ''),
    )
    if (parent === 'specialistModel' && !isCompleteRoute(compact)) {
      return { field: parent, run: undefined }
    }
    if (clearing || Object.keys(compact).length === 0) {
      if (!this.topLevelStored(parent)) return { field: parent, run: () => Promise.resolve(true) }
      return { field: parent, run: () => this.clear(parent) }
    }
    if (this.sameJson(compact, current) && this.topLevelStored(parent)) {
      return { field: parent, run: () => Promise.resolve(true) }
    }
    return { field: parent, run: () => this.store(parent, compact) }
  }

  private async clear(field: string): Promise<boolean> {
    await this.scope.unset(field)
    return !this.topLevelStored(field)
  }

  private async store(field: string, value: unknown): Promise<boolean> {
    await this.scope.set(field, value)
    return this.sameJson(this.topLevelUserValue(field), value)
  }

  private stage(field: string, edit: StagedEdit): void {
    this.staged.set(field, edit)
    this.failed = false
    this.publish()
  }

  private spec(field: string): CardFieldSpec {
    const spec = this.specs.get(field)
    if (spec === undefined) throw new Error(`plugin card has no field ${field}`)
    return spec
  }

  private snapshotOf(): SettingsScopeSnapshot<T> {
    return this.scope.getSnapshot()
  }

  private sectionValue(field: string): unknown {
    const nested = nestedParts(field)
    if (nested === undefined) return this.topLevelValue(field)
    const parent = this.topLevelValue(nested.parent)
    if (parent === undefined || typeof parent !== 'object' || parent === null) return undefined
    return (parent as Record<string, unknown>)[nested.key]
  }

  private baseValue(field: string): unknown {
    const nested = nestedParts(field)
    const base = this.snapshotOf().base as Record<string, unknown> | undefined
    if (nested === undefined) return base?.[field]
    const parent = base?.[nested.parent]
    if (parent === undefined || typeof parent !== 'object' || parent === null) return undefined
    return (parent as Record<string, unknown>)[nested.key]
  }

  private topLevelValue(field: string): unknown {
    return (this.snapshotOf().value as Record<string, unknown> | undefined)?.[field]
  }

  private topLevelUserValue(field: string): unknown {
    return this.userLayer()?.[field]
  }

  private userLayer(): Record<string, unknown> | undefined {
    return this.snapshotOf().user as Record<string, unknown> | undefined
  }

  private stored(field: string): boolean {
    const nested = nestedParts(field)
    return this.topLevelStored(nested === undefined ? field : nested.parent)
  }

  private topLevelStored(field: string): boolean {
    const user = this.userLayer()
    return user !== undefined && Object.hasOwn(user, field)
  }

  private sameJson(left: unknown, right: unknown): boolean {
    return JSON.stringify(left) === JSON.stringify(right)
  }

  private publish(): void {
    for (const listener of this.listeners) listener()
  }
}

/** A specialist route is either absent or a complete provider+model pair. */
function isCompleteRoute(value: Record<string, unknown>): boolean {
  const provider = typeof value.provider === 'string' ? value.provider : ''
  const model = typeof value.model === 'string' ? value.model : ''
  if (provider.length === 0 && model.length === 0) return Object.keys(value).length === 0
  return provider.length > 0 && model.length > 0
}
