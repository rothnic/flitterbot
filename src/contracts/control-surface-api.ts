import type { ClaudeSessionStatus } from "./blackboard.ts";
import type {
  ChatTimelineItem,
  ChatTimelineMessage,
  ChatTimelineTool,
  MessageSource,
} from "./timeline.ts";
import type {
  SendMessageToTmuxSessionFailureReason,
  TmuxDeliveryMethod,
  TmuxSessionInspection,
} from "./tmux-bridge.ts";
import type { TranscriptPageResponse } from "./transcript.ts";

export type DeliveryMode = "followUp" | "steer";
export type BlackboardHealth = "ok" | "error";
export type WhatsAppDaemonStatus =
  | "unknown"
  | "disabled"
  | "stopped"
  | "starting"
  | "auth_required"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "logged_out"
  | "error"
  | "stopping";

export interface WhatsAppRuntimeStatus {
  ok?: boolean;
  status: WhatsAppDaemonStatus;
  pid?: number | null;
  managedByControlSurface: boolean;
  requiresManualAuth?: boolean;
}

export interface PiSessionModelInfo {
  id: string;
  provider: string;
  modelId: string;
  thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
}

export interface PiSessionRuntimeStatus {
  piSessionId: string;
  sessionFile: string | null;
  messageCount: number;
  lastPromptAt: string | null;
  busy: boolean;
  model?: PiSessionModelInfo;
}

export interface ClaudeSessionListItem {
  sessionId: string;
  tmuxSession: string | null;
  cwd: string;
  project: string;
  projectLabel: string | null;
  model: string | null;
  permissionMode: string | null;
  source: string | null;
  status: ClaudeSessionStatus;
  transcriptPath: string | null;
  taskDescription: string | null;
  todoistTaskId: string | null;
  agentManaged: boolean;
  sessionEndReason: string | null;
  streamId: string | null;
  piSessionId: string | null;
  startedAt: string;
  endedAt: string | null;
  lastEventAt: string;
  lastToolStartedAt: string | null;
}

export type ClaudeSessionDetail = ClaudeSessionListItem;

export interface PiOrchestratorStatus {
  piSessionId: string;
  streamId: string;
  streamName: string | null;
  messageCount: number;
  busy: boolean;
}

export interface PiMultiSessionStatus {
  default: PiSessionRuntimeStatus | null;
  orchestrators: PiOrchestratorStatus[];
}

export interface StreamSummary {
  id: string;
  name: string;
  type: "work" | "defaultStream";
  status: "open" | "closed";
  pinned: boolean;
  closedAt?: string;
  repoPath?: string;
  worktreePath?: string;
  piSessionId?: string;
  piSessionStatus?: "active" | "waiting_for_user" | "waiting_for_sessions" | "ended" | "crashed";
  model?: PiSessionModelInfo;
  sessionCount: number;
  createdAt: string;
}

export type ShortcutBindingsConfig = Partial<Record<string, string | string[]>>;

export interface StatusResponse {
  ok: true;
  pid: number;
  uptime: number;
  piAgent: PiMultiSessionStatus;
  whatsapp: WhatsAppRuntimeStatus;
  blackboard: BlackboardHealth;
  streams?: StreamSummary[];
  shortcuts?: ShortcutBindingsConfig;
}

export interface MessageRequest {
  text: string;
  source?: MessageSource;
  metadata?: Record<string, unknown>;
  deliveryMode?: DeliveryMode;
  images?: Array<{ data: string; mimeType: string }>;
  targetPiSessionId?: string;
}

export interface ModelListItem {
  id: string;
  label: string;
  provider: string;
  modelId: string;
  thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  reasoning?: boolean;
  supportsXhigh?: boolean;
  name?: string;
  contextWindow?: number;
  available?: boolean;
  authKind?: "subscription" | "api_key" | "none";
}

export interface ModelsListResponse {
  pinned: ModelListItem[];
  all: ModelListItem[];
  defaultModel: string;
  defaultThinkingLevel: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
}

export interface ModelsPinRequest {
  id: string;
  pin: boolean;
  label?: string;
}

export interface ModelsDefaultRequest {
  id: string;
}

export interface ModelsThinkingLevelRequest {
  level: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
}

export interface ModelsMutationResponse extends ModelsListResponse {
  ok: true;
}

export interface MessageResponse {
  ok: boolean;
}

export interface ClaudeHookPayload {
  hook_event_name?: string;
  event_name?: string;
  session_id?: string;
  tool_name?: string;
  tool_use_id?: string;
  cwd?: string;
  model?: string;
  permission_mode?: string;
  source?: string;
  transcript_path?: string;
  reason?: string;
  timestamp?: string;
  [key: string]: unknown;
}

export interface HookResponse {
  ok: boolean;
  filtered?: boolean;
  bookkeeping?: boolean;
}

export interface SessionsListResponse {
  items: ClaudeSessionListItem[];
}

export interface DownstreamSessionItem {
  sessionId: string;
  status: ClaudeSessionStatus;
  streamId: string | null;
  streamName: string | null;
  tmuxSession: string | null;
  cwd: string | null;
  taskDescription: string | null;
  project: string | null;
}

export interface DownstreamSessionsListResponse {
  items: DownstreamSessionItem[];
}

