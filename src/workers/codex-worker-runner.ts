import os from "node:os";
import path from "node:path";
import type { BlackboardDatabase } from "../blackboard/db.ts";
import {
  appendWorkerEvent,
  getWorkerHost,
  getWorkerSession,
  getWorkerTurn,
  insertWorkerSession,
  insertWorkerTurn,
  updateWorkerSession,
  updateWorkerTurn,
  upsertWorkerHost,
} from "../blackboard/query-workers.ts";
import type { CodexWorkerProfile, WorkerHostConfig } from "../config/load-config.ts";
import type { WorkerSessionRow } from "../contracts/index.ts";
import {
  CodexAppServerClient,
  type CodexAppServerEvent,
  type CodexTurnCompletion,
} from "./codex-app-server-client.ts";
import { buildCodexProfileDeveloperInstructions } from "./codex-worker-profiles.ts";

export type StartCodexWorkerOptions = {
  db: BlackboardDatabase;
  cwd: string;
  prompt: string;
  streamId?: string | null;
  piSessionId?: string | null;
  codexCommand?: string;
  workerHost?: WorkerHostConfig;
  timeoutMs?: number;
  profile?: CodexWorkerProfile;
  model?: string;
  developerInstructions?: string;
  context?: string;
  skillNames?: string[];
};

export type StartCodexWorkerFollowUpOptions = Omit<
  StartCodexWorkerOptions,
  "streamId" | "piSessionId"
> & {
  workerSessionId: string;
};

export type CodexWorkerRunHandle = {
  workerSessionId: string;
  workerTurnId: string;
  threadId: string;
  turnId: string;
  client: CodexAppServerClient;
  completion: Promise<CodexWorkerRunCompletion>;
};

export type CodexWorkerRunCompletion = {
  workerSessionId: string;
  workerTurnId: string;
  threadId: string;
  turnId: string;
  status: string;
  finalOutput: string;
};

function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function buildDeveloperInstructions(options: {
  profile?: CodexWorkerProfile;
  developerInstructions?: string;
  context?: string;
  skillNames?: string[];
}): string {
  const profile = options.profile;
  const skillNames = [...(profile?.skillNames ?? []), ...(options.skillNames ?? [])];
  return [
    profile ? buildCodexProfileDeveloperInstructions(profile) : "",
    options.developerInstructions,
    options.context ? `Additional task context:\n${options.context}` : "",
    skillNames.length > 0
      ? [
          "Requested skills:",
          ...skillNames.map((skill) => `- ${skill.startsWith("$") ? skill : `$${skill}`}`),
        ].join("\n")
      : "",
  ]
    .filter((section): section is string => Boolean(section?.trim()))
    .join("\n\n");
}

