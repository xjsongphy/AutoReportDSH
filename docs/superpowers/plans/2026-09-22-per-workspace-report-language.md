# 按工作区选报告语言 + 设置页迁移 Implementation Plan

> 已被 `PLAN.md` rev 11 取代。本文保留历史执行记录；其中 `project.json` 兼容与迁移
> 步骤已废弃，当前实现不再读取、迁移或写入该设置层。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让每个工作区的报告语言有一个存储位置、一个设置界面和一个切换动作：设置页把工作区列成 LaTeX/Typst 两张表，按 `−` 即把该项目换到另一种语言并切换目录里的模板。

**Architecture:** 权威存进 `autoreport` 用户设置的 `workspaceLanguages`（键 = 工作区根路径），`project.json.reportLanguage` 变成只读兼容并在首次初始化时一次性采纳。host 侧不复用新的枚举/扫描机制：项目列表由客户端从已有 session store 推导，host 只在设置变更的 `onChange` 钩子里按需切换模板。设置卡片从 `plugins.item` 迁到 `plugins.bundle.config`，去掉折叠层与自绘卡片外观，对齐官方插件页的样式。

**Tech Stack:** TypeScript（Node 22 ESM）、Cordis 插件、DSH 设置服务与 client slots、React 18、vitest + @testing-library/react、schemastery。

**Spec:** `PLAN.md` §2.18（rev 9）；相关旧行为见 §2.10 / §2.14（本计划会把这两处与新语义冲突的句子一并改掉）。

## Global Constraints

- 语言集合只有 `'latex' | 'typst'`；键是**工作区绝对根路径**（host 侧 `resolve()`，client 侧原样写 session 行的 `cwd`）。
- 解析优先级：`override > workspaceLanguages[root] > project.reportLanguage(legacy) > 用户默认 > 组合配置 > schema 默认('latex')`。
- 模板切换三条规则互相独立：与打包资源**逐字节相同**才删；目标已存在**绝不覆盖**；非模板名文件一律不碰。整段操作**幂等**，且**不扫描**目录（只按已知文件名操作）。
- 不新增注册表、不做目录扫描、不在每次渲染/每次设置变更时枚举工作区。
- 卡片注册在 `plugins.bundle.config`（key = 包名 `dsh-autoreport`），只有 `page` 视图，不画标题/图标/面包屑。
- 官方页风格：**无边框、无圆角、无分割线**；分组小标题 + 左标签右控件/上下排 + 一个「保存」。
- 所有面向用户的文案同时提供 `en` 与 `zh`；注释与测试用英文。
- 提交习惯：按功能切分提交，直推 `main`，推送前必须自己跑过 `pnpm run typecheck` 与 `pnpm test`。

---

### Task 1: 设置字段 `workspaceLanguages` 与解析优先级

**Files:**
- Modify: `src/settings.ts`
- Test: `tests/settings.test.ts`

**Interfaces:**
- Consumes: `ReportLanguage`（`src/config.ts`）、`enumField`/`firstDefined`（本文件内已有）。
- Produces:
  - `AutoReportUserSettings.workspaceLanguages: Readonly<Record<string, ReportLanguage>>`
  - `WorkflowSettingsLayers.workspaceRoot?: string`（新增，供解析时查表）
  - `resolveWorkflowSettings(layers)` 在 `override` 与 `project` 之间插入 `workspaceLanguages[resolve(workspaceRoot)]`。

- [ ] **Step 1: 写失败的测试**

在 `tests/settings.test.ts` 的 `describe('resolveWorkflowSettings', ...)`（若无则新建 describe）里加：

```ts
describe('per-workspace language', () => {
  it('lets a workspace entry beat the legacy project setting and the user default', () => {
    const resolved = resolveWorkflowSettings({
      user: { workspaceLanguages: { '/exp/a': 'typst', '/exp/b': 'latex' } },
      project: { reportLanguage: 'latex' },
      workspaceRoot: '/exp/a',
      override: undefined,
    })
    expect(resolved.reportLanguage).toBe('typst')
  })

  it('falls back through project, user default, and the schema default', () => {
    expect(resolveWorkflowSettings({
      user: { workspaceLanguages: { '/exp/b': 'latex' } },
      project: { reportLanguage: 'typst' },
      workspaceRoot: '/exp/a',
    }).reportLanguage).toBe('typst')
    expect(resolveWorkflowSettings({
      user: { defaultReportLanguage: 'typst' },
      workspaceRoot: '/exp/a',
    }).reportLanguage).toBe('typst')
    expect(resolveWorkflowSettings({ workspaceRoot: '/exp/a' }).reportLanguage).toBe('latex')
    expect(resolveWorkflowSettings({ user: { workspaceLanguages: { '/exp/a': 'typst' } } }).reportLanguage).toBe('latex')
  })

  it('keys on the resolved path so a trailing slash is the same workspace', () => {
    expect(resolveWorkflowSettings({
      user: { workspaceLanguages: { '/exp/a': 'typst' } },
      workspaceRoot: '/exp/a/',
    }).reportLanguage).toBe('typst')
  })

  it('defaults the field to an empty map and rejects a foreign language', () => {
    const user = AUTO_REPORT_USER_SETTINGS_SCHEMA({}) as Record<string, unknown>
    expect(user['workspaceLanguages']).toEqual({})
    expect(() => AUTO_REPORT_USER_SETTINGS_SCHEMA({ workspaceLanguages: { '/exp': 'kotlin' } })).toThrow()
  })
})
```

并在文件顶部 import 补上 `AUTO_REPORT_USER_SETTINGS_SCHEMA`（若未引入）。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/settings.test.ts -t 'per-workspace language'`
Expected: FAIL —— `workspaceLanguages` 未定义，`workspaceRoot` 不是合法入参。

- [ ] **Step 3: 实现**

`src/settings.ts`：

1) `AutoReportUserSettings` 增加字段（放在 `defaultReportLanguage` 之后）：

```ts
  /**
   * Per-workspace report language keyed by the absolute workspace root. The
   * authoritative layer: a workspace present here never consults the legacy
   * `project.json` value or the user default.
   */
  workspaceLanguages: Readonly<Record<string, ReportLanguage>>
```

2) `AUTO_REPORT_USER_SETTINGS_SCHEMA` 增加一行：

```ts
  workspaceLanguages: z.dict(z.union(['latex', 'typst'] as const)).default({}),
