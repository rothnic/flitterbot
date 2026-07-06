import crypto from "node:crypto";
import fs from "node:fs";
import type http from "node:http";
import type net from "node:net";
import os from "node:os";
import path from "node:path";
import type { AssistantMessage, KnownProvider, TextContent } from "@earendil-works/pi-ai";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { type BlackboardDatabase, openBlackboard, pingBlackboard } from "./blackboard/db.ts";
import {
  getLastDatetimeReportedAt,
  touchDatetimeReportedAt,
  touchPiPrompt,
  updatePiSessionModelMirror,
  updatePiSessionStatus,
} from "./blackboard/pi-sessions.ts";
import { clearAllHealthFlags, setHealthFlag } from "./blackboard/query-health-flags.ts";
import { persistInboundMessage, persistOutboundMessage } from "./blackboard/query-messages.ts";
import {
  findIdleCleanupCandidates,
  getSessionById,
  insertSession,
  listSessions,
  markSessionEnded,
  markStaleSessions,
  updateSessionStop,
} from "./blackboard/query-sessions.ts";
import {
  getActivePiSessionId,
  getLatestPiSessionId,
  getPiSessionStatus,
  getStreamById,
  getStreamByName,
  listOpenStreams,
  listRecentlyClosedStreams,
  RECENTLY_CLOSED_WINDOW_HOURS,
  reopenStream as reopenStreamRow,
  resetClosedStreams,
  setStreamName,
  setStreamPinned,
  setStreamType,
  updateStreamRepoPath,
} from "./blackboard/query-streams.ts";
import {
  getLatestWorkerTurnBySession,
  getWorkerSession,
  listWorkerSessionsByStream,
  listWorkerTurnsBySession,
  updateWorkerSession,
  updateWorkerTurn,
} from "./blackboard/query-workers.ts";
import { createQueryBlackboardTool } from "./blackboard/tool-query-blackboard.ts";
import { killTmuxSession } from "./claude-sessions/tmux.ts";
import { type FlitterbotConfig, loadConfig, type ThinkingLevel } from "./config/load-config.ts";
import { resolveModelEntry } from "./config/models.ts";
import { persistModelsToConfigFile } from "./config/persist-models.ts";
import type {
  ClaudeHookPayload,
  ControlSurfaceWebSocketClientEvent,
  WhatsAppDaemonStatus as ControlSurfaceWhatsAppStatus,
  DaemonCommand,
  DaemonResponse,
  DeliveryMode,
  DirectSessionMessageResponse,
  HookResponse,
  MessageMetadata,
  PiSessionModelInfo,
  RuntimeWhatsAppStartResponse,
  RuntimeWhatsAppStopResponse,
  ClaudeSessionListItem as SessionListItem,
  SessionTranscriptResponse,
  StatusResponse,
  StreamRoutingMeta,
  StreamSurfacedWebSocketEvent,
} from "./contracts/index.ts";
import { executeCloseStream } from "./custom-tools/close-stream.ts";
import { directSessionMessage } from "./custom-tools/manage-session.ts";
import { executeSetUpWorktree } from "./custom-tools/set-up-worktree.ts";
import { formatDatetimeBlock } from "./prompts/datetime.ts";
import { formatPromptWithContext } from "./streams/format-prompt.ts";
import { stripInjectedDatetimeBlocks } from "./streams/format-stream-prompt.ts";
import { type ManagedPiSession, PiSessionManager } from "./streams/pi-session-manager.ts";
import { stripStreamNamePrefix } from "./streams/strip-name-prefix.ts";
import type { QueueItem, QueueSource } from "./streams/turn-queue.ts";
import {
  clearWorktreePathIfStale,
  shouldReconcileWorktreeOnRecovery,
} from "./streams/worktree-link.ts";
import { fireAndForgetPeriodicTaskSync } from "./tasks/periodic-sync.ts";
import { readTranscriptPage } from "./transcript/transcript.ts";
import { loadWhatsAppConfig } from "./whatsapp/config.ts";
import { sendDaemonCommand } from "./whatsapp/ipc.ts";
import { getWhatsAppStatusSignalPath } from "./whatsapp/paths.ts";
import {
  getDaemonStatus,
  startDaemonProcess,
  stopDaemonProcess,
  waitForDaemonReady,
} from "./whatsapp/process.ts";
import { resolveCodexWorkerProfile } from "./workers/codex-worker-profiles.ts";
import {
  type CodexWorkerRunHandle,
  parseWorkerProfileId,
  startCodexWorker,
  startCodexWorkerFollowUp,
} from "./workers/codex-worker-runner.ts";
import { syncConfiguredWorkerHosts } from "./workers/worker-hosts.ts";
import { type WebSocketClient, WebSocketHub } from "./ws/hub.ts";

// ponytail: prefer the SDK's tool definition type here instead of maintaining a local mirror.
type CustomToolDefinition = {
  name: string;
  label: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    ...rest: unknown[]
  ) => Promise<{
    content: Array<{ type: string; text: string }>;
    details?: unknown;
  }>;
};

type EnqueueInput = {
  text: string;
  source: QueueSource;
  metadata?: MessageMetadata;
  deliveryMode?: DeliveryMode;
  webClientId?: string;
  images?: Array<{ data: string; mimeType: string }>;
  serverMessageId?: string;
  clientMessageId?: string;
};

type ActiveCodexWorker = {
  handle: CodexWorkerRunHandle;
  streamId?: string | null;
  streamName?: string | null;
  canceled?: boolean;
};

const ACCEPTED_HOOK_EVENTS = new Set(["session-start", "stop", "session-end"]);

// ponytail: this god object mixes server lifecycle, routing, streams, WhatsApp, tools, and queues; split by domain when touching it.
export class ControlSurfaceRuntime {
  readonly config: FlitterbotConfig;
  readonly blackboard: BlackboardDatabase;
  readonly runtimeInstanceId = crypto.randomUUID();
  readonly startedAt = Date.now();
  readonly wsHub: WebSocketHub;
  readonly sessionManager: PiSessionManager;
  server?: http.Server;
  private stopping = false;
  private maintenanceTimer?: NodeJS.Timeout;
  private whatsappStatusWatcher?: fs.FSWatcher;
  private readonly activeCodexWorkers = new Map<string, ActiveCodexWorker>();
  private whatsappStatusCache: {
    status: ControlSurfaceWhatsAppStatus;
    pid?: number;
    managedByControlSurface: true;
    requiresManualAuth?: boolean;
  } = {
    status: "stopped",
    managedByControlSurface: true,
  };
  get whatsappEnabled(): boolean {
    return this.config.whatsappEnabled;
  }

  constructor(config: FlitterbotConfig = loadConfig()) {
    this.config = config;
    if (!config.whatsappEnabled) {
      this.whatsappStatusCache = { status: "disabled", managedByControlSurface: true };
    }
    this.blackboard = openBlackboard(config.blackboardPath);
    syncConfiguredWorkerHosts(this.blackboard, config);
    this.wsHub = new WebSocketHub(this.handleWebSocketMessage.bind(this));
    this.sessionManager = new PiSessionManager(
      config,
      this.blackboard,
      this.wsHub,
      this.runtimeInstanceId,
      this.startedAt,
      this.processQueueItem.bind(this),
      this.log.bind(this),
    );
  }

  attachServer(server: http.Server): void {
    this.server = server;
  }

  async start(): Promise<void> {
    this.ensurePidFile();

    // Legacy work streams predate per-user ownership; in a single-user history they were all the
    // owner's, so adopt unowned work streams to the configured default user for owner-scoped routing.
    const defaultUser = loadWhatsAppConfig().defaultUser;
    if (defaultUser) {
      const adopted = this.blackboard
        .prepare("UPDATE streams SET stream_user = ? WHERE type = 'work' AND stream_user IS NULL")
        .run(defaultUser);
      if (adopted.changes > 0) {
        this.blackboard
          .prepare(
            "UPDATE pi_sessions SET session_user = ? WHERE session_user IS NULL AND stream_id IN (SELECT id FROM streams WHERE stream_user = ?)",
          )
          .run(defaultUser, defaultUser);
        this.log(`adopted ${adopted.changes} legacy work stream(s) to owner "${defaultUser}"`);
      }
    }

    if (this.config.wipeStreamsOnStart) {
      const closed = resetClosedStreams(this.blackboard);
      if (closed > 0)
        this.log(`wiped ${closed} closed stream(s) on startup (wipeStreamsOnStart=true)`);
    }

    const resumeDefaultSessionFile =
      process.env.FLITTERBOT_RESUME_DEFAULT_SESSION?.trim() || undefined;
    if (resumeDefaultSessionFile) {
      this.log(`resuming default session from ${resumeDefaultSessionFile}`);
    }
    await this.sessionManager.createDefault(
      this.createCustomTools("default"),
      resumeDefaultSessionFile,
    );
    fireAndForgetPeriodicTaskSync(this.config, this.log.bind(this));

    const openStreams = listOpenStreams(this.blackboard);
    for (const ws of openStreams) {
      const streamsRow = this.blackboard.get<{
        pi_session_id: string;
        session_file: string | null;
        started_at: string;
        model_provider: string | null;
        model_id: string | null;
      }>(
        `SELECT pi_session_id, session_file, started_at, model_provider, model_id
         FROM pi_sessions
         WHERE stream_id = ? AND role = 'orchestrator'
           AND status NOT IN ('ended', 'crashed')
         ORDER BY started_at DESC LIMIT 1`,
        ws.id,
      );

      if (streamsRow) {
        this.sessionManager.rehydrateStreamSession(
          ws.id,
          ws.name,
          streamsRow.pi_session_id,
          streamsRow.session_file,
          streamsRow.started_at,
          streamsRow.model_provider,
          streamsRow.model_id,
        );
      } else {
        this.log(
          `skipping stream session spawn for open stream "${ws.name}" (${ws.id}) — no alive pi_session; awaiting explicit Recover`,
        );
      }
    }
    if (openStreams.length > 0) {
      this.log(`rehydrated ${openStreams.length} stream session(s) for open streams`);
    }
    await this.ensureWhatsAppUserDefaultStreams();

    await this.ensureWhatsAppDaemon();
    await this.refreshWhatsAppStatus();
    this.watchWhatsAppStatusSignal();
    this.startMaintenanceLoop();
    clearAllHealthFlags(this.blackboard);
    this.log(
      `runtime started on ${this.config.controlSurfaceHost}:${this.config.controlSurfacePort}`,
    );

    if (!resumeDefaultSessionFile) {
      this.enqueueDefaultAgentFirstMessage("startup");
    }
  }

