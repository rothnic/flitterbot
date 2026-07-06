import { randomUUID } from "node:crypto";
import type {
  WorkerEventRow,
  WorkerHostConnectionMode,
  WorkerHostRow,
  WorkerHostStatus,
  WorkerRunnerType,
  WorkerSessionRow,
  WorkerSessionStatus,
  WorkerTurnRow,
  WorkerTurnStatus,
} from "../contracts/index.ts";
import type { BlackboardDatabase } from "./db.ts";

function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function encodeJson(value: unknown): string | null {
  if (value == null) return null;
  return JSON.stringify(value);
}

export type UpsertWorkerHostInput = {
  hostId: string;
  displayName: string;
  connectionMode: WorkerHostConnectionMode;
  connectionTarget?: string | null;
  projectsRoot?: string | null;
  codexHome?: string | null;
  maxConcurrentWorkers?: number;
  status?: WorkerHostStatus;
  capabilities?: unknown;
};

export function upsertWorkerHost(
  db: BlackboardDatabase,
  input: UpsertWorkerHostInput,
): WorkerHostRow {
  const updatedAt = nowIso();
  db.prepare(
    `INSERT INTO worker_hosts (
       host_id, display_name, connection_mode, connection_target, projects_root,
       codex_home, max_concurrent_workers, status, last_heartbeat_at,
       capabilities_json, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(host_id) DO UPDATE SET
       display_name = excluded.display_name,
       connection_mode = excluded.connection_mode,
       connection_target = excluded.connection_target,
       projects_root = excluded.projects_root,
       codex_home = excluded.codex_home,
       max_concurrent_workers = excluded.max_concurrent_workers,
       status = excluded.status,
       last_heartbeat_at = excluded.last_heartbeat_at,
       capabilities_json = excluded.capabilities_json,
       updated_at = excluded.updated_at`,
  ).run(
    input.hostId,
    input.displayName,
    input.connectionMode,
    input.connectionTarget ?? null,
    input.projectsRoot ?? null,
    input.codexHome ?? null,
    input.maxConcurrentWorkers ?? 1,
    input.status ?? "ready",
    updatedAt,
    encodeJson(input.capabilities),
    updatedAt,
  );
  return getWorkerHost(db, input.hostId)!;
}

export function getWorkerHost(db: BlackboardDatabase, hostId: string): WorkerHostRow | null {
  return db.get<WorkerHostRow>("SELECT * FROM worker_hosts WHERE host_id = ?", hostId) ?? null;
}

export function listWorkerHosts(db: BlackboardDatabase): WorkerHostRow[] {
  return db.all<WorkerHostRow>(
    `SELECT *
     FROM worker_hosts
     ORDER BY status = 'ready' DESC, host_id ASC`,
  );
}

export function getWorkerHostActiveSessionCount(db: BlackboardDatabase, hostId: string): number {
  const row = db.get<{ count: number }>(
    `SELECT COUNT(*) AS count
     FROM worker_sessions
     WHERE host_id = ?
       AND status IN ('starting', 'running', 'waiting_for_user')`,
    hostId,
  );
  return row?.count ?? 0;
}

export function updateWorkerHostStatus(
  db: BlackboardDatabase,
  hostId: string,
  input: { status: WorkerHostStatus; capabilities?: unknown },
): WorkerHostRow {
  const current = getWorkerHost(db, hostId);
  if (!current) throw new Error(`Unknown worker host: ${hostId}`);
  const updatedAt = nowIso();
  db.prepare(
    `UPDATE worker_hosts
     SET status = ?,
         last_heartbeat_at = ?,
         capabilities_json = ?,
         updated_at = ?
     WHERE host_id = ?`,
  ).run(
    input.status,
    updatedAt,
    input.capabilities === undefined ? current.capabilities_json : encodeJson(input.capabilities),
    updatedAt,
    hostId,
  );
  return getWorkerHost(db, hostId)!;
}

const ACTIVE_WORKER_SESSION_STATUSES: WorkerSessionStatus[] = [
  "starting",
  "running",
  "waiting_for_user",
];

const ACTIVE_WORKER_TURN_STATUSES: WorkerTurnStatus[] = ["queued", "running", "waiting_for_user"];

export type InsertWorkerSessionInput = {
  workerSessionId?: string;
  runnerType: WorkerRunnerType;
  status?: WorkerSessionStatus;
  hostId?: string | null;
  streamId?: string | null;
  piSessionId?: string | null;
  legacySessionId?: string | null;
  cwd: string;
  repoPath?: string | null;
  worktreePath?: string | null;
  branch?: string | null;
  modelProvider?: string | null;
  modelId?: string | null;
  externalThreadId?: string | null;
  externalSessionId?: string | null;
  approvalPolicy?: string | null;
  sandboxPolicy?: string | null;
  metadata?: unknown;
};