```

3) `autoReportUserSettingsBase` 增加 `workspaceLanguages: {},`。

4) `WorkflowSettingsLayers` 增加：

```ts
  /** Absolute workspace root the resolution is for; absent skips the per-workspace layer. */
  readonly workspaceRoot?: string
```

5) `resolveWorkflowSettings` 里计算并在链条中用上：

```ts
  const workspaceLanguage = layers.workspaceRoot === undefined
    ? undefined
    : enumField(
        'workspaceLanguage',
        user?.workspaceLanguages?.[resolve(layers.workspaceRoot)],
        REPORT_LANGUAGES,
      )
  const reportLanguage = enumField(
    'reportLanguage',
    firstDefined(
      override?.reportLanguage,
      workspaceLanguage,
      project?.reportLanguage,
      user?.defaultReportLanguage,
      composition?.defaultReportLanguage,
    ),
    REPORT_LANGUAGES,
  ) ?? WORKFLOW_SETTINGS_SCHEMA_DEFAULTS.reportLanguage
```

（`resolve` 已在本文件从 `node:path` 引入。）

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/settings.test.ts`
Expected: PASS（含原有用例）。

- [ ] **Step 5: 提交**

```bash
git add src/settings.ts tests/settings.test.ts
git commit -m "feat(settings): key report language by workspace root

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 2: `switchReportLanguage()` 模板切换

**Files:**
- Modify: `src/workspace/init.ts`
- Test: `tests/workspace-init.test.ts`

**Interfaces:**
- Consumes: 同模块的 `LATEX_FILES` / `TYPST_FILES` / `resolveResourceFile` / `ReportLanguage`。
- Produces:

```ts
export interface LanguageSwitchResult {
  /** Workspace-relative template files removed because they were unmodified. */
  readonly deleted: string[]
  /** Workspace-relative template files installed for the new language. */
  readonly written: string[]
  /** Files left alone: already present, or modified by the user. */
  readonly kept: string[]
}
export function switchReportLanguage(
  root: string,
  from: ReportLanguage,
  to: ReportLanguage,
): LanguageSwitchResult
```

- [ ] **Step 1: 写失败的测试**

在 `tests/workspace-init.test.ts` 追加：

```ts
describe('switchReportLanguage', () => {
  function workspaceWith(language: 'latex' | 'typst'): string {
    const root = mkdtempSync(join(tmpdir(), 'autoreport-switch-'))
    ensureInitialized(root, language)
    return root
  }

  it('deletes the unmodified source template and installs the target set', () => {
    const root = workspaceWith('latex')
    const result = switchReportLanguage(root, 'latex', 'typst')
    expect(result.deleted).toEqual(['Report/main.tex', 'Report/mpltx.cls'])
    expect(result.written).toEqual([
      'Report/main.typ', 'Report/mplts.typ', 'Report/american-physics-society.csl', 'Report/bibli.bib',
    ])
    expect(existsSync(join(root, 'Report/main.tex'))).toBe(false)
    expect(existsSync(join(root, 'Report/main.typ'))).toBe(true)
  })

  it('keeps a modified source template and still installs the target set', () => {
    const root = workspaceWith('latex')
    writeFileSync(join(root, 'Report/main.tex'), '% my own report\n')
    const result = switchReportLanguage(root, 'latex', 'typst')
    expect(result.deleted).toEqual(['Report/mpltx.cls'])
    expect(result.kept).toContain('Report/main.tex')
    expect(readFileSync(join(root, 'Report/main.tex'), 'utf8')).toBe('% my own report\n')
    expect(existsSync(join(root, 'Report/main.typ'))).toBe(true)
  })

  it('never overwrites an existing target template', () => {
    const root = workspaceWith('latex')
    switchReportLanguage(root, 'latex', 'typst')
    writeFileSync(join(root, 'Report/main.typ'), '// mine\n')
    const back = switchReportLanguage(root, 'typst', 'latex')
    expect(back.kept).toContain('Report/main.typ')
    expect(readFileSync(join(root, 'Report/main.typ'), 'utf8')).toBe('// mine\n')
    expect(existsSync(join(root, 'Report/main.tex'))).toBe(true)
  })

  it('leaves non-template files alone and is idempotent', () => {
    const root = workspaceWith('latex')
    writeFileSync(join(root, 'Report/custom.typ'), 'not a template\n')
    switchReportLanguage(root, 'latex', 'typst')
    const again = switchReportLanguage(root, 'latex', 'typst')
    expect(again).toEqual({ deleted: [], written: [], kept: [] })
    expect(readFileSync(join(root, 'Report/custom.typ'), 'utf8')).toBe('not a template\n')
  })

  it('skips a workspace directory that no longer exists', () => {
    expect(switchReportLanguage('/nonexistent/autoreport-workspace', 'latex', 'typst'))
      .toEqual({ deleted: [], written: [], kept: [] })
  })
})
```

`tests/workspace-init.test.ts` 顶部按需补 `mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync`（`node:fs`）、`tmpdir`（`node:os`）、`join`（`node:path`）与 `ensureInitialized, switchReportLanguage`。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/workspace-init.test.ts -t switchReportLanguage`
Expected: FAIL —— `switchReportLanguage is not a function`。

- [ ] **Step 3: 实现**

`src/workspace/init.ts` 追加（`readFileSync`/`unlinkSync` 需加入顶部 `node:fs` 导入）：

