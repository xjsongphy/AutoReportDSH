/** Validate the single requirement accepted by Main's package tool. */
export function validPackageRequirement(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}(?:\[[A-Za-z0-9,._-]+\])?(?:[<>=!~]{1,2}[A-Za-z0-9.*_-]+)?$/u.test(value)
}
