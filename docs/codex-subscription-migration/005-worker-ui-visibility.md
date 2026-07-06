# Worker UI Visibility

## Objective

Expose Codex worker sessions in the operator UI so coding work is visible
without querying SQLite directly.

## Scope

- Add an API route for worker sessions by stream.
- Return worker host, runner, profile, model, status, thread id, turn ids,
  final output, and errors.
- Render Codex worker sessions in the existing stream side panel alongside
  legacy downstream/tmux sessions.
- Keep legacy session visibility intact.

## Out Of Scope

- Starting, following up, or canceling workers from the web UI.
- Streaming every app-server event into the browser.
- Remote host scheduling.

## Definition Of Done

- Bearer-protected `GET /api/streams/:streamId/workers` returns neutral worker
  session rows for the stream.
- The web side panel displays a `Codex Workers` section when worker sessions
  exist.
- The side panel frames the area as worker activity, with Codex workers first
  and legacy tmux/Claude rows explicitly labeled as `Legacy Sessions`.
- Each worker row shows status, worker session id, profile/model, host, thread
  id, and latest final output or error.
- Existing legacy downstream/tmux session rendering remains available.
- `pnpm run audit` and `pnpm --dir web run build` pass.

## Validation

```bash
pnpm run e2e:worker-ui-visibility -- --cwd "$PWD"
pnpm run e2e:codex-worker-control-plane -- --cwd "$PWD"
pnpm run audit
pnpm --dir web run build
```

Manual UI proof:

1. Start the control surface and web UI.
2. Open a stream where a Codex worker has completed.
3. Confirm the side panel shows `Codex Workers`, status, host/profile/model,
   thread id, and latest output.

## Verified Evidence

2026-07-06 local run:

- `pnpm run e2e:worker-ui-visibility -- --cwd "$PWD"` passed against a
  temporary runtime and blackboard.
- The smoke inserted a `codex_app_server` worker session and turn, started the
  real control-surface HTTP router on an ephemeral local port, verified
  unauthenticated worker reads return 401, and verified authenticated
  `GET /api/streams/:streamId/workers` returned one item with final output
  `worker-ui-ok`.
- The repeatable smoke verified the browser worker API returns host, profile,
  model, status, thread id, and final output, then rendered the stream side
  panel through Vite SSR with a seeded Codex worker and legacy tmux session.
- The rendered proof verified `Worker Activity` contains `Codex Workers` before
  the worker output, then `Legacy Sessions` before the tmux row, without showing
  the empty state.
- The rendered proof also covers the no-attached-stream path, where legacy
  sessions are empty and the disabled worker query still needs to show `No
  Codex workers or legacy sessions.` instead of a blank panel.
- The rendered proof distinguishes pending worktree context from resolved
  no-stream state, so the empty state does not flash before worker lookup can
  know whether a stream id exists.
- `pnpm --dir web run build` passed with the existing Vite large-chunk warning.
- `pnpm run audit` passed.
