import { describe, expect, it } from 'vitest'
import { renderFilesystemScope } from '../src/filesystem-scope.js'

describe('AutoReport filesystem prompt surface', () => {
  it('lists only supplied visible tools and contains no guidance for hidden search tools', () => {
    const prompt = renderFilesystemScope('MAIN', '/workspace', false, ['list', 'grep', 'read'])

    expect(prompt).toContain('AutoReport tools: list, grep, read')
    expect(prompt.toLowerCase()).not.toContain('glob')
  })
})
