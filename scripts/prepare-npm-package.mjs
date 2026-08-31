#!/usr/bin/env node

/** Build the publishable npm bundle from the source-oriented checkout. */

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(new URL('.', import.meta.url).pathname, '..')
const output = join(root, 'dist', 'npm')
const source = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const dshVersion = '0.1.1-rc.2'

rmSync(output, { recursive: true, force: true })
mkdirSync(output, { recursive: true })

const packageDependencies = {}
for (const dependencies of [source.dependencies ?? {}, source.devDependencies ?? {}]) {
  for (const [name, version] of Object.entries(dependencies)) {
    if (!name.startsWith('@deepseek-ai/')) continue
    packageDependencies[name] = name === '@deepseek-ai/cordis'
      ? '^4.0.1'
      : name === '@deepseek-ai/schemastery'
        ? '^3.18.1'
        : `^${dshVersion}`
    void version
  }
}

const manifest = {
  name: source.name,
  version: source.version,
  description: source.description,
  type: 'module',
  main: './dist/src/index.js',
  exports: source.exports,
  files: [
    'dist/client.js',
    'dist/src/**/*.js',
    'dist/resources/**',
    'dist/scripts/install-user-preset.js',
    'dist/scripts/install-package-preset.js',
    'cordis.patch.yml',
    'presets/autoreport/**',
  ],
  scripts: {
    postinstall: 'node dist/scripts/install-package-preset.js',
  },
  repository: {
    type: 'git',
    url: 'git+https://github.com/xjsongphy/AutoReportDSH.git',
  },
  license: 'MIT',
  publishConfig: { access: 'public' },
  dsh: source.dsh,
  dependencies: packageDependencies,
}

writeFileSync(join(output, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
cpSync(join(root, 'dist', 'client.js'), join(output, 'dist', 'client.js'))
cpSync(join(root, 'dist', 'src'), join(output, 'dist', 'src'), { recursive: true })
cpSync(join(root, 'dist', 'resources'), join(output, 'dist', 'resources'), { recursive: true })
cpSync(join(root, 'dist', 'scripts', 'install-user-preset.js'), join(output, 'dist', 'scripts', 'install-user-preset.js'))
cpSync(join(root, 'dist', 'scripts', 'install-package-preset.js'), join(output, 'dist', 'scripts', 'install-package-preset.js'))
cpSync(join(root, 'cordis.patch.yml'), join(output, 'cordis.patch.yml'))
cpSync(join(root, 'presets', 'autoreport'), join(output, 'presets', 'autoreport'), { recursive: true })

if (!existsSync(join(output, 'dist', 'src', 'index.js'))) {
  throw new Error('autoreportdsh: npm package preparation did not produce dist/src/index.js')
}
console.log(`autoreportdsh: prepared npm package at ${output}`)