function upsertLocalHost(
  db: BlackboardDatabase,
  cwd: string,
  options: { codexCommand?: string; profile?: CodexWorkerProfile; model?: string },
): void {
  upsertWorkerHost(db, {
    hostId: "local",
    displayName: os.hostname() || "local",
    connectionMode: "local-stdio",
    projectsRoot: cwd,
    codexHome: process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex"),
    status: "ready",
    capabilities: {
      platform: process.platform,
      arch: process.arch,
      codexCommand: options.codexCommand ?? "codex",
      profileId: options.profile?.id ?? null,
      model: options.model ?? null,
    },
  });
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function remoteShellValue(value: string): string {
  if (value === "~") return '"$HOME"';
  if (value.startsWith("~/")) return `"${"$HOME"}/${value.slice(2).replaceAll('"', '\\"')}"`;
  return shellQuote(value);
}

function upsertConfiguredHost(db: BlackboardDatabase, host: WorkerHostConfig): void {
  if (getWorkerHost(db, host.id)) return;
  upsertWorkerHost(db, {
    hostId: host.id,
    displayName: host.displayName,
    connectionMode: host.connectionMode,
    connectionTarget: host.connectionTarget,
    projectsRoot: host.projectsRoot,
    codexHome: host.codexHome,
    maxConcurrentWorkers: host.maxConcurrentWorkers,
    status: "unknown",
    capabilities: host.capabilities,
  });
}

function resolveClientTransport(
  options: Pick<StartCodexWorkerOptions, "codexCommand" | "workerHost"> & { cwd: string },
) {
  const host = options.workerHost;
  if (!host || host.connectionMode === "local-stdio") {
    return {
      codexCommand: options.codexCommand,
      cwd: options.cwd,
      env: host?.codexHome ? { ...process.env, CODEX_HOME: host.codexHome } : process.env,
    };
  }
  if (host.connectionMode === "ssh-stdio") {
    if (!host.connectionTarget)
      throw new Error(`SSH worker host ${host.id} is missing connectionTarget`);
    const codexCommand = options.codexCommand ?? "codex";
    const envPrefix = host.codexHome
      ? `export CODEX_HOME=${remoteShellValue(host.codexHome)}\n`
      : "";
    const script = `${envPrefix}cd ${shellQuote(options.cwd)}\n${codexCommand} app-server`;
    return {
      spawnCommand: "ssh",
      spawnArgs: [host.connectionTarget, "sh", "-lc", shellQuote(script)],
      cwd: undefined,
      env: process.env,
    };
  }
  throw new Error(
    `Worker host mode ${host.connectionMode} is not supported for app-server turns yet`,
  );
}

function createClient(
  options: Pick<StartCodexWorkerOptions, "codexCommand" | "workerHost"> & { cwd: string },
  onEvent: (event: CodexAppServerEvent) => void,
): CodexAppServerClient {
  const transport = resolveClientTransport(options);
  return new CodexAppServerClient({
    ...transport,
    onEvent,
    onStderr: (chunk) => {
      onEvent({ method: "stderr", params: { chunk } });
    },
  });
}

function attachCompletionPersistence(args: {
  db: BlackboardDatabase;
  client: CodexAppServerClient;
  workerSessionId: string;
  workerTurnId: string;
  threadId: string;
  turnId: string;
  timeoutMs?: number;
}): Promise<CodexWorkerRunCompletion> {
  const { db, client, workerSessionId, workerTurnId, threadId, turnId } = args;
  return client
    .waitForTurnCompletion(threadId, turnId, args.timeoutMs ?? 120_000)
    .then((completion: CodexTurnCompletion) => {
      const completedAt = nowIso();
      const currentSession = getWorkerSession(db, workerSessionId);
      const currentTurn = getWorkerTurn(db, workerTurnId);
      const wasCanceled =
        currentSession?.status === "canceled" || currentTurn?.status === "canceled";
      const terminalStatus =
        wasCanceled || completion.status === "canceled" ? "canceled" : "completed";
      updateWorkerTurn(db, workerTurnId, {
        status: terminalStatus,
        finalOutput: wasCanceled ? (currentTurn?.final_output ?? null) : completion.finalOutput,
        completedAt,
      });
      updateWorkerSession(db, workerSessionId, {
        status: terminalStatus,
        completedAt,
      });
      return {
        workerSessionId,
        workerTurnId,
        threadId,
        turnId,
        status: completion.status,
        finalOutput: completion.finalOutput,
      };
    })
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      const completedAt = nowIso();
      updateWorkerTurn(db, workerTurnId, {
        status: "failed",
        errorMessage: message,
        completedAt,
      });
      updateWorkerSession(db, workerSessionId, {
        status: "failed",
        errorMessage: message,
        completedAt,
      });
      appendWorkerEvent(db, {
        workerSessionId,
        workerTurnId,
        eventType: "error",
        eventSource: "codex-app-server",
        payload: { message },
      });
      throw error;
    })
    .finally(() => client.close());
}

