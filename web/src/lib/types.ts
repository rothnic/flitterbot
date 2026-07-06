import type {
  ChatTimelineItem,
  ChatTimelineMessage,
  ChatTimelineTool,
} from "../../../src/contracts/timeline.ts";

export type {
  ChatTimelineItem,
  ChatTimelineMessage,
  ChatTimelineTool,
  ImageAttachment,
  JsonValue,
  MessageSource,
} from "../../../src/contracts/timeline.ts";

export type ConnectionState = "connected" | "connecting" | "reconnecting" | "stub" | "disconnected";

type SessionSummary = {
  sessionId: string;
  status: "working" | "idle" | "stale" | "ended";
  taskDescription?: string;
  project?: string;
  tmuxSession?: string;
  transcriptPath?: string;
  lastEventAt?: string;
  streamId?: string;
  streamName?: string;
};

type SessionDetail = {
  sessionId: string;
  status: "working" | "idle" | "stale" | "ended";
  taskDescription?: string;
  project?: string;
  tmuxSession?: string;
  transcriptPath?: string;
  lastEventAt?: string;
  startedAt?: string;
  cwd?: string;
  model?: string;
  streamId?: string;
  streamName?: string;
  recentEvents: SessionEvent[];
};

type SessionEvent = {
  id: number;
  event_name: string;
  tool_name?: string;
  payload?: string;
  timestamp: string;
};

type TmuxSessionInspection = {
  exists: boolean;
  attached: boolean;
  pane?: {
    uiState?: string;
    currentCommand?: string;
    target?: string;
    panePid?: number;
    capture?: string;
  };
};

type TranscriptItem = {
  id: string;
  kind: "message" | "tool_call" | "tool_result" | "event";
  role?: string;
  text?: string;
  title?: string;
  rawType?: string;
  toolName?: string;
  timestamp?: string;
  metadata: Record<string, unknown>;
};

export type TranscriptPage = {
  items: TranscriptItem[];
  nextCursor?: string;
};

export type ShortcutBindingsConfig = Partial<Record<string, string | string[]>>;

type PiSessionModelInfo = {
  id: string;
  provider: string;
  modelId: string;
  thinkingLevel?: ThinkingLevel;
};

export type StatusResponse = {
  source?: string;
  pid?: number;
  uptime: number;
  blackboard: string;
  whatsapp: {
    status: string;
    pid?: number;
    managedByControlSurface?: boolean;
  };
  piAgent?: {
    default?: {
      piSessionId?: string;
      busy?: boolean;
      messageCount?: number;
      state?: string;
      model?: PiSessionModelInfo;
    };
    orchestrators?: Array<{
      piSessionId: string;
      streamId: string;
      streamName?: string;
      messageCount: number;
      busy: boolean;
    }>;
  };
  streams?: StreamSummary[];
  shortcuts?: ShortcutBindingsConfig;
};

export type PiSessionStatus =
  | "active"
  | "waiting_for_user"
  | "waiting_for_sessions"
  | "ended"
  | "crashed";

export type StreamSummary = {
  id: string;
  name: string;
  type: "work" | "defaultStream";
  status: "open" | "closed";
  pinned: boolean;
  closedAt?: string;
  repoPath?: string;
  worktreePath?: string;
  piSessionId?: string;
  piSessionStatus?: PiSessionStatus;
  model?: PiSessionModelInfo;
  sessionCount: number;
  createdAt: string;
};

export type SessionListResponse = {
  items: SessionSummary[];
};

export type DownstreamSessionItem = {
  sessionId: string;
  status: "working" | "idle" | "stale" | "ended";
  streamId: string | null;
  streamName: string | null;
  tmuxSession: string | null;
  cwd: string | null;
  taskDescription: string | null;
  project: string | null;
};

export type WorkerTurnItem = {
  workerTurnId: string;
  externalTurnId: string | null;
  status: "queued" | "running" | "waiting_for_user" | "completed" | "failed" | "canceled";
  prompt: string | null;
  finalOutput: string | null;
  startedAt: string;
  completedAt: string | null;
  errorMessage: string | null;
};

