/**
 * Pending-call views for AutoReport's tools.
 *
 * `ToolDefinition.presentCall` speaks DSH's provider-neutral render-intent
 * vocabulary: a client maps the declared card into its own chrome without
 * special-casing tool names. All four AutoReport tools want the same card — a
 * titled row over one salient argument — so they share this builder instead of
 * restating the union.
 *
 * The Web client does not read these values: it derives its rows from the wire
 * call. Declaring them still matters, because `rawInput`'s contract is the ONE
 * input a reader wants (`NOT the full raw args object`), and a second client
 * has no way to narrow a leaked argument dump.
 *
 * @module autoreportdsh/presentation
 */

import type { GenericCallView } from '@deepseek-ai/dsh-tools'

/**
 * The default tool-call card: a titled row over one salient input.
 * @param title - what THIS call does, shown as the row header.
 * @param rawInput - the single argument worth showing, or undefined to show none.
 * @returns the generic call view.
 */
export function genericCall(title: string, rawInput: unknown): GenericCallView {
  return {
    card: 'generic',
    kind: 'other',
    title,
    // Omitted rather than set to undefined: the contract reads "omit to show
    // nothing", and an explicit undefined would be a value a client must filter.
    ...rawInput === undefined ? {} : { rawInput },
  }
}