```ts
/** Files one language switch removed, installed, and left alone. */
export interface LanguageSwitchResult {
  /** Workspace-relative template files removed because they were unmodified. */
  readonly deleted: string[]
  /** Workspace-relative template files installed for the new language. */
  readonly written: string[]
  /** Files left alone: already present, or modified by the user. */
  readonly kept: string[]
}

/**
 * Move a workspace from one report language to the other.
 *
 * Two independent rules, by design: a source template is deleted only when it
 * is byte-identical to the bundled resource (any difference is the user's and
 * is kept), and a target template is copied only when the target is absent (an
 * existing file is never overwritten). Only the two known resource sets are
 * touched, so the switch never scans the workspace, and a repeated call is a
 * no-op. A missing workspace directory skips the file work entirely.
 * @param root - absolute experiment workspace root.
 * @param from - language the workspace is leaving.
 * @param to - language the workspace is entering.
 * @returns what was deleted, written, and kept.
 */
export function switchReportLanguage(
  root: string,
  from: ReportLanguage,
  to: ReportLanguage,
): LanguageSwitchResult {
  const deleted: string[] = []
  const written: string[] = []
  const kept: string[] = []
  if (!isDirectory(root)) return { deleted, written, kept }
  for (const file of from === 'latex' ? LATEX_FILES : TYPST_FILES) {
    const target = join(root, file.destination)
    if (!existsSync(target)) continue
    const source = resolveResourceFile(file.resourcePath)
    const unmodified = source !== undefined && readFileSync(target).equals(readFileSync(source))
    if (!unmodified) {
      kept.push(file.destination)
      continue
    }
    unlinkSync(target)
    deleted.push(file.destination)
  }
  for (const file of to === 'latex' ? LATEX_FILES : TYPST_FILES) {
    const target = join(root, file.destination)
    if (existsSync(target)) {
      kept.push(file.destination)
      continue
    }
    const source = resolveResourceFile(file.resourcePath)
    if (source === undefined) {
      throw new Error(`AutoReport bundled resource ${file.resourcePath} is missing`)
    }
    mkdirSync(dirname(target), { recursive: true })
    copyFileSync(source, target)
    written.push(file.destination)
  }
  return { deleted, written, kept }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/workspace-init.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/workspace/init.ts tests/workspace-init.test.ts
git commit -m "feat(workspace): add the two-rule template switch

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 3: host 读新字段、采纳 legacy、按需切换

**Files:**
- Modify: `src/runtime.ts`
- Test: `tests/host-runtime.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `workspaceRoot` 入参与 `workspaceLanguages`；Task 2 的 `switchReportLanguage`。
- Produces: `AutoReportWorkflowRuntime.workspaceLanguageFor(root: string): ReportLanguage`（读用户设置里的表，缺省回落默认），供 `/init` 与卡片写入路径复用。

- [ ] **Step 1: 写失败的测试**

在 `tests/host-runtime.test.ts` 追加：

```ts
it('resolves the language from the user workspace map, then adopts a legacy project setting', async () => {
  const root = mkdtempSync(join(tmpdir(), 'autoreport-runtime-'))
  const home = mkdtempSync(join(tmpdir(), 'autoreport-home-'))
  tempDirs.push(root, home)
  saveProjectSettings(home, workspaceIdForRoot(root), { reportLanguage: 'typst' })
  const ctx = new Context()
  await ctx.plugin(MemorySettings, { doc: { autoreport: {} } })
  const runtime = createRuntime(ctx, { ...CONFIG, workspaceRoot: root }, { settingsHome: home })
  const session = rootSession('main-adopt', AUTOREPORT_MAIN_PRESET)
  runtime.maybeInitialize(session)
  const meta = runtime.forSession(session).state.projection().meta
  expect(meta?.settings?.reportLanguage).toBe('typst')
  // The first initialization adopts the legacy value into the authoritative map.
  await vi.waitFor(() => {
    expect(ctx.settings.describe().find(entry => entry.ns === 'autoreport')?.user)
      .toMatchObject({ workspaceLanguages: { [root]: 'typst' } })
  })
})

it('switches the templates when the workspace map changes under a live runtime', async () => {
  const root = mkdtempSync(join(tmpdir(), 'autoreport-runtime-'))
  const home = mkdtempSync(join(tmpdir(), 'autoreport-home-'))
  tempDirs.push(root, home)
  const ctx = new Context()
  await ctx.plugin(MemorySettings, { doc: { autoreport: {} } })
  const runtime = createRuntime(ctx, { ...CONFIG, workspaceRoot: root }, { settingsHome: home })
  const session = rootSession('main-switch', AUTOREPORT_MAIN_PRESET)
  runtime.maybeInitialize(session)
  expect(existsSync(join(root, 'Report/main.tex'))).toBe(true)

  await ctx.settings.mutate(AUTOREPORT_SETTINGS_NAMESPACE, [
    { op: 'set', path: ['workspaceLanguages', root], value: 'typst' },
  ])
  await vi.waitFor(() => {
    expect(existsSync(join(root, 'Report/main.typ'))).toBe(true)
  })
  expect(existsSync(join(root, 'Report/main.tex'))).toBe(false)
})
```

顶部 import 补 `AUTOREPORT_SETTINGS_NAMESPACE`（来自 `../src/settings.js`）与 `existsSync`（`node:fs`）。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/host-runtime.test.ts -t 'workspace map'`
Expected: FAIL —— 语言仍来自 legacy 层但不会被写回；模板不会切换。

- [ ] **Step 3: 实现**

`src/runtime.ts`：

1) 构造函数里，`ctx.inject(['settings'], sctx => {...})` 之前保留 `let previousUserSettings: AutoReportUserSettings | undefined`（实例字段），并在 `installSection` 的 `onChange` 里调用新方法：

```ts
    ctx.inject(['settings'], sctx => {
      this.settingsService = sctx.settings
      sctx.settings.installSection(
        ctx,
        AUTOREPORT_SETTINGS_NAMESPACE,
        AUTO_REPORT_USER_SETTINGS_SCHEMA,
        userSettingsBase,
        {
          setSource: current => { this.userSettingsSource = current },
          validate: value => validatePythonExecutableSetting(value, dshHome),
          // A workspace-language move must reach the workspace on disk, which
          // only the host can do; every other field stays read-at-creation.
          onChange: () => { this.observeUserSettingsChange() },
        },
      )
    })
```

新增私有成员：

```ts
  /** Settings provider when one is mounted; absent in settings-less test contexts. */
  private settingsService: SettingsProvider | undefined
  /** Last user settings this runtime saw, for diffing one change into a switch. */
  private previousUserSettings: AutoReportUserSettings | undefined