export function insertWorkerSession(
  db: BlackboardDatabase,
  input: InsertWorkerSessionInput,
): WorkerSessionRow {
  const workerSessionId = input.workerSessionId ?? randomUUID();
  const startedAt = nowIso();
  db.prepare(
    `INSERT INTO worker_sessions (
       worker_session_id, runner_type, status, host_id, stream_id, pi_session_id,
       legacy_session_id, cwd, repo_path, worktree_path, branch, model_provider,
       model_id, external_thread_id, external_session_id, approval_policy,
       sandbox_policy, started_at, last_event_at, metadata_json
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    workerSessionId,
    input.runnerType,
    input.status ?? "starting",
    input.hostId ?? null,
    input.streamId ?? null,
    input.piSessionId ?? null,
    input.legacySessionId ?? null,
    input.cwd,
    input.repoPath ?? null,
    input.worktreePath ?? null,
    input.branch ?? null,
    input.modelProvider ?? null,
    input.modelId ?? null,
    input.externalThreadId ?? null,
    input.externalSessionId ?? null,
    input.approvalPolicy ?? null,
    input.sandboxPolicy ?? null,
    startedAt,
    startedAt,
    encodeJson(input.metadata),
  );
  return getWorkerSession(db, workerSessionId)!;
}

export function getWorkerSession(
  db: BlackboardDatabase,
  workerSessionId: string,
): WorkerSessionRow | null {
  return (
    db.get<WorkerSessionRow>(
      "SELECT * FROM worker_sessions WHERE worker_session_id = ?",
      workerSessionId,
    ) ?? null
  );
}

export function listWorkerSessionsByStream(
  db: BlackboardDatabase,
  streamId: string,
  limit = 10,
): WorkerSessionRow[] {
  return db.all<WorkerSessionRow>(
    `SELECT *
     FROM worker_sessions
     WHERE stream_id = ?
     ORDER BY started_at DESC
     LIMIT ?`,
    streamId,
    limit,
  );
}

export type UpdateWorkerSessionInput = {
  status?: WorkerSessionStatus;
  externalThreadId?: string | null;
  externalSessionId?: string | null;
  modelProvider?: string | null;
  modelId?: string | null;
  errorMessage?: string | null;
  completedAt?: string | null;
};

export function updateWorkerSession(
  db: BlackboardDatabase,
  workerSessionId: string,
  input: UpdateWorkerSessionInput,
): WorkerSessionRow {
  const current = getWorkerSession(db, workerSessionId);
  if (!current) throw new Error(`Unknown worker session: ${workerSessionId}`);
  const lastEventAt = nowIso();
  db.prepare(
    `UPDATE worker_sessions
     SET status = ?,
         external_thread_id = ?,
         external_session_id = ?,
         model_provider = ?,
         model_id = ?,
         error_message = ?,
         completed_at = ?,
         last_event_at = ?
     WHERE worker_session_id = ?`,
  ).run(
    input.status ?? current.status,
    input.externalThreadId === undefined ? current.external_thread_id : input.externalThreadId,
    input.externalSessionId === undefined ? current.external_session_id : input.externalSessionId,
    input.modelProvider === undefined ? current.model_provider : input.modelProvider,
    input.modelId === undefined ? current.model_id : input.modelId,
    input.errorMessage === undefined ? current.error_message : input.errorMessage,
    input.completedAt === undefined ? current.completed_at : input.completedAt,
    lastEventAt,
    workerSessionId,
  );
  return getWorkerSession(db, workerSessionId)!;
}

export type InsertWorkerTurnInput = {
  workerTurnId?: string;
  workerSessionId: string;
  externalTurnId?: string | null;
  clientMessageId?: string | null;
  status?: WorkerTurnStatus;
  prompt?: string | null;
  finalOutput?: string | null;
  metadata?: unknown;
};

export function insertWorkerTurn(
  db: BlackboardDatabase,
  input: InsertWorkerTurnInput,
): WorkerTurnRow {
  const workerTurnId = input.workerTurnId ?? randomUUID();
  db.prepare(
    `INSERT INTO worker_turns (
       worker_turn_id, worker_session_id, external_turn_id, client_message_id,
       status, prompt, final_output, metadata_json
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    workerTurnId,
    input.workerSessionId,
    input.externalTurnId ?? null,
    input.clientMessageId ?? null,
    input.status ?? "queued",
    input.prompt ?? null,
    input.finalOutput ?? null,
    encodeJson(input.metadata),
  );
  return getWorkerTurn(db, workerTurnId)!;
}

export function getWorkerTurn(db: BlackboardDatabase, workerTurnId: string): WorkerTurnRow | null {
  return (
    db.get<WorkerTurnRow>("SELECT * FROM worker_turns WHERE worker_turn_id = ?", workerTurnId) ??
    null
  );
}

export function listWorkerTurnsBySession(
  db: BlackboardDatabase,
  workerSessionId: string,
): WorkerTurnRow[] {
  return db.all<WorkerTurnRow>(
    `SELECT *
     FROM worker_turns
     WHERE worker_session_id = ?
     ORDER BY started_at ASC, rowid ASC`,
    workerSessionId,
  );
}

export function getLatestWorkerTurnBySession(
  db: BlackboardDatabase,
  workerSessionId: string,
): WorkerTurnRow | null {
  return (
    db.get<WorkerTurnRow>(
      `SELECT *
       FROM worker_turns
       WHERE worker_session_id = ?
       ORDER BY started_at DESC, rowid DESC
       LIMIT 1`,
      workerSessionId,
    ) ?? null
  );
}

export type UpdateWorkerTurnInput = {
  status?: WorkerTurnStatus;
  externalTurnId?: string | null;
  finalOutput?: string | null;
  errorMessage?: string | null;
  completedAt?: string | null;
};

export function updateWorkerTurn(
  db: BlackboardDatabase,
  workerTurnId: string,
  input: UpdateWorkerTurnInput,
): WorkerTurnRow {
  const current = getWorkerTurn(db, workerTurnId);
  if (!current) throw new Error(`Unknown worker turn: ${workerTurnId}`);
  db.prepare(
    `UPDATE worker_turns
     SET status = ?,
         external_turn_id = ?,
         final_output = ?,
         error_message = ?,
         completed_at = ?
     WHERE worker_turn_id = ?`,
  ).run(
    input.status ?? current.status,
    input.externalTurnId === undefined ? current.external_turn_id : input.externalTurnId,
    input.finalOutput === undefined ? current.final_output : input.finalOutput,
    input.errorMessage === undefined ? current.error_message : input.errorMessage,
    input.completedAt === undefined ? current.completed_at : input.completedAt,
    workerTurnId,
  );
  return getWorkerTurn(db, workerTurnId)!;
}

export type ReconciledInterruptedWorkerSession = {
  workerSessionId: string;
  workerTurnId: string | null;
  previousStatus: WorkerSessionStatus;
  previousTurnStatus: WorkerTurnStatus | null;
};

export function reconcileInterruptedCodexWorkerSessions(
  db: BlackboardDatabase,
  input: { reason: string; runtimeInstanceId?: string },
): ReconciledInterruptedWorkerSession[] {
  const sessions = db.all<WorkerSessionRow>(
    `SELECT *
     FROM worker_sessions
     WHERE runner_type = 'codex_app_server'
       AND status IN (${ACTIVE_WORKER_SESSION_STATUSES.map(() => "?").join(", ")})
     ORDER BY last_event_at ASC`,
    ...ACTIVE_WORKER_SESSION_STATUSES,
  );
  const reconciled: ReconciledInterruptedWorkerSession[] = [];
  const completedAt = nowIso();
  for (const session of sessions) {
    const latestTurn = getLatestWorkerTurnBySession(db, session.worker_session_id);
    const previousTurnStatus = latestTurn?.status ?? null;
    updateWorkerSession(db, session.worker_session_id, {
      status: "unreachable",
      errorMessage: input.reason,
      completedAt,
    });
    if (latestTurn && ACTIVE_WORKER_TURN_STATUSES.includes(latestTurn.status)) {
      updateWorkerTurn(db, latestTurn.worker_turn_id, {
        status: "failed",
        errorMessage: input.reason,
        completedAt,
      });
    }
    appendWorkerEvent(db, {
      workerSessionId: session.worker_session_id,
      workerTurnId: latestTurn?.worker_turn_id ?? null,
      eventType: "worker/recovery/interrupted",
      eventSource: "flitterbot",
      payload: {
        reason: input.reason,
        runtimeInstanceId: input.runtimeInstanceId ?? null,
        previousStatus: session.status,
        previousTurnStatus,
      },
    });
    reconciled.push({
      workerSessionId: session.worker_session_id,
      workerTurnId: latestTurn?.worker_turn_id ?? null,
      previousStatus: session.status,
      previousTurnStatus,
    });
  }
  return reconciled;
}

export type AppendWorkerEventInput = {
  workerEventId?: string;
  workerSessionId: string;
  workerTurnId?: string | null;
  eventType: string;
  eventSource?: string;
  payload: unknown;
};

export function appendWorkerEvent(
  db: BlackboardDatabase,
  input: AppendWorkerEventInput,
): WorkerEventRow {
  const workerEventId = input.workerEventId ?? randomUUID();
  db.prepare(
    `INSERT INTO worker_events (
       worker_event_id, worker_session_id, worker_turn_id,
       event_type, event_source, payload_json
     ) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    workerEventId,
    input.workerSessionId,
    input.workerTurnId ?? null,
    input.eventType,
    input.eventSource ?? "runner",
    JSON.stringify(input.payload ?? null),
  );
  return (
    db.get<WorkerEventRow>(
      "SELECT * FROM worker_events WHERE worker_event_id = ?",
      workerEventId,
    ) ??
    (() => {
      throw new Error(`Failed to read worker event after insert: ${workerEventId}`);
    })()
  );
}
