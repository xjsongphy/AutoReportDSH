# Implementation plan — per-workspace report language & settings page (PLAN §2.18, rev 9)

> Historical plan superseded by PLAN.md rev 11. Do not follow its legacy `project.json`
> compatibility steps; the current implementation removes that settings layer entirely.

Spec: `PLAN.md` §2.18 (commit d0e3d4c), plus §2.14 and §2.17 row 9. This file is the
step-by-step execution plan; each step is independently verifiable. Base: `main` at
`cea0bf8` (rename landed and verified — typecheck + 355 tests green).

Run after every step: `pnpm run typecheck && pnpm test`.

## Step 1 — Storage: `workspaceLanguages` in the settings namespace

**File:** `src/settings.ts`

- Add to `AutoReportUserSettings`:
  `workspaceLanguages: Record<string, ReportLanguage>` — key = absolute workspace root path.
- Add to `AUTO_REPORT_USER_SETTINGS_SCHEMA`:
  `workspaceLanguages: z.dict(z.union(['latex', 'typst'] as const)).default({})`
  (schemastery's record type is `z.dict`, NOT `z.record` — see `node_modules/@deepseek-ai/schemastery/src/index.ts`).
- Include it in `autoReportUserSettingsBase()` as `{}`.
- In `resolveWorkflowSettings`, insert a new layer in `firstDefined` for `reportLanguage`:
  `override → workspaceRoot-entry → project.reportLanguage → user.defaultReportLanguage → composition → schema default`.
  The workspace entry is read from `user.workspaceLanguages[resolvedRoot]`; add an input
  `workspaceRoot?: string` to `WorkflowSettingsLayers` (host passes the resolved absolute root).
- `project.reportLanguage` stays in the chain BELOW the workspace entry (read-only
  compatibility, one version). Do NOT change `AutoReportProjectSettings` or its load/save.

**Tests** (`tests/settings.test.ts`):
- workspace entry beats `project.reportLanguage`; project beats `user.defaultReportLanguage`;
  absent root entry falls through to project; absent everything → schema default.
- key is the resolved absolute path (symlink/relative root resolves before lookup).
- `workspaceLanguages` defaults to `{}` when the stored user section omits it.

## Step 2 — `/init --language` writes the field, not the file

**Files:** `src/workspace/command.ts`, `src/host.ts`

- In `command.ts`, replace the `ProjectSettingsStore` seam usage for the language write with a
  new option `languageStore?: (root: string) => { read(): ReportLanguage | undefined; write(lang: ReportLanguage): void }`.
  Precedence inside the handler becomes:
  `--language flag → languageStore(root).read() → project.reportLanguage (via existing read-only seam) → currentDefaultReportLanguage() → options.reportLanguage`.
  On explicit `--language`: call `languageStore.write(lang)` BEFORE `ensureInitialized`
  (same crash-safety ordering as today), and drop the `(saved to project settings)` message
  in favor of e.g. `(saved)`.
  Keep `ensureInitialized(root, language)` unchanged — still materializes missing only,
  still deletes nothing.
- In `host.ts` (`createReportInitCommand({...})` around line 130), supply `languageStore`
  from the runtime's settings seam: read `runtime.currentUserSettings().workspaceLanguages[root]`,
  write via the settings service scope (the same handle `installSection` registers — expose a
  small method on the runtime, e.g. `runtime.setWorkspaceLanguage(root, lang)`, which issues
  `settings.update('autoreport', { workspaceLanguages: { ...current, [root]: lang } })`
  through the registered `SettingsScope`; capture the scope in `installSection`'s `setSource`
  or keep the owner `SettingsScope<T>` returned by `ctx.settings.register` — see
  `node_modules/@deepseek-ai/dsh-settings/src/index.ts` `SettingsScope.update(patch)`).
- `projectStore` in host stays (it still backs reads for lower-priority fields); only the
  language WRITE moves.

**Tests** (`tests/report-init-command.test.ts`):
- `--language typst` calls `languageStore.write('typst')` and never `projectStore.save`.
- no flag → reads `languageStore.read()` first, falls back to project then default.
- write happens before materialization (assert call order with a shared log array).
- host-side: `setWorkspaceLanguage` merges into the existing map (other roots preserved).

## Step 3 — `switchReportLanguage(root, from, to)` in `src/workspace/init.ts`

New exported function; pure filesystem, no DSH dependencies (same style as `materializeResources`):

```text
FOR each file of FROM set (LATEX_FILES/TYPST_FILES, export those lists or derive by language):
    target missing                          → skip
    target byte-identical to bundled source → unlink (readFileSync vs readFileSync compare)
    otherwise                                → keep (user-modified template)
FOR each file of TO set:
    target missing → copyFileSync (same as materializeResources)
    target present → never overwrite
Root missing (not a directory) → return { skipped: true } without throwing.
Never scan the workspace; iterate only the two known name lists.
```

Return a result record `{ deleted: string[], copied: string[], kept: string[], skippedRoot: boolean }`.

**Tests** (`tests/workspace-init.test.ts`) — four combinations of
"from-template modified or not" × "to-template present or not", plus:
- non-template files (e.g. `Report/figures/x.pdf`, `main.tex.bak`) untouched in every case;
- running twice changes nothing (idempotent);
- missing root returns `skippedRoot`, throws nothing;
- a from-template from an older plugin build (byte-different bundled source) counts as
  user-modified and is kept.

## Step 4 — `onChange` diff in `src/runtime.ts`

The `installSection` hook at `src/runtime.ts:154` (`onChange: () => {}`):

- Keep a `private workspaceLanguagesPrev: Record<string, ReportLanguage> = {}` snapshot.
- `onChange` reads the current resolved section via `this.userSettingsSource()`,
  diffs keys against `Prev`:
  - key present in both with different value, or key newly added →
    `switchReportLanguage(resolve(root), prevLang, nextLang)`;
  - key removed → no file work (this revision has no "revert" affordance, PLAN §2.18 Boundaries);
    remove from `Prev`.
  - missing/renamed root → `switchReportLanguage` returns `skippedRoot`; still update `Prev`
    (language is recorded by the settings write itself) and log at debug.
  - file-work errors are caught + logged, never thrown (onChange must not break the settings commit).
- IMPORTANT: `installSection` calls `hooks.onChange()` once at attach (see dsh-settings
  `installSection`), so the first invocation with an empty `Prev` must be treated as
  baseline snapshot only — no switch work for keys that merely "appeared" at attach.
  Distinguish via an `initialized` flag: first call seeds `Prev` and returns.
- In-flight workflows are unaffected by construction (they read the frozen
  `WorkflowSettingsSnapshot`), no extra guard needed — but add a comment saying so.

**Tests** (new integration test, e.g. `tests/integration.settings-switch.test.ts` or extend
`tests/integration.host.test.ts`):
- committed settings change `latex→typst` for a seeded root triggers exactly one switch
  with `(root, 'latex', 'typst')`;
- attach (initial `onChange`) triggers zero switches;
- deleting the key triggers zero switches;
- a second identical write (deep-equal) triggers nothing (dsh-settings suppresses
  deep-equal commits).

## Step 5 — Client: slot move, card restyle, language lists

**Files:** `src/client/index.ts`, `AutoReportCard.tsx`, `PluginCard.tsx`, `styles.ts`,
`controller.ts`, `locales.ts`

1. **Slot move** (`index.ts:56`): register into `plugins.bundle.config` instead of
   `plugins.item`, keyed by the package name `dsh-autoreport` (same string as
   `scripts/build-client.ts` `packageId`; hoist to a shared constant if easy, else spell it).
   Registration shape: `{ name: 'plugins.bundle.config', key: 'dsh-autoreport', ... }`
   (slot is `kind: 'keyed'` — see `dsh-client-ui-plugin-manager/src/client/slot-contract.ts`;
   the page renders it with `{ view: 'page' }` only, keyed by `pkg.name`).
   Type-only import of `@deepseek-ai/dsh-client-ui-plugin-manager/client` stays type-only
   (bundle-purity gate). `PropsRuntime<'plugins.item'>` → `PropsRuntime<'plugins.bundle.config'>`.
   Drop the `summary` branch in `AutoReportCard` (page view only) — or keep it harmless;
   the page never asks for `summary` on this slot.
2. **Card chrome** (`PluginCard.tsx` + `styles.ts`): remove the disclosure header
   (title/description/chevron/`aria-expanded`), the card border/radius/hover, the
   between-field dividers, and the rule above the save row. Target style: section headings +
   left-label/right-control rows + one save control (official page style). Keep
   read-only/unsaved/failed/save/discard logic. The page draws title/icon/crumb itself —
   do not duplicate them. In-page copy: the page's own title comes from the bundle row
   (`autoreport`), so any visible heading uses the description copy (`AutoReportDSH …`).
3. **Language lists** (new UI under the report-language row):
   - Two lists: LaTeX and Typst. Row = project name (`displayTitle`), root path (`cwd`),
     and a `−` button that moves the project to the other list.
   - Membership: rows of the session store where
     `projectionValues.agentPreset === 'autoreport'` (or the row-level `agentPreset` your
     ambient decl already reads), `parentId === undefined`, `cwd` present, `blank === false`;
     group by `cwd`. No host publication, no filesystem scan, no new wire payload (PLAN §2.18
     "The project list needs no scan").
   - Language of a workspace: `state.workspaceLanguages[cwd] ?? state.defaultReportLanguage`
     (no entry ⇒ appears under the resolved default's list).
   - `−` writes `workspaceLanguages[cwd] = <other>` through the card's staged form
     (`props.edit`/`mutate` on the field — use `SettingsScope.mutate` with path
     `['workspaceLanguages', root]` so the write is one atomic op, or stage it and let the
     existing save row commit; pick atomic — the save row should keep covering only the
     scalar fields, see step 5.4). File switching happens Host-side via step 4's `onChange`.
   - Missing/unavailable root path renders as unavailable (greyed, no `−`) — the Host marks
     it; until then, client only shows the stored path.
4. **Controller/schema** (`controller.ts`): add `workspaceLanguages` +
   `defaultReportLanguage` to `AutoReportCardSettings`/State as read projections (never
   staged-invalid). Add locale keys (`locales.ts`, zh+en): list headings, `−` aria label,
   unavailable path, empty-list copy.
5. `dsh-client.d.ts`: extend the ambient `byId` row shape with `cwd?: string`,
   `displayTitle: string`, `blank: boolean`, `parentId?: string`,
   `projectionValues?: { agentPreset?: string | null }` to match `SessionSummary`
   (`api/session-controller/src/client/sessions/service.ts:27`).

**Tests** (`tests/client/`):
- `apply.test.ts`: registers into `plugins.bundle.config` with key `dsh-autoreport`,
  not `plugins.item`.
- card test: list grouping (autoreport+cwd+non-blank only; blank/child/other-preset rows
  excluded; two sessions in one cwd ⇒ one row; no entry ⇒ falls under default language);
  `−` issues the `workspaceLanguages` path write for exactly that root.
- restyle: no assertion on CSS beyond class cleanup — just keep existing form tests green.

## Ordering & commits

Suggested commits (each green on `typecheck + test`):

1. `feat(settings): store per-workspace report language in the user namespace` — step 1
2. `refactor(init): write the language field instead of project.json` — step 2
3. `feat(workspace): switch templates on language change` — step 3
4. `feat(runtime): diff workspaceLanguages in settings onChange` — step 4
5. `feat(client): bundle-config slot, official page style, language lists` — step 5
6. docs: fold this plan's outcome back into PLAN §6 / §2.17 row 9 status.

## Out of scope (do not do)

- No workspace registry under `<dshHome>/autoreport/` (PLAN §2.18: no reader in this revision).
- No "follow the default again" undo affordance.
- No scanning the filesystem for projects; the list is session-store-derived only.
- No deletion behavior in `/init` itself; deletion exists only inside `switchReportLanguage`.
- `project.reportLanguage` is not removed — read-only compatibility for one version.