```

2) `observeUserSettingsChange()`：

```ts
  /**
   * React to one user-settings change by switching the templates of every
   * workspace whose resolved language moved.
   *
   * The first observation is not a change: it records the baseline F. Later
   * observations compare each key that either snapshot carries, so a move
   * recorded as a fresh map entry is diffed against the language that was in
   * effect before it (the legacy project setting, then the user default).
   * A default-only change therefore switches nothing: no key moves.
   */
  private observeUserSettingsChange(): void {
    const next = this.userSettingsSource()
    const previous = this.previousUserSettings
    this.previousUserSettings = next
    if (previous === undefined) return
    const roots = new Set([
      ...Object.keys(previous.workspaceLanguages ?? {}),
      ...Object.keys(next.workspaceLanguages ?? {}),
    ])
    for (const root of roots) {
      const before = this.effectiveLanguageFor(root, previous)
      const after = this.effectiveLanguageFor(root, next)
      if (before === after) continue
      try {
        switchReportLanguage(resolve(root), before, after)
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error)
        try {
          this.ctx.logger.warn('AutoReportDSH: language switch failed for %s: %s', root, message)
        } catch {
          // A bare test Context may lack a working logger.
        }
      }
    }
  }

  /** Language in effect for one workspace root under one settings snapshot. */
  private effectiveLanguageFor(root: string, settings: AutoReportUserSettings): ReportLanguage {
    const explicit = settings.workspaceLanguages?.[resolve(root)]
    if (explicit !== undefined) return explicit
    const legacy = loadProjectSettings(this.settingsHome, workspaceIdForRoot(root)).reportLanguage
    return legacy ?? settings.defaultReportLanguage
  }
```

3) `maybeInitialize`：把 `workspaceRoot: root` 传进解析，并在解析出的语言来自 legacy 时一次性采纳：

```ts
      const project = loadProjectSettings(this.settingsHome, workspaceIdForRoot(root))
      settings = resolveWorkflowSettings({
        user: this.userSettingsSource(),
        project,
        workspaceRoot: root,
        composition: this.config,
        dshHome: this.settingsHome ?? resolveDshHome(),
      })
      this.adoptLegacyLanguage(root, project)
      ensureInitialized(root, settings.reportLanguage)
```

```ts
  /**
   * Record a legacy `project.json` language into the authoritative map, once.
   *
   * Before this revision the only per-workspace language lived in that file, so
   * a workspace configured by an older build would otherwise keep resolving
   * from a layer the settings page cannot see or set. Writing the map entry on
   * first initialization is idempotent: the entry then exists, and later
   * resolutions read it directly.
   */
  private adoptLegacyLanguage(root: string, project: AutoReportProjectSettings): void {
    const key = resolve(root)
    if (project.reportLanguage === undefined) return
    if (this.userSettingsSource().workspaceLanguages?.[key] !== undefined) return
    void this.writeWorkspaceLanguage(key, project.reportLanguage)
  }

  /** Persist one workspace's language through the settings service when present. */
  private async writeWorkspaceLanguage(root: string, language: ReportLanguage): Promise<void> {
    const settings = this.settingsService
    if (settings === undefined) return
    try {
      await settings.mutate(AUTOREPORT_SETTINGS_NAMESPACE, [
        { op: 'set', path: ['workspaceLanguages', root], value: language },
      ])
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      try {
        this.ctx.logger.warn('AutoReportDSH: could not record the workspace language: %s', message)
      } catch {
        // A bare test Context may lack a working logger.
      }
    }
  }
```

4) 新增公开读取器（`/init` 与外部复用）：

```ts
  /**
   * Language currently in effect for one workspace root under the live user
   * settings: the authoritative map entry, else the legacy project setting,
   * else the user default.
   * @param root - absolute workspace root.
   */
  workspaceLanguageFor(root: string): ReportLanguage {
    return this.effectiveLanguageFor(root, this.userSettingsSource())
  }
```

5) 顶部 import 增加：`SettingsProvider`（`import type { SettingsProvider } from '@deepseek-ai/dsh-settings'`；若该包未导出此名，就用 `Parameters<Context['settings']['installSection']>` 所在的 `ctx.inject(['settings'], sctx => ...)` 提供的 `sctx.settings` 直接赋给一个 `private settingsService: { mutate(ns: string, ops: readonly { op: 'set' | 'unset'; path: readonly string[]; value?: unknown }[]): Promise<void> } | undefined` 结构类型，避免多一个包依赖）、`resolve`（`node:path`）、`switchReportLanguage`、`loadProjectSettings`/`workspaceIdForRoot`/`AUTOREPORT_SETTINGS_NAMESPACE`（`./settings.js`）、`AutoReportProjectSettings` 与 `AutoReportUserSettings` 类型、`ReportLanguage`（`./config.js`）。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/host-runtime.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/runtime.ts tests/host-runtime.test.ts
git commit -m "feat(runtime): resolve and switch the per-workspace language

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 4: `/init --language` 写权威字段

**Files:**
- Modify: `src/workspace/command.ts`、`src/host.ts`、`src/settings.ts`（如需要）
- Test: `tests/report-init-command.test.ts`、`tests/integration.host.test.ts`

**Interfaces:**
- Consumes: Task 3 的 `runtime.workspaceLanguageFor(root)`；`ctx.settings.mutate`。
- Produces:
  - `ReportInitCommandOptions.languageStore?: { read(root: string): ReportLanguage | undefined; write(root: string, language: ReportLanguage): void }`
  - `parseReportInitInput` 接受裸 token `latex|typst` 作为语言（`--language` 仍保留）。
  - `projectStore` **保留**为 legacy 只读（`load`），`save` 不再使用。

- [ ] **Step 1: 写失败的测试**

`tests/report-init-command.test.ts`：把「共存」用例改成新语义，并加裸 token 与写入断言：

```ts
it('records the choice in the settings map and switches the templates', async () => {
  const home = tempDir('autoreport-cmdhome-')
  const root = tempDir('autoreport-cmdswitch-')
  const written: Array<[string, string]> = []
  const definition = createReportInitCommand({
    reportLanguage: 'latex',
    languageStore: {
      read: () => undefined,
      write: (workspaceRoot, language) => { written.push([workspaceRoot, language]) },
    },
  })

  const typst = await definition.handler(invocation(`--language typst ${root}`))
  expect(typst.kind).toBe('success')
  if (typst.kind === 'success') expect(typst.text).toContain('report language: typst')
  expect(written).toEqual([[root, 'typst']])
  expect(existsSync(join(root, 'Report/main.typ'))).toBe(true)
  expect(existsSync(join(home, 'autoreport'))).toBe(false)
})