export async function startCodexWorker(
  options: StartCodexWorkerOptions,
): Promise<CodexWorkerRunHandle> {
  const cwd = path.resolve(options.cwd);
  const profile = options.profile;
  const model = options.model ?? profile?.model;
  const approvalPolicy = profile?.approvalPolicy ?? "never";
  const sandbox = profile?.sandbox ?? "workspace-write";
  const developerInstructions = buildDeveloperInstructions(options);
  let workerSessionId: string | undefined;
  let workerTurnId: string | undefined;

  const workerHostId = options.workerHost?.id ?? "local";
  if (options.workerHost) {
    upsertConfiguredHost(options.db, options.workerHost);
  } else {
    upsertLocalHost(options.db, cwd, { codexCommand: options.codexCommand, profile, model });
  }

  const client = createClient(
    { codexCommand: options.codexCommand, workerHost: options.workerHost, cwd },
    (event) => {
      if (!workerSessionId) return;
      appendWorkerEvent(options.db, {
        workerSessionId,
        workerTurnId,
        eventType: event.method,
        eventSource: "codex-app-server",
        payload: event,
      });
    },
  );

  try {
    const init = await client.initialize();
    workerSessionId = insertWorkerSession(options.db, {
      runnerType: "codex_app_server",
      status: "starting",
      hostId: workerHostId,
      streamId: options.streamId,
      piSessionId: options.piSessionId,
      cwd,
      repoPath: cwd,
      approvalPolicy,
      sandboxPolicy: sandbox,
      metadata: {
        initialize: init,
        profile: profile
          ? {
              id: profile.id,
              label: profile.label,
              model: profile.model ?? null,
              skillNames: profile.skillNames,
              skillPaths: profile.skillPaths,
            }
          : null,
      },
    }).worker_session_id;
    appendWorkerEvent(options.db, {
      workerSessionId,
      eventType: "initialize/result",
      eventSource: "codex-app-server",
      payload: init,
    });

    const thread = await client.startThread({
      cwd,
      model,
      approvalPolicy,
      sandbox,
      baseInstructions: profile?.baseInstructions,
      developerInstructions: developerInstructions || undefined,
    });
    const threadId = thread.thread.id;
    updateWorkerSession(options.db, workerSessionId, {
      status: "running",
      externalThreadId: threadId,
      externalSessionId: thread.thread.sessionId ?? threadId,
      modelProvider: thread.modelProvider,
      modelId: thread.model,
    });
    appendWorkerEvent(options.db, {
      workerSessionId,
      eventType: "thread/start/result",
      eventSource: "codex-app-server",
      payload: thread,
    });

    workerTurnId = insertWorkerTurn(options.db, {
      workerSessionId,
      status: "queued",
      prompt: options.prompt,
    }).worker_turn_id;

    const turn = await client.startTurn({
      threadId,
      prompt: options.prompt,
      approvalPolicy,
      model,
    });
    const turnId = turn.turn.id;
    updateWorkerTurn(options.db, workerTurnId, {
      status: "running",
      externalTurnId: turnId,
    });
    appendWorkerEvent(options.db, {
      workerSessionId,
      workerTurnId,
      eventType: "turn/start/result",
      eventSource: "codex-app-server",
      payload: turn,
    });

    return {
      workerSessionId,
      workerTurnId,
      threadId,
      turnId,
      client,
      completion: attachCompletionPersistence({
        db: options.db,
        client,
        workerSessionId,
        workerTurnId,
        threadId,
        turnId,
        timeoutMs: options.timeoutMs,
      }),
    };
  } catch (error) {
    client.close();
    const message = error instanceof Error ? error.message : String(error);
    if (workerTurnId) {
      updateWorkerTurn(options.db, workerTurnId, {
        status: "failed",
        errorMessage: message,
        completedAt: nowIso(),
      });
    }
    if (workerSessionId) {
      updateWorkerSession(options.db, workerSessionId, {
        status: "failed",
        errorMessage: message,
        completedAt: nowIso(),
      });
    }
    throw error;
  }
}

