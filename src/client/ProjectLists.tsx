/**
 * The two language lists on the configuration page.
 *
 * One row per project — the name the session list already computed, the root
 * it lives at, and the control that moves it to the other language. The list a
 * project sits in IS its current language, so a project with no recorded
 * choice appears under the page's current default.
 */

import type { AutoReportLocaleKey } from './locales.js'
import type { ProjectEntry, ProjectLanguage, ProjectLists as Lists } from './project-lists.js'
import { css } from './styles.js'

/** Props the card binds for the project lists. */
export interface ProjectListsProps {
  /** Locale reader for this card's copy. */
  readonly t: (key: AutoReportLocaleKey) => string
  /** The lists to render, already split by language. */
  readonly projects: Lists
  /** Whether the Host settings document accepts writes. */
  readonly disabled: boolean
  /** Move one project to the other language. */
  readonly onMove: (root: string) => void
}

/**
 * Render both language lists.
 * @param props - the lists, the locale reader, and the move action.
 * @returns the two lists under one heading.
 */
export function ProjectLists(props: ProjectListsProps) {
  const { t } = props
  return (
    <div className={css.projects}>
      <p className={css.projectsTitle}>{t('projectsTitle')}</p>
      <LanguageList
        language="latex"
        title={t('languageLatex')}
        targetLabel={t('languageTypst')}
        entries={props.projects.latex}
        t={t}
        disabled={props.disabled}
        onMove={props.onMove}
      />
      <LanguageList
        language="typst"
        title={t('languageTypst')}
        targetLabel={t('languageLatex')}
        entries={props.projects.typst}
        t={t}
        disabled={props.disabled}
        onMove={props.onMove}
      />
    </div>
  )
}

interface LanguageListProps {
  readonly language: ProjectLanguage
  readonly title: string
  /** Name of the language this list's control moves a project to. */
  readonly targetLabel: string
  readonly entries: readonly ProjectEntry[]
  readonly t: (key: AutoReportLocaleKey) => string
  readonly disabled: boolean
  readonly onMove: (root: string) => void
}

/** One language's list: its rows, or the empty notice. */
function LanguageList(props: LanguageListProps) {
  const { t } = props
  const headingId = `autoreport-projects-${props.language}`
  const label = `${t('moveToOther')} ${props.targetLabel}`
  return (
    <div className={css.listGroup}>
      <p className={css.listTitle} id={headingId}>{props.title}</p>
      {props.entries.length === 0
        ? <p className={css.listEmpty}>{t('projectsEmpty')}</p>
        : (
          <ul className={css.list} aria-labelledby={headingId}>
            {props.entries.map(entry => (
              <li key={entry.root} className={css.listItem}>
                <span className={css.listText}>
                  <span className={css.listName}>{entry.name}</span>
                  <span className={css.listPath}>{entry.root}</span>
                </span>
                <button
                  type="button"
                  className={css.minus}
                  disabled={props.disabled}
                  aria-label={label}
                  title={label}
                  onClick={() => { props.onMove(entry.root) }}
                >
                  −
                </button>
              </li>
            ))}
          </ul>
        )}
    </div>
  )
}
