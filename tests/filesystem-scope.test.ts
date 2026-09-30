import { describe, expect, it } from 'vitest'
import { renderFilesystemScope } from '../src/filesystem-scope.js'

describe('AutoReport filesystem prompt surface', () => {
  it('lists only supplied visible tools and contains no guidance for hidden search tools', () => {
    const prompt = renderFilesystemScope('MAIN', '/workspace', false, ['list', 'grep', 'read'])

    expect(prompt).toContain('AutoReport tools: list, grep, read')
    expect(prompt.toLowerCase()).not.toContain('glob')
  })

  it('derives filesystem usage guidance from the visible tools', () => {
    const prompt = renderFilesystemScope('THEORY', '/workspace', false, [
      'read', 'list', 'grep', 'write', 'edit', 'skill',
    ])

    expect(prompt).toContain('Filesystem tool usage')
    expect(prompt).toContain('`list`')
    expect(prompt).toContain('`grep`')
    expect(prompt).toContain('regular files only')
    expect(prompt).toContain('Do not use failed `read` calls to probe for existence')
    expect(prompt).toContain('Never invent skill names')
  })

  it('omits discovery guidance for tools the role cannot see', () => {
    const prompt = renderFilesystemScope('MAIN', '/workspace', false, ['read', 'write', 'skill'])

    expect(prompt).not.toContain('`list`')
    expect(prompt).not.toContain('`grep`')
    expect(prompt).toContain('Do not use failed `read` calls to probe for existence')
  })
})