export async function startCodexWorkerFollowUp(
  options: StartCodexWorkerFollowUpOptions,
): Promise<CodexWorkerRunHandle> {
  const session = getWorkerSession(options.db, options.workerSessionId);
  if (!session) throw new Error(`Unknown worker session: ${options.workerSessionId}`);
  if (!session.external_thread_id) {
    throw new Error(`Worker session ${options.workerSessionId} has no Codex thread id`);
  }

  const cwd = path.resolve(options.cwd || session.cwd);
  const profile = options.profile;
  const model = options.model ?? profile?.model ?? session.model_id ?? undefined;
  const approvalPolicy = profile?.approvalPolicy ?? "never";
  const sandbox = profile?.sandbox ?? "workspace-write";
  const developerInstructions = buildDeveloperInstructions(options);
  let workerTurnId: string | undefined;

  if (options.workerHost) {
    upsertConfiguredHost(options.db, options.workerHost);
  } else {
    upsertLocalHost(options.db, cwd, { codexCommand: options.codexCommand, profile, model });
  }

  const client = createClient(
    { codexCommand: options.codexCommand, workerHost: options.workerHost, cwd },
    (event) => {
      appendWorkerEvent(options.db, {
        workerSessionId: session.worker_session_id,
        workerTurnId,
        eventType: event.method,
        eventSource: "codex-app-server",
        payload: event,
      });
    },
  );

  try {
    const init = await client.initialize();
    appendWorkerEvent(options.db, {
      workerSessionId: session.worker_session_id,
      eventType: "followup/initialize/result",
      eventSource: "codex-app-server",
      payload: init,
    });

    const thread = await client.resumeThread({
      threadId: session.external_thread_id,
      cwd,
      model,
      approvalPolicy,
      sandbox,
      baseInstructions: profile?.baseInstructions,
      developerInstructions: developerInstructions || undefined,
    });
    updateWorkerSession(options.db, session.worker_session_id, {
      status: "running",
      externalThreadId: thread.thread.id,
      externalSessionId: thread.thread.sessionId ?? thread.thread.id,
      modelProvider: thread.modelProvider,
      modelId: thread.model,
      completedAt: null,
      errorMessage: null,
    });
    appendWorkerEvent(options.db, {
      workerSessionId: session.worker_session_id,
      eventType: "thread/resume/result",
      eventSource: "codex-app-server",
      payload: thread,
    });

    workerTurnId = insertWorkerTurn(options.db, {
      workerSessionId: session.worker_session_id,
      status: "queued",
      prompt: options.prompt,
    }).worker_turn_id;

    const turn = await client.startTurn({
      threadId: thread.thread.id,
      prompt: options.prompt,
      approvalPolicy,
      model,
    });
    const turnId = turn.turn.id;
    updateWorkerTurn(options.db, workerTurnId, {
      status: "running",
      externalTurnId: turnId,
    });
    appendWorkerEvent(options.db, {
      workerSessionId: session.worker_session_id,
      workerTurnId,
      eventType: "turn/start/result",
      eventSource: "codex-app-server",
      payload: turn,
    });

    return {
      workerSessionId: session.worker_session_id,
      workerTurnId,
      threadId: thread.thread.id,
      turnId,
      client,
      completion: attachCompletionPersistence({
        db: options.db,
        client,
        workerSessionId: session.worker_session_id,
        workerTurnId,
        threadId: thread.thread.id,
        turnId,
        timeoutMs: options.timeoutMs,
      }),
    };
  } catch (error) {
    client.close();
    const message = error instanceof Error ? error.message : String(error);
    if (workerTurnId) {
      updateWorkerTurn(options.db, workerTurnId, {
        status: "failed",
        errorMessage: message,
        completedAt: nowIso(),
      });
    }
    updateWorkerSession(options.db, session.worker_session_id, {
      status: "failed",
      errorMessage: message,
      completedAt: nowIso(),
    });
    throw error;
  }
}

export function parseWorkerProfileId(session: WorkerSessionRow): string | undefined {
  if (!session.metadata_json) return undefined;
  try {
    const metadata = JSON.parse(session.metadata_json) as { profile?: { id?: unknown } };
    return typeof metadata.profile?.id === "string" ? metadata.profile.id : undefined;
  } catch {
    return undefined;
  }
}
