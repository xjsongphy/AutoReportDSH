/**
 * Styles for the AutoReport settings card. Prefixed class names so this
 * out-of-tree bundle does not share DSH's CSS-modules hasher.
 */

const STYLE_ID = 'autoreportdsh-settings-card'

/** Class names consumed by the card chrome and field controls. */
export const css = {
  card: 'ar-card',
  cardOpen: 'ar-card-open',
  header: 'ar-card-header',
  headText: 'ar-card-head-text',
  name: 'ar-card-name',
  description: 'ar-card-description',
  pending: 'ar-card-pending',
  chevron: 'ar-card-chevron',
  chevronOpen: 'ar-card-chevron-open',
  body: 'ar-card-body',
  readOnly: 'ar-card-readonly',
  footer: 'ar-card-footer',
  failed: 'ar-card-failed',
  discard: 'ar-card-discard',
  save: 'ar-card-save',
  field: 'ar-field',
  fieldHead: 'ar-field-head',
  label: 'ar-field-label',
  badges: 'ar-field-badges',
  badge: 'ar-field-badge',
  reset: 'ar-field-reset',
  input: 'ar-field-input',
  inputInvalid: 'ar-field-input-invalid',
  hint: 'ar-field-hint',
  invalid: 'ar-field-invalid',
} as const

const STYLESHEET = `
.${css.card} {
  list-style: none;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 12px;
  background: var(--dsw-alias-bg-layer-3);
  transition: border-color .16s, background .16s;
}
.${css.card}:hover { border-color: var(--dsw-alias-label-dimmed); }
.${css.cardOpen} {
  background: var(--dsw-alias-bg-layer-2);
  border-color: var(--dsw-alias-label-dimmed);
}
.${css.header} {
  width: 100%;
  appearance: none;
  border: 0;
  background: none;
  font: inherit;
  color: inherit;
  text-align: left;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px 16px;
  border-radius: 12px;
}
.${css.header}:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary);
  outline-offset: -2px;
}
.${css.headText} {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.${css.name} {
  font-size: 15px;
  font-weight: 600;
  line-height: 1.4;
  color: var(--dsw-alias-label-primary);
}
.${css.description} {
  font-size: 13px;
  line-height: 1.5;
  color: var(--dsw-alias-label-tertiary);
}
.${css.chevron} {
  flex: none;
  color: var(--dsw-alias-label-tertiary);
  transition: transform .16s;
}
.${css.chevronOpen} { transform: rotate(180deg); }
.${css.body} {
  border-top: 1px solid var(--dsw-alias-border-l2);
  margin: 0 16px;
  padding-bottom: 8px;
}
.${css.readOnly} {
  margin: 12px 0 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--dsw-alias-label-tertiary);
}
.${css.pending} {
  flex: none;
  border-radius: 999px;
  padding: 1px 8px;
  font-size: 11px;
  line-height: 17px;
  font-weight: 500;
  white-space: nowrap;
  background: var(--dsw-alias-bg-module-platform);
  color: var(--dsw-alias-label-secondary);
}
.${css.footer} {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  padding: 12px 0 4px;
  border-top: 1px solid var(--dsw-alias-border-l2);
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
  border: 1px solid transparent;
  border-radius: 8px;
  padding: 5px 14px;
  font: inherit;
  font-size: 13px;
  line-height: 1.5;
  cursor: pointer;
}
.${css.discard} {
  border-color: var(--dsw-alias-border-l2);
  background: none;
  color: var(--dsw-alias-label-secondary);
}
.${css.discard}:hover:not(:disabled) {
  color: var(--dsw-alias-label-primary);
  border-color: var(--dsw-alias-label-dimmed);
}
.${css.save} {
  background: var(--dsw-alias-label-primary);
  color: var(--dsw-alias-bg-layer-3);
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
  gap: 6px;
  padding: 12px 0;
}
.${css.field} + .${css.field} { border-top: 1px solid var(--dsw-alias-border-l2); }
.${css.fieldHead} {
  display: flex;
  align-items: center;
  gap: 8px;
}
.${css.label} {
  flex: 1;
  min-width: 0;
  font-size: 13px;
  font-weight: 500;
  line-height: 1.5;
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
  line-height: 1.5;
  color: var(--dsw-alias-label-secondary);
  cursor: pointer;
}
.${css.reset}:hover:not(:disabled) { color: var(--dsw-alias-label-primary); }
.${css.reset}:disabled { cursor: default; }
.${css.input} {
  height: 34px;
  padding: 0 12px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-3);
  font: inherit;
  font-size: 13px;
  line-height: 1.5;
  color: var(--dsw-alias-label-primary);
}
.${css.input}:focus-visible {
  outline: none;
  border-color: var(--dsw-alias-brand-primary);
}
.${css.input}:disabled {
  color: var(--dsw-alias-label-tertiary);
  cursor: default;
}
.${css.inputInvalid} { border-color: var(--dsw-alias-label-error); }
.${css.invalid} {
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--dsw-alias-label-error);
}
.${css.hint} {
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--dsw-alias-label-tertiary);
}
`

/**
 * Inject the card stylesheet once. Safe to call from apply() and from tests.
 */
export function installCardStyles(): void {
  if (typeof document === 'undefined') return
  if (document.querySelector(`style[data-plugin-css=${JSON.stringify(STYLE_ID)}]`)) return
  const tag = document.createElement('style')
  tag.dataset.plugin = 'autoreportdsh'
  tag.dataset.pluginCss = STYLE_ID
  tag.textContent = STYLESHEET
  document.head.appendChild(tag)
}
