import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadSpecialistPersona } from '../src/personas.js'
import { loadBundledSkills } from '../src/workspace/skill-loader.js'

// This fixture is the original AutoReport document, not a snapshot of the
// migrated skill. Only the listed DSH interface adaptations are permitted.
const original = readFileSync(join(import.meta.dirname, 'fixtures/autoreport-plotting-original.md'), 'utf8')
const provenance = JSON.parse(readFileSync(join(import.meta.dirname, '../resources/personas/plotting_agent.provenance.json'), 'utf8')) as { sourceSha256: string }
const persona = loadSpecialistPersona('PLOTTING')

describe('original AutoReport plotting instructions', () => {
  it('records the unchanged upstream document so migration checks work on other machines', () => {
    expect(createHash('sha256').update(original).digest('hex')).toBe(provenance.sourceSha256)
  })

  it('delivers the original prose with only the documented DSH interface adaptations', () => {
    let body = original.slice(original.indexOf('# Plotting Agent\n') + '# Plotting Agent\n'.length)
      .replaceAll('final report to finish a Main-dispatched task', '`report_workflow` report to finish a Main-dispatched task')
      .replaceAll('via a blocker report or directly to MAIN', 'via `report_workflow` to MAIN')
      .replaceAll('(via Bash)', '(via the `bash` tool)')
      .replaceAll('`blocked: missing_data`', '`report_workflow` with `block_type="missing_data"`')
      .replaceAll('`blocked: quality`', '`report_workflow` with `block_type="quality"`')
      .replaceAll('with the unified template', 'through `manifest`')
      .replaceAll('using the unified template', 'through `manifest`')
      // DPI statements are unified to the most specific standard in the
      // original (graphs 600-1000, photos 300-600); see
      // plotting_agent.provenance.json.
      .replaceAll('300-1000 DPI', '600-1000 DPI for graphs, 300-600 DPI for photos')
      .replaceAll('Resolution 300+ DPI', 'Resolution: 600-1000 DPI for graphs, 300-600 DPI for photos')
      .replaceAll('Generated PNG images (300+ DPI)', 'Generated PNG images (600-1000 DPI for graphs, 300-600 DPI for photos)')
    body = body.split('\n').filter(line => !line.startsWith('- **You MUST end your turn')).join('\n')
    const issue = body.indexOf('**Issue reporting**:')
    body = body.slice(0, issue) + body.slice(body.indexOf('## Quality', issue))
    expect(persona).toContain(body.trim())
    expect(persona.split(body.trim())).toHaveLength(2)
    expect(persona).not.toContain('Load `plotting-quality`')
    expect(loadBundledSkills().some(entry => entry.name === 'plotting-quality')).toBe(false)
  })
})
