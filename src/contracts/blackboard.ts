export const BLACKBOARD_SCHEMA_VERSION = 24;

export type MessageMetadata = {
  router_action?: string;
  stream_id?: string;
  stream_name?: string;
  _targetSessionId?: string;
  serverMessageId?: string;
  [key: string]: unknown;
};

export type StreamRoutingMeta = {
  router_action?: string;
  stream_id?: string;
  stream_name?: string;
  _targetSessionId?: string;
};

export type CountRow = { count: number };

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; name: string; id: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: string };

export interface ApiError extends Error {
  status?: number;
  body?: unknown;
}

export type RawTranscriptEntry = {
  role?: string;
  sender?: string;
  author?: string;
  type?: string;
  kind?: string;
  event_name?: string;
  event?: string;
  text?: string;
  content?: unknown;
  message?: RawTranscriptEntry;
  summary?: string;
  error?: string;
  status?: string;
  tool_status?: string;
  toolStatus?: string;
  timestamp?: string | number;
  created_at?: string | number;
};

export type ActionResolutionPayload = {
  resolvedBy: string;
  deliveryResult?: Record<string, unknown>;
  error?: string;
};

export type ClaudeSessionStatus = "working" | "idle" | "stale" | "ended";
export type PiSessionStatus =
  | "active"
  | "waiting_for_user"
  | "waiting_for_sessions"
  | "ended"
  | "crashed";
export type StreamStatus = "open" | "closed";
export type StreamType = "work" | "defaultStream";
export type WhatsAppMessageDirection = "inbound" | "outbound";
export type WhatsAppMessageStatus = "pending" | "sent" | "delivered" | "failed";
export type PendingActionKind =
  | "whatsapp_auth_expired"
  | "restart_session"
  | "approve_change"
  | "clarify";
export type PendingActionStatus = "pending" | "resolved" | "expired" | "canceled";
export type WorkerHostConnectionMode =
  | "local-stdio"
  | "ssh-stdio"
  | "unix-socket"
  | "websocket-auth";
export type WorkerHostStatus = "unknown" | "ready" | "busy" | "unreachable" | "disabled";
export type WorkerRunnerType = "codex_app_server" | "codex_exec" | "claude_tmux" | "pi";
export type WorkerSessionStatus =
  | "starting"
  | "running"
  | "waiting_for_user"
  | "idle"
  | "completed"
  | "failed"
  | "canceled"
  | "unreachable";
export type WorkerTurnStatus =
  | "queued"
  | "running"
  | "waiting_for_user"
  | "completed"
  | "failed"
  | "canceled";
export type HookEventName = "SessionStart" | "Stop" | "SessionEnd";

export type HookRouteEventName = "session-start" | "stop" | "session-end";

export const ROUTE_EVENT_TO_HOOK_EVENT: Record<HookRouteEventName, HookEventName> = {
  "session-start": "SessionStart",
  stop: "Stop",
  "session-end": "SessionEnd",
};

export interface StreamRow {
  id: string;
  name: string;
  type: StreamType;
  repo_path: string | null;
  worktree_path: string | null;
  status: StreamStatus;
  created_at: string;
  closed_at: string | null;
  base_branch: string | null;
  pinned: number | boolean;
  stream_user: string | null;
}

export interface ClaudeSessionRow {
  session_id: string;
  tmux_session: string | null;
  cwd: string;
  project: string;
  project_label: string | null;
  model: string | null;
  permission_mode: string | null;
  source: string | null;
  status: ClaudeSessionStatus;
  transcript_path: string | null;
  task_description: string | null;
  todoist_task_id: string | null;
  agent_managed: number | boolean | null;
  session_end_reason: string | null;
  stream_id: string | null;
  pi_session_id: string | null;
  started_at: string;
  ended_at: string | null;
  last_event_at: string;
  last_tool_started_at: string | null;
}

export interface WhatsAppMessageRow {
  id: number;
  direction: WhatsAppMessageDirection;
  wa_message_id: string | null;
  remote_jid: string;
  body: string;
  context_ref: string | null;
  status: WhatsAppMessageStatus;
  error_message: string | null;
  created_at: string;
  processed_at: string | null;
}

export type UnifiedMessageSource =
  | "whatsapp"
  | "web"
  | "hook"
  | "cron"
  | "init"
  | "agent"
  | "stream_outbound";
