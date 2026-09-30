import { describe, expect, it } from 'vitest'
import { restrictInheritedShell } from '../src/policy/role-tool-visibility.js'

describe('role shell visibility', () => {
  it('hides inherited bash and pwsh for Main, Theory, and Report', () => {
    for (const role of ['MAIN', 'THEORY', 'REPORT'] as const) {
      const denied: string[][] = []
      const ctx = { tools: {
        get: (name: string) => ({ name }),
        restrict: (filter: { deny: string[] }) => { denied.push(filter.deny); return () => {} },
      } }
      restrictInheritedShell(ctx as never, {} as never, role)
      expect(denied).toEqual([['bash', 'pwsh']])
    }
  })

  it('keeps compute bash, hides inherited pwsh, and tolerates missing names', () => {
    const denied: string[][] = []
    const ctx = { tools: {
      get: (name: string) => name === 'pwsh' ? undefined : { name },
      restrict: (filter: { deny: string[] }) => { denied.push(filter.deny); return () => {} },
    } }
    restrictInheritedShell(ctx as never, {} as never, 'DATA_ANALYSIS')
    expect(denied).toEqual([])
  })
})
