# Live provider smoke for AutoReportDSH

This opt-in smoke uses the **already configured default model route of a DSH deployment**. It does not declare a provider, model, endpoint, or credential, and it never reads or converts provider secrets.

Its purpose is to answer one deployment-level question:

```text
Can the configured DSH profile still make one real model turn when the
AutoReportDSH overlay is loaded?
```

The normal unit/integration suite remains keyless. This test requires an explicit opt-in so local test runs never consume provider quota accidentally.

## Prerequisites

- Complete the [source installation](../README.md#run-from-source) first.
- Use a DSH home that already has a working configured default model route.
- Ensure the local Harness profile selected below can run normally before adding the AutoReport overlay.

You may use your ordinary DSH home or, preferably, an isolated DSH home that contains a copy of the intended provider/settings/credential configuration.

## Run

```sh
cd /path/to/AutoReportDSH

export AUTOREPORT_LIVE_TEST=1
export AUTOREPORT_E2E_DSH_HOME="/path/to/configured/dsh-home"
# Optional; defaults to headless.
export AUTOREPORT_E2E_PROFILE=headless

pnpm vitest run tests/e2e/configured-route.e2e.test.ts
```

The test:

1. builds AutoReportDSH if its `dist/` entries are absent;
2. idempotently materializes `autoreport` into the explicitly selected DSH home;
3. starts the local source Harness with its normal selected profile and the generated AutoReport overlay;
4. sends one short headless task through the profile's current default model route;
5. verifies that a non-empty assistant response is returned.

It does not alter the profile's provider settings, default route, or credentials. The overlay coexistence tests separately verify that a normal non-AutoReport session remains stock DSH behavior.

## Why there is no fixed OpenRouter configuration

Provider selection is a DSH responsibility. AutoReportDSH deliberately has no provider configuration or API-key layer. A fixed OpenRouter `stealth/ox-alpha` route is useful for a controlled external benchmark, but it is not a valid deployment smoke: it can pass while the route a user actually configured in DSH is broken, or fail because an unrelated gateway quota is exhausted.

For a controlled OpenRouter benchmark, configure that route in DSH first, make it the deployment default (or select the matching profile), then run the same test. The test will use it automatically.

## Diagnostics and safety

The subprocess captures stdout/stderr and includes both in an assertion failure. It never prints environment variables or credential values. The command is bounded to 110 seconds and the temporary workspace is removed afterwards.

The test is skipped unless both variables below are set:

```text
AUTOREPORT_LIVE_TEST=1
AUTOREPORT_E2E_DSH_HOME=/path/to/configured/dsh-home
```
