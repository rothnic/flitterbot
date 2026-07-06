import type http from "node:http";
import {
  getWorkerHost,
  listWorkerSessionsByStream,
  listWorkerTurnsBySession,
} from "../blackboard/query-workers.ts";
import type {
  WorkerHostConnectionMode,
  WorkerRunnerType,
  WorkerSessionStatus,
  WorkerTurnStatus,
} from "../contracts/index.ts";
import type { ControlSurfaceRuntime } from "../runtime.ts";
import { requireBearer, sendJson } from "./_shared.ts";

type BrowserWorkerTurnItem = {
  workerTurnId: string;
  externalTurnId: string | null;
  status: WorkerTurnStatus;
  prompt: string | null;
  finalOutput: string | null;
  startedAt: string;
  completedAt: string | null;
  errorMessage: string | null;
};

type BrowserWorkerSessionItem = {
  workerSessionId: string;
  runnerType: WorkerRunnerType;
  status: WorkerSessionStatus;
  hostId: string | null;
  hostDisplayName: string | null;
  connectionMode: WorkerHostConnectionMode | null;
  cwd: string;
  repoPath: string | null;
  worktreePath: string | null;
  branch: string | null;
  modelProvider: string | null;
  modelId: string | null;
  profileId: string | null;
  externalThreadId: string | null;
  externalSessionId: string | null;
  approvalPolicy: string | null;
  sandboxPolicy: string | null;
  startedAt: string;
  lastEventAt: string;
  completedAt: string | null;
  errorMessage: string | null;
  turns: BrowserWorkerTurnItem[];
};

function parseProfileId(metadataJson: string | null): string | null {
  if (!metadataJson) return null;
  try {
    const metadata = JSON.parse(metadataJson) as { profile?: { id?: unknown } };
    return typeof metadata.profile?.id === "string" ? metadata.profile.id : null;
  } catch {
    return null;
  }
}

export async function handleBrowserWorkerSessionsRoute(
  runtime: ControlSurfaceRuntime,
  request: http.IncomingMessage,
  response: http.ServerResponse,
  streamId: string,
) {
  if (!requireBearer(request, runtime.config.controlSurfaceToken)) {
    return sendJson(response, 401, { ok: false, error: "unauthorized" });
  }
  const sessions = listWorkerSessionsByStream(runtime.blackboard, streamId, 20);
  const items: BrowserWorkerSessionItem[] = sessions.map((session) => {
    const host = session.host_id ? getWorkerHost(runtime.blackboard, session.host_id) : null;
    return {
      workerSessionId: session.worker_session_id,
      runnerType: session.runner_type,
      status: session.status,
      hostId: session.host_id,
      hostDisplayName: host?.display_name ?? null,
      connectionMode: host?.connection_mode ?? null,
      cwd: session.cwd,
      repoPath: session.repo_path,
      worktreePath: session.worktree_path,
      branch: session.branch,
      modelProvider: session.model_provider,
      modelId: session.model_id,
      profileId: parseProfileId(session.metadata_json),
      externalThreadId: session.external_thread_id,
      externalSessionId: session.external_session_id,
      approvalPolicy: session.approval_policy,
      sandboxPolicy: session.sandbox_policy,
      startedAt: session.started_at,
      lastEventAt: session.last_event_at,
      completedAt: session.completed_at,
      errorMessage: session.error_message,
      turns: listWorkerTurnsBySession(runtime.blackboard, session.worker_session_id).map(
        (turn) => ({
          workerTurnId: turn.worker_turn_id,
          externalTurnId: turn.external_turn_id,
          status: turn.status,
          prompt: turn.prompt,
          finalOutput: turn.final_output,
          startedAt: turn.started_at,
          completedAt: turn.completed_at,
          errorMessage: turn.error_message,
        }),
      ),
    };
  });

  return sendJson(response, 200, { items });
}
