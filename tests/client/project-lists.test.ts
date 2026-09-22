/** Which workspaces the settings page lists, and under which language. */

import { describe, expect, it } from 'vitest'
import { projectsByLanguage, type ProjectSessionRow } from '../../src/client/project-lists.js'

const rows: Record<string, ProjectSessionRow> = {
  a: { cwd: '/exp/a', agentPreset: 'autoreport', blank: false, displayTitle: 'Alpha' },
  b: { cwd: '/exp/b', agentPreset: 'autoreport', blank: false, displayTitle: 'Beta' },
  empty: { cwd: '/exp/c', agentPreset: 'autoreport', blank: true, displayTitle: 'Gamma' },
  child: { cwd: '/exp/a', agentPreset: 'autoreport', blank: false, parentId: 'a' },
  stock: { cwd: '/exp/d', agentPreset: 'standard', blank: false },
  untitled: { cwd: '/exp/deep/workspace', agentPreset: 'autoreport', blank: false },
  projected: { cwd: '/exp/e', blank: false, projectionValues: { agentPreset: 'autoreport' } },
}

describe('projectsByLanguage', () => {
  it('keeps AutoReport main sessions that have conversed, one entry per workspace', () => {
    const lists = projectsByLanguage(rows, undefined, 'latex')
    expect(lists.latex.map(entry => entry.root)).toEqual(['/exp/a', '/exp/b', '/exp/e', '/exp/deep/workspace'])
    expect(lists.typst).toEqual([])
  })

  it('reads the preset from the projection face when the row carries none', () => {
    expect(projectsByLanguage({ only: rows.projected }, undefined, 'latex').latex).toHaveLength(1)
  })

  it('omits a session whose log is still empty', () => {
    expect(projectsByLanguage({ only: rows.empty }, undefined, 'latex').latex).toEqual([])
  })

  it('files each project by its recorded language and names it from the session title', () => {
    const lists = projectsByLanguage(rows, { '/exp/b': 'typst' }, 'latex')
    expect(lists.latex.map(entry => entry.name)).toEqual(['Alpha', 'e', 'workspace'])
    expect(lists.typst.map(entry => [entry.root, entry.name])).toEqual([['/exp/b', 'Beta']])
  })

  it('falls back to the default language when nothing is recorded', () => {
    expect(projectsByLanguage(rows, undefined, 'typst').typst).toHaveLength(4)
  })
})
