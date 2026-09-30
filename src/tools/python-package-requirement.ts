/** Validate the single requirement accepted by Main's package tool. */
export function validPackageRequirement(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}(?:\[[A-Za-z0-9,._-]+\])?(?:[<>=!~]{1,2}[A-Za-z0-9.*_-]+)?$/u.test(value)
}

/** Fixed argv for the selected environment; no model-supplied command text. */
export function packageInstallArgv(python: string, requirement: string, managed: boolean): string[] {
  return managed
    ? ['uv', 'pip', 'install', '--python', python, requirement]
    : [python, '-m', 'pip', 'install', requirement]
}