export type UnifiedMessageDirection = "inbound" | "outbound";

export interface MessageRow {
  id: string;
  source: UnifiedMessageSource;
  direction: UnifiedMessageDirection;
  content: string;
  sender: string | null;
  stream_id: string | null;
  pi_session_id: string | null;
  metadata: string | null;
  created_at: string;
}

export interface MessageIdMapRow {
  server_id: string;
  agent_id: string | null;
  pi_session_id: string | null;
  created_at: string;
}

export interface PendingActionRow {
  action_id: string;
  channel: string;
  context_ref: string | null;
  kind: PendingActionKind;
  prompt_text: string;
  related_session_id: string | null;
  related_todoist_task_id: string | null;
  status: PendingActionStatus;
  created_at: string;
  resolved_at: string | null;
  resolution_payload: string | null;
}

export interface HealthFlagRow {
  flag: string;
  reason: string;
  set_at: string;
  expires_at: string | null;
  cleared_at: string | null;
}

export interface UserConfigRow {
  user_id: string;
  key: string;
  value: string;
  updated_at: string;
}

export interface WorkerHostRow {
  host_id: string;
  display_name: string;
  connection_mode: WorkerHostConnectionMode;
  connection_target: string | null;
  projects_root: string | null;
  codex_home: string | null;
  max_concurrent_workers: number;
  status: WorkerHostStatus;
  last_heartbeat_at: string | null;
  capabilities_json: string | null;
  created_at: string;
  updated_at: string;
}

export interface WorkerSessionRow {
  worker_session_id: string;
  runner_type: WorkerRunnerType;
  status: WorkerSessionStatus;
  host_id: string | null;
  stream_id: string | null;
  pi_session_id: string | null;
  legacy_session_id: string | null;
  cwd: string;
  repo_path: string | null;
  worktree_path: string | null;
  branch: string | null;
  model_provider: string | null;
  model_id: string | null;
  external_thread_id: string | null;
  external_session_id: string | null;
  approval_policy: string | null;
  sandbox_policy: string | null;
  started_at: string;
  last_event_at: string;
  completed_at: string | null;
  error_message: string | null;
  metadata_json: string | null;
}

export interface WorkerTurnRow {
  worker_turn_id: string;
  worker_session_id: string;
  external_turn_id: string | null;
  client_message_id: string | null;
  status: WorkerTurnStatus;
  prompt: string | null;
  final_output: string | null;
  started_at: string;
  completed_at: string | null;
  error_message: string | null;
  metadata_json: string | null;
}

export interface WorkerEventRow {
  worker_event_id: string;
  worker_session_id: string;
  worker_turn_id: string | null;
  event_type: string;
  event_source: string;
  payload_json: string;
  created_at: string;
}