it('accepts a bare language token', async () => {
  const root = tempDir('autoreport-cmdbare-')
  const written: Array<[string, string]> = []
  const definition = createReportInitCommand({
    reportLanguage: 'latex',
    languageStore: { read: () => undefined, write: (workspaceRoot, language) => { written.push([workspaceRoot, language]) } },
  })
  const result = await definition.handler(invocation(`typst ${root}`))
  expect(result.kind).toBe('success')
  expect(written).toEqual([[root, 'typst']])
  expect((await definition.handler(invocation('--language kotlin'))).kind).toBe('error')
})
```

`tests/integration.host.test.ts` 的 `/init is membership-gated, then switches languages without deleting either backend` 改成：

```ts
  it('/init is membership-gated, then switches languages and clears unmodified templates', async () => {
    // ...membership 断言保持不变...
    await invoke('--language typst')
    expect(existsSync(join(assembled.workspaceRoot, 'Report/main.typ'))).toBe(true)
    // The LaTeX template set was unmodified, so switching to Typst removed it.
    expect(existsSync(join(assembled.workspaceRoot, 'Report/main.tex'))).toBe(false)
    // A modified template survives the switch.
    const latexAgain = await invoke('--language latex')
    expect(latexAgain.kind).toBe('success')
    writeFileSync(join(assembled.workspaceRoot, 'Report/main.typ'), '// mine\n')
    await invoke('--language typst')
    expect(existsSync(join(assembled.workspaceRoot, 'Report/main.typ'))).toBe(true)
    // The in-flight snapshot still never adopts the later change.
    expect(assembled.runtime.forSession(assembled.mainSession).state.projection().meta?.settings).toEqual(before)
  })
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/report-init-command.test.ts tests/integration.host.test.ts`
Expected: FAIL —— 命令仍写 `project.json`，删除语义未生效。

- [ ] **Step 3: 实现**

`src/workspace/command.ts`：

1) `REPORT_LANGUAGES` 解析改为「flag 或裸 token」：

```ts
export function parseReportInitInput(rawInput: string): ParsedReportInitInput | InvalidReportInitInput {
  const tokens = rawInput.trim().split(/\s+/u).filter(token => token.length > 0)
  const positional: string[] = []
  let language: ReportLanguage | undefined
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] as string
    if (token === '--language') {
      const value = tokens[index + 1]
      if (value === undefined) return { error: '--language requires a value: latex or typst.' }
      if (!(REPORT_LANGUAGES as readonly string[]).includes(value)) {
        return { error: `--language must be latex or typst, got ${value}.` }
      }
      language = value as ReportLanguage
      index += 1
      continue
    }
    if (token.startsWith('--')) {
      return { error: `unknown option ${token}. Supported: latex|typst, or --language latex|typst.` }
    }
    // A bare `latex`/`typst` anywhere is the language, so `/init typst ~/exp`
    // and `/init ~/exp typst` both work. A directory literally named `typst`
    // has to be spelled `./typst`.
    if (language === undefined && (REPORT_LANGUAGES as readonly string[]).includes(token)) {
      language = token as ReportLanguage
      continue
    }
    positional.push(token)
  }
  return { language, directory: positional.join(' ') }
}
```

2) `ReportInitCommandOptions`：`projectStore` 改为 legacy 只读 seam，新增 `languageStore`：

```ts
/** Legacy per-workspace language source; read-only, superseded by the settings map. */
export interface LegacyProjectSettingsSource {
  /** Read the stored patch (missing file ⇒ `{}`); may throw loud on corruption. */
  load(): AutoReportProjectSettings
}

/** Authoritative per-workspace language seam over the `autoreport` settings namespace. */
export interface WorkspaceLanguageStore {
  /** Recorded language for one workspace root, or undefined when none is recorded. */
  read(root: string): ReportLanguage | undefined
  /** Record the choice; the host switches the workspace templates from the change. */
  write(root: string, language: ReportLanguage): void
}
```
并把 `options.projectStore` 换成 `options.legacyProject?: (root: string) => LegacyProjectSettingsSource`、新增 `options.languageStore?: WorkspaceLanguageStore`。

3) handler 主体：

```ts
      try {
        const recorded = options.languageStore?.read(root)
        const legacy = options.legacyProject?.(root).load().reportLanguage
        const language = parsed.language
          ?? recorded
          ?? legacy
          ?? options.currentDefaultReportLanguage?.()
          ?? options.reportLanguage
        let saved = ''
        if (parsed.language !== undefined && options.languageStore !== undefined) {
          // Record the explicit choice BEFORE materializing so a crash between
          // the two steps still leaves the authoritative language persisted.
          options.languageStore.write(root, parsed.language)
          saved = ' (saved to settings)'
        }
        const initialization = ensureInitialized(root, language)
        return {
          kind: 'success',
          text: `${renderInitialization(initialization)}\nreport language: ${language}${saved}`,
        }
      } catch (error: unknown) {
        return { kind: 'error', text: 'init failed: ' + (error instanceof Error ? error.message : String(error)) }
      }
```

`src/host.ts` 的 `createReportInitCommand({...})` 改为：

```ts
    const definition = createReportInitCommand({
      reportLanguage: resolved.defaultReportLanguage,
      currentDefaultReportLanguage: () => runtime.currentUserSettings().defaultReportLanguage,
      ...(resolved.workspaceRoot === undefined ? {} : { workspaceRoot: resolved.workspaceRoot }),
      legacyProject: root => ({
        load: () => loadProjectSettings(options.settingsHome, workspaceIdForRoot(root)),
      }),
      ...(runtime.languageStore === undefined ? {} : { languageStore: runtime.languageStore }),
    })
```

`src/runtime.ts` 增加公开 seam：

```ts
  /** Authoritative per-workspace language seam for the explicit `/init` path. */
  get languageStore(): WorkspaceLanguageStore | undefined {
    if (this.settingsService === undefined) return undefined
    return {
      read: root => this.userSettingsSource().workspaceLanguages?.[resolve(root)],
      write: (root, language) => { void this.writeWorkspaceLanguage(resolve(root), language) },
    }
  }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/report-init-command.test.ts tests/integration.host.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/workspace/command.ts src/host.ts src/runtime.ts tests/report-init-command.test.ts tests/integration.host.test.ts
git commit -m "feat(init): record the explicit language in the settings map

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 5: 卡片迁到 `plugins.bundle.config` 并去掉折叠层

**Files:**
- Modify: `src/client/index.ts`、`src/client/AutoReportCard.tsx`、`src/client/locales.ts`
- Delete: `src/client/PluginCard.tsx`
- Test: `tests/client/card.test.tsx`