export interface SessionDetailResponse {
  session: ClaudeSessionDetail;
  tmux?: TmuxSessionInspection | null;
}

// ponytail: delete these deprecated aliases once callers use ChatTimeline* directly.
/** @deprecated Use ChatTimelineMessage from timeline.ts */
export type StreamsHistoryMessageItem = ChatTimelineMessage;
/** @deprecated Use ChatTimelineTool from timeline.ts */
export type StreamsHistoryToolItem = ChatTimelineTool;
/** @deprecated Use ChatTimelineItem from timeline.ts */
export type StreamsHistoryItem = ChatTimelineItem;

export interface StreamsHistoryResponse {
  piSessionId: string | null;
  sessionFile: string | null;
  items: ChatTimelineItem[];
}

export type SessionTranscriptResponse = TranscriptPageResponse;

export interface DirectSessionMessageRequest {
  text: string;
}

export type DirectSessionMessageFailureReason =
  | "ended"
  | "no_tmux_session"
  | "busy"
  | "stale_or_ambiguous"
  | SendMessageToTmuxSessionFailureReason;

export interface DirectSessionMessageResponse {
  ok: boolean;
  sessionId: string;
  delivery?: TmuxDeliveryMethod;
  busy?: boolean;
  reason?: DirectSessionMessageFailureReason;
  error?: string;
}

export interface RuntimeWhatsAppControlResponse {
  ok: boolean;
  status: WhatsAppDaemonStatus;
  pid?: number;
  managedByControlSurface?: boolean;
  requiresManualAuth?: boolean;
}

export type RuntimeWhatsAppStartResponse = RuntimeWhatsAppControlResponse;
export type RuntimeWhatsAppStopResponse = RuntimeWhatsAppControlResponse;

export interface SkillListItem {
  name: string;
  description: string;
  disableModelInvocation: boolean;
}

export interface SkillsListResponse {
  items: SkillListItem[];
}

export interface DirectoryCompletionItem {
  name: string;
  kind: "directory" | "file";
  path: string;
  insertText: string;
}

export interface DirectoryCompletionsResponse {
  items: DirectoryCompletionItem[];
  cwd: string;
  query: string;
}

export interface StopResponse {
  ok: boolean;
  message: string;
}

export interface PiSessionInterruptResponse {
  ok: boolean;
  piSessionId?: string;
  signaledSessions?: number;
  error?: string;
}

export type CronTickAction = "enqueued" | "skipped";
export type CronTickReason =
  | "idle_check"
  | "stale_check"
  | "pi_active"
  | "pi_ended"
  | "whatsapp_disconnected"
  | "circuit_breaker"
  | "no_actionable_state";

export interface CronTickResponse {
  ok: true;
  action: CronTickAction;
  reason: CronTickReason;
  flags?: string[];
}

export const CONTROL_SURFACE_ENDPOINTS = {
  status: {
    method: "GET",
    path: "/status",
    auth: "none",
  },
  message: {
    method: "POST",
    path: "/message",
    auth: "bearer",
  },
  hook: {
    method: "POST",
    path: "/hook/:event",
    auth: "bearer",
  },
  sessions: {
    method: "GET",
    path: "/api/sessions",
    auth: "none",
  },
  sessionDetail: {
    method: "GET",
    path: "/api/sessions/:sessionId",
    auth: "none",
  },
  streamsHistory: {
    method: "GET",
    path: "/api/streams/history",
    auth: "none",
  },
  sessionTranscript: {
    method: "GET",
    path: "/api/sessions/:sessionId/transcript",
    auth: "none",
  },
  sessionMessage: {
    method: "POST",
    path: "/sessions/:sessionId/message",
    auth: "bearer",
  },
  runtimeWhatsAppStart: {
    method: "POST",
    path: "/runtime/whatsapp/start",
    auth: "bearer",
  },
  runtimeWhatsAppStop: {
    method: "POST",
    path: "/runtime/whatsapp/stop",
    auth: "bearer",
  },
  skills: {
    method: "GET",
    path: "/api/skills",
    auth: "none",
  },
  models: {
    method: "GET",
    path: "/api/models",
    auth: "none",
  },
  modelsPin: {
    method: "POST",
    path: "/api/models/pin",
    auth: "bearer",
  },
  stop: {
    method: "POST",
    path: "/stop",
    auth: "bearer",
  },
  cronTick: {
    method: "POST",
    path: "/cron/tick",
    auth: "bearer",
  },
  piSessions: {
    method: "GET",
    path: "/api/pi-sessions/:piSessionId/sessions",
    auth: "none",
  },
  piSessionInterrupt: {
    method: "POST",
    path: "/api/pi-sessions/:piSessionId/interrupt",
    auth: "bearer",
  },
  piSessionModel: {
    method: "PUT",
    path: "/api/pi-sessions/:piSessionId/model",
    auth: "bearer",
  },
  directoryCompletions: {
    method: "GET",
    path: "/api/directory-completions",
    auth: "none",
  },
  streamsPrune: {
    method: "POST",
    path: "/api/streams/prune",
    auth: "bearer",
  },
  streamsCompact: {
    method: "POST",
    path: "/api/streams/compact",
    auth: "bearer",
  },
  streamWorkers: {
    method: "GET",
    path: "/api/streams/:streamId/workers",
    auth: "bearer",
  },
} as const;