export const BLACKBOARD_SCHEMA_SQL = `
PRAGMA journal_mode=WAL;
PRAGMA busy_timeout=5000;
PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at DATETIME NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS streams (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'work' CHECK (type IN ('work', 'defaultStream')),
    repo_path TEXT,
    worktree_path TEXT,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
    created_at DATETIME NOT NULL DEFAULT (datetime('now')),
    closed_at TEXT,
    base_branch TEXT,
    pinned BOOLEAN NOT NULL DEFAULT 0,
    stream_user TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
    session_id TEXT PRIMARY KEY,
    tmux_session TEXT,
    cwd TEXT NOT NULL,
    project TEXT NOT NULL,
    project_label TEXT,
    model TEXT,
    permission_mode TEXT,
    source TEXT,
    status TEXT NOT NULL DEFAULT 'working'
      CHECK (status IN ('working', 'idle', 'stale', 'ended')),
    transcript_path TEXT,
    task_description TEXT,
    todoist_task_id TEXT,
    agent_managed BOOLEAN DEFAULT 0,
    session_end_reason TEXT,
    stream_id TEXT REFERENCES streams(id) ON DELETE SET NULL,
    pi_session_id TEXT REFERENCES pi_sessions(pi_session_id) ON DELETE SET NULL,
    started_at DATETIME NOT NULL,
    ended_at DATETIME,
    last_event_at DATETIME NOT NULL,
    last_tool_started_at DATETIME
);

CREATE TABLE IF NOT EXISTS pi_sessions (
    pi_session_id TEXT PRIMARY KEY,
    role TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active'
      CHECK (status IN ('active', 'waiting_for_user', 'waiting_for_sessions', 'ended', 'crashed')),
    runtime_instance_id TEXT,
    pid INTEGER,
    session_file TEXT,
    cwd TEXT NOT NULL,
    agent_dir TEXT,
    model_provider TEXT,
    model_id TEXT,
    thinking_level TEXT,
    started_at DATETIME NOT NULL,
    last_prompt_at DATETIME,
    last_event_at DATETIME NOT NULL,
    ended_at DATETIME,
    end_reason TEXT,
    stream_id TEXT REFERENCES streams(id) ON DELETE SET NULL,
    last_datetime_reported_at DATETIME,
    session_user TEXT
);

CREATE INDEX IF NOT EXISTS idx_pi_sessions_stream ON pi_sessions(stream_id);

CREATE TABLE IF NOT EXISTS whatsapp_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
    wa_message_id TEXT,
    remote_jid TEXT NOT NULL,
    body TEXT NOT NULL,
    context_ref TEXT,
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK (status IN ('pending', 'sent', 'delivered', 'failed')),
    error_message TEXT,
    created_at DATETIME NOT NULL DEFAULT (datetime('now')),
    processed_at DATETIME
);

CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    source TEXT NOT NULL CHECK (source IN ('whatsapp', 'web', 'hook', 'cron', 'init', 'agent', 'stream_outbound')),
    direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
    content TEXT NOT NULL,
    sender TEXT,
    stream_id TEXT REFERENCES streams(id) ON DELETE SET NULL,
    pi_session_id TEXT REFERENCES pi_sessions(pi_session_id) ON DELETE SET NULL,
    metadata TEXT,
    created_at DATETIME NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS message_id_map (
    server_id TEXT PRIMARY KEY,
    agent_id TEXT,
    pi_session_id TEXT,
    created_at DATETIME NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_message_id_map_agent ON message_id_map(agent_id);

CREATE TABLE IF NOT EXISTS health_flags (
    flag TEXT PRIMARY KEY,
    reason TEXT NOT NULL,
    set_at DATETIME NOT NULL DEFAULT (datetime('now')),
    expires_at DATETIME,
    cleared_at DATETIME
);

CREATE TABLE IF NOT EXISTS pending_actions (
    action_id TEXT PRIMARY KEY,
    channel TEXT NOT NULL,
    context_ref TEXT,
    kind TEXT NOT NULL,
    prompt_text TEXT NOT NULL,
    related_session_id TEXT,
    related_todoist_task_id TEXT,
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK (status IN ('pending', 'resolved', 'expired', 'canceled')),
    created_at DATETIME NOT NULL DEFAULT (datetime('now')),
    resolved_at DATETIME,
    resolution_payload TEXT
);

CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project);
CREATE INDEX IF NOT EXISTS idx_sessions_last_event_at ON sessions(last_event_at);
CREATE INDEX IF NOT EXISTS idx_sessions_stream ON sessions(stream_id);
CREATE INDEX IF NOT EXISTS idx_sessions_pi_session ON sessions(pi_session_id);
CREATE INDEX IF NOT EXISTS idx_streams_name ON streams(name);
CREATE INDEX IF NOT EXISTS idx_pi_sessions_status ON pi_sessions(status);
CREATE INDEX IF NOT EXISTS idx_pi_sessions_role_status ON pi_sessions(role, status);
CREATE INDEX IF NOT EXISTS idx_pi_sessions_last_event_at ON pi_sessions(last_event_at);
CREATE INDEX IF NOT EXISTS idx_whatsapp_status_created ON whatsapp_messages(status, created_at);
CREATE INDEX IF NOT EXISTS idx_pending_actions_status_created ON pending_actions(status, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_source_created ON messages(source, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);
CREATE INDEX IF NOT EXISTS idx_messages_stream ON messages(stream_id);
CREATE INDEX IF NOT EXISTS idx_messages_pi_session ON messages(pi_session_id);

CREATE TABLE IF NOT EXISTS worker_hosts (
    host_id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    connection_mode TEXT NOT NULL
      CHECK (connection_mode IN ('local-stdio', 'ssh-stdio', 'unix-socket', 'websocket-auth')),
    connection_target TEXT,
    projects_root TEXT,
    codex_home TEXT,
    max_concurrent_workers INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'unknown'
      CHECK (status IN ('unknown', 'ready', 'busy', 'unreachable', 'disabled')),
    last_heartbeat_at DATETIME,
    capabilities_json TEXT,
    created_at DATETIME NOT NULL DEFAULT (datetime('now')),
    updated_at DATETIME NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS worker_sessions (
    worker_session_id TEXT PRIMARY KEY,
    runner_type TEXT NOT NULL
      CHECK (runner_type IN ('codex_app_server', 'codex_exec', 'claude_tmux', 'pi')),
    status TEXT NOT NULL DEFAULT 'starting'
      CHECK (status IN ('starting', 'running', 'waiting_for_user', 'idle', 'completed', 'failed', 'canceled', 'unreachable')),
    host_id TEXT REFERENCES worker_hosts(host_id) ON DELETE SET NULL,
    stream_id TEXT REFERENCES streams(id) ON DELETE SET NULL,
    pi_session_id TEXT REFERENCES pi_sessions(pi_session_id) ON DELETE SET NULL,
    legacy_session_id TEXT,
    cwd TEXT NOT NULL,
    repo_path TEXT,
    worktree_path TEXT,
    branch TEXT,
    model_provider TEXT,
    model_id TEXT,
    external_thread_id TEXT,
    external_session_id TEXT,
    approval_policy TEXT,
    sandbox_policy TEXT,
    started_at DATETIME NOT NULL DEFAULT (datetime('now')),
    last_event_at DATETIME NOT NULL DEFAULT (datetime('now')),
    completed_at DATETIME,
    error_message TEXT,
    metadata_json TEXT
);

CREATE TABLE IF NOT EXISTS worker_turns (
    worker_turn_id TEXT PRIMARY KEY,
    worker_session_id TEXT NOT NULL REFERENCES worker_sessions(worker_session_id) ON DELETE CASCADE,
    external_turn_id TEXT,
    client_message_id TEXT,
    status TEXT NOT NULL DEFAULT 'queued'
      CHECK (status IN ('queued', 'running', 'waiting_for_user', 'completed', 'failed', 'canceled')),
    prompt TEXT,
    final_output TEXT,
    started_at DATETIME NOT NULL DEFAULT (datetime('now')),
    completed_at DATETIME,
    error_message TEXT,
    metadata_json TEXT
);

CREATE TABLE IF NOT EXISTS worker_events (
    worker_event_id TEXT PRIMARY KEY,
    worker_session_id TEXT NOT NULL REFERENCES worker_sessions(worker_session_id) ON DELETE CASCADE,
    worker_turn_id TEXT REFERENCES worker_turns(worker_turn_id) ON DELETE SET NULL,
    event_type TEXT NOT NULL,
    event_source TEXT NOT NULL DEFAULT 'runner',
    payload_json TEXT NOT NULL,
    created_at DATETIME NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_worker_hosts_status ON worker_hosts(status);
CREATE INDEX IF NOT EXISTS idx_worker_sessions_status ON worker_sessions(status);
CREATE INDEX IF NOT EXISTS idx_worker_sessions_runner ON worker_sessions(runner_type);
CREATE INDEX IF NOT EXISTS idx_worker_sessions_host ON worker_sessions(host_id);
CREATE INDEX IF NOT EXISTS idx_worker_sessions_stream ON worker_sessions(stream_id);
CREATE INDEX IF NOT EXISTS idx_worker_sessions_pi_session ON worker_sessions(pi_session_id);
CREATE INDEX IF NOT EXISTS idx_worker_sessions_external_thread ON worker_sessions(external_thread_id);
CREATE INDEX IF NOT EXISTS idx_worker_turns_session ON worker_turns(worker_session_id);
CREATE INDEX IF NOT EXISTS idx_worker_turns_status ON worker_turns(status);
CREATE INDEX IF NOT EXISTS idx_worker_turns_external ON worker_turns(external_turn_id);
CREATE INDEX IF NOT EXISTS idx_worker_events_session_created ON worker_events(worker_session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_worker_events_turn_created ON worker_events(worker_turn_id, created_at);

CREATE TABLE IF NOT EXISTS user_config (
    user_id TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    updated_at DATETIME NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, key)
);
`;