**Interfaces:**
- Consumes: `PropsRuntime<'plugins.item'>` 的 `view` 不再需要（slot 只有 page）。
- Produces: `AutoReportCard` 直接渲染表单与保存行；`BUNDLE_ID = 'dsh-autoreport'` 常量在 `src/client/index.ts` 中导出。

- [ ] **Step 1: 写失败的测试**

`tests/client/card.test.tsx` 里把折叠相关断言换掉，改为「进页面就是设置项」：

```ts
it('renders the settings directly, with no disclosure layer', () => {
  renderCard()
  expect(screen.getByLabelText('Report language')).toBeTruthy()
  expect(screen.queryByRole('button', { name: /expand|collapse/i })).toBeNull()
  expect(screen.queryByText('AutoReport')).toBeNull()
})

it('keeps the staged save row', () => {
  renderCard()
  expect(screen.getByRole('button', { name: 'Save' })).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Discard' })).toBeTruthy()
})
```

（`renderCard` 现有实现保留；若它传了 `view` prop，一并删掉。）

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/client/card.test.tsx`
Expected: FAIL —— 目前控件藏在折叠头之后。

- [ ] **Step 3: 实现**

1) 删除 `src/client/PluginCard.tsx`，其保存行并入 `AutoReportCard.tsx`：

```tsx
/** The AutoReport plugin configuration page: settings form plus the project lists. */
export function AutoReportCard(props: AutoReportCardProps) {
  const { t } = props
  const state = props.useAutoreportCard(snapshot => snapshot)
  if (!state.available) return null
  const shared = { overriddenLabel: t('overridden'), resetLabel: t('reset'), disabled: !state.writable }
  const blocked = !state.dirty || state.invalid || state.saving
  return (
    <div className={css.page}>
      {!state.writable ? <p className={css.readOnly} role="status">{t('readOnly')}</p> : null}
      <section className={css.section}>
        <h3 className={css.sectionTitle}>{t('sectionReport')}</h3>
        <SelectField
          id="plugin-config-autoreport-language"
          label={t('reportLanguage')}
          hint={t('reportLanguageHint')}
          invalidLabel={t('invalidChoice')}
          options={[
            { value: 'latex', label: t('languageLatex') },
            { value: 'typst', label: t('languageTypst') },
          ]}
          {...shared}
          {...state.defaultReportLanguage}
          onEdit={(text) => { props.edit('defaultReportLanguage', text) }}
          onReset={() => { props.resetField('defaultReportLanguage') }}
        />
      </section>
      <section className={css.section}>
        <h3 className={css.sectionTitle}>{t('sectionDelegation')}</h3>
        <ValueField
          id="plugin-config-autoreport-idle-timeout"
          label={t('idleTimeoutMs')}
          hint={t('idleTimeoutMsHint')}
          invalidLabel={t('invalidNumber')}
          numeric
          {...shared}
          {...state.delegationIdleTimeoutMs}
          onEdit={(text) => { props.edit('delegationIdleTimeoutMs', text) }}
          onReset={() => { props.resetField('delegationIdleTimeoutMs') }}
        />
        <ValueField
          id="plugin-config-autoreport-timeout"
          label={t('timeoutMs')}
          hint={t('timeoutMsHint')}
          invalidLabel={t('invalidNumber')}
          numeric
          {...shared}
          {...state.delegationWaitTimeoutMs}
          onEdit={(text) => { props.edit('delegationWaitTimeoutMs', text) }}
          onReset={() => { props.resetField('delegationWaitTimeoutMs') }}
        />
      </section>
      <section className={css.section}>
        <h3 className={css.sectionTitle}>{t('sectionEnvironment')}</h3>
        <PythonField
          id="plugin-config-autoreport-python"
          label={t('python')}
          hint={t('pythonHint')}
          invalidLabel={t('invalidPython')}
          environments={state.pythonEnvironments}
          managedLabel={t('pythonManaged')}
          pickLabel={t('pythonPick')}
          customLabel={t('pythonCustom')}
          {...shared}
          {...state.pythonExecutable}
          onEdit={(text) => { props.edit('pythonExecutable', text) }}
          onReset={() => { props.resetField('pythonExecutable') }}
        />
        <MineruStatusField
          label={t('mineru')}
          hint={t('mineruHint')}
          commandLabel={t('mineruCommand')}
          installedLabel={t('mineruInstalled')}
          notInstalledLabel={t('mineruNotInstalled')}
          tokenLabel={t('mineruToken')}
          tokenConfiguredLabel={t('mineruTokenConfigured')}
          tokenMissingLabel={t('mineruTokenMissing')}
          tokenSource={state.mineruStatus.tokenSource === 'environment'
            ? t('mineruTokenSourceEnvironment')
            : state.mineruStatus.tokenSource === 'config'
              ? t('mineruTokenSourceConfig')
              : undefined}
          status={state.mineruStatus}
        />
      </section>
      <div className={css.actions}>
        {state.failed ? <p className={css.failed} role="status">{t('saveFailed')}</p> : null}
        <button type="button" className={css.discard} disabled={!state.dirty || state.saving} onClick={props.discard}>
          {t('discard')}
        </button>
        <button type="button" className={css.save} disabled={blocked} onClick={props.save}>
          {t(state.saving ? 'saving' : 'save')}
        </button>
      </div>
    </div>
  )
}
```

2) `AutoReportCardProps` 改为绑定新 slot：

```ts
export type AutoReportCardProps =
  PropsRuntime<'plugins.bundle.config'>
  & PropsLocale<'settings.autoreport'>
  & InjectFace<AutoReportCardFace>
```

3) `src/client/index.ts` 的注册改槽位（`apply` 里删掉 `settings.plugin.item` 注释与注册）：

```ts
/** Bundle id the Plugins page keys a bundle's own configuration by. */
export const BUNDLE_ID = 'dsh-autoreport'
...
  ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
    name: 'plugins.bundle.config',
    key: BUNDLE_ID,
    locale: SETTINGS_NS,
    inject: () => card.inject(),
  }, AutoReportCard))
```

4) `locales.ts`：加 `sectionReport` / `sectionDelegation` / `sectionEnvironment`（`en`: `Report` / `Delegation` / `Environment`；`zh`: `报告` / `委派` / `环境`），删掉不再使用的 `collapse` / `expand`（若仍被引用则保留）。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/client/`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/client tests/client
git commit -m "refactor(client): register the configuration on the bundle's own page

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 6: 两张项目列表与 `−` 切换按钮

