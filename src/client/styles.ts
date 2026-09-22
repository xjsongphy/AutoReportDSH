/**
 * Styles for the AutoReport settings card. Prefixed class names so this
 * out-of-tree bundle does not share DSH's CSS-modules hasher.
 */

const STYLE_ID = 'autoreport-settings-card'

/** Class names consumed by the card chrome and field controls. */
export const css = {
  page: 'ar-page',
  section: 'ar-section',
  sectionTitle: 'ar-section-title',
  actions: 'ar-actions',
  projects: 'ar-projects',
  projectsTitle: 'ar-projects-title',
  listGroup: 'ar-list-group',
  listTitle: 'ar-list-title',
  list: 'ar-list',
  listItem: 'ar-list-item',
  listText: 'ar-list-text',
  listName: 'ar-list-name',
  listPath: 'ar-list-path',
  listEmpty: 'ar-list-empty',
  minus: 'ar-minus',
  readOnly: 'ar-readonly',
  failed: 'ar-failed',
  discard: 'ar-discard',
  save: 'ar-save',
  field: 'ar-field',
  grid: 'ar-grid',
  fieldSplit: 'ar-field-split',
  fieldText: 'ar-field-text',
  fieldHead: 'ar-field-head',
  label: 'ar-field-label',
  badges: 'ar-field-badges',
  badge: 'ar-field-badge',
  reset: 'ar-field-reset',
  input: 'ar-field-input',
  inputInvalid: 'ar-field-input-invalid',
  hint: 'ar-field-hint',
  invalid: 'ar-field-invalid',
  statusList: 'ar-field-status-list',
  statusItem: 'ar-field-status-item',
  statusGood: 'ar-field-status-good',
  statusBad: 'ar-field-status-bad',
  statusName: 'ar-field-status-name',
  statusValue: 'ar-field-status-value',
  selectRoot: 'ar-select-root',
  selector: 'ar-selector',
  selectorLabel: 'ar-selector-label',
  selectorChevron: 'ar-selector-chevron',
  selectorChevronOpen: 'ar-selector-chevron-open',
  selectorInvalid: 'ar-selector-invalid',
  selectorOpen: 'ar-selector-open',
  menu: 'ar-menu',
  menuCompact: 'ar-menu-compact',
  menuItem: 'ar-menu-item',
  menuItemSelected: 'ar-menu-item-selected',
  menuItemLabel: 'ar-menu-item-label',
  menuCheck: 'ar-menu-check',
  subagentModel: 'ar-subagent-model',
  subagentModelLabel: 'ar-subagent-model-label',
  chipTrigger: 'ar-chip-trigger',
  chipTriggerLabel: 'ar-chip-trigger-label',
  toolSummary: 'ar-tool-summary',
  toolSummaryFailed: 'ar-tool-summary-failed',
  toolState: 'ar-tool-state',
  toolIo: 'ar-tool-io',
  toolIoBlock: 'ar-tool-io-block',
  toolIoLabel: 'ar-tool-io-label',
  toolIoBody: 'ar-tool-io-body',
  toolInspect: 'ar-tool-inspect',
} as const

