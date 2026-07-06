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
  Codex CLI credential store does not satisfy this by itself.
- **Classifier prompts** are orchestrator-adjacent. Prefer
  `classifier.provider: "pi"` after Pi provider auth is present. Until then use
  `disabled`, direct API auth, or an OpenAI-compatible proxy such as 9router.

## Scope

- Add `pnpm run doctor:codex-subscription-auth`.
- Check Codex CLI availability and login status for worker execution.
- Inspect Pi auth files without printing secret values.
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
pnpm run doctor:codex-subscription-auth -- --fresh-local --cwd "$PWD" --report-only
pnpm run audit
```

Run without `--report-only` when the operator expects all auth gates to be
ready:

```bash
pnpm run doctor:codex-subscription-auth
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

## Remaining Operator Action

The subscription-only story is complete for coding workers, but not for live Pi
orchestrator prompts until Pi has an `openai-codex` provider credential or the
default orchestrator is configured to a provider with available Pi auth. This is
an external auth setup step, not a Codex app-server worker implementation gap.
