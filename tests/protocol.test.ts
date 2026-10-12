import { describe, expect, it } from 'vitest'
import { delegationKey, normalizeProducedPath, parseWorkflowEnvelope, parseWorkflowEnvelopeFromText, parseWorkflowReportContent } from '../src/workflow/protocol.js'

describe('workflow protocol', () => {
  const report = {
    task_id: 'task-6', delegation_revision: 1, status: 'success', block_type: null,
    response: 'κ ∈ {N, 1}; formula \\frac{a}{b}; "quoted" \\ escaped\nnew line', produced_files: [],
  }

  it('accepts the incident relay containing braces inside its response string', () => {
    const mixed = `Background subagent reported:\nTHEORY → MAIN\n${JSON.stringify(report)}`
    expect(parseWorkflowEnvelopeFromText(mixed)).toEqual({ ok: true, value: report })
    expect(parseWorkflowReportContent([
      { type: 'text', text: 'THEORY → MAIN\nκ ∈ {N, 1}' },
      { type: 'text', text: JSON.stringify(report) },
    ])).toEqual({ ok: true, value: report })
  })

  it('reads a report after unrelated code fences and a human prefix with braces', () => {
    const text = `Example {N, 1}\n\`\`\`python\nprint("{x}")\n\`\`\`\n\`\`\`json\n${JSON.stringify(report)}\n\`\`\``
    expect(parseWorkflowEnvelopeFromText(text)).toEqual({ ok: true, value: report })
    expect(parseWorkflowReportContent([{ type: 'text', text }])).toEqual({ ok: true, value: report })
  })

  it('does not turn malformed JSON or arbitrary brace text into a valid report', () => {
    expect(parseWorkflowEnvelopeFromText('κ ∈ {N, 1}')).toMatchObject({ ok: false })
    expect(parseWorkflowReportContent([{ type: 'text', text: 'summary' }, { type: 'text', text: '{"task_id":"task-6"' }])).toMatchObject({ ok: false })
    expect(parseWorkflowEnvelopeFromText(JSON.stringify({ ...report, status: 'unknown' }))).toMatchObject({ ok: false })
  })

  it('derives stable composite keys', () => {
    expect(delegationKey('task-7', 3)).toBe('task-7#3')
  })

  describe('normalizeProducedPath', () => {
    it('normalizes separators and collapses duplicates', () => {
      expect(normalizeProducedPath('Plots//Fig\\result.png')).toBe('Plots/Fig/result.png')
      expect(normalizeProducedPath('./Data/Processed/./x.csv')).toBe('Data/Processed/x.csv')
    })
    it('rejects absolute and traversing paths without rewriting them', () => {
      expect(normalizeProducedPath('/etc/passwd')).toBeNull()
      expect(normalizeProducedPath('C:/temp/x')).toBeNull()
      expect(normalizeProducedPath('../escape')).toBeNull()
      expect(normalizeProducedPath('a/../../b')).toBeNull()
      expect(normalizeProducedPath('')).toBeNull()
    })
  })

  describe('parseWorkflowEnvelope', () => {
    const valid = {
      task_id: 'task-7',
      delegation_revision: 3,
      status: 'success',
      block_type: null,
      response: 'done',
      produced_files: ['Report/main.pdf'],
    }

    it('accepts a valid envelope (object or JSON text)', () => {
      for (const raw of [valid, JSON.stringify(valid)]) {
        const result = parseWorkflowEnvelope(raw)
        expect(result.ok).toBe(true)
        if (result.ok) expect(result.value.produced_files).toEqual(['Report/main.pdf'])
      }
    })

    it('requires block_type on blocked reports and null on success', () => {
      const blocked = { ...valid, status: 'blocked', block_type: 'missing_data' }
      const parsed = parseWorkflowEnvelope(blocked)
      expect(parsed.ok).toBe(true)

      const dependency = { ...valid, status: 'blocked', block_type: 'missing_dependency' }
      expect(parseWorkflowEnvelope(dependency).ok).toBe(true)

      const missing = { ...valid, status: 'blocked' }
      expect(parseWorkflowEnvelope(missing).ok).toBe(false)

      const badSuccess = { ...valid, block_type: 'quality' }
      expect(parseWorkflowEnvelope(badSuccess).ok).toBe(false)
    })

    it('rejects malformed shapes with reasons, not throws', () => {
      expect(parseWorkflowEnvelope('not json').ok).toBe(false)
      expect(parseWorkflowEnvelope(42).ok).toBe(false)
      expect(parseWorkflowEnvelope({ ...valid, task_id: 'x' }).ok).toBe(false)
      expect(parseWorkflowEnvelope({ ...valid, delegation_revision: 0 }).ok).toBe(false)
      expect(parseWorkflowEnvelope({ ...valid, delegation_revision: 1.5 }).ok).toBe(false)
      expect(parseWorkflowEnvelope({ ...valid, status: 'maybe' }).ok).toBe(false)
      expect(parseWorkflowEnvelope({ ...valid, response: '' }).ok).toBe(false)
    })

    it('bounds and normalizes produced_files', () => {
      const absolute = { ...valid, produced_files: ['/abs/path'] }
      const parsedAbsolute = parseWorkflowEnvelope(absolute)
      expect(parsedAbsolute.ok).toBe(false)
      if (!parsedAbsolute.ok) expect(parsedAbsolute.reason).toMatch(/absolute or traversing/)

      const dupes = { ...valid, produced_files: ['a/b.txt', 'a//b.txt'] }
      const parsedDupes = parseWorkflowEnvelope(dupes)
      expect(parsedDupes.ok).toBe(true)
      if (parsedDupes.ok) expect(parsedDupes.value.produced_files).toEqual(['a/b.txt'])

      const overflow = { ...valid, produced_files: Array.from({ length: 513 }, (_, i) => `f${i}.txt`) }
      expect(parseWorkflowEnvelope(overflow).ok).toBe(false)
    })
  })
})