  async stop(reason: string = "shutdown", _crash: boolean = false): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    this.log(`runtime stopping: ${reason}`);
    if (this.maintenanceTimer) clearInterval(this.maintenanceTimer);
    this.unwatchWhatsAppStatusSignal();
    this.sessionManager.disposeAll();
    try {
      await this.stopWhatsAppDaemon();
      await this.refreshWhatsAppStatus();
    } catch {}
    try {
      this.wsHub.closeAll();
    } catch {}
    await new Promise<void>((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
    });
    try {
      if (fs.existsSync(this.config.controlSurfacePidPath))
        fs.unlinkSync(this.config.controlSurfacePidPath);
    } catch {}
    this.blackboard.close();
    const { destroyAll: destroyAllFileFinders } = await import("./file-finder/manager.ts");
    destroyAllFileFinders();
  }

  private enqueueDefaultAgentFirstMessage(via: "startup" | "clear"): void {
    if (!this.config.defaultAgentFirstMessage.trim()) return;
    this.enqueue({
      text: this.config.defaultAgentFirstMessage,
      source: "init",
      metadata: { via },
    });
  }

  enqueue(
    input: EnqueueInput,
  ):
    | { ok: true; item: QueueItem }
    | { ok: true; cleared: true }
    | { ok: true; reloaded: true }
    | { ok: true; compacted: true } {
    input.text = input.text.trim();

    if (input.text === "/clear") {
      const targetSessionId = (input.metadata?._targetSessionId as string | undefined)?.trim();
      const target = targetSessionId
        ? this.sessionManager.getByPiSessionId(targetSessionId)
        : undefined;
      const targetStreamId = target?.streamId ?? undefined;
      const targetStream = targetStreamId ? getStreamById(this.blackboard, targetStreamId) : null;

      if (targetSessionId && target && targetStreamId && targetStream) {
        this.log(`/clear: resetting ${targetStream.type} stream session ${targetSessionId}`);
        void (async () => {
          try {
            if (!target.runtime) {
              await this.sessionManager.activateStreamSession(
                target,
                this.createStreamSessionTools(targetStreamId),
              );
            }
            await this.sessionManager.resetStreamSession(targetStreamId);
            if (targetStream.type === "defaultStream") {
              this.enqueueDefaultStreamFirstMessage(target);
            }
          } catch (error) {
            this.log(
              `/clear stream reset failed: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        })();
        return { ok: true, cleared: true };
      }

      const defaultPiSessionId = this.sessionManager.getDefault()?.piSessionId;
      const targetsDefaultSession =
        (!input.metadata?.stream_id && !targetSessionId) ||
        (!!targetSessionId && targetSessionId === defaultPiSessionId);
      if (targetsDefaultSession) {
        this.log("/clear: resetting default session");
        void this.sessionManager
          .resetDefault()
          .then(() => {
            fireAndForgetPeriodicTaskSync(this.config, this.log.bind(this));
            this.enqueueDefaultAgentFirstMessage("clear");
          })
          .catch((error) => {
            this.log(
              `/clear reset failed: ${error instanceof Error ? error.message : String(error)}`,
            );
          });
        return { ok: true, cleared: true };
      }
    }

    if (
      input.text === "/reload" &&
      !input.metadata?.stream_id &&
      !input.metadata?._targetSessionId
    ) {
      const managed = this.sessionManager.getDefault();
      this.log(`/reload: reloading session ${managed?.piSessionId ?? "<none>"}`);
      void (async () => {
        try {
          await managed?.runtime?.session?.reload();
          this.wsHub.broadcast({ type: "resources_reloaded" });
        } catch (error) {
          this.log(`/reload failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      })();
      return { ok: true, reloaded: true };
    }

    if (input.text === "/compact" || input.text.startsWith("/compact ")) {
      const customInstructions = input.text.startsWith("/compact ")
        ? input.text.slice("/compact ".length).trim()
        : undefined;
      const piSessionId = this.resolveCompactTargetPiSessionId(input.metadata);
      this.log(`/compact: compacting session ${piSessionId ?? "<none>"}`);
      void (async () => {
        try {
          if (!piSessionId) throw new Error("No pi session available to compact");
          await this.compactPiSession(piSessionId, customInstructions);
        } catch (error) {
          this.log(`/compact failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      })();
      return { ok: true, compacted: true };
    }

    const images = input.images?.map((img) => ({
      type: "image" as const,
      data: img.data,
      mimeType: img.mimeType,
    }));
    const messageUuid = input.serverMessageId ?? crypto.randomUUID();
    const sender: "user" | "system" =
      input.source === "web" || input.source === "whatsapp" ? "user" : "system";
    const item: QueueItem = {
      id: crypto.randomUUID(),
      source: input.source,
      sender,
      text: input.text,
      metadata: input.metadata,
      receivedAt: new Date().toISOString(),
      webClientId: input.webClientId,
      deliveryMode: input.deliveryMode ?? "followUp",
      images: images?.length ? images : undefined,
      serverMessageId: messageUuid,
      clientMessageId: input.clientMessageId,
    };

    try {
      const source = item.source as "whatsapp" | "web" | "cron";
      const streamId = (input.metadata?.stream_id as string) ?? undefined;
      const targetSessionId = (input.metadata?._targetSessionId as string) ?? undefined;
      const piSessionId = targetSessionId
        ? targetSessionId
        : streamId
          ? this.sessionManager.getByStream(streamId)?.piSessionId
          : this.sessionManager.getDefault()?.piSessionId;
      persistInboundMessage(this.blackboard, {
        id: messageUuid,
        source,
        content: input.text,
        sender: "user",
        streamId,
        piSessionId: piSessionId,
        metadata: input.metadata,
      });
    } catch (error) {
      this.log(`message persist failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    const target = this.resolveTargetSession(input, item);
    if (!target) {
      throw new Error("No target session available");
    }

    if (item.source === "web" || item.source === "whatsapp") {
      item.text = this.maybeInjectDatetime(target.piSessionId, item.text);
    }

    if (item.deliveryMode === "steer" && target.queue.isBusy() && target.runtime?.session) {
      this.log(`steer bypass: delivering ${item.id} directly to ${target.role} (queue busy)`);
      void target.runtime.session.prompt(formatPromptWithContext(item), {
        streamingBehavior: "steer",
        images: item.images,
      });
      return { ok: true, item };
    }

    item.streamId = target.streamId ?? undefined;
    item.streamName = target.streamName ?? undefined;
    target.queue.enqueue(item);
    this.log(
      `enqueued ${item.source} item ${item.id} → ${target.role}${target.streamId ? ` ws=${target.streamId}` : ""}`,
    );

    return { ok: true, item };
  }

  handleHook(eventName: string, payload: ClaudeHookPayload): HookResponse {
    const normalized = eventName.toLowerCase();
    if (!ACCEPTED_HOOK_EVENTS.has(normalized)) {
      this.log(`hook ${eventName}: filtered, unknown event`);
      return { ok: true, filtered: true };
    }

    const sessionId = pickString(payload, ["session_id", "sessionId"]);
    if (!sessionId) {
      this.log(`hook ${normalized}: filtered, no session_id in payload`);
      return { ok: true, filtered: true };
    }

    const isOwnPiSession = this.sessionManager.getByPiSessionId(sessionId) !== undefined;

    if (normalized === "session-start") {
      const agentManaged = payload.agent_managed === true || payload.agent_managed === 1;
      if (!agentManaged && !isOwnPiSession) {
        return { ok: true, filtered: true };
      }
      const cwd = pickString(payload, ["cwd"]);
      let piSessionIdValue = pickString(payload, [
        "pi_session_id",
        "piSessionId",
        "FLITTERBOT_PI_SESSION_ID",
      ]);
      let streamIdValue = pickString(payload, ["stream_id", "streamId", "FLITTERBOT_STREAM_ID"]);
      if (cwd && !piSessionIdValue && !streamIdValue) {
        const openStreams = listOpenStreams(this.blackboard);
        const matchingStream = openStreams.find(
          (ws) => ws.worktree_path && cwd.startsWith(ws.worktree_path),
        );
        if (matchingStream) {
          const orchestrator = this.sessionManager.getByStream(matchingStream.id);
          if (orchestrator) {
            piSessionIdValue = orchestrator.piSessionId;
            streamIdValue = matchingStream.id;
          }
        }
      }
      insertSession(this.blackboard, {
        session_id: sessionId,
        cwd,
        model: pickString(payload, ["model"]),
        permission_mode: pickString(payload, ["permission_mode", "permissionMode"]),
        source: pickString(payload, ["source"]),
        transcript_path: pickString(payload, ["transcript_path", "transcriptPath"]),
        agent_managed: agentManaged,
        tmux_session: pickString(payload, [
          "tmux_session",
          "tmuxSession",
          "FLITTERBOT_TMUX_SESSION",
        ]),
        task_description: pickString(payload, [
          "task_description",
          "taskDescription",
          "FLITTERBOT_TASK_DESCRIPTION",
        ]),
        todoist_task_id: pickString(payload, [
          "todoist_task_id",
          "todoistTaskId",
          "FLITTERBOT_TODOIST_TASK_ID",
        ]),
        pi_session_id: piSessionIdValue,
        stream_id: streamIdValue,
      });
      if (piSessionIdValue) {
        this.wsHub.broadcast({
          type: "sessions_changed",
          piSessionId: piSessionIdValue,
          reason: "registered",
        });
      }
    } else {
      if (!isOwnPiSession) {
        const known = getSessionById(this.blackboard, sessionId);
        if (!known) {
          return { ok: true, filtered: true };
        }
      }

      if (normalized === "stop") {
        updateSessionStop(this.blackboard, sessionId);
        const stoppedSession = getSessionById(this.blackboard, sessionId);
        if (stoppedSession?.piSessionId) {
          this.wsHub.broadcast({
            type: "sessions_changed",
            piSessionId: stoppedSession.piSessionId,
            reason: "stopped",
          });
        }
      } else if (normalized === "session-end") {
        const reason =
          pickString(payload, ["reason", "stop_reason", "session_end_reason"]) || "ended";
        const endingSession = getSessionById(this.blackboard, sessionId);
        markSessionEnded(this.blackboard, sessionId, reason);
        if (endingSession?.piSessionId) {
          this.wsHub.broadcast({
            type: "sessions_changed",
            piSessionId: endingSession.piSessionId,
            reason: "ended",
          });
        }
      }
    }

    if (normalized !== "stop") {
      return { ok: true, bookkeeping: true };
    }

    const lastAssistantText = pickString(payload, [
      "last_assistant_message",
      "lastAssistantMessage",
    ]);
    if (lastAssistantText) {
      payload.lastAssistantText = lastAssistantText;
    }

    const piSessionIdFromPayload = pickString(payload, [
      "pi_session_id",
      "piSessionId",
      "FLITTERBOT_PI_SESSION_ID",
    ]);
    let targetQueue: ManagedPiSession | undefined;
    let resolvedVia = "default";
    if (piSessionIdFromPayload) {
      targetQueue = this.sessionManager.getByPiSessionId(piSessionIdFromPayload);
      if (targetQueue) resolvedVia = "payload";
    }
    const ccSession = !targetQueue ? getSessionById(this.blackboard, sessionId) : undefined;
    if (!targetQueue) {
      if (ccSession?.piSessionId) {
        targetQueue = this.sessionManager.getByPiSessionId(ccSession.piSessionId);
        if (targetQueue) resolvedVia = "sessions-table";
      }
    }
    if (!targetQueue) {
      const ccCwd = ccSession?.cwd || pickString(payload, ["cwd"]);
      if (ccCwd) {
        const openStreams = listOpenStreams(this.blackboard);
        const matchingStream = openStreams.find(
          (ws) => ws.worktree_path && ccCwd.startsWith(ws.worktree_path),
        );
        if (matchingStream) {
          targetQueue = this.sessionManager.getByStream(matchingStream.id);
          if (targetQueue) resolvedVia = `cwd-match:${matchingStream.id}`;
        }
      }
    }
    if (!targetQueue) {
      targetQueue = this.sessionManager.getDefault();
    }
    if (!targetQueue) {
      this.log(`hook: no target session found for session_id=${sessionId}`);
      return { ok: false };
    }

    const text = formatHookMessage(normalized, payload);
    const hookItem: QueueItem = {
      id: crypto.randomUUID(),
      source: "hook",
      sender: "system",
      text,
      metadata: { event: normalized, ...payload },
      receivedAt: new Date().toISOString(),
      deliveryMode: "followUp",
      streamId: targetQueue.streamId ?? undefined,
      streamName: targetQueue.streamName ?? undefined,
    };

    try {
      persistInboundMessage(this.blackboard, {
        source: "hook",
        content: text,
        sender: "system",
        streamId: targetQueue.streamId ?? undefined,
        piSessionId: targetQueue.piSessionId,
        metadata: { event: normalized, ...payload },
      });
    } catch (error) {
      this.log(`message persist failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    targetQueue.queue.enqueue(hookItem);
    this.log(
      `hook stop: session_id=${sessionId} → ${targetQueue.role}${targetQueue.streamId ? ` ws=${targetQueue.streamId}` : ""} (via ${resolvedVia})`,
    );
    return { ok: true };
  }

  private resolveModelEntryId(provider: string, modelId: string): string {
    return (
      this.config.models.find((entry) => entry.provider === provider && entry.modelId === modelId)
        ?.id ?? `${provider}/${modelId}`
    );
  }

  private toPiSessionModelInfo(modelInfo: {
    provider: string;
    id: string;
    thinkingLevel?: PiSessionModelInfo["thinkingLevel"];
  }): PiSessionModelInfo {
    return {
      id: this.resolveModelEntryId(modelInfo.provider, modelInfo.id),
      provider: modelInfo.provider,
      modelId: modelInfo.id,
      thinkingLevel: modelInfo.thinkingLevel,
    };
  }

  private getPersistedPiSessionModels(
    piSessionIds: Array<string | undefined>,
  ): Map<string, PiSessionModelInfo> {
    const ids = Array.from(new Set(piSessionIds.filter((id): id is string => Boolean(id))));
    const models = new Map<string, PiSessionModelInfo>();
    if (ids.length === 0) return models;

    const rows = this.blackboard.all<{
      pi_session_id: string;
      model_provider: string | null;
      model_id: string | null;
      thinking_level: PiSessionModelInfo["thinkingLevel"] | null;
    }>(
      `SELECT pi_session_id, model_provider, model_id, thinking_level
       FROM pi_sessions
       WHERE pi_session_id IN (${ids.map(() => "?").join(", ")})`,
      ...ids,
    );

    for (const row of rows) {
      if (!row.model_provider || !row.model_id) continue;
      models.set(row.pi_session_id, {
        id: this.resolveModelEntryId(row.model_provider, row.model_id),
        provider: row.model_provider,
        modelId: row.model_id,
        thinkingLevel: row.thinking_level ?? undefined,
      });
    }
    return models;
  }

  async setPiSessionModel(piSessionId: string, modelId: string): Promise<PiSessionModelInfo> {
    const managed = this.sessionManager.getByPiSessionId(piSessionId);
    if (!managed) {
      throw new Error(`Pi session not found: ${piSessionId}`);
    }

    if (!managed.runtime && managed.role !== "default" && managed.streamId) {
      await this.sessionManager.activateStreamSession(
        managed,
        this.createStreamSessionTools(managed.streamId),
      );
    }

    const session = managed.runtime?.session;
    if (!session) {
      throw new Error(`Pi session is not active: ${piSessionId}`);
    }

    const modelEntry = resolveModelEntry(this.config, modelId);
    const isDefaultSession = this.sessionManager.getDefault()?.piSessionId === piSessionId;
    if (
      managed.modelInfo.provider === modelEntry.provider &&
      managed.modelInfo.id === modelEntry.modelId
    ) {
      managed.modelInfo.entryId = modelEntry.id;
      updatePiSessionModelMirror(
        this.blackboard,
        managed.piSessionId,
        managed.modelInfo.provider,
        managed.modelInfo.id,
        managed.modelInfo.thinkingLevel,
      );
      if (isDefaultSession) this.persistDefaultModel(modelId);
      return this.toPiSessionModelInfo(managed.modelInfo);
    }

    const model = getBuiltinModel(
      modelEntry.provider as KnownProvider,
      modelEntry.modelId as never,
    );
    if (!model) {
      throw new Error(
        `Unable to resolve Pi model: provider=${modelEntry.provider} modelId=${modelEntry.modelId}`,
      );
    }

    await session.setModel(model);
    const currentModel = session.model;
    if (!currentModel) {
      throw new Error(`Pi session has no current model after switch: ${piSessionId}`);
    }

    managed.modelInfo = {
      provider: currentModel.provider,
      id: currentModel.id,
      entryId: this.resolveModelEntryId(currentModel.provider, currentModel.id),
      thinkingLevel: session.thinkingLevel,
    };
    updatePiSessionModelMirror(
      this.blackboard,
      managed.piSessionId,
      managed.modelInfo.provider,
      managed.modelInfo.id,
      managed.modelInfo.thinkingLevel,
    );
    this.broadcastStatusChanged("pi_session");
    this.log(
      `pi-session model switched: ${managed.piSessionId} → ${managed.modelInfo.provider}/${managed.modelInfo.id}`,
    );

    if (isDefaultSession) {
      this.persistDefaultModel(modelId);
      return this.setPiSessionThinkingLevel(
        piSessionId,
        modelEntry.thinkingLevel ?? this.config.defaultThinkingLevel,
      );
    }

    return this.toPiSessionModelInfo(managed.modelInfo);
  }

  private persistDefaultModel(modelId: string): void {
    this.config.defaultModel = modelId;
    persistModelsToConfigFile({
      models: this.config.models,
      defaultModel: modelId,
    });
    this.log(`models: defaultModel set to ${modelId}`);
  }

  async setPiSessionThinkingLevel(
    piSessionId: string,
    thinkingLevel: ThinkingLevel,
  ): Promise<PiSessionModelInfo> {
    const managed = this.sessionManager.getByPiSessionId(piSessionId);
    if (!managed) {
      throw new Error(`Pi session not found: ${piSessionId}`);
    }

    if (!managed.runtime && managed.role !== "default" && managed.streamId) {
      await this.sessionManager.activateStreamSession(
        managed,
        this.createStreamSessionTools(managed.streamId),
      );
    }

    const session = managed.runtime?.session;
    if (!session) {
      throw new Error(`Pi session is not active: ${piSessionId}`);
    }

    session.setThinkingLevel(thinkingLevel);
    const currentThinkingLevel = session.thinkingLevel;
    const currentModel = session.model;
    if (!currentModel) {
      throw new Error(
        `Pi session has no current model after thinking-level switch: ${piSessionId}`,
      );
    }

    managed.modelInfo = {
      provider: currentModel.provider,
      id: currentModel.id,
      entryId: this.resolveModelEntryId(currentModel.provider, currentModel.id),
      thinkingLevel: currentThinkingLevel,
    };
    updatePiSessionModelMirror(
      this.blackboard,
      managed.piSessionId,
      managed.modelInfo.provider,
      managed.modelInfo.id,
      managed.modelInfo.thinkingLevel,
    );
    this.broadcastStatusChanged("pi_session");
    this.log(
      `pi-session thinking level switched: ${managed.piSessionId} → ${managed.modelInfo.thinkingLevel}`,
    );

    if (this.sessionManager.getDefault()?.piSessionId === piSessionId) {
      this.config.defaultThinkingLevel = thinkingLevel;
      persistModelsToConfigFile({
        models: this.config.models,
        defaultThinkingLevel: thinkingLevel,
      });
      this.log(`models: defaultThinkingLevel set to ${thinkingLevel}`);
    }

    return this.toPiSessionModelInfo(managed.modelInfo);
  }

  getStatus(): StatusResponse {
    const def = this.sessionManager.getDefault();
    const defSnapshot = def?.state.getSnapshot();
    const whatsapp = this.getWhatsAppStatusSnapshot();
    const blackboardStatus = pingBlackboard(this.blackboard) ? "ok" : "error";

    const orchestratorStatuses = this.sessionManager.listStreamSessions().map((o) => {
      const snap = o.state.getSnapshot();
      return {
        piSessionId: o.piSessionId,
        streamId: o.streamId!,
        streamName: o.streamName,
        messageCount: o.runtime?.session?.messages?.length ?? snap.messageCount,
        busy: snap.busy,
      };
    });

    const openStreams = listOpenStreams(this.blackboard).map((stream) => ({
      stream,
      piSessionId: getActivePiSessionId(this.blackboard, stream.id),
    }));
    const closedStreams = listRecentlyClosedStreams(
      this.blackboard,
      RECENTLY_CLOSED_WINDOW_HOURS,
    ).map((stream) => ({
      stream,
      piSessionId: getLatestPiSessionId(this.blackboard, stream.id),
    }));
    const persistedModelByPiSession = this.getPersistedPiSessionModels([
      ...openStreams.map(({ piSessionId }) => piSessionId),
      ...closedStreams.map(({ piSessionId }) => piSessionId),
    ]);
    const sessionCountByStream = new Map<string, number>();
    for (const session of this.getSessionList()) {
      if (session.streamId) {
        sessionCountByStream.set(
          session.streamId,
          (sessionCountByStream.get(session.streamId) ?? 0) + 1,
        );
      }
    }

    return {
      ok: true,
      pid: process.pid,
      uptime: Math.floor((Date.now() - this.startedAt) / 1000),
      piAgent: {
        default: defSnapshot
          ? {
              piSessionId: defSnapshot.piSessionId!,
              sessionFile: defSnapshot.sessionFile ?? null,
              messageCount: def!.runtime?.session?.messages?.length ?? defSnapshot.messageCount,
              lastPromptAt: defSnapshot.lastPromptAt ?? null,
              busy: defSnapshot.busy,
              model: this.toPiSessionModelInfo(def!.modelInfo),
            }
          : null,
        orchestrators: orchestratorStatuses,
      },
      whatsapp: {
        status: whatsapp.status,
        pid: whatsapp.pid ?? null,
        managedByControlSurface: whatsapp.managedByControlSurface,
        requiresManualAuth: whatsapp.requiresManualAuth,
      },
      blackboard: blackboardStatus,
      streams: [
        ...openStreams.map(({ stream: ws, piSessionId }) => {
          const managed = this.sessionManager.getByStream(ws.id);
          return {
            id: ws.id,
            name: ws.name,
            type: ws.type,
            status: "open" as const,
            pinned: Boolean(ws.pinned),
            repoPath: ws.repo_path ?? undefined,
            worktreePath: ws.worktree_path ?? undefined,
            piSessionId,
            piSessionStatus: piSessionId
              ? getPiSessionStatus(this.blackboard, piSessionId)
              : undefined,
            model: managed
              ? this.toPiSessionModelInfo(managed.modelInfo)
              : persistedModelByPiSession.get(piSessionId ?? ""),
            sessionCount: sessionCountByStream.get(ws.id) ?? 0,
            createdAt: ws.created_at,
          };
        }),
        ...closedStreams.map(({ stream: ws, piSessionId }) => ({
          id: ws.id,
          name: ws.name,
          type: ws.type,
          status: "closed" as const,
          pinned: Boolean(ws.pinned),
          closedAt: ws.closed_at ?? undefined,
          repoPath: ws.repo_path ?? undefined,
          worktreePath: ws.worktree_path ?? undefined,
          piSessionId,
          piSessionStatus: piSessionId
            ? getPiSessionStatus(this.blackboard, piSessionId)
            : undefined,
          model: persistedModelByPiSession.get(piSessionId ?? ""),
          sessionCount: sessionCountByStream.get(ws.id) ?? 0,
          createdAt: ws.created_at,
        })),
      ],
      shortcuts: this.config.shortcuts,
    };
  }

  setStreamPinned(
    streamId: string,
    pinned: boolean,
  ): { ok: true; streamId: string; pinned: boolean } {
    const stream = setStreamPinned(this.blackboard, streamId, pinned);
    if (!stream) {
      throw new Error(`Stream not found: ${streamId}`);
    }
    this.wsHub.broadcast({
      type: "streams_changed",
      reason: "pinned",
      streamId,
      streamName: stream.name,
    });
    return { ok: true, streamId, pinned: Boolean(stream.pinned) };
  }

  setStreamName(streamId: string, name: string): { ok: true; streamId: string; name: string } {
    const trimmed = name.trim();
    if (!trimmed) {
      throw new Error("name must not be empty");
    }
    const stream = setStreamName(this.blackboard, streamId, trimmed);
    if (!stream) {
      throw new Error(`Stream not found: ${streamId}`);
    }
    this.wsHub.broadcast({
      type: "streams_changed",
      reason: "renamed",
      streamId,
      streamName: stream.name,
    });
    return { ok: true, streamId, name: stream.name };
  }

  async closeStreamNoop(
    streamId: string,
  ): Promise<{ ok: true; streamId: string; message: string }> {
    const managed = this.sessionManager.getByStream(streamId);
    const piSessionId =
      managed?.piSessionId ??
      getActivePiSessionId(this.blackboard, streamId) ??
      getLatestPiSessionId(this.blackboard, streamId);
    if (!piSessionId) {
      throw new Error(`No pi session found for stream ${streamId}`);
    }
    const result = await executeCloseStream(
      this.blackboard,
      piSessionId,
      streamId,
      "noop",
      "closing: noop close from context menu",
    );
    if (!result.ok) {
      throw new Error(result.message);
    }
    if (managed) {
      managed.pendingDestroy = true;
    }
    this.wsHub.broadcast({
      type: "streams_changed",
      reason: "closed",
      streamId,
    });
    return { ok: true, streamId, message: result.message };
  }

  getSessionList(): SessionListItem[] {
    return listSessions(this.blackboard);
  }

  async getTranscript(
    sessionId: string,
    cursor?: string,
    limit: number = 50,
  ): Promise<SessionTranscriptResponse> {
    const session = getSessionById(this.blackboard, sessionId);
    if (!session?.transcriptPath) {
      return {
        sessionId,
        transcriptPath: null,
        oldestFirst: true as const,
        items: [],
      };
    }
    return readTranscriptPage(sessionId, session.transcriptPath, cursor ?? "0", limit);
  }

  async directSessionMessage(
    sessionId: string,
    text: string,
  ): Promise<DirectSessionMessageResponse> {
    return directSessionMessage(this, sessionId, text);
  }

  async startWhatsAppDaemon(): Promise<RuntimeWhatsAppStartResponse> {
    if (!this.whatsappEnabled) {
      return { ok: false, status: "disabled", managedByControlSurface: true };
    }
    const existing = await getDaemonStatus();
    if (existing) {
      this.whatsappStatusCache = this.mapDaemonStatus(existing);
      return { ok: true, ...this.whatsappStatusCache };
    }
    await startDaemonProcess();
    const daemon = await waitForDaemonReady();
    this.whatsappStatusCache = this.mapDaemonStatus(daemon);
    this.watchWhatsAppStatusSignal();
    this.broadcastStatusChanged("whatsapp");
    return { ok: true, ...this.whatsappStatusCache };
  }

  async stopWhatsAppDaemon(): Promise<RuntimeWhatsAppStopResponse> {
    if (!this.whatsappEnabled) {
      return { ok: false, status: "disabled", managedByControlSurface: true };
    }
    const daemon = await stopDaemonProcess();
    this.whatsappStatusCache = this.mapDaemonStatus(daemon);
    this.broadcastStatusChanged("whatsapp");
    return { ok: true, ...this.whatsappStatusCache };
  }

  handleUpgrade(req: http.IncomingMessage, socket: net.Socket, head: Buffer | undefined): boolean {
    return this.wsHub.handleUpgrade(req, socket, head, this.config.controlSurfaceToken);
  }

  private static readonly DATETIME_INJECTION_INTERVAL_MS = 60 * 60 * 1000;

  private maybeInjectDatetime(piSessionId: string, text: string): string {
    const lastReportedAt = getLastDatetimeReportedAt(this.blackboard, piSessionId);
    const now = Date.now();
    const lastMs = lastReportedAt ? new Date(lastReportedAt).getTime() : 0;
    if (now - lastMs < ControlSurfaceRuntime.DATETIME_INJECTION_INTERVAL_MS) {
      return text;
    }

    const nowIso = new Date(now).toISOString();
    touchDatetimeReportedAt(this.blackboard, piSessionId, nowIso);

    return `${text}\n\n${formatDatetimeBlock()}`;
  }

  private resolveTargetSession(
    input: EnqueueInput,
    _item: QueueItem,
  ): ManagedPiSession | undefined {
    const meta = input.metadata;

    const targetSessionId = meta?._targetSessionId as string | undefined;
    if (targetSessionId) {
      const target = this.sessionManager.getByPiSessionId(targetSessionId);
      if (target) return target;
    }

    if (input.source === "cron") {
      return this.sessionManager.getDefault();
    }

    const streamId = meta?.stream_id as string | undefined;
    if (streamId && meta?.router_action === "matched") {
      return this.sessionManager.getByStream(streamId);
    }

    return this.sessionManager.getDefault();
  }

  private async processQueueItem(managed: ManagedPiSession, item: QueueItem): Promise<void> {
    if (!managed.runtime && managed.role !== "default" && managed.streamId) {
      this.log(`activating dormant stream session for stream ${managed.streamId}`);
      await this.sessionManager.activateStreamSession(
        managed,
        this.createStreamSessionTools(managed.streamId),
      );
    }

    const session = managed.runtime?.session;
    if (!session) throw new Error("pi session not initialized");

    const piSessionId = session.sessionId;
    const itemRemoteJid = extractRemoteJid(item.metadata);

    this.log(
      `processing queue item ${item.id} source=${item.source} role=${managed.role}${managed.streamId ? ` ws=${managed.streamId}` : ""} text=${item.text.slice(0, 80)}...`,
    );

    const promptAt = managed.state.notePrompt(session.messages.length);
    touchPiPrompt(this.blackboard, piSessionId, promptAt, "active");
    this.broadcastStatusChanged("pi_session");

    const promptText = formatPromptWithContext(item);

    if (session.isStreaming) {
      await session.prompt(promptText, {
        streamingBehavior: item.deliveryMode ?? "followUp",
        images: item.images,
      });
    } else {
      await session.prompt(promptText, { images: item.images });
    }

    const serverMsgId = item.metadata?.serverMessageId as string | undefined;
    if (serverMsgId) {
      for (let i = session.messages.length - 1; i >= 0; i--) {
        const msg = session.messages[i] as Record<string, unknown> | undefined;
        if (msg?.role === "user") {
          msg.id = serverMsgId;
          break;
        }
      }
    }

    this.log(`queue item ${item.id} prompt completed, messages=${session.messages.length}`);

    const lastMsg = session.messages[session.messages.length - 1];
    if (lastMsg?.role === "assistant") {
      const assistantMsg = lastMsg as AssistantMessage;
      if (assistantMsg.stopReason === "error") {
        this.log(`queue item ${item.id} API error: ${assistantMsg.errorMessage ?? "unknown"}`);
        throw new Error(
          `pi session API error: ${assistantMsg.errorMessage ?? assistantMsg.stopReason}`,
        );
      }
    }

    managed.state.noteEvent(session.messages.length);

    this.transitionStreamsAfterTurn(piSessionId);

    const finalAssistant = extractFinalAssistantMessage(session);
    const pendingSurface = managed.lastSurfacedAssistantMessage;
    managed.lastSurfacedAssistantMessage = undefined;
    if (finalAssistant) {
      const { text: finalText, messageId: finalMessageId } = finalAssistant;

      let persistedId: string | undefined;
      try {
        const streamId = managed.streamId ?? (item.metadata?.stream_id as string) ?? undefined;
        const row = persistOutboundMessage(this.blackboard, {
          id: finalMessageId,
          source: "stream_outbound",
          content: finalText,
          streamId,
          piSessionId: managed.piSessionId,
        });
        persistedId = row.id;
      } catch (error) {
        this.log(
          `outbound message persist failed (len=${finalText.length}): ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      if (pendingSurface && persistedId) {
        pendingSurface.serverMessageId = persistedId;
        const surfacedPayload: StreamSurfacedWebSocketEvent = {
          type: "stream_surfaced",
          piSessionId: managed.piSessionId,
          message: pendingSurface,
          streamId: pendingSurface.streamId,
          streamName: pendingSurface.streamName,
        };
        this.wsHub.broadcast(surfacedPayload);
      }

      const surfaceText = managed.streamName ? `*[${managed.streamName}]* ${finalText}` : finalText;

      const MAX_WHATSAPP_LENGTH = 60_000;
      const waText =
        surfaceText.length > MAX_WHATSAPP_LENGTH
          ? `${surfaceText.slice(0, MAX_WHATSAPP_LENGTH)}\n\n[...truncated — full response available in web client]`
          : surfaceText;

      try {
        const targetUserId = managed.streamId
          ? whatsappUserIdFromStreamName(managed.streamName)
          : metadataString(item.metadata, "whatsapp_user_id");
        await this.sendWhatsAppCommand({
          command: "send",
          text: waText,
          contextRef: undefined,
          ...(targetUserId ? { targetUserId } : { remoteJid: itemRemoteJid }),
        });
      } catch (error) {
        this.log(
          `auto-surface to WhatsApp failed (len=${surfaceText.length}): ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  private transitionStreamsAfterTurn(piSessionId: string): void {
    try {
      const row = this.blackboard
        .prepare(
          `SELECT COUNT(*) as count FROM sessions
				 WHERE pi_session_id = ? AND status = 'working' AND agent_managed = 1`,
        )
        .get(piSessionId) as { count: number } | undefined;
      const activeCount = row?.count ?? 0;

      const nextStatus = activeCount > 0 ? "waiting_for_sessions" : "waiting_for_user";
      updatePiSessionStatus(this.blackboard, piSessionId, nextStatus);
      this.broadcastStatusChanged("pi_session");
    } catch (error) {
      this.log(
        `streams state transition failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async spawnStreamWithSession(opts: {
    name: string;
    cwd: string;
    type?: "work" | "defaultStream";
    streamUser?: string;
    rollbackOnSpawnFailure: boolean;
  }): Promise<
    | { ok: true; streamId: string; streamName: string; managed: ManagedPiSession }
    | { ok: false; streamId: string | null; streamName: string; spawnError: Error }
  > {
    const { insertStream, enrichStream, deleteStream } = await import(
      "./blackboard/query-streams.ts"
    );

    if (!fs.existsSync(opts.cwd)) {
      throw new Error(`cwd path "${opts.cwd}" does not exist`);
    }

    const ws = insertStream(this.blackboard, opts.name, opts.type ?? "work", opts.streamUser);
    enrichStream(this.blackboard, ws.id, opts.cwd);

    try {
      const managed =
        opts.type === "defaultStream"
          ? await this.sessionManager.createDefaultStream(
              ws.id,
              ws.name,
              opts.cwd,
              this.createCustomTools("default", ws.id),
            )
          : await this.sessionManager.createOrchestrator(
              ws.id,
              ws.name,
              opts.cwd,
              this.createCustomTools("orchestrator", ws.id),
            );
      this.wsHub.broadcast({
        type: "streams_changed",
        reason: "created",
        streamId: ws.id,
        streamName: ws.name,
      });
      return { ok: true, streamId: ws.id, streamName: ws.name, managed };
    } catch (error) {
      const spawnError = error instanceof Error ? error : new Error(String(error));
      if (opts.rollbackOnSpawnFailure) {
        try {
          deleteStream(this.blackboard, ws.id);
          this.log(
            `${opts.type ?? "work"} stream session spawn failed for "${ws.name}" (${ws.id}); rolled back stream row: ${spawnError.message}`,
          );
        } catch (cleanupError) {
          this.log(
            `${opts.type ?? "work"} stream session spawn failed and rollback failed for "${ws.name}" (${ws.id}): spawn=${spawnError.message} cleanup=${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
          );
        }
        return { ok: false, streamId: null, streamName: ws.name, spawnError };
      }
      this.log(
        `${opts.type ?? "work"} stream session spawn failed for "${ws.name}" (${ws.id}); leaving orphan stream row for caller: ${spawnError.message}`,
      );
      return { ok: false, streamId: ws.id, streamName: ws.name, spawnError };
    }
  }

  async createStreamProgrammatic(input?: {
    name?: string;
    cwd?: string;
  }): Promise<{ ok: true; streamId: string; streamName: string; piSessionId: string }> {
    const { getStreamByName } = await import("./blackboard/query-streams.ts");

    let name = input?.name ? stripStreamNamePrefix(input.name) : "";
    if (!name) {
      for (let i = 0; i < 5; i++) {
        const candidate = `scratch-${crypto.randomUUID().slice(0, 6)}`;
        if (!getStreamByName(this.blackboard, candidate)) {
          name = candidate;
          break;
        }
      }
      if (!name) throw new Error("Failed to generate unique stream name");
    }

    const effectiveCwd = input?.cwd ?? this.config.projectsDir;
    this.log(`programmatic stream create requested name="${name}" cwd=${effectiveCwd}`);

    const result = await this.spawnStreamWithSession({
      name,
      cwd: effectiveCwd,
      rollbackOnSpawnFailure: true,
    });
    if (!result.ok) {
      throw result.spawnError;
    }
    this.log(`programmatic stream created "${result.streamName}" (${result.streamId})`);
    return {
      ok: true,
      streamId: result.streamId,
      streamName: result.streamName,
      piSessionId: result.managed.piSessionId,
    };
  }

  async setStreamCwd(
    streamId: string,
    cwdInput: string,
  ): Promise<{ ok: true; streamId: string; cwd: string; piSessionId: string }> {
    const cwd = this.resolveStreamCwdInput(cwdInput);
    const stat = fs.statSync(cwd, { throwIfNoEntry: false });
    if (!stat?.isDirectory())
      throw new Error(`cwd path "${cwd}" does not exist or is not a directory`);

    const ws = getStreamById(this.blackboard, streamId);
    if (!ws) throw new Error("Stream not found");
    if (ws.status !== "open") throw new Error("Stream is not open");

    const managed = this.sessionManager.getByStream(streamId);
    if (!managed) throw new Error("No orchestrator session for stream");
    if (managed.state.getSnapshot().busy)
      throw new Error("Cannot switch cwd while session is busy");
    if (managed.role !== "orchestrator")
      throw new Error("cwd switch is only supported for work streams");
    if (!managed.runtime) {
      this.log(`activating dormant orchestrator for cwd switch stream=${streamId}`);
      await this.sessionManager.activateStreamSession(
        managed,
        this.createCustomTools("orchestrator", streamId),
      );
    }

    const switched = await this.sessionManager.switchStreamCwd(streamId, cwd);
    updateStreamRepoPath(this.blackboard, streamId, cwd);
    this.blackboard
      .prepare(
        `UPDATE pi_sessions
         SET cwd = ?, last_event_at = ?
         WHERE pi_session_id = ?`,
      )
      .run(cwd, new Date().toISOString(), switched.piSessionId);

    this.wsHub.broadcast({
      type: "streams_changed",
      reason: "cwd_changed",
      streamId,
      streamName: ws.name,
    });
    this.wsHub.broadcast({
      type: "worktree_changed",
      piSessionId: switched.piSessionId,
      streamId,
    });
    this.wsHub.broadcast({
      type: "status_changed",
      subsystem: "pi_session",
      timestamp: new Date().toISOString(),
    });
    this.log(`stream cwd switched "${ws.name}" (${streamId}) → ${cwd}`);
    return { ok: true, streamId, cwd, piSessionId: switched.piSessionId };
  }

  private resolveStreamCwdInput(input: string): string {
    const raw = input.trim().replace(/^@/, "");
    if (!raw) return path.resolve(this.config.projectsDir);
    const expanded = raw.startsWith("~")
      ? path.resolve(os.homedir(), raw === "~" ? "." : raw.slice(2))
      : path.isAbsolute(raw)
        ? path.resolve(raw)
        : path.resolve(this.config.projectsDir, raw);
    const rel = path.relative(os.homedir(), expanded);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new Error("cwd must stay under the home directory");
    }
    return expanded;
  }

  async reopenStream(streamId: string): Promise<{ ok: boolean; streamId: string }> {
    const { reopenStream, getStreamById } = await import("./blackboard/query-streams.ts");

    const ws = getStreamById(this.blackboard, streamId);
    if (!ws) throw new Error("Stream not found");

    const hasDeadPiSession =
      ws.status === "open" &&
      !!this.blackboard.get<{ pi_session_id: string }>(
        `SELECT pi_session_id FROM pi_sessions
         WHERE stream_id = ? AND role = 'orchestrator'
           AND status IN ('ended', 'crashed')
         ORDER BY started_at DESC LIMIT 1`,
        streamId,
      );

    if (ws.status !== "closed" && !hasDeadPiSession) {
      throw new Error("Stream is not closed and has no recoverable pi-session");
    }

    if (ws.status === "closed") {
      reopenStream(this.blackboard, streamId);
    }
    if (shouldReconcileWorktreeOnRecovery(ws.status)) {
      const reconciled = clearWorktreePathIfStale(this.blackboard, ws);
      if (reconciled.cleared) {
        this.log(
          `cleared stale worktree_path for reopened stream "${ws.name}" (${streamId}): ${reconciled.previousPath} (${reconciled.reason})`,
        );
      }
    }

    const streamsRow = this.blackboard.get<{
      pi_session_id: string;
      session_file: string | null;
      started_at: string;
      model_provider: string | null;
      model_id: string | null;
    }>(
      `SELECT pi_session_id, session_file, started_at, model_provider, model_id
       FROM pi_sessions
       WHERE stream_id = ? AND role = 'orchestrator'
       ORDER BY started_at DESC LIMIT 1`,
      streamId,
    );

    if (streamsRow) {
      this.blackboard
        .prepare(
          `UPDATE pi_sessions
           SET status = 'waiting_for_user',
               ended_at = NULL,
               end_reason = NULL,
               last_event_at = ?
           WHERE pi_session_id = ?`,
        )
        .run(new Date().toISOString().replace(/\.\d{3}Z$/, "Z"), streamsRow.pi_session_id);

      this.sessionManager.rehydrateStreamSession(
        streamId,
        ws.name,
        streamsRow.pi_session_id,
        streamsRow.session_file,
        streamsRow.started_at,
        streamsRow.model_provider,
        streamsRow.model_id,
      );
    }

    this.wsHub.broadcast({
      type: "streams_changed",
      reason: "reopened",
      streamId,
      streamName: ws.name,
    });

    const reopenReason =
      ws.status === "closed" ? "reopened closed stream" : "recovered dead pi-session for stream";
    this.log(`${reopenReason} "${ws.name}" (${streamId})`);
    return { ok: true, streamId };
  }

  private resolveCompactTargetPiSessionId(
    metadata: MessageMetadata | undefined,
  ): string | undefined {
    if (typeof metadata?._targetSessionId === "string" && metadata._targetSessionId.trim()) {
      return metadata._targetSessionId;
    }
    if (typeof metadata?.stream_id === "string" && metadata.stream_id.trim()) {
      return this.sessionManager.getByStream(metadata.stream_id)?.piSessionId;
    }
    return this.sessionManager.getDefault()?.piSessionId;
  }

  async compactPiSession(
    piSessionId: string,
    customInstructions?: string,
  ): Promise<{
    ok: true;
    piSessionId: string;
    messageCount: number;
    summary: string;
    firstKeptEntryId: string;
    tokensBefore: number;
  }> {
    const managed = this.sessionManager.getByPiSessionId(piSessionId);
    if (!managed) throw new Error("Pi session not found");

    if (!managed.runtime) {
      if (managed.role !== "default" && managed.streamId) {
        this.log(`activating dormant stream session for compact stream=${managed.streamId}`);
        await this.sessionManager.activateStreamSession(
          managed,
          this.createStreamSessionTools(managed.streamId),
        );
      } else {
        throw new Error("Pi session is not active and cannot be activated for compact");
      }
    }

    const session = managed.runtime?.session;
    if (!session) throw new Error("Pi session failed to activate");
    if (session.isCompacting) throw new Error("Pi session is already compacting");
    if (managed.state.getSnapshot().busy) throw new Error("Pi session is busy");

    const result = await session.compact(customInstructions?.trim() || undefined);
    const newCount = session.messages.length;
    managed.state.noteEvent(newCount);

    this.wsHub.broadcast({
      type: "history_rewritten",
      piSessionId,
      reason: "compact",
    });

    this.log(
      `compacted pi session ${piSessionId} at entry ${result.firstKeptEntryId} (${result.tokensBefore} tokens before; messages now ${newCount})`,
    );
    return {
      ok: true,
      piSessionId,
      messageCount: newCount,
      summary: result.summary,
      firstKeptEntryId: result.firstKeptEntryId,
      tokensBefore: result.tokensBefore,
    };
  }

  async pruneStreamHistory(
    piSessionId: string,
    entryId: string,
  ): Promise<{ ok: true; piSessionId: string; messageCount: number }> {
    const managed = this.sessionManager.getByPiSessionId(piSessionId);
    if (!managed) throw new Error("Pi session not found");

    if (!managed.runtime) {
      if (managed.role !== "default" && managed.streamId) {
        this.log(`activating dormant stream session for prune stream=${managed.streamId}`);
        await this.sessionManager.activateStreamSession(
          managed,
          this.createStreamSessionTools(managed.streamId),
        );
      } else {
        throw new Error("Pi session is not active and cannot be activated for prune");
      }
    }

    const session = managed.runtime?.session;
    if (!session) throw new Error("Pi session failed to activate");

    const sessionManager = session.sessionManager;
    const target = sessionManager.getEntry(entryId);
    if (!target) throw new Error(`Session entry ${entryId} not found`);
    if (target.type !== "message" || target.message.role !== "user") {
      throw new Error(`Entry ${entryId} is not a user message (type=${target.type})`);
    }

    const navResult = await session.navigateTree(entryId);
    if (navResult.cancelled) {
      throw new Error("navigateTree cancelled (extension veto)");
    }

    sessionManager.appendCustomEntry("flitterbot:prune_anchor", {
      prunedEntryId: entryId,
      prunedAt: new Date().toISOString(),
    });

    const newCount = session.messages.length;
    managed.state.noteEvent(newCount);

    this.wsHub.broadcast({
      type: "history_rewritten",
      piSessionId,
      reason: "prune",
    });

    this.log(
      `pruned history for pi session ${piSessionId} at entry ${entryId} (messages now ${newCount})`,
    );
    return { ok: true, piSessionId, messageCount: newCount };
  }

  private async ensureWhatsAppUserDefaultStreams(): Promise<void> {
    if (!this.whatsappEnabled) return;

    const config = loadWhatsAppConfig();
    for (const userId of Object.keys(config.users)) {
      if (config.defaultUser === userId) continue;

      const streamName = `flitterbot: ${userId}`;
      let stream = getStreamByName(this.blackboard, streamName);

      if (stream?.status === "closed") {
        stream = reopenStreamRow(this.blackboard, stream.id);
        if (stream) {
          this.log(`reopened WhatsApp default stream for user "${userId}" (${stream.id})`);
        }
      }

      if (!stream) {
        const created = await this.createWhatsAppDefaultStream(streamName, userId);
        this.log(`created WhatsApp default stream for user "${userId}" (${created.streamId})`);
        continue;
      }

      if (stream.type !== "defaultStream") {
        stream = setStreamType(this.blackboard, stream.id, "defaultStream") ?? stream;
      }
      if (!stream.stream_user) {
        this.blackboard
          .prepare("UPDATE streams SET stream_user = ? WHERE id = ?")
          .run(userId, stream.id);
      }

      const managed = this.sessionManager.getByStream(stream.id);
      if (managed) continue;

      this.log(`creating missing WhatsApp default stream session for user "${userId}"`);
      await this.sessionManager.createDefaultStream(
        stream.id,
        stream.name,
        stream.repo_path ?? this.config.projectsDir,
        this.createCustomTools("default", stream.id),
      );
    }
  }

  private async createWhatsAppDefaultStream(
    streamName: string,
    streamUser: string,
  ): Promise<{ streamId: string; streamName: string; piSessionId: string }> {
    const spawn = await this.spawnStreamWithSession({
      name: streamName,
      cwd: this.config.projectsDir,
      type: "defaultStream",
      streamUser,
      rollbackOnSpawnFailure: true,
    });
    if (!spawn.ok) throw spawn.spawnError;
    this.enqueueDefaultStreamFirstMessage(spawn.managed);
    return {
      streamId: spawn.streamId,
      streamName: spawn.streamName,
      piSessionId: spawn.managed.piSessionId,
    };
  }

  private enqueueDefaultStreamFirstMessage(managed: ManagedPiSession): void {
    const text = this.config.defaultAgentFirstMessage.trim();
    if (!text || !managed.streamId) return;
    managed.queue.enqueue({
      id: `default-stream-init-${managed.streamId}`,
      text,
      source: "init",
      sender: "system",
      metadata: {
        stream_id: managed.streamId,
        stream_name: managed.streamName ?? undefined,
        via: "defaultStream",
      },
      receivedAt: new Date().toISOString(),
    });
  }

  private resolveCodexWorkerCwd(streamId: string | undefined, cwd?: string): string {
    if (cwd?.trim()) return path.resolve(cwd.trim());
    const stream = streamId ? getStreamById(this.blackboard, streamId) : null;
    return path.resolve(stream?.worktree_path ?? stream?.repo_path ?? this.config.projectsDir);
  }

  private registerActiveCodexWorker(active: ActiveCodexWorker): void {
    const { handle } = active;
    this.activeCodexWorkers.set(handle.workerSessionId, active);
    handle.completion
      .then((completion) => {
        if (active.canceled) return;
        if (!active.streamId || !completion.finalOutput.trim()) return;
        const stream = getStreamById(this.blackboard, active.streamId);
        const streamName = stream?.name ?? active.streamName ?? active.streamId;
        const message = [
          `Codex worker completed (${completion.workerSessionId.slice(0, 8)}).`,
          "",
          completion.finalOutput,
        ].join("\n");
        const orchestrator = this.sessionManager.getByStream(active.streamId);
        if (orchestrator) {
          orchestrator.queue.enqueue({
            id: `codex-worker-${completion.workerTurnId}`,
            text: message,
            source: "agent",
            sender: "system",
            metadata: {
              stream_id: active.streamId,
              stream_name: streamName,
              worker_session_id: completion.workerSessionId,
              worker_turn_id: completion.workerTurnId,
              codex_thread_id: completion.threadId,
              codex_turn_id: completion.turnId,
            },
            receivedAt: new Date().toISOString(),
          });
        }
        persistInboundMessage(this.blackboard, {
          source: "agent",
          content: message,
          sender: "system",
          streamId: active.streamId,
          piSessionId: orchestrator?.piSessionId,
          metadata: {
            stream_id: active.streamId,
            stream_name: streamName,
            worker_session_id: completion.workerSessionId,
            worker_turn_id: completion.workerTurnId,
            codex_thread_id: completion.threadId,
            codex_turn_id: completion.turnId,
            worker_event: "completed",
          },
        });
      })
      .catch((error) => {
        this.log(
          `codex worker ${handle.workerSessionId} failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      })
      .finally(() => {
        this.activeCodexWorkers.delete(handle.workerSessionId);
      });
  }

  private async launchCodexWorkerTask(input: {
    streamId?: string;
    profileId?: string;
    prompt: string;
    cwd?: string;
    context?: string;
  }): Promise<{
    workerSessionId: string;
    workerTurnId: string;
    threadId: string;
    turnId: string;
    profileId: string;
    cwd: string;
    streamId?: string;
    streamName?: string;
  }> {
    const targetStreamId = input.streamId;
    const stream = targetStreamId ? getStreamById(this.blackboard, targetStreamId) : null;
    if (targetStreamId && !stream) throw new Error(`Stream not found: ${targetStreamId}`);
    if (stream && stream.status !== "open") throw new Error(`Stream is closed: ${stream.name}`);
    const cwd = this.resolveCodexWorkerCwd(targetStreamId, input.cwd);
    if (!fs.existsSync(cwd)) throw new Error(`Codex worker cwd does not exist: ${cwd}`);
    const profile = resolveCodexWorkerProfile(this.config, input.profileId);
    const managed = targetStreamId ? this.sessionManager.getByStream(targetStreamId) : undefined;
    const handle = await startCodexWorker({
      db: this.blackboard,
      cwd,
      prompt: input.prompt,
      streamId: targetStreamId,
      piSessionId: managed?.piSessionId,
      profile,
      context: input.context,
    });
    this.registerActiveCodexWorker({
      handle,
      streamId: targetStreamId,
      streamName: stream?.name,
    });
    return {
      workerSessionId: handle.workerSessionId,
      workerTurnId: handle.workerTurnId,
      threadId: handle.threadId,
      turnId: handle.turnId,
      profileId: profile.id,
      cwd,
      streamId: targetStreamId,
      streamName: stream?.name,
    };
  }

  private async followUpCodexWorkerTask(input: {
    workerSessionId: string;
    prompt: string;
    profileId?: string;
  }): Promise<{
    workerSessionId: string;
    workerTurnId: string;
    threadId: string;
    turnId: string;
    profileId: string;
    streamId?: string | null;
  }> {
    if (this.activeCodexWorkers.has(input.workerSessionId)) {
      throw new Error(`Worker ${input.workerSessionId} is still running; wait or cancel first`);
    }
    const session = getWorkerSession(this.blackboard, input.workerSessionId);
    if (!session) throw new Error(`Unknown worker session: ${input.workerSessionId}`);
    const profileId = input.profileId ?? parseWorkerProfileId(session);
    const profile = resolveCodexWorkerProfile(this.config, profileId);
    const handle = await startCodexWorkerFollowUp({
      db: this.blackboard,
      workerSessionId: input.workerSessionId,
      cwd: session.cwd,
      prompt: input.prompt,
      profile,
    });
    const stream = session.stream_id ? getStreamById(this.blackboard, session.stream_id) : null;
    this.registerActiveCodexWorker({
      handle,
      streamId: session.stream_id,
      streamName: stream?.name,
    });
    return {
      workerSessionId: handle.workerSessionId,
      workerTurnId: handle.workerTurnId,
      threadId: handle.threadId,
      turnId: handle.turnId,
      profileId: profile.id,
      streamId: session.stream_id,
    };
  }

  private getCodexWorkerStatus(input: { workerSessionId?: string; streamId?: string }): {
    session: ReturnType<typeof getWorkerSession>;
    turns: ReturnType<typeof listWorkerTurnsBySession>;
    active: boolean;
  } {
    let workerSessionId = input.workerSessionId;
    if (!workerSessionId && input.streamId) {
      workerSessionId = listWorkerSessionsByStream(this.blackboard, input.streamId, 1)[0]
        ?.worker_session_id;
    }
    if (!workerSessionId) throw new Error("Provide worker_session_id or stream_id");
    const session = getWorkerSession(this.blackboard, workerSessionId);
    if (!session) throw new Error(`Unknown worker session: ${workerSessionId}`);
    return {
      session,
      turns: listWorkerTurnsBySession(this.blackboard, workerSessionId),
      active: this.activeCodexWorkers.has(workerSessionId),
    };
  }

  private async cancelCodexWorkerTask(workerSessionId: string): Promise<{
    workerSessionId: string;
    canceled: boolean;
    reason?: string;
  }> {
    const session = getWorkerSession(this.blackboard, workerSessionId);
    if (!session) throw new Error(`Unknown worker session: ${workerSessionId}`);
    const active = this.activeCodexWorkers.get(workerSessionId);
    const latestTurn = getLatestWorkerTurnBySession(this.blackboard, workerSessionId);
    if (!active) {
      if (
        session.status === "completed" ||
        session.status === "failed" ||
        session.status === "canceled"
      ) {
        return { workerSessionId, canceled: false, reason: `already ${session.status}` };
      }
      updateWorkerSession(this.blackboard, workerSessionId, {
        status: "canceled",
        completedAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      });
      if (latestTurn && latestTurn.status === "running") {
        updateWorkerTurn(this.blackboard, latestTurn.worker_turn_id, {
          status: "canceled",
          completedAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
        });
      }
      return {
        workerSessionId,
        canceled: true,
        reason: "no active app-server client in this runtime; persisted canceled state",
      };
    }
    active.canceled = true;
    try {
      await active.handle.client.interruptTurn({
        threadId: active.handle.threadId,
        turnId: active.handle.turnId,
      });
    } catch (error) {
      active.canceled = false;
      const message = error instanceof Error ? error.message : String(error);
      if (message.toLowerCase().includes("no active turn")) {
        return { workerSessionId, canceled: false, reason: message };
      }
      throw error;
    }
    updateWorkerSession(this.blackboard, workerSessionId, {
      status: "canceled",
      completedAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    });
    updateWorkerTurn(this.blackboard, active.handle.workerTurnId, {
      status: "canceled",
      completedAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    });
    return { workerSessionId, canceled: true };
  }

  private createStreamSessionTools(streamId: string): CustomToolDefinition[] {
    const stream = getStreamById(this.blackboard, streamId);
    return this.createCustomTools(
      stream?.type === "defaultStream" ? "default" : "orchestrator",
      streamId,
    );
  }

  private persistStreamWhatsAppOwner(
    streamId: string,
    streamName: string,
    piSessionId: string | undefined,
    remoteJid: string,
    content = "WhatsApp stream owner set.",
  ): void {
    try {
      persistInboundMessage(this.blackboard, {
        source: "agent",
        content,
        sender: "system",
        streamId,
        piSessionId,
        metadata: {
          stream_id: streamId,
          stream_name: streamName,
          stream_owner_remote_jid: remoteJid,
        },
      });
    } catch (error) {
      this.log(
        `stream WhatsApp owner persist failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  createCustomTools(
    role: "orchestrator" | "default" = "default",
    streamId?: string,
  ): CustomToolDefinition[] {
    const tools: CustomToolDefinition[] = [createQueryBlackboardTool(this.blackboard)];

    if (role === "default") {
      tools.push({
        name: "create_stream",
        label: "Create Stream",
        description:
          "Create a new stream and spawn a dedicated orchestrator for it. Use when the user requests any work (features, bugs, investigations, even web research) that might benefit from a dedicated session.",
        parameters: {
          type: "object",
          properties: {
            suggested_name: {
              type: "string",
              description:
                "Your suggested name for the stream — 2-4 words, lowercase, dash-separated. Prefix it with intent: 'i-' for investigations, 'wr-' for web research, 'bug-' or 'fix-' for bug fixes, 'bs-' for repo brainstorms (e.g. 'i-wu-lifecycle', 'fix-auth-token-refresh'). The tool normalizes this into a canonical name by stripping the leading intent prefix, so the stored stream name, worktree dir, and branch stay tight. The canonical name is returned in the response — use it for any subsequent references.",
            },
            message: {
              type: "string",
              description:
                "Optional agent-authored context appended after the passed-through user message. Use for interpretation, constraints, repo/spec paths, or batch-created stream instructions. Do not duplicate the user's request here during normal single-stream creation — the runtime passes the user's message through automatically.",
            },
            cwd: {
              type: "string",
              description:
                "Absolute path to use as the working directory for new stream's orchestrator and agents.",
            },
            skipUserMessage: {
              type: "boolean",
              description:
                "Set true only when batch-creating multiple new streams and the message field contains the targeted full prompt for this stream. Leave false/omitted for normal stream creation so the runtime can pass through the relevant user messages.",
            },
          },
          required: ["suggested_name", "cwd"],
          additionalProperties: false,
        },
        execute: async (_toolCallId: string, params: Record<string, unknown>) => {
          const {
            suggested_name: suggestedName,
            message: agentMessage,
            cwd: cwdParam,
            skipUserMessage: skipUserMessageParam,
          } = params as {
            suggested_name: string;
            message?: string;
            cwd: string;
            skipUserMessage?: boolean;
          };
          const name = stripStreamNamePrefix(suggestedName);
          const skipUserMessage = skipUserMessageParam === true;
          if (skipUserMessage && !agentMessage?.trim()) {
            return {
              content: [
                {
                  type: "text",
                  text: "Error: skipUserMessage=true is only valid when message contains the targeted batch prompt for this stream.",
                },
              ],
              details: { error: true },
            };
          }

          if (!fs.existsSync(cwdParam)) {
            return {
              content: [
                {
                  type: "text",
                  text: `Error: cwd path "${cwdParam}" does not exist`,
                },
              ],
              details: {},
            };
          }
          const effectiveCwd = cwdParam;

          const nameTrace =
            suggestedName !== name ? `"${name}" (from "${suggestedName}")` : `"${name}"`;
          this.log(`default agent creating stream ${nameTrace} cwd=${effectiveCwd}`);

          // Owner trickles from the creating default stream (per-user) or the global default session (owner).
          const parentStream = streamId ? getStreamById(this.blackboard, streamId) : null;
          const streamUser =
            parentStream?.stream_user ?? loadWhatsAppConfig().defaultUser ?? undefined;

          const spawn = await this.spawnStreamWithSession({
            name,
            cwd: effectiveCwd,
            streamUser,
            rollbackOnSpawnFailure: false,
          });

          if (!spawn.ok) {
            return {
              content: [
                {
                  type: "text",
                  text: spawn.streamId
                    ? `Stream "${spawn.streamName}" created (ID: ${spawn.streamId}, canonical name: "${spawn.streamName}") but orchestrator failed to spawn: ${spawn.spawnError.message}`
                    : `Stream creation failed before orchestrator spawn: ${spawn.spawnError.message}`,
                },
              ],
              details: {
                streamId: spawn.streamId,
                canonicalName: spawn.streamName,
                suggestedName,
                namePrefixStripped: suggestedName !== name,
                error: true,
              },
            };
          }

          const ws = { id: spawn.streamId, name: spawn.streamName };
          const orchestrator = spawn.managed;

          try {
            const sourceSession = streamId
              ? this.sessionManager.getByStream(streamId)
              : this.sessionManager.getDefault();
            const currentItem = sourceSession?.queue.getCurrentItem();
            const originalText = currentItem?.text;
            const inheritedReplyMetadata = whatsappReplyMetadataFrom(currentItem);
            const inheritedRemoteJid = extractRemoteJid(inheritedReplyMetadata);
            if (inheritedRemoteJid) {
              orchestrator.whatsappRemoteJid = inheritedRemoteJid;
              this.persistStreamWhatsAppOwner(
                ws.id,
                ws.name,
                orchestrator.piSessionId,
                inheritedRemoteJid,
              );
            }
            const currentUserText = originalText
              ? stripInjectedDatetimeBlocks(originalText)
              : undefined;

            if (currentUserText && !skipUserMessage) {
              let prompt: string;
              try {
                const { getRecentDefaultMessages } = await import("./blackboard/query-messages.ts");
                const { getPreviousStreamCreatedAt } = await import(
                  "./blackboard/query-streams.ts"
                );
                const { classifyContextRelevance } = await import(
                  "./classifier/context-relevance.ts"
                );
                const { formatStreamPrompt } = await import("./streams/format-stream-prompt.ts");

                const boundary = getPreviousStreamCreatedAt(this.blackboard, ws.id);
                const recentMessages = getRecentDefaultMessages(this.blackboard, 10, boundary);

                if (
                  role === "default" &&
                  this.config.classifier.provider !== "disabled" &&
                  recentMessages.length > 1
                ) {
                  const relevance = await classifyContextRelevance(
                    recentMessages,
                    ws.name,
                    this.config,
                    agentMessage,
                    this.log.bind(this),
                  );
                  const relevantTexts = recentMessages
                    .filter((_, i) => relevance[i])
                    .map((m) => m.content);

                  if (relevantTexts.length > 1) {
                    if (!relevantTexts.includes(currentUserText)) {
                      relevantTexts.push(currentUserText);
                    }
                    prompt = formatStreamPrompt(
                      relevantTexts,
                      ws.name,
                      ws.id,
                      agentMessage,
                      this.config.newStreamFirstMessageFooter,
                    );
                    this.log(
                      `context classifier: ${relevantTexts.length}/${recentMessages.length} messages relevant for "${ws.name}"`,
                    );
                  } else {
                    prompt = this.sessionManager.buildStreamPrompt(
                      currentUserText,
                      ws.name,
                      ws.id,
                      agentMessage,
                      this.config.newStreamFirstMessageFooter,
                    );
                  }
                } else {
                  prompt = this.sessionManager.buildStreamPrompt(
                    currentUserText,
                    ws.name,
                    ws.id,
                    agentMessage,
                    this.config.newStreamFirstMessageFooter,
                  );
                }
              } catch (error) {
                this.log(
                  `context classifier failed, falling back to single message: ${error instanceof Error ? error.message : String(error)}`,
                );
                this.wsHub.broadcast({
                  type: "error",
                  message:
                    "Context classification failed — stream context limited to current message.",
                });
                prompt = this.sessionManager.buildStreamPrompt(
                  currentUserText,
                  ws.name,
                  ws.id,
                  agentMessage,
                  this.config.newStreamFirstMessageFooter,
                );
              }

              orchestrator.queue.enqueue({
                id: `ws-init-${ws.id}`,
                text: prompt,
                source: "web",
                // agent-authored bootstrap prompt — sender "system" keeps it from coalescing with subsequent real user messages
                sender: "system",
                metadata: {
                  stream_id: ws.id,
                  stream_name: ws.name,
                  ...inheritedReplyMetadata,
                },
                receivedAt: new Date().toISOString(),
              });
              this.log(`enqueued original user message onto stream "${ws.name}" (${ws.id})`);
            } else if (skipUserMessage && agentMessage) {
              const { formatStreamPrompt } = await import("./streams/format-stream-prompt.ts");
              const prompt = formatStreamPrompt(
                [],
                ws.name,
                ws.id,
                agentMessage,
                this.config.newStreamFirstMessageFooter,
              );
              orchestrator.queue.enqueue({
                id: `ws-init-${ws.id}`,
                text: prompt,
                source: "web",
                // agent-authored bootstrap prompt — sender "system" keeps it from coalescing with subsequent real user messages
                sender: "system",
                metadata: {
                  stream_id: ws.id,
                  stream_name: ws.name,
                  ...inheritedReplyMetadata,
                },
                receivedAt: new Date().toISOString(),
              });
              this.log(
                `enqueued agent-only message onto stream "${ws.name}" (${ws.id}) [batch mode]`,
              );
            }

            const passthroughNote = skipUserMessage
              ? agentMessage
                ? " with agent-authored context (batch mode)"
                : ""
              : currentUserText
                ? " and user message passed through"
                : "";
            const normalizationNote =
              suggestedName !== name
                ? ` Suggested name "${suggestedName}" normalized to canonical "${name}".`
                : "";
            return {
              content: [
                {
                  type: "text",
                  text: `Stream created (ID: ${ws.id}, canonical name: "${ws.name}"). Orchestrator spawned${passthroughNote}.${normalizationNote} Use the canonical name for any subsequent references.`,
                },
              ],
              details: {
                streamId: ws.id,
                canonicalName: ws.name,
                suggestedName,
                namePrefixStripped: suggestedName !== name,
              },
            };
          } catch (error) {
            return {
              content: [
                {
                  type: "text",
                  text: `Stream "${ws.name}" (ID: ${ws.id}) created and orchestrator spawned, but bootstrap prompt enqueue failed: ${error instanceof Error ? error.message : String(error)}`,
                },
              ],
              details: {
                streamId: ws.id,
                canonicalName: ws.name,
                suggestedName,
                namePrefixStripped: suggestedName !== name,
                error: true,
              },
            };
          }
        },
      });

      tools.push({
        name: "enqueue_message",
        label: "Enqueue Message",
        description:
          "Send a message to an existing orchestrator running on an open stream. Use to forward user follow-ups, delegate context, or nudge an orchestrator. Does NOT create a stream or spawn an orchestrator — use create_stream for that.",
        parameters: {
          type: "object",
          properties: {
            stream_id: {
              type: "string",
              description: "ID of the target stream",
            },
            message: {
              type: "string",
              description:
                "Message content to deliver to the orchestrator. Include relevant context.",
            },
          },
          required: ["stream_id", "message"],
          additionalProperties: false,
        },
        execute: async (_toolCallId: string, params: Record<string, unknown>) => {
          const { stream_id, message } = params as { stream_id: string; message: string };
          const { getStreamById } = await import("./blackboard/query-streams.ts");
          const ws = getStreamById(this.blackboard, stream_id);
          if (!ws) {
            return {
              content: [{ type: "text", text: `Stream not found: ${stream_id}` }],
              details: { error: true },
            };
          }
          if (ws.status !== "open") {
            return {
              content: [{ type: "text", text: `Stream is closed: ${ws.name}` }],
              details: { error: true },
            };
          }

          const orchestrator = this.sessionManager.getByStream(ws.id);
          if (!orchestrator) {
            return {
              content: [
                {
                  type: "text",
                  text: `No running orchestrator for stream: ${ws.name}`,
                },
              ],
              details: { error: true },
            };
          }

          try {
            orchestrator.queue.enqueue({
              id: `enq-msg-${crypto.randomUUID()}`,
              text: message,
              source: "agent",
              sender: "system",
              metadata: {
                stream_id: ws.id,
                stream_name: ws.name,
              },
              receivedAt: new Date().toISOString(),
            });
          } catch (enqueueError) {
            return {
              content: [
                {
                  type: "text",
                  text: `Failed to enqueue message to stream "${ws.name}": ${enqueueError instanceof Error ? enqueueError.message : String(enqueueError)}`,
                },
              ],
              details: { error: true },
            };
          }

          try {
            persistInboundMessage(this.blackboard, {
              source: "agent",
              content: message,
              sender: "system",
              streamId: ws.id,
              piSessionId: this.sessionManager.getByStream(ws.id)?.piSessionId,
              metadata: {
                stream_id: ws.id,
                stream_name: ws.name,
                enqueued_by: "enqueue_message_tool",
              },
            });
          } catch (error) {
            this.log(
              `enqueue_message persist failed: ${error instanceof Error ? error.message : String(error)}`,
            );
          }

          this.log(
            `enqueued message onto stream "${ws.name}" (${ws.id}), queue depth: ${orchestrator.queue.getDepth()}`,
          );

          return {
            content: [
              {
                type: "text",
                text: `Message enqueued to stream "${ws.name}" (queue depth: ${orchestrator.queue.getDepth()}).`,
              },
            ],
            details: {
              streamId: ws.id,
              streamName: ws.name,
              queueDepth: orchestrator.queue.getDepth(),
            },
          };
        },
      });
    }

    if (role === "orchestrator") {
      tools.push({
        name: "launch_codex_worker",
        label: "Launch Codex Worker",
        description:
          "Launch a real Codex app-server coding worker for this stream. Use for implementation, focused repo inspection, or parallel coding work. Codex worker state is tracked in worker_sessions/worker_turns/worker_events; tmux is not required.",
        parameters: {
          type: "object",
          properties: {
            prompt: {
              type: "string",
              description:
                "Task prompt for the Codex worker. State the problem and relevant files/constraints.",
            },
            profile: {
              type: "string",
              description:
                "Optional Codex worker profile id from config, such as coding or light. Defaults to defaultCodexWorkerProfile.",
            },
            cwd: {
              type: "string",
              description:
                "Optional absolute working directory. Defaults to this stream's worktree, repo path, or projectsDir.",
            },
            stream_id: {
              type: "string",
              description:
                "Optional stream id. Defaults to the current orchestrator stream; use only for deliberate cross-stream launch.",
            },
            context: {
              type: "string",
              description: "Optional extra context injected as Codex developer instructions.",
            },
          },
          required: ["prompt"],
          additionalProperties: false,
        },
        execute: async (_toolCallId: string, params: Record<string, unknown>) => {
          try {
            const parsed = params as {
              prompt: string;
              profile?: string;
              cwd?: string;
              stream_id?: string;
              context?: string;
            };
            const result = await this.launchCodexWorkerTask({
              streamId: parsed.stream_id || streamId,
              profileId: parsed.profile,
              prompt: parsed.prompt,
              cwd: parsed.cwd,
              context: parsed.context,
            });
            return {
              content: [
                {
                  type: "text",
                  text: `Codex worker launched (${result.workerSessionId}). Profile: ${result.profileId}. Thread: ${result.threadId}. The final output will be routed back to this stream when the turn completes.`,
                },
              ],
              details: result,
            };
          } catch (error) {
            return {
              content: [
                {
                  type: "text",
                  text: `Failed to launch Codex worker: ${error instanceof Error ? error.message : String(error)}`,
                },
              ],
              details: { error: true },
            };
          }
        },
      });

      tools.push({
        name: "send_codex_worker_followup",
        label: "Send Codex Worker Follow-Up",
        description:
          "Resume an existing Codex app-server worker thread and send a follow-up prompt. Use after a worker completed when the same thread should continue.",
        parameters: {
          type: "object",
          properties: {
            worker_session_id: {
              type: "string",
              description: "Worker session id returned by launch_codex_worker.",
            },
            prompt: {
              type: "string",
              description: "Follow-up prompt to send to the same Codex thread.",
            },
            profile: {
              type: "string",
              description:
                "Optional profile override. Defaults to the profile recorded on the worker session.",
            },
          },
          required: ["worker_session_id", "prompt"],
          additionalProperties: false,
        },
        execute: async (_toolCallId: string, params: Record<string, unknown>) => {
          try {
            const parsed = params as {
              worker_session_id: string;
              prompt: string;
              profile?: string;
            };
            const result = await this.followUpCodexWorkerTask({
              workerSessionId: parsed.worker_session_id,
              prompt: parsed.prompt,
              profileId: parsed.profile,
            });
            return {
              content: [
                {
                  type: "text",
                  text: `Codex worker follow-up started (${result.workerTurnId}) on worker session ${result.workerSessionId}.`,
                },
              ],
              details: result,
            };
          } catch (error) {
            return {
              content: [
                {
                  type: "text",
                  text: `Failed to send Codex worker follow-up: ${error instanceof Error ? error.message : String(error)}`,
                },
              ],
              details: { error: true },
            };
          }
        },
      });

      tools.push({
        name: "cancel_codex_worker",
        label: "Cancel Codex Worker",
        description:
          "Cancel an active Codex app-server worker turn and mark its worker session canceled.",
        parameters: {
          type: "object",
          properties: {
            worker_session_id: {
              type: "string",
              description: "Worker session id returned by launch_codex_worker.",
            },
          },
          required: ["worker_session_id"],
          additionalProperties: false,
        },
        execute: async (_toolCallId: string, params: Record<string, unknown>) => {
          try {
            const parsed = params as { worker_session_id: string };
            const result = await this.cancelCodexWorkerTask(parsed.worker_session_id);
            return {
              content: [
                {
                  type: "text",
                  text: result.canceled
                    ? `Codex worker canceled: ${result.workerSessionId}`
                    : `Codex worker was not canceled: ${result.reason ?? result.workerSessionId}`,
                },
              ],
              details: result,
            };
          } catch (error) {
            return {
              content: [
                {
                  type: "text",
                  text: `Failed to cancel Codex worker: ${error instanceof Error ? error.message : String(error)}`,
                },
              ],
              details: { error: true },
            };
          }
        },
      });

      tools.push({
        name: "get_codex_worker_status",
        label: "Get Codex Worker Status",
        description:
          "Inspect a Codex worker session and its turns. Provide worker_session_id, or omit it to inspect the latest worker for this stream.",
        parameters: {
          type: "object",
          properties: {
            worker_session_id: {
              type: "string",
              description: "Optional worker session id.",
            },
            stream_id: {
              type: "string",
              description: "Optional stream id. Defaults to the current stream.",
            },
          },
          additionalProperties: false,
        },
        execute: async (_toolCallId: string, params: Record<string, unknown>) => {
          try {
            const parsed = params as { worker_session_id?: string; stream_id?: string };
            const result = this.getCodexWorkerStatus({
              workerSessionId: parsed.worker_session_id,
              streamId: parsed.stream_id || streamId,
            });
            const latestTurn = result.turns.at(-1);
            return {
              content: [
                {
                  type: "text",
                  text: [
                    `Codex worker ${result.session?.worker_session_id} is ${result.session?.status}${result.active ? " (active in this runtime)" : ""}.`,
                    latestTurn
                      ? `Latest turn ${latestTurn.worker_turn_id} is ${latestTurn.status}.`
                      : "No turns recorded.",
                  ].join("\n"),
                },
              ],
              details: result,
            };
          } catch (error) {
            return {
              content: [
                {
                  type: "text",
                  text: `Failed to inspect Codex worker: ${error instanceof Error ? error.message : String(error)}`,
                },
              ],
              details: { error: true },
            };
          }
        },
      });

      tools.push({
        name: "set_up_worktree",
        label: "Set Up Worktree",
        description:
          "Inspect or apply the current stream's git worktree setup. mode is required. mode:'inspect' accepts no other args and reports the current repo, stream worktree, [flitterbot] config, resolved create base, planned create path, and discovery advisory when config is missing. mode:'apply' creates a new worktree when path is omitted, or attaches an existing worktree when path is provided. Applying requires [flitterbot] bootstrap config; if config is missing, no worktree is created and the agent should run inspect. base_ref chooses the create base, or updates only the recorded merge target when the stream already has a worktree; it never rebases/resets/moves the checkout. Attaching with path requires base_ref so the merge target is explicit. force:true means delink the current stream worktree association and mint a fresh new worktree; force cannot be combined with path. Stream and repo are ambient: the tool is bound to the current stream, and repo is resolved from the orchestrator cwd then anchored on the repo's main worktree.",

        parameters: {
          type: "object",
          properties: {
            mode: {
              type: "string",
              enum: ["inspect", "apply"],
              description:
                "Required. inspect reports config/discovery and makes no changes; apply creates, attaches, or retargets the stream worktree.",
            },
            path: {
              type: "string",
              description:
                "Existing git worktree path to attach. Only valid with mode:'apply', and base_ref is required with path.",
            },
            base_ref: {
              type: "string",
              description:
                "Branch to fork from for create, or recorded merge target for an existing/attached worktree. Does NOT accept SHAs or tags.",
            },
            force: {
              type: "boolean",
              description:
                "Only valid with mode:'apply' and no path. Delink the current stream worktree association and mint a fresh new worktree; old worktree is left on disk.",
            },
          },
          required: ["mode"],
          additionalProperties: false,
        },
        execute: async (_toolCallId: string, params: Record<string, unknown>) => {
          const { mode, path, base_ref, force } = params as {
            mode: "inspect" | "apply";
            path?: string;
            base_ref?: string;
            force?: boolean;
          };
          if (!streamId) {
            return {
              content: [
                { type: "text", text: "Error: set_up_worktree is only available on a stream." },
              ],
              details: { ok: false },
            };
          }
          const stream_id = streamId;
          const orchestratorRow = this.blackboard.get<{ cwd: string | null }>(
            `SELECT cwd FROM pi_sessions
             WHERE stream_id = ? AND role = 'orchestrator'
             ORDER BY started_at DESC LIMIT 1`,
            stream_id,
          );
          const orchestratorCwd = orchestratorRow?.cwd;
          if (!orchestratorCwd) {
            return {
              content: [
                {
                  type: "text",
                  text: `Error: no orchestrator pi_session found for stream ${stream_id} — cannot resolve repo_path / base_ref defaults.`,
                },
              ],
              details: { ok: false, streamId: stream_id },
            };
          }
          const result = await executeSetUpWorktree(
            this.blackboard,
            stream_id,
            orchestratorCwd,
            mode,
            base_ref,
            force,
            path,
          );
          if (result.ok) {
            const worktreePiSessionId = this.sessionManager.getByStream(stream_id)?.piSessionId;
            if (worktreePiSessionId) {
              this.sessionManager.toolDisplayCache.invalidatePiSession(worktreePiSessionId);
              this.wsHub.broadcast({
                type: "worktree_changed",
                piSessionId: worktreePiSessionId,
                streamId: stream_id,
              });
            }
          }
          return { content: [{ type: "text", text: result.message }], details: result };
        },
      });

      const closeStreamId = streamId;
      tools.push({
        name: "close_stream",
        label: "Close Stream",
        description:
          'Close the current stream. ONLY call when the user explicitly signals finality (e.g., "looks good", "ship it", "done"). Requests like "merge with main" or "rebase" are NOT close signals — run those as git commands directly. Mode is required: "merge" merges the branch and closes the stream; "noop" skips all git operations and just closes the stream record (use only when the user explicitly says don\'t merge). commit_message is required: it is used to commit any uncommitted in-flight work in the worktree before the merge — author it from `git log <base>..HEAD --oneline` and `git diff HEAD` so it describes the actual work, not a placeholder. The merge commit itself uses git\'s default message ("Merge branch \'X\' into Y"). Merge uses a two-call flow: call first without base_branch to get a non-destructive preview (returns current branch + resolved base branch); relay to user as "Merge <current> → <base>. Confirm, or name a different branch." If resolved base is null, ask the user for a branch first. Call again with explicit base_branch to execute. On merge conflicts the tool aborts cleanly, leaves the repo untouched, returns the conflict list, and the stream stays open; resolve each file intelligently (retain both sides when additive/non-overlapping, pick the superseding side when one replaces the other, stop and ask the user if ambiguous — never silently discard), then call close_stream again. Don\'t autonomously open PRs. Don\'t autonomously merge into main unless the user named it.',
        parameters: {
          type: "object",
          properties: {
            stream_id: { type: "string", description: "ID of the stream to close" },
            mode: {
              type: "string",
              enum: ["merge", "noop"],
              description:
                '"merge" commits uncommitted changes, merges branch to the stream\'s base branch, and pushes. On the first merge call without base_branch, returns a non-destructive preview with the current branch and resolved base branch for user confirmation; pass explicit base_branch on the follow-up call to actually execute. "noop" skips all git operations — just closes the stream and ends the session.',
            },
            commit_message: {
              type: "string",
              description:
                'Commit message used when auto-committing any uncommitted in-flight work in the worktree before the merge. Required. Must describe the actual work in this stream — do NOT use placeholder/chore filler. Ignored for noop mode and on preview calls, but still required (write a short reason like "closing: <why>").',
            },
            base_branch: {
              type: "string",
              description:
                "Target branch to merge into. Supersedes the stream's recorded base_branch AND skips the preview step — passing this executes the merge directly. Omit it on the first call to get a preview; pass it on the confirming call to execute. Ignored in noop mode.",
            },
          },
          required: ["stream_id", "mode", "commit_message"],
          additionalProperties: false,
        },
        execute: async (_toolCallId: string, params: Record<string, unknown>) => {
          const { stream_id, mode, commit_message, base_branch } = params as {
            stream_id: string;
            mode: "merge" | "noop";
            commit_message: string;
            base_branch?: string;
          };
          const managed = closeStreamId
            ? this.sessionManager.getByStream(closeStreamId)
            : undefined;
          const streamsSessId = managed?.piSessionId;
          if (!streamsSessId) {
            return {
              content: [{ type: "text", text: "Error: Orchestrator session not found" }],
              details: {},
            };
          }
          const result = await executeCloseStream(
            this.blackboard,
            streamsSessId,
            stream_id,
            mode,
            commit_message,
            base_branch,
          );
          if (result.ok) {
            if (managed) {
              managed.pendingDestroy = true;
            }
            this.wsHub.broadcast({
              type: "streams_changed",
              reason: "closed",
              streamId: stream_id,
            });
          }
          return { content: [{ type: "text", text: result.message }], details: result };
        },
      });
    }

    return tools;
  }

  private async sendWhatsAppCommand(command: DaemonCommand): Promise<DaemonResponse> {
    if (!this.whatsappEnabled) return { ok: false, status: "disabled" };
    try {
      const response = await sendDaemonCommand(command);
      if (response.daemon) {
        this.whatsappStatusCache = this.mapDaemonStatus(response.daemon);
      }
      return response;
    } catch {
      await this.startWhatsAppDaemon();
      const response = await sendDaemonCommand(command);
      if (response.daemon) {
        this.whatsappStatusCache = this.mapDaemonStatus(response.daemon);
      }
      return response;
    }
  }

  private getWhatsAppStatusSnapshot(): {
    status: ControlSurfaceWhatsAppStatus;
    pid?: number;
    managedByControlSurface: true;
    requiresManualAuth?: boolean;
  } {
    return this.whatsappStatusCache;
  }

  private mapDaemonStatus(daemon?: {
    status: ControlSurfaceWhatsAppStatus;
    pid?: number;
    requiresManualAuth?: boolean;
  }): {
    status: ControlSurfaceWhatsAppStatus;
    pid?: number;
    managedByControlSurface: true;
    requiresManualAuth?: boolean;
  } {
    if (!daemon) {
      return { status: "stopped", managedByControlSurface: true };
    }

    return {
      status: daemon.status,
      pid: daemon.pid,
      managedByControlSurface: true,
      requiresManualAuth: daemon.requiresManualAuth,
    };
  }

  private async refreshWhatsAppStatus(): Promise<void> {
    if (!this.whatsappEnabled) return;
    const prev = this.whatsappStatusCache.status;
    this.whatsappStatusCache = this.mapDaemonStatus(await getDaemonStatus());
    if (this.whatsappStatusCache.status !== prev) {
      this.broadcastStatusChanged("whatsapp");
    }
  }

  private watchWhatsAppStatusSignal(): void {
    this.unwatchWhatsAppStatusSignal();
    const signalPath = getWhatsAppStatusSignalPath();
    const dir = path.dirname(signalPath);
    const basename = path.basename(signalPath);
    try {
      this.whatsappStatusWatcher = fs.watch(dir, (_, filename) => {
        if (filename !== basename) return;
        void this.refreshWhatsAppStatus();
      });
      this.whatsappStatusWatcher.on("error", () => {
        this.unwatchWhatsAppStatusSignal();
      });
    } catch {}
  }

  private unwatchWhatsAppStatusSignal(): void {
    if (this.whatsappStatusWatcher) {
      this.whatsappStatusWatcher.close();
      this.whatsappStatusWatcher = undefined;
    }
  }

  private broadcastStatusChanged(subsystem: string): void {
    this.wsHub.broadcast({
      type: "status_changed",
      subsystem,
      timestamp: new Date().toISOString(),
    });
  }

  private async ensureWhatsAppDaemon(): Promise<void> {
    if (!this.whatsappEnabled) {
      this.log("whatsapp daemon disabled via WHATSAPP_ENABLED");
      return;
    }
    await this.refreshWhatsAppStatus();
    if (this.whatsappStatusCache.status !== "stopped") return;
    try {
      await this.startWhatsAppDaemon();
    } catch (error) {
      this.log(`whatsapp start skipped: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private startMaintenanceLoop(): void {
    this.maintenanceTimer = setInterval(async () => {
      try {
        pingBlackboard(this.blackboard);
        await this.refreshWhatsAppStatus();
        markStaleSessions(
          this.blackboard,
          this.config.stallMinutes,
          this.config.toolTimeoutMinutes,
        );
        const idleBefore = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
        const oldSessions = findIdleCleanupCandidates(this.blackboard, idleBefore);
        for (const session of oldSessions) {
          if (session.tmuxSession) {
            try {
              await killTmuxSession(session.tmuxSession);
            } catch {}
          }
          markSessionEnded(this.blackboard, session.sessionId, "idle_timeout");
        }
        const defaultManaged = this.sessionManager.getDefault();
        const allManaged = [
          ...(defaultManaged ? [defaultManaged] : []),
          ...this.sessionManager.listStreamSessions(),
        ];
        for (const managed of allManaged) {
          const snapshot = managed.state.getSnapshot();
          if (snapshot.busy && snapshot.currentTurnStartedAt) {
            const age = Date.now() - Date.parse(snapshot.currentTurnStartedAt);
            if (age > this.config.toolTimeoutMinutes * 60_000) {
              const label = `${managed.role}${managed.streamId ? ` ws=${managed.streamId}` : ""}`;
              const ageSeconds = Math.round(age / 1000);
              this.log(`queue turn appears stuck for ${ageSeconds}s (${label})`);
              setHealthFlag(
                this.blackboard,
                "stuck_turn",
                `Turn stuck for ${ageSeconds}s (${label})`,
                30,
              );
              const targetUserId = managed.streamId
                ? whatsappUserIdFromStreamName(managed.streamName)
                : metadataString(snapshot.currentItem?.metadata, "whatsapp_user_id");
              const remoteJid = extractRemoteJid(snapshot.currentItem?.metadata);
              if (!targetUserId && !remoteJid) {
                this.log(`stuck-turn WhatsApp alert skipped: no WhatsApp reply target (${label})`);
                continue;
              }
              this.sendWhatsAppCommand({
                command: "send",
                text: `⚠️ Stuck turn detected: ${label} — stuck for ${Math.round(age / 60_000)}min. Cron paused via circuit breaker (30min TTL).`,
                contextRef: undefined,
                ...(targetUserId ? { targetUserId } : { remoteJid }),
              }).catch((err) => {
                this.log(
                  `stuck-turn WhatsApp alert failed: ${err instanceof Error ? err.message : String(err)}`,
                );
              });
            }
          }
        }
      } catch (error) {
        this.log(`maintenance error: ${error instanceof Error ? error.message : String(error)}`);
      }
    }, 60_000);
  }

  private ensurePidFile(): void {
    const existingPid = readPid(this.config.controlSurfacePidPath);
    if (existingPid && isPidRunning(existingPid)) {
      throw new Error(`control surface already running with pid ${existingPid}`);
    }
    fs.mkdirSync(path.dirname(this.config.controlSurfacePidPath), { recursive: true });
    fs.writeFileSync(this.config.controlSurfacePidPath, `${process.pid}\n`, "utf8");
  }

  log(message: string): void {
    const line = `[${new Date().toISOString()}] ${message}`;
    fs.appendFileSync(this.config.controlSurfaceLogPath, `${line}\n`, "utf8");
  }

  private async handleWebSocketMessage(
    client: WebSocketClient,
    data: ControlSurfaceWebSocketClientEvent | unknown,
  ): Promise<void> {
    if (!data || typeof data !== "object") {
      console.warn("[ws] Dropping non-object WebSocket message (type=%s)", typeof data);
      return;
    }
    const payload = data as ControlSurfaceWebSocketClientEvent;
    if (payload.type === "ping") {
      this.wsHub.send(client.id, { type: "pong" });
      return;
    }
    if (payload.type === "subscribe" && typeof payload.piSessionId === "string") {
      this.wsHub.subscribeClient(
        client.id,
        payload.piSessionId,
        Array.isArray(payload.eventTypes) ? payload.eventTypes : undefined,
      );
      return;
    }
    if (payload.type === "unsubscribe" && typeof payload.piSessionId === "string") {
      this.wsHub.unsubscribeClient(client.id, payload.piSessionId);
      return;
    }
    if (payload.type === "message" && typeof payload.text === "string") {
      const targetPiSessionId =
        typeof payload.targetPiSessionId === "string" ? payload.targetPiSessionId : undefined;

      const serverMessageId = crypto.randomUUID();
      let routerMeta: StreamRoutingMeta = {};
      if (targetPiSessionId) {
        routerMeta._targetSessionId = targetPiSessionId;
        const targetSession = this.sessionManager.getByPiSessionId(targetPiSessionId);
        if (targetSession?.streamId) {
          routerMeta.stream_id = targetSession.streamId;
          routerMeta.stream_name = targetSession.streamName ?? undefined;
        }
      } else {
        try {
          const { classifyMessage } = await import("./classifier/classify.ts");
          const { resolveClassifierApiKey } = await import("./classifier/groq-client.ts");
          const classifier = this.config.classifier;
          const apiKey = resolveClassifierApiKey(classifier);
          if (classifier.provider === "disabled") throw new Error("Classifier is disabled");
          if (classifier.provider !== "pi" && !apiKey) {
            throw new Error(`No classifier API key available in ${classifier.apiKeyEnv}`);
          }
          const defaultPiSessionId = this.sessionManager.getDefault()?.piSessionId;
          const result = await classifyMessage(
            payload.text,
            this.blackboard,
            this.config,
            defaultPiSessionId,
            loadWhatsAppConfig().defaultUser ?? undefined,
          );
          routerMeta = { router_action: result.action };
          if (result.stream) {
            routerMeta.stream_id = result.stream.id;
            routerMeta.stream_name = result.stream.name;
          }
        } catch (error) {
          this.log(
            `router classification failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }

      try {
        this.enqueue({
          text: payload.text,
          source: "web",
          metadata: { via: "ws", ...routerMeta },
          webClientId: client.id,
          deliveryMode: payload.deliveryMode === "steer" ? "steer" : "followUp",
          images: Array.isArray(payload.images) ? payload.images : undefined,
          serverMessageId,
          clientMessageId:
            typeof payload.clientMessageId === "string" ? payload.clientMessageId : undefined,
        });

        const MAX_USER_WA_LENGTH = 30_000;
        try {
          const wsLabel = routerMeta.stream_name ? `*[${routerMeta.stream_name}]* ` : "";
          const userText =
            payload.text.length > MAX_USER_WA_LENGTH
              ? `${payload.text.slice(0, MAX_USER_WA_LENGTH)}\n\n[...truncated — full message in web client]`
              : payload.text;
          await this.sendWhatsAppCommand({
            command: "send",
            text: `${wsLabel}*User (web):*\n---\n${userText}`,
            contextRef: undefined,
          });
        } catch (error) {
          this.log(
            `mirror web message to WhatsApp failed (len=${payload.text.length}): ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        this.log(`WS message enqueue failed for client ${client.id}: ${reason}`);
        this.wsHub.send(client.id, {
          type: "error",
          message: `Failed to deliver message — ${reason}`,
        });
      }
    }
  }
}

function extractFinalAssistantMessage(
  session: AgentSession,
): { text: string; messageId?: string } | undefined {
  if (!session.messages.length) return undefined;
  for (let i = session.messages.length - 1; i >= 0; i--) {
    const msg = session.messages[i];
    if (!msg || msg.role !== "assistant") continue;
    const assistantMsg = msg as AssistantMessage;
    const messageId = assistantMsg.responseId?.trim() || undefined;
    const textParts = assistantMsg.content
      .filter((block): block is TextContent => block.type === "text")
      .map((block) => block.text)
      .join("");
    if (textParts.trim()) return { text: textParts.trim(), messageId };
    return undefined;
  }
  return undefined;
}

function formatHookMessage(eventName: string, payload: Record<string, unknown>): string {
  const sessionId = pickString(payload, ["session_id", "sessionId"]);
  const cwd = pickString(payload, ["cwd"]);
  const transcript = pickString(payload, ["transcript_path", "transcriptPath"]);
  const tmuxSession = pickString(payload, [
    "tmux_session",
    "tmuxSession",
    "FLITTERBOT_TMUX_SESSION",
  ]);
  const project = pickString(payload, ["project", "project_label", "projectLabel"]);
  const reason = pickString(payload, ["reason", "stop_reason", "session_end_reason"]);
  const agentManaged =
    payload.agent_managed === true ||
    payload.agentManaged === true ||
    payload.agent_managed === 1 ||
    payload.agentManaged === 1;
  const lastAssistantText = pickString(payload, [
    "lastAssistantText",
    "last_assistant_message",
    "lastAssistantMessage",
  ]);
  const lines = [
    `${humanizeHookEvent(eventName)}: ${hookVerb(eventName)}`,
    sessionId ? `Session ID: ${sessionId}` : undefined,
    project ? `Project: ${project}` : undefined,
    cwd ? `CWD: ${cwd}` : undefined,
    transcript ? `Transcript: ${transcript}` : undefined,
    eventName === "session-start" ? `Agent managed: ${agentManaged ? "yes" : "no"}` : undefined,
    tmuxSession ? `Tmux session: ${tmuxSession}` : undefined,
    reason ? `Reason: ${reason}` : undefined,
    lastAssistantText ? `Last output: "${lastAssistantText}"` : undefined,
  ].filter(Boolean);
  return lines.join("\n");
}

function metadataString(metadata: MessageMetadata | undefined, key: string): string | undefined {
  const value = metadata?.[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function whatsappUserIdFromStreamName(streamName: string | null | undefined): string | undefined {
  const prefix = "flitterbot: ";
  return streamName?.startsWith(prefix) ? streamName.slice(prefix.length).trim() : undefined;
}

function extractRemoteJid(metadata?: MessageMetadata): string | undefined {
  return metadataString(metadata, "remote_jid");
}

function whatsappReplyMetadataFrom(item?: QueueItem): MessageMetadata {
  const remoteJid = extractRemoteJid(item?.metadata);
  const contextRef = metadataString(item?.metadata, "context_ref");
  return {
    ...(remoteJid ? { remote_jid: remoteJid } : {}),
    ...(contextRef ? { context_ref: contextRef } : {}),
  };
}

function pickString(payload: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

function humanizeHookEvent(eventName: string): string {
  return eventName
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

function hookVerb(eventName: string): string {
  switch (eventName) {
    case "session-start":
      return "Claude Code session started.";
    case "stop":
      return "Claude Code session stopped.";
    case "session-end":
      return "Claude Code session ended.";
    case "subagent-start":
      return "Claude subagent started.";
    case "subagent-stop":
      return "Claude subagent stopped.";
    default:
      return "Hook event received.";
  }
}

function readPid(pidPath: string): number | undefined {
  try {
    if (!fs.existsSync(pidPath)) return undefined;
    const value = Number(fs.readFileSync(pidPath, "utf8").trim());
    return Number.isFinite(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function isPidRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
