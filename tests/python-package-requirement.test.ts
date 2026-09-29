import { describe, expect, it } from 'vitest'
import { validPackageRequirement } from '../src/tools/python-package-requirement.js'

describe('package requirement', () => {
  it('accepts one named requirement and rejects flags, URLs, and shell text', () => {
    expect(validPackageRequirement('pandas')).toBe(true)
    expect(validPackageRequirement('scipy==1.14.1')).toBe(true)
    expect(validPackageRequirement('matplotlib[qt]>=3.9')).toBe(true)
    for (const unsafe of ['--target=/tmp', 'https://example.test/pkg.whl', 'pandas; echo bad', 'pandas other', '../package']) {
      expect(validPackageRequirement(unsafe)).toBe(false)
    }
  })

})
