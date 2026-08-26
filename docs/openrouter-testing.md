# Testing AutoReportDSH against OpenRouter (`stealth/ox-alpha`)

Real-API milestone configuration (PLAN.md §2.13, §3). DSH owns provider
execution and credentials; AutoReportDSH only documents how to point a route
at OpenRouter and select it. Credentials never live in this repository.

## 1. Verified endpoint spelling

DSH's LLM adapter (`@deepseek-ai/dsh-llm-pi-ai`) speaks the Anthropic wire
protocol through the `anthropic-messages` API, which drives the official
Anthropic SDK client with `baseURL = model.baseUrl`. That SDK posts to
`<baseURL>/v1/messages` (verified in `@anthropic-ai/sdk`:
`client.post('/v1/messages', …)`), so the route's `baseURL` must be:

```text
https://openrouter.ai/api
```

and requests land on `https://openrouter.ai/api/v1/messages`.

> Do NOT configure `https://openrouter.ai/api/v1` — the SDK appends
> `/v1/messages` itself, which would produce `/v1/v1/messages`.

## 2. Provider route

Add the provider under the `llm-pi-ai` settings namespace in the harness home's
`settings.yaml` (or pass the same shape as the plugin row's `config.providers`
in a composition/overlay). A hand-declared route — OpenRouter ships no pi-ai
catalog entry by default — needs `apiKeyEnv`, `api`, `baseURL`, and its models:

```yaml
# <dshHome>/settings.yaml
llm-pi-ai:
  providers:
    openrouter:
      displayName: OpenRouter
      apiKeyEnv: OPENROUTER_API_KEY   # resolved per request via ctx.credentials / env
      api: anthropic-messages         # wire protocol (the ONLY supported spelling)
      baseURL: https://openrouter.ai/api
      models:
        - id: 'stealth/ox-alpha'
          name: Ox Alpha
          contextWindow: 262144       # declared, not interrogated; correct if your tier differs
          maxTokens: 8192
        - id: 'stealth/ox-alpha[1M]'
          name: Ox Alpha 1M Context
          contextWindow: 1000000
          maxTokens: 8192
```

Notes:

- Model ids are sent verbatim to the gateway; quote `[1M]` in YAML.
- `contextWindow`/`maxTokens` are capacity claims. Over-claiming admits a
  request that fails mid-turn; under-claiming refuses attachments early.
- A missing key fails loud with `MISSING_CREDENTIAL` naming `OPENROUTER_API_KEY`
  — export it or store it through DSH's credentials service.

## 3. Selecting the route as MAIN's model

```yaml
# <dshHome>/settings.yaml (same document)
agent-default-model:
  provider: openrouter
  model: 'stealth/ox-alpha'
```

Specialist children inherit the Main selection unless the AutoReport
composition config sets `specialistModel` (PLAN §2.13), and an in-flight
workflow keeps the snapshot frozen at creation time (PLAN §2.14).

## 4. Boot with the overlay

After `pnpm run build && pnpm install:preset` in this repository:

```sh
pnpm dsh web --patch ./cordis.overlay.generated.yml     # from the harness checkout
```

The overlay disables the stock `tool-subagent-report` row and inserts
`autoreportdsh-host` plus `autoreportdsh-report-router`; select the
`autoreport-main` preset for the session. Windows is unsupported until
network-denial isolation is verified there (PLAN §2.9).

## 5. Automated e2e

`tests/e2e/openrouter.e2e.test.ts` boots a real headless Loader composition
(spine + persistence + subagents + both overlay rows) against a temporary
harness home, sends one trivial prompt to MAIN through the real adapter, and
asserts only that **a response happened** (non-empty assistant output plus a
persisted transcript) — never any particular model text. Runtime is bounded
(<120s including cleanup).

The e2e is also the real-API coexistence smoke: its session runs the stock
`agent-spine-demo` composition (no `autoreport-main` preset), so with both
overlay rows loaded it additionally asserts the transcript contains **no**
`autoreport/*` events — the overlay must leave sessions that did not select
AutoReport entirely untouched (see `src/membership.ts`).

Activation checklist:

| Condition | Effect |
|---|---|
| `OPENROUTER_API_KEY` unset | test self-skips (keyless CI stays green) |
| harness checkout not resolvable via linked deps | skip with reason |
| `dist/src/host.js` / router entry missing | one bounded `pnpm run build`, else skip |
| all preconditions met | real network turn runs, bounded at ~100s process timeout |

```sh
export OPENROUTER_API_KEY=...   # environment only; never committed
pnpm vitest run tests/e2e/openrouter.e2e.test.ts
```

## 6. Environment-variable checklist

- [ ] `OPENROUTER_API_KEY` — exported in the invoking shell (or stored via
      DSH's credentials service); the adapter fails loud without it.
- [ ] `DSH_HOME` — optional; point at an isolated directory for experiments
      (the e2e always uses a temp home).
- [ ] No other AutoReport variables are required; report-execution network
      denial is independent of provider access (specialists still cannot reach
      the network; only the host process talks to OpenRouter).
