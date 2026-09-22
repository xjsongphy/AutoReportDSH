/**
 * AutoReportDSH host-plane plugin entry.
 *
 * Overlay composition loads `src/host.ts` by absolute path so the global
 * report router can sit in a sibling row. Tests and the package export keep
 * this `index` module as the loadable plugin name `autoreport`.
 *
 * @module autoreport
 */

export { apply, inject, resolveHostConfig } from './host.js'
export { name as hostName } from './host.js'

export const name = 'autoreport'
