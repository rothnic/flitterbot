import os from "node:os";
import path from "node:path";
import type { BlackboardDatabase } from "../blackboard/db.ts";
import {
  appendWorkerEvent,
  insertWorkerSession,
  insertWorkerTurn,
  updateWorkerSession,
  updateWorkerTurn,
  upsertWorkerHost,
} from "../blackboard/query-workers.ts";
import type { CodexWorkerProfile } from "../config/load-config.ts";
import { CodexAppServerClient, type CodexAppServerEvent } from "./codex-app-server-client.ts";
import { buildCodexProfileDeveloperInstructions } from "./codex-worker-profiles.ts";

const SMOKE_PROMPT = "Reply exactly: flitterbot-worker-ok";

export type RunCodexWorkerSmokeOptions = {
  db: BlackboardDatabase;
  cwd: string;
  prompt?: string;
  codexCommand?: string;
  timeoutMs?: number;
  profile?: CodexWorkerProfile;
  model?: string;
  developerInstructions?: string;
  context?: string;
  skillNames?: string[];
};

export type RunCodexWorkerSmokeResult = {
  ok: true;
  finalOutput: string;
  workerHostId: string;
  workerSessionId: string;
  workerTurnId: string;
  threadId: string;
  turnId: string;
  eventCount: number;
};

export async function runCodexWorkerSmoke(
  options: RunCodexWorkerSmokeOptions,
): Promise<RunCodexWorkerSmokeResult> {
  const cwd = path.resolve(options.cwd);
  const prompt = options.prompt ?? SMOKE_PROMPT;
  const profile = options.profile;
  const model = options.model ?? profile?.model;
  const approvalPolicy = profile?.approvalPolicy ?? "never";
  const sandbox = profile?.sandbox ?? "workspace-write";
  const skillNames = [...(profile?.skillNames ?? []), ...(options.skillNames ?? [])];
  const profileInstructions = profile ? buildCodexProfileDeveloperInstructions(profile) : "";
  const developerInstructions = [
    profileInstructions,
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
  const workerHostId = "local";
  let workerSessionId: string | undefined;
  let workerTurnId: string | undefined;
  let eventCount = 0;

  upsertWorkerHost(options.db, {
    hostId: workerHostId,
    displayName: os.hostname() || "local",
    connectionMode: "local-stdio",
    projectsRoot: cwd,
    codexHome: process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex"),
    status: "ready",
    capabilities: {
      platform: process.platform,
      arch: process.arch,
      codexCommand: options.codexCommand ?? "codex",
      profileId: profile?.id ?? null,
      model: model ?? null,
    },
  });

  const recordEvent = (event: CodexAppServerEvent) => {
    if (!workerSessionId) return;
    appendWorkerEvent(options.db, {
      workerSessionId,
      workerTurnId,
      eventType: event.method,
      eventSource: "codex-app-server",
      payload: event,
    });
    eventCount += 1;
  };

  const client = new CodexAppServerClient({
    codexCommand: options.codexCommand,
    cwd,
    onEvent: recordEvent,
    onStderr: (chunk) => {
      if (!workerSessionId) return;
      appendWorkerEvent(options.db, {
        workerSessionId,
        workerTurnId,
        eventType: "stderr",
        eventSource: "codex-app-server",
        payload: { chunk },
      });
      eventCount += 1;
    },
  });

  try {
    const init = await client.initialize();
    workerSessionId = insertWorkerSession(options.db, {
      runnerType: "codex_app_server",
      status: "starting",
      hostId: workerHostId,
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
    eventCount += 1;

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
    eventCount += 1;

    workerTurnId = insertWorkerTurn(options.db, {
      workerSessionId,
      status: "queued",
      prompt,
    }).worker_turn_id;

    const turn = await client.startTurn({ threadId, prompt, approvalPolicy, model });
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
    eventCount += 1;

    const completion = await client.waitForTurnCompletion(
      threadId,
      turnId,
      options.timeoutMs ?? 120_000,
    );
    const completedAt = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
    updateWorkerTurn(options.db, workerTurnId, {
      status: "completed",
      finalOutput: completion.finalOutput,
      completedAt,
    });
    updateWorkerSession(options.db, workerSessionId, {
      status: "completed",
      completedAt,
    });

    return {
      ok: true,
      finalOutput: completion.finalOutput,
      workerHostId,
      workerSessionId,
      workerTurnId,
      threadId,
      turnId,
      eventCount,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (workerTurnId) {
      updateWorkerTurn(options.db, workerTurnId, {
        status: "failed",
        errorMessage: message,
        completedAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      });
    }
    if (workerSessionId) {
      updateWorkerSession(options.db, workerSessionId, {
        status: "failed",
        errorMessage: message,
        completedAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      });
      appendWorkerEvent(options.db, {
        workerSessionId,
        workerTurnId,
        eventType: "error",
        eventSource: "codex-app-server",
        payload: { message },
      });
    }
    throw error;
  } finally {
    client.close();
  }
}

export { SMOKE_PROMPT };
