# Subscription Auth Closure

## Objective

Make the Codex subscription migration explicit about which auth layer powers
each kind of work, and provide a repeatable doctor command that proves the
current state.

## Auth Decision

- **Coding workers** use Codex CLI/app-server auth. This is the right path for
  real coding tasks because `codex app-server` owns threads, turns, streamed
  events, approvals, and resumability.
- **Pi orchestrator prompts** use Pi provider auth. If the orchestrator model is
  `openai-codex/gpt-5.5`, Pi needs a Pi-visible `openai-codex` credential. The
  Codex CLI credential store does not satisfy this by itself. Flitterbot
  resolves Pi auth by preferring a populated
  `~/.flitterbot/control-surface/agent/auth.json` for the target provider,
  then a populated `~/.pi/agent/auth.json` for that provider; empty files and
  unrelated provider credentials are ignored for provider-specific selection.
- **Classifier prompts** are orchestrator-adjacent. Prefer
  `classifier.provider: "pi"` after Pi provider auth is present. Until then use
  `disabled`, direct API auth, or an OpenAI-compatible proxy such as 9router.

## Scope

- Add `pnpm run doctor:codex-subscription-auth`.
- Check Codex CLI availability and login status for worker execution.
- Inspect Pi auth files without printing secret values.
- Report the resolved Pi auth path so an empty global Pi auth file cannot hide
  a populated Flitterbot control-surface auth file.
- Report whether the configured default orchestrator provider needs Pi
  `openai-codex` auth.
- Report classifier auth readiness.
- Exit nonzero when required auth is missing, unless `--report-only` is used.

## Out Of Scope

- Performing an interactive Pi provider login.
- Copying Codex credentials into Pi auth stores.
- Guaranteeing 9router model availability.

## Validation

```bash
pnpm run doctor:codex-subscription-readiness -- --cwd "$PWD"
pnpm run doctor:codex-subscription-auth -- --fresh-local --cwd "$PWD" --report-only
pnpm run e2e:classifier-provider-configs
pnpm run audit
```

Run without `--report-only` when the operator expects all auth gates to be
ready:

```bash
pnpm run doctor:codex-subscription-auth
```

Run the aggregate readiness doctor in strict mode after Pi provider auth is
present:

```bash
pnpm run doctor:codex-subscription-readiness -- --cwd "$PWD" --strict --full-local-worker
```

## Verified Evidence

2026-07-06 local run:

- `pnpm run doctor:codex-subscription-auth -- --fresh-local --cwd "$PWD" --report-only`
  completed and reported `codexWorkers.ready: true`.
- The doctor found `~/.codex` auth and `codex-cli 0.142.5`.
- The doctor found `~/.pi/agent/auth.json` but no Pi provider keys.
- The doctor found no fresh Flitterbot control-surface Pi auth file.
- The doctor reported `piOrchestrator.ready: false` for `openai-codex`.
- The doctor reported classifier readiness as true only because the fresh-local
  validation config uses `classifier.provider: "disabled"`.

2026-07-06 follow-up run after auth path selection hardening:

- `pnpm run doctor:codex-subscription-auth -- --fresh-local --cwd "$PWD" --report-only`
  completed and reported `codexWorkers.ready: true`.
- The report included `piOrchestrator.resolvedAuthPath` and selected the
  Flitterbot control-surface auth path because no populated Pi auth file exists.
- The report marked the empty `~/.pi/agent/auth.json` as
  `hasCredentials: false`, so it cannot shadow a populated control-surface
  auth file.
- A focused resolver regression check confirmed empty control auth falls back
  to populated global `openai-codex` auth, unrelated control provider auth does
  not shadow global `openai-codex` auth, and populated control
  `openai-codex` auth wins.
- `pnpm run e2e:classifier-provider-configs` passed and verified doctor/config
  readiness reporting for classifier providers `disabled`, `groq`, `openai`,
  `openai-compatible`, and `pi`, including missing-key, API-key-present,
  9router-style base URL, and Pi provider-auth-present/missing cases.
- `pnpm run doctor:codex-subscription-readiness -- --cwd "$PWD"` passed in
  report mode and produced one JSON readiness summary for auth, classifier
  provider configs, Codex-first install defaults, host scheduler, worker UI
  visibility, and Pi provider-auth readiness. Report mode requires Codex worker
  auth but does not run the live Pi harness unless `--live-pi-harness` is
  passed.

## Remaining Operator Action

The subscription-only story is complete for coding workers, but not for live Pi
orchestrator prompts until Pi has an `openai-codex` provider credential or the
default orchestrator is configured to a provider with available Pi auth. This is
an external auth setup step, not a Codex app-server worker implementation gap.

To close the Pi auth gate, run interactive Pi and complete provider login:

```bash
pnpm exec pi
/login
```

Select `ChatGPT Plus/Pro (Codex)`, then rerun:

```bash
pnpm run doctor:codex-subscription-auth
```