export type WorkerSessionItem = {
  workerSessionId: string;
  runnerType: "codex_app_server" | "codex_exec" | "claude_tmux" | "pi";
  status:
    | "starting"
    | "running"
    | "waiting_for_user"
    | "idle"
    | "completed"
    | "failed"
    | "canceled"
    | "unreachable";
  hostId: string | null;
  hostDisplayName: string | null;
  connectionMode: "local-stdio" | "ssh-stdio" | "unix-socket" | "websocket-auth" | null;
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
  turns: WorkerTurnItem[];
};

export type SessionDetailResponse = {
  session: SessionDetail;
  tmux?: TmuxSessionInspection | null;
};

export type DirectMessageResponse = {
  ok: boolean;
  delivery?: string;
  reason?: string;
};

export type StreamsHistoryResponse = {
  items: ChatTimelineItem[];
};

export type SkillListItem = {
  name: string;
  description: string;
  disableModelInvocation: boolean;
  kind?: "skill" | "command";
};

export type SkillsListResponse = {
  items: SkillListItem[];
};

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export type ModelListItem = {
  id: string;
  label: string;
  provider: string;
  modelId: string;
  thinkingLevel?: ThinkingLevel;
  reasoning?: boolean;
  supportsXhigh?: boolean;
  name?: string;
  contextWindow?: number;
  available?: boolean;
  authKind?: "subscription" | "api_key" | "none";
};

export type ModelsListResponse = {
  pinned: ModelListItem[];
  all: ModelListItem[];
  defaultModel: string;
  defaultThinkingLevel: ThinkingLevel;
};

export type ModelsMutationResponse = ModelsListResponse & {
  ok: true;
};

export type DirectoryCompletionItem = {
  name: string;
  kind: "directory" | "file";
  path: string;
  insertText: string;
};

export type DirectoryCompletionsResponse = {
  items: DirectoryCompletionItem[];
  cwd: string;
  query: string;
};

export type WsMessage =
  | { type: "connected"; clientId: string }
  | { type: "queue_item_start"; item: { id: string; source: string }; piSessionId?: string }
  | { type: "queue_item_end"; itemId: string; error?: string; piSessionId?: string }
  | { type: "text_delta"; delta: string; piSessionId?: string; messageId: string }
  | { type: "message_start"; piSessionId?: string; messageId: string }
  | {
      type: "message_end";
      piSessionId?: string;
      message: ChatTimelineMessage;
      toolCalls?: Array<{
        toolUseId: string;
        toolName: string;
        args?: unknown;
        displayArgs?: unknown;
      }>;
      clientMessageId?: string;
    }
  | {
      type: "tool_execution_start" | "tool_execution_end";
      id?: string;
      tool?: string;
      toolUseId?: string;
      args?: unknown;
      displayArgs?: unknown;
      result?: unknown;
      isError?: boolean;
      event?: unknown;
      timestamp?: string;
      piSessionId?: string;
    }
  | { type: "thinking_start"; piSessionId?: string; messageId: string }
  | { type: "thinking_delta"; delta: string; piSessionId?: string; messageId: string }
  | { type: "thinking_end"; piSessionId?: string; messageId: string }
  | {
      type: "toolcall_start";
      contentIndex: number;
      toolName?: string;
      toolUseId?: string;
      piSessionId?: string;
    }
  | {
      type: "tool_execution_update";
      toolUseId?: string;
      partialResult?: unknown;
      piSessionId?: string;
    }
  | {
      type: "tool_result";
      item: ChatTimelineTool;
      piSessionId?: string;
    }
  | { type: "turn_end"; piSessionId?: string }
  | { type: "agent_end"; piSessionId?: string; aborted?: boolean }
  | {
      type: "stream_surfaced";
      message: ChatTimelineMessage;
      piSessionId?: string;
      streamId?: string;
      streamName?: string;
    }
  | {
      type: "streams_changed";
      reason: "created" | "closed" | "reopened" | "pinned" | "renamed" | "cwd_changed";
      streamId: string;
      streamName?: string;
    }
  | { type: "status_changed"; subsystem: string; timestamp: string }
  | {
      type: "sessions_changed";
      sessionId: string;
      piSessionId: string;
      reason: "registered" | "ended" | "stopped";
    }
  | {
      type: "worktree_changed";
      piSessionId: string;
      streamId: string;
    }
  | {
      type: "message_ack";
      serverMessageId: string;
      text: string;
      source: "web";
    }
  | { type: "resources_reloaded" }
  | { type: "history_rewritten"; piSessionId: string; reason: "prune" | "compact" }
  | { type: "error"; message: string };