**Files:**
- Create: `src/client/project-lists.ts`、`src/client/ProjectLists.tsx`
- Modify: `src/client/controller.ts`、`src/client/index.ts`、`src/client/AutoReportCard.tsx`、`src/client/dsh-client.d.ts`、`src/client/locales.ts`
- Test: `tests/client/project-lists.test.ts`、`tests/client/card.test.tsx`

**Interfaces:**
- Consumes: `ctx.get('sessions').list`（`ObservableSnapshot<{ byId: Record<string, SessionRow> }>`）；`SettingsScope.mutate(ops)`。
- Produces:

```ts
export interface ProjectRow {
  readonly cwd?: string
  readonly parentId?: string
  readonly blank?: boolean
  readonly displayTitle?: string
  readonly agentPreset?: string
}
export interface ProjectEntry {
  readonly root: string
  readonly name: string
  readonly language: ReportLanguage
}
export function projectsByLanguage(
  rows: Readonly<Record<string, ProjectRow>>,
  recorded: Readonly<Record<string, ReportLanguage>> | undefined,
  fallback: ReportLanguage,
): { readonly latex: readonly ProjectEntry[]; readonly typst: readonly ProjectEntry[] }
```

- [ ] **Step 1: 写失败的测试**

`tests/client/project-lists.test.ts`：

```ts
import { describe, expect, it } from 'vitest'
import { projectsByLanguage } from '../../src/client/project-lists.js'

const rows = {
  a: { cwd: '/exp/a', agentPreset: 'autoreport', blank: false, displayTitle: 'A' },
  b: { cwd: '/exp/b', agentPreset: 'autoreport', blank: false, displayTitle: 'B' },
  blank: { cwd: '/exp/c', agentPreset: 'autoreport', blank: true, displayTitle: 'C' },
  child: { cwd: '/exp/a', agentPreset: 'autoreport', blank: false, parentId: 'a' },
  stock: { cwd: '/exp/d', agentPreset: 'standard', blank: false },
}

describe('projectsByLanguage', () => {
  it('keeps AutoReport main sessions that have actually conversed, one entry per workspace', () => {
    const lists = projectsByLanguage(rows, undefined, 'latex')
    expect(lists.latex.map(entry => entry.root)).toEqual(['/exp/a', '/exp/b'])
    expect(lists.typst).toEqual([])
  })

  it('omits a session whose log is still empty', () => {
    const lists = projectsByLanguage({ only: rows.blank }, undefined, 'latex')
    expect(lists.latex).toEqual([])
  })

  it('files each project by its recorded language and shows the root basename', () => {
    const lists = projectsByLanguage(rows, { '/exp/b': 'typst' }, 'latex')
    expect(lists.latex.map(entry => entry.name)).toEqual(['a'])
    expect(lists.typst.map(entry => entry.root)).toEqual(['/exp/b'])
  })

  it('falls back to the default language when nothing is recorded', () => {
    expect(projectsByLanguage(rows, undefined, 'typst').typst).toHaveLength(2)
  })
})
```

`tests/client/card.test.tsx` 追加：

```ts
it('moves a project to the other list through the injected action', () => {
  const moveProject = vi.fn()
  renderCard({ projects: { latex: [{ root: '/exp/a', name: 'a', language: 'latex' }], typst: [] } }, { moveProject })
  fireEvent.click(screen.getByRole('button', { name: 'Switch to Typst' }))
  expect(moveProject).toHaveBeenCalledWith('/exp/a')
})
```

（`renderCard` 增加第二个可选参数以注入额外 action，并把 `projects` 纳入默认 state。）

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/client/project-lists.test.ts tests/client/card.test.tsx`
Expected: FAIL —— 模块与控件都不存在。

- [ ] **Step 3: 实现**

1) 新建 `src/client/project-lists.ts`：过滤（`agentPreset === 'autoreport' && parentId === undefined && cwd 非空 && blank === false`，即"实际产生过对话"）、按 `cwd` 去重、`name` = `displayTitle` 非空则用否则取 `cwd` 末段、`language` = `recorded[root] ?? fallback`，最后按语言分桶（同桶内按 `name` 排序）。

2) `src/client/dsh-client.d.ts` 的行类型补上 `cwd?: string`、`parentId?: string`、`blank?: boolean`、`displayTitle?: string`。

3) 新建 `src/client/ProjectLists.tsx`：两张 `<fieldset>`（legend = 语言名），每题一行 `名称` + `路径`，右侧 `−` 按钮，`aria-label` 为 `t('moveToOther')` 加目标语言名；空表渲染 `t('projectsEmpty')`。`onMove(root)` 由卡片传入。

4) `controller.ts`：
   - 构造函数第二参数 `sessions: ObservableSnapshot<{ byId: Record<string, ProjectRow> }>`，并在 `bind()` 的投影里订阅它（与 settings scope 同样触发 republish）。
   - `projection()` 增加 `projects: projectsByLanguage(rows, value?.workspaceLanguages, value?.defaultReportLanguage ?? 'latex')`。
   - `inject()` 返回面增加 `moveProject`：

```ts
  /** Move one workspace to the other report language. */
  private moveProject(root: string): void {
    const current = this.scope.getSnapshot().value?.workspaceLanguages?.[root]
      ?? this.scope.getSnapshot().value?.defaultReportLanguage
      ?? 'latex'
    const next: ReportLanguage = current === 'latex' ? 'typst' : 'latex'
    // Recorded immediately: this is an action on the workspace, not a staged
    // field, and the host switches the templates from this write.
    void this.scope.mutate([{ op: 'set', path: ['workspaceLanguages', root], value: next }])
  }
```

5) `index.ts` 把卡片构造移进 `ctx.inject(['sessions'], ...)`，用 `sessions.list` 构造控制器（`installSubagentModelSeat` 保持在同一回调内）。

6) `AutoReportCard.tsx` 在「报告语言」下方渲染 `<ProjectLists .../>`，`onMove={props.moveProject}`、`disabled={!state.writable}`。

7) `locales.ts` 增加 `projectsTitle`、`projectsEmpty`、`moveToOther`（`en`: `Projects` / `No AutoReport project yet.` / `Switch to`；`zh`: `项目` / `还没有 AutoReport 项目。` / `切换到`）。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/client/`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/client tests/client
git commit -m "feat(client): list projects by language and move them with one control

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 7: 对齐官方插件页样式