const STYLESHEET = `
.${css.page} {
  display: flex;
  flex-direction: column;
  gap: 24px;
  max-width: 640px;
}
.${css.section} {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.${css.sectionTitle} {
  margin: 0 0 6px;
  font-size: 14px;
  font-weight: 600;
  line-height: 22px;
  color: var(--dsw-alias-label-primary);
}
.${css.actions} {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
}
.${css.projects} {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 10px 0;
}
.${css.projectsTitle} {
  margin: 0;
  font-size: 14px;
  font-weight: 400;
  line-height: 22px;
  color: var(--dsw-alias-label-primary);
}
.${css.listGroup} {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.${css.listTitle} {
  margin: 0;
  font-size: 12px;
  font-weight: 500;
  line-height: 18px;
  letter-spacing: .02em;
  color: var(--dsw-alias-label-tertiary);
}
.${css.list} {
  display: flex;
  flex-direction: column;
  margin: 0;
  padding: 0;
  list-style: none;
}
.${css.listItem} {
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 40px;
}
.${css.listText} {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: baseline;
  gap: 8px;
}
.${css.listName} {
  flex: none;
  max-width: 50%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 14px;
  line-height: 22px;
  color: var(--dsw-alias-label-primary);
}
.${css.listPath} {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-tertiary);
}
.${css.listEmpty} {
  margin: 0;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-tertiary);
}
.${css.minus} {
  flex: none;
  width: 28px;
  height: 28px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: 14px;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  font-size: 16px;
  line-height: 1;
  cursor: pointer;
}
.${css.minus}:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary);
}
.${css.minus}:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px var(--dsw-alias-border-l3);
}
.${css.minus}:disabled {
  color: var(--dsw-alias-label-tertiary);
  cursor: default;
}
.${css.readOnly} {
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--dsw-alias-label-tertiary);
}
.${css.failed} {
  flex: 1;
  min-width: 0;
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--dsw-alias-label-error);
}
.${css.discard}, .${css.save} {
  appearance: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: 36px;
  border: 1px solid transparent;
  border-radius: 18px;
  padding: 0 14px;
  font: inherit;
  font-size: 14px;
  line-height: 22px;
  cursor: pointer;
}
.${css.discard} {
  border-color: var(--dsw-alias-border-l2);
  background: none;
  color: var(--dsw-alias-label-secondary);
}
.${css.discard}:hover:not(:disabled) {
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-interactive-bg-hover);
}
.${css.save} {
  background: var(--dsw-alias-button-primary-fill, var(--dsw-alias-label-primary));
  color: var(--dsw-alias-label-primary-foreground, var(--dsw-alias-bg-layer-3));
}
.${css.save}:hover:not(:disabled) {
  background: var(--dsw-alias-button-primary-hover, var(--dsw-alias-label-primary));
}
.${css.discard}:disabled, .${css.save}:disabled {
  opacity: 0.4;
  cursor: default;
}
.${css.discard}:focus-visible, .${css.save}:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary);
  outline-offset: 1px;
}
.${css.field} {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 0;
}
.${css.grid} {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0 24px;
}
.${css.fieldSplit} {
  display: flex;
  align-items: center;
  gap: 8px;
}
.${css.fieldText} {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding-right: 16px;
}
.${css.fieldHead} {
  display: flex;
  align-items: center;
  gap: 8px;
}
.${css.label} {
  flex: 1;
  min-width: 0;
  font-size: 14px;
  font-weight: 400;
  line-height: 22px;
  color: var(--dsw-alias-label-primary);
}
.${css.badges} {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}
.${css.badge} {
  border-radius: 999px;
  padding: 1px 8px;
  font-size: 11px;
  line-height: 17px;
  white-space: nowrap;
  font-weight: 500;
  background: var(--dsw-alias-bg-module-platform);
  color: var(--dsw-alias-label-secondary);
}
.${css.reset} {
  border: none;
  background: none;
  padding: 0;
  font: inherit;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-secondary);
  cursor: pointer;
}
.${css.reset}:hover:not(:disabled) { color: var(--dsw-alias-label-primary); }
.${css.reset}:disabled { cursor: default; }
.${css.input} {
  box-sizing: border-box;
  width: 100%;
  height: 36px;
  padding: 0 14px;
  border: none;
  border-radius: 18px;
  background: var(--dsw-alias-bg-module-platform);
  font: inherit;
  font-size: 14px;
  line-height: 22px;
  color: var(--dsw-alias-label-primary);
}
.${css.input}:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover);
}
.${css.input}:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px var(--dsw-alias-border-l3);
}
.${css.input}:disabled {
  color: var(--dsw-alias-label-tertiary);
  cursor: default;
}
.${css.inputInvalid} { box-shadow: 0 0 0 1px var(--dsw-alias-label-error); }
.${css.invalid} {
  margin: 0;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-error);
}
.${css.hint} {
  margin: 0;
  font-size: 12px;
  font-weight: 400;
  line-height: 18px;
  color: var(--dsw-alias-label-tertiary);
}
.${css.statusList} {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 2px 0;
}
.${css.statusItem} {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 22px;
  font-size: 13px;
  line-height: 20px;
}
.${css.statusGood}, .${css.statusBad} {
  flex: none;
  font-size: 10px;
  line-height: 1;
}
.${css.statusGood} { color: var(--dsw-alias-label-success, #2e9b63); }
.${css.statusBad} { color: var(--dsw-alias-label-error); }
.${css.statusName} {
  min-width: 96px;
  color: var(--dsw-alias-label-secondary);
}
.${css.statusValue} {
  color: var(--dsw-alias-label-primary);
}
.${css.selectRoot} {
  position: relative;
  display: inline-flex;
  flex: none;
  max-width: min(280px, 52%);
}
.${css.selector} {
  display: inline-flex;
  align-items: center;
  gap: 12px;
  max-width: 100%;
  height: 36px;
  padding: 0 14px;
  border: none;
  border-radius: 18px;
  background: var(--dsw-alias-bg-module-platform);
  font: inherit;
  font-size: 14px;
  line-height: 22px;
  color: var(--dsw-alias-label-primary);
  cursor: pointer;
}
.${css.selector}:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover);
}
.${css.selector}:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px var(--dsw-alias-border-l3);
}
.${css.selector}:disabled {
  color: var(--dsw-alias-label-tertiary);
  cursor: default;
}
.${css.selectorLabel} {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.${css.selectorChevron} {
  flex: none;
  color: var(--dsw-alias-label-caption, var(--dsw-alias-label-tertiary));
  transition: transform 120ms ease;
}
.${css.selectorChevronOpen} { transform: rotate(180deg); }
.${css.selectorInvalid} { box-shadow: 0 0 0 1px var(--dsw-alias-label-error); }
.${css.menu} {
  box-sizing: border-box;
  position: fixed;
  z-index: 1100;
  min-width: 218px;
  max-width: min(360px, calc(100vw - 24px));
  max-height: calc(100vh - 24px);
  overflow-y: auto;
  padding: 4px;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--dsw-alias-border-inverted);
  border-radius: 12px;
  background: var(--dsw-specific-menu, var(--dsw-alias-bg-layer-3));
  box-shadow: var(--dsw-shadow-lv3);
  --dsh-scrollbar-thumb: var(--dsw-alias-scrollbar-bg-l2);
  --dsh-scrollbar-thumb-hover: var(--dsw-alias-scrollbar-hover-l2);
}
.${css.menuCompact} {
  min-width: 164px;
  padding: 2px;
  border-radius: 7px;
}
.${css.menuItem} {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-height: 40px;
  padding: 8px 10px;
  border: none;
  border-radius: 10px;
  background: transparent;
  cursor: pointer;
  font: inherit;
  font-size: 14px;
  line-height: 22px;
  color: var(--dsw-alias-label-primary);
  text-align: left;
}
.${css.menuItem}:hover {
  background: var(--dsw-alias-interactive-bg-hover);
}
.${css.menuCompact} .${css.menuItem} {
  min-height: 26px;
  gap: 6px;
  padding: 3px 7px;
  border-radius: 5px;
  font-size: 12px;
  line-height: 18px;
}
.${css.menuItemLabel} {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.${css.menuCheck} {
  flex: none;
  color: var(--dsw-alias-label-primary);
}
.${css.subagentModel} {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  max-width: 100%;
}
.${css.subagentModel} .${css.selectRoot} {
  max-width: 220px;
  max-width: min(360px, 45cqw);
}
.${css.subagentModelLabel} {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
}
.${css.chipTrigger} {
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
  max-width: 100%;
  height: 28px;
  padding: 0 4px 0 8px;
  border: none;
  border-radius: 24px;
  outline: none;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  font-size: 13px;
  line-height: 20px;
  font-weight: 500;
  cursor: pointer;
}
.${css.chipTrigger}:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover);
}
.${css.chipTrigger}:focus-visible {
  box-shadow: 0 0 0 2px var(--dsw-alias-border-l3);
}
.${css.chipTrigger}:disabled {
  color: var(--dsw-alias-label-dimmed, var(--dsw-alias-label-tertiary));
  cursor: default;
}
.${css.chipTriggerLabel} {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* AutoReport tool rows. The collapsed chrome belongs to DSH's DisclosureRow;
   these rules cover only the summary text and the expanded IN/OUT card. */

.${css.toolSummary} {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--dsw-alias-label-secondary);
}
.${css.toolSummaryFailed} {
  color: var(--dsw-alias-label-error);
}
.${css.toolState} {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
  border: 0;
}
.${css.toolIo} {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 4px 0 8px 24px;
  padding: 8px 10px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-2);
}
.${css.toolIoBlock} {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
.${css.toolIoLabel} {
  color: var(--dsw-alias-label-caption);
  font: var(--dsw-font-xs-13);
  letter-spacing: 0.04em;
  text-transform: uppercase;
}
.${css.toolIoBody} {
  margin: 0;
  max-height: 240px;
  overflow: auto;
  color: var(--dsw-alias-label-primary);
  font: var(--dsw-font-markdown-code-block-small);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.${css.toolInspect} {
  align-self: flex-start;
  padding: 2px 8px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 6px;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font: var(--dsw-font-xs-13);
  cursor: pointer;
}
.${css.toolInspect}:hover {
  background: var(--dsw-alias-interactive-bg-hover);
}
`

/**
 * Inject the card stylesheet once. Safe to call from apply() and from tests.
 */
export function installCardStyles(): void {
  if (typeof document === 'undefined') return
  if (document.querySelector(`style[data-plugin-css=${JSON.stringify(STYLE_ID)}]`)) return
  const tag = document.createElement('style')
  tag.dataset.plugin = 'autoreport'
  tag.dataset.pluginCss = STYLE_ID
  tag.textContent = STYLESHEET
  document.head.appendChild(tag)
}