**Files:**
- Modify: `src/client/styles.ts`、`src/client/AutoReportCard.tsx`、`src/client/ProjectLists.tsx`
- Test: `tests/client/card.test.tsx`

**Interfaces:**
- Consumes: Task 5/6 已有的 DOM 结构。
- Produces: `css.page` / `css.section` / `css.sectionTitle` / `css.actions` / `css.list*` / `css.minus` 类；删除 `card*`、`name`、`description`、`chevron*`、`headText`、`pending`。

- [ ] **Step 1: 写失败的测试**

```ts
it('groups the fields under section headings', () => {
  renderCard()
  expect(screen.getByRole('heading', { name: 'Report' })).toBeTruthy()
  expect(screen.getByRole('heading', { name: 'Delegation' })).toBeTruthy()
  expect(screen.getByRole('heading', { name: 'Environment' })).toBeTruthy()
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/client/card.test.tsx -t 'section headings'`
Expected: FAIL（Task 5 已加标题时此步会直接 PASS —— 那就跳过 Step 3 的标题部分，只做样式）。

- [ ] **Step 3: 实现**

`styles.ts`：
- 删除规则：`.ar-card`、`.ar-card:hover`、`.ar-card-open`、`.ar-card-header`、`.ar-card-head-text`、`.ar-card-name`、`.ar-card-description`、`.ar-card-chevron*`、`.ar-card-pending`、`.ar-card-body`（含 `border-top`）、`.ar-card-footer`（含 `border-top`）、`.ar-field + .ar-field { border-top }`。
- 对应地从 `css` 对象里删掉这些类名（以及 `card*`/`name`/`description`/`chevronOpen` 等键），并保证没有遗留引用（`grep -rn "css.card\|css.name\|css.chevron" src/client`）。
- 新增：

```css
.ar-page { display: flex; flex-direction: column; gap: 28px; }
.ar-section { display: flex; flex-direction: column; gap: 4px; }
.ar-section-title {
  margin: 0 0 4px; font-size: 14px; font-weight: 600; line-height: 22px;
  color: var(--dsw-alias-label-primary);
}
.ar-actions { display: flex; align-items: center; justify-content: flex-end; gap: 8px; }
.ar-field { padding: 10px 0; }
.ar-list { display: flex; flex-direction: column; gap: 4px; margin: 4px 0 0; padding: 0; list-style: none; }
.ar-list-title { padding: 0; font-size: 13px; font-weight: 500; color: var(--dsw-alias-label-secondary); }
.ar-list-group { margin: 8px 0 0; padding: 0; border: 0; }
.ar-list-item { display: flex; align-items: center; gap: 8px; padding: 6px 0; }
.ar-list-text { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.ar-list-name { font-size: 14px; line-height: 22px; color: var(--dsw-alias-label-primary); }
.ar-list-path {
  font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.ar-list-empty { margin: 4px 0 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }
.ar-minus {
  flex: none; width: 28px; height: 28px; border: 0; border-radius: 14px;
  background: transparent; color: var(--dsw-alias-label-secondary);
  font: inherit; font-size: 16px; line-height: 1; cursor: pointer;
}
.ar-minus:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.ar-minus:disabled { color: var(--dsw-alias-label-tertiary); cursor: default; }
```

`AutoReportCard.tsx` / `ProjectLists.tsx` 把类名换成上述键。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/client/ && pnpm run typecheck`
Expected: PASS。

- [ ] **Step 5: 手工目视（重建后在浏览器确认）**

Run: `pnpm run build && pnpm run install:source` 后重开 DSH，插件 → 已安装 → dsh-autoreport：**无卡片边框、无分割线、分组标题、底部一个保存、两张语言表各带 `−`**。
Expected: 与官方插件页（如 Subagent）观感一致。

- [ ] **Step 6: 提交**

```bash
git add src/client tests/client
git commit -m "style(client): match the official plugin page

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 8: 文档与旧行为描述收口

**Files:**
- Modify: `PLAN.md`（§2.10、§2.14 的冲突句）、`README.md`、`README.zh.md`、`docs/own-features.md`
- Test: 无（文档）；跑全量测试确认没有代码被牵连

**Interfaces:**
- Consumes: 前七个任务的最终行为。
- Produces: 文档与实现一致——尤其是"两套模板可以共存"这句已经不成立。

- [ ] **Step 1: 改文案**

- `PLAN.md` §2.10：`Existing files are never overwritten.` 后补一句 rev 9 规则（切换时未改动的旧语言模板会被删除，改过的一律保留，目标已存在绝不覆盖），并指向 §2.18。
- `PLAN.md` §2.14：把"`/init --language` updates project settings"改成"records the choice in the user settings map"，并保留 rev 9 指向。
- `README.md` / `README.zh.md`：设置入口改为「插件 → 已安装 → dsh-autoreport」；`/init` 说明改为"选语言并切换模板"；删掉/改写"两套文件可以共存"的表述（现在只有改过的才会共存）。
- `docs/own-features.md`：同步语言选择与设置页位置的描述。

- [ ] **Step 2: 全量验证**

Run: `pnpm run typecheck && pnpm test`
Expected: PASS（45+ 测试文件全绿）。

- [ ] **Step 3: 提交并推送**

```bash
git add PLAN.md README.md README.zh.md docs/own-features.md
git commit -m "docs: fold the per-workspace language semantics forward

Co-Authored-By: Claude Code <noreply@anthropic.com>"
git push origin main
```

---

## 自查记录

- **Spec 覆盖**：存储与优先级（Task 1）、切换规则（Task 2）、host 反应与 legacy 采纳（Task 3）、`/init` 写权威字段（Task 4）、slot 迁移与去折叠层（Task 5）、两张列表与 `−`（Task 6）、官方样式（Task 7）、文档收口（Task 8）。spec 里"不新增注册表、不扫描"由 Task 6 的客户端推导 + Task 2 的按名操作满足。
- **命名一致性**：`switchReportLanguage` / `LanguageSwitchResult` / `workspaceLanguages` / `languageStore` / `projectsByLanguage` / `moveProject` / `BUNDLE_ID` 在全文一致。
- **已知取舍**：`−` 立即写入（不走保存按钮），因为它是作用在工作区上的动作而不是待保存字段；`project.json.reportLanguage` 只读并在首次初始化时采纳进映射。
