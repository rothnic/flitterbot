import type { DatabaseSync } from "node:sqlite";
import { BLACKBOARD_SCHEMA_SQL, BLACKBOARD_SCHEMA_VERSION } from "../contracts/index.ts";

type MigrationTableRow = { name: string };
type MigrationColumnRow = { name: string };
type MigrationVersionRow = { version: number };
type MigrationCountRow = { count: number };

const LATEST_BLACKBOARD_SCHEMA_VERSION = BLACKBOARD_SCHEMA_VERSION;

function hasTable(db: DatabaseSync, tableName: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(tableName) as MigrationTableRow | undefined;
  return Boolean(row?.name);
}

function hasColumn(db: DatabaseSync, tableName: string, columnName: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${tableName})`).all() as MigrationColumnRow[];
  return rows.some((row) => row.name === columnName);
}

function getSchemaVersion(db: DatabaseSync): number {
  if (!hasTable(db, "schema_migrations")) {
    return 0;
  }
  const row = db
    .prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations")
    .get() as MigrationVersionRow;
  return Number(row.version ?? 0);
}

function hasLegacyMarkers(db: DatabaseSync): boolean {
  if (!hasTable(db, "sessions")) {
    return false;
  }
  // stream_sessions (V16/V17) is not legacy — V18 renames it back to pi_sessions
  if (hasTable(db, "stream_sessions")) {
    return false;
  }
  if (hasTable(db, "agents") || !hasTable(db, "pi_sessions")) {
    return true;
  }
  const row = db
    .prepare("SELECT COUNT(*) AS count FROM sessions WHERE status = 'running'")
    .get() as MigrationCountRow;
  return Number(row.count ?? 0) > 0;
}

function ensureMigrationsTable(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at DATETIME NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

function applyFullSchema(db: DatabaseSync): void {
  db.exec(BLACKBOARD_SCHEMA_SQL);
}

// ponytail: prune old migration branches when legacy DB compatibility is no longer needed.
function applyLegacyUpgrade(db: DatabaseSync): void {
  db.exec("PRAGMA foreign_keys=OFF;");
  db.exec("BEGIN IMMEDIATE;");

  try {
    db.exec(`
      DROP INDEX IF EXISTS idx_sessions_status;
      DROP INDEX IF EXISTS idx_sessions_project;
      DROP INDEX IF EXISTS idx_sessions_last_event_at;
      DROP INDEX IF EXISTS idx_events_session_id;
      DROP INDEX IF EXISTS idx_events_timestamp;
      DROP INDEX IF EXISTS idx_events_session_event;
      DROP INDEX IF EXISTS idx_pi_sessions_status;
      DROP INDEX IF EXISTS idx_pi_sessions_role_status;
      DROP INDEX IF EXISTS idx_pi_sessions_last_event_at;
      DROP INDEX IF EXISTS idx_whatsapp_status_created;
      DROP INDEX IF EXISTS idx_pending_actions_status_created;
    `);

    if (hasTable(db, "events")) {
      db.exec("DROP TABLE events;");
    }
    if (hasTable(db, "events_legacy")) {
      db.exec("DROP TABLE events_legacy;");
    }
    if (hasTable(db, "sessions")) {
      db.exec("ALTER TABLE sessions RENAME TO sessions_legacy;");
    }

    applyFullSchema(db);

    if (hasTable(db, "sessions_legacy")) {
      db.exec(`
        INSERT INTO sessions (
          session_id,
          tmux_session,
          cwd,
          project,
          project_label,
          model,
          permission_mode,
          source,
          status,
          transcript_path,
          task_description,
          todoist_task_id,
          agent_managed,
          session_end_reason,
          started_at,
          ended_at,
          last_event_at,
          last_tool_started_at
        )
        SELECT
          session_id,
          tmux_session,
          COALESCE(NULLIF(cwd, ''), '.') AS cwd,
          COALESCE(NULLIF(project, ''), NULLIF(project_label, ''), COALESCE(NULLIF(cwd, ''), 'unknown')) AS project,
          project_label,
          model,
          permission_mode,
          source,
          CASE
            WHEN status = 'running' THEN 'working'
            WHEN status IN ('working', 'idle', 'stale', 'ended') THEN status
            ELSE 'working'
          END AS status,
          transcript_path,
          task_description,
          todoist_task_id,
          COALESCE(agent_managed, 0),
          session_end_reason,
          COALESCE(started_at, last_event_at, datetime('now')),
          ended_at,
          COALESCE(last_event_at, started_at, datetime('now')),
          last_tool_started_at
        FROM sessions_legacy
      `);
    }

    db.exec(`
      DROP TABLE IF EXISTS sessions_legacy;
      DROP TABLE IF EXISTS agents;
      INSERT OR IGNORE INTO schema_migrations(version) VALUES (3);
    `);

    db.exec("COMMIT;");
  } catch (error) {
    db.exec("ROLLBACK;");
    throw error;
  } finally {
    db.exec("PRAGMA foreign_keys=ON;");
  }
}

function applyV4Migration(db: DatabaseSync): void {
  db.exec("PRAGMA foreign_keys=OFF;");
  db.exec("BEGIN IMMEDIATE;");

  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS workstreams (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          repo_path TEXT,
          worktree_path TEXT,
          created_at DATETIME NOT NULL DEFAULT (datetime('now'))
      );
    `);

    db.exec(
      "ALTER TABLE sessions ADD COLUMN workstream_id TEXT REFERENCES workstreams(id) ON DELETE SET NULL;",
    );

    db.exec(`
      CREATE TABLE pi_sessions_v4 (
          pi_session_id TEXT PRIMARY KEY,
          role TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'active'
            CHECK (status IN ('active', 'idle', 'waiting_for_user', 'waiting_for_sessions', 'ended', 'crashed')),
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
          end_reason TEXT
      );
      INSERT INTO pi_sessions_v4 SELECT * FROM pi_sessions;
      DROP TABLE pi_sessions;
      ALTER TABLE pi_sessions_v4 RENAME TO pi_sessions;

      CREATE INDEX IF NOT EXISTS idx_pi_sessions_status ON pi_sessions(status);
      CREATE INDEX IF NOT EXISTS idx_pi_sessions_role_status ON pi_sessions(role, status);
      CREATE INDEX IF NOT EXISTS idx_pi_sessions_last_event_at ON pi_sessions(last_event_at);
      CREATE INDEX IF NOT EXISTS idx_sessions_workstream ON sessions(workstream_id);
      CREATE INDEX IF NOT EXISTS idx_workstreams_name ON workstreams(name);

      INSERT OR IGNORE INTO schema_migrations(version) VALUES (4);
    `);

    db.exec("COMMIT;");
  } catch (error) {
    db.exec("ROLLBACK;");
    throw error;
  } finally {
    db.exec("PRAGMA foreign_keys=ON;");
  }
}

function applyV5Migration(db: DatabaseSync): void {
  db.exec("PRAGMA foreign_keys=OFF;");
  db.exec("BEGIN IMMEDIATE;");

  try {
    db.exec(
      "ALTER TABLE sessions ADD COLUMN pi_session_id TEXT REFERENCES pi_sessions(pi_session_id) ON DELETE SET NULL;",
    );
    db.exec("CREATE INDEX IF NOT EXISTS idx_sessions_pi_session ON sessions(pi_session_id);");

    db.exec(
      "ALTER TABLE workstreams ADD COLUMN status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed'));",
    );
    db.exec("ALTER TABLE workstreams ADD COLUMN closed_at TEXT;");

    db.exec(`
      CREATE TABLE pi_sessions_v5 (
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
          end_reason TEXT
      );

      INSERT INTO pi_sessions_v5
        SELECT pi_session_id, role,
          CASE WHEN status = 'idle' THEN 'waiting_for_user' ELSE status END,
          runtime_instance_id, pid, session_file, cwd, agent_dir,
          model_provider, model_id, thinking_level,
          started_at, last_prompt_at, last_event_at, ended_at, end_reason
        FROM pi_sessions;

      DROP TABLE pi_sessions;
      ALTER TABLE pi_sessions_v5 RENAME TO pi_sessions;

      CREATE INDEX IF NOT EXISTS idx_pi_sessions_status ON pi_sessions(status);
      CREATE INDEX IF NOT EXISTS idx_pi_sessions_role_status ON pi_sessions(role, status);
      CREATE INDEX IF NOT EXISTS idx_pi_sessions_last_event_at ON pi_sessions(last_event_at);

      INSERT OR IGNORE INTO schema_migrations(version) VALUES (5);
    `);

    db.exec("COMMIT;");
  } catch (error) {
    db.exec("ROLLBACK;");
    throw error;
  } finally {
    db.exec("PRAGMA foreign_keys=ON;");
  }
}

function applyV6Migration(db: DatabaseSync): void {
  db.exec("BEGIN IMMEDIATE;");

  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          source TEXT NOT NULL CHECK (source IN ('whatsapp', 'web', 'hook', 'cron', 'init', 'pi_outbound')),
          direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
          content TEXT NOT NULL,
          sender TEXT,
          workstream_id TEXT REFERENCES workstreams(id) ON DELETE SET NULL,
          metadata TEXT,
          created_at DATETIME NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_messages_source_created ON messages(source, created_at);
      CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);
      CREATE INDEX IF NOT EXISTS idx_messages_workstream ON messages(workstream_id);

      INSERT OR IGNORE INTO schema_migrations(version) VALUES (6);
    `);

    db.exec("COMMIT;");
  } catch (error) {
    db.exec("ROLLBACK;");
    throw error;
  }
}

function applyV7Migration(db: DatabaseSync): void {
  db.exec("BEGIN IMMEDIATE;");

  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS health_flags (
          flag TEXT PRIMARY KEY,
          reason TEXT NOT NULL,
          set_at DATETIME NOT NULL DEFAULT (datetime('now')),
          expires_at DATETIME,
          cleared_at DATETIME
      );

      INSERT OR IGNORE INTO schema_migrations(version) VALUES (7);
    `);

    db.exec("COMMIT;");
  } catch (error) {
    db.exec("ROLLBACK;");
    throw error;
  }
}

function applyV8Migration(db: DatabaseSync): void {
  // No-op recreation — 'init' already in V6's CHECK; kept for migration-chain continuity
  db.exec("PRAGMA foreign_keys=OFF;");
  db.exec("BEGIN IMMEDIATE;");

  try {
    db.exec(`
      CREATE TABLE messages_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          source TEXT NOT NULL CHECK (source IN ('whatsapp', 'web', 'hook', 'cron', 'init', 'pi_outbound')),
          direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
          content TEXT NOT NULL,
          sender TEXT,
          workstream_id TEXT REFERENCES workstreams(id) ON DELETE SET NULL,
          metadata TEXT,
          created_at DATETIME NOT NULL DEFAULT (datetime('now'))
      );

      INSERT INTO messages_new SELECT * FROM messages;
      DROP TABLE messages;
      ALTER TABLE messages_new RENAME TO messages;

      CREATE INDEX IF NOT EXISTS idx_messages_source_created ON messages(source, created_at);
      CREATE INDEX IF NOT EXISTS idx_messages_workstream ON messages(workstream_id);

      INSERT OR IGNORE INTO schema_migrations(version) VALUES (8);
    `);

    db.exec("COMMIT;");
  } catch (error) {
    db.exec("ROLLBACK;");
    throw error;
  }
  db.exec("PRAGMA foreign_keys=ON;");
}

function applyV9Migration(db: DatabaseSync): void {
  db.exec("BEGIN IMMEDIATE;");

  try {
    db.exec(`
      ALTER TABLE pi_sessions ADD COLUMN workstream_id TEXT REFERENCES workstreams(id) ON DELETE SET NULL;
      CREATE INDEX IF NOT EXISTS idx_pi_sessions_workstream ON pi_sessions(workstream_id);

      INSERT OR IGNORE INTO schema_migrations(version) VALUES (9);
    `);

    db.exec("COMMIT;");
  } catch (error) {
    db.exec("ROLLBACK;");
    throw error;
  }
}

function applyV10Migration(db: DatabaseSync): void {
  // SQLite can't DROP COLUMN (pre-3.35) or ALTER CHECK, so both tables are recreated
  db.exec("PRAGMA foreign_keys=OFF;");
  db.exec("BEGIN IMMEDIATE;");

  try {
    db.exec(`
      CREATE TABLE sessions_v10 (
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
          workstream_id TEXT REFERENCES workstreams(id) ON DELETE SET NULL,
          pi_session_id TEXT REFERENCES pi_sessions(pi_session_id) ON DELETE SET NULL,
          started_at DATETIME NOT NULL,
          ended_at DATETIME,
          last_event_at DATETIME NOT NULL,
          last_tool_started_at DATETIME
      );

      INSERT INTO sessions_v10
        SELECT session_id, tmux_session, cwd, project, project_label,
               model, permission_mode, source, status, transcript_path,
               task_description, todoist_task_id, agent_managed, session_end_reason,
               workstream_id, pi_session_id, started_at, ended_at,
               last_event_at, last_tool_started_at
        FROM sessions;

      DROP TABLE sessions;
      ALTER TABLE sessions_v10 RENAME TO sessions;

      CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
      CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project);
      CREATE INDEX IF NOT EXISTS idx_sessions_last_event_at ON sessions(last_event_at);
      CREATE INDEX IF NOT EXISTS idx_sessions_workstream ON sessions(workstream_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_pi_session ON sessions(pi_session_id);
    `);

    db.exec(`
      CREATE TABLE whatsapp_messages_v10 (
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

      INSERT INTO whatsapp_messages_v10
        SELECT * FROM whatsapp_messages WHERE status != 'processed';

      DROP TABLE whatsapp_messages;
      ALTER TABLE whatsapp_messages_v10 RENAME TO whatsapp_messages;

      CREATE INDEX IF NOT EXISTS idx_whatsapp_status_created ON whatsapp_messages(status, created_at);

      INSERT OR IGNORE INTO schema_migrations(version) VALUES (10);
    `);

    db.exec("COMMIT;");
  } catch (error) {
    db.exec("ROLLBACK;");
    throw error;
  } finally {
    db.exec("PRAGMA foreign_keys=ON;");
  }
}

// SQLite CHECK constraints are part of the table definition, so the table is recreated
function applyV11Migration(db: DatabaseSync): void {
  db.exec("PRAGMA foreign_keys=OFF;");
  db.exec("BEGIN IMMEDIATE;");

  try {
    db.exec(`
      CREATE TABLE messages_v11 (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          source TEXT NOT NULL CHECK (source IN ('whatsapp', 'web', 'hook', 'cron', 'init', 'agent', 'pi_outbound')),
          direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
          content TEXT NOT NULL,
          sender TEXT,
          workstream_id TEXT REFERENCES workstreams(id) ON DELETE SET NULL,
          metadata TEXT,
          created_at DATETIME NOT NULL DEFAULT (datetime('now'))
      );

      INSERT INTO messages_v11 SELECT * FROM messages;

      DROP TABLE messages;
      ALTER TABLE messages_v11 RENAME TO messages;

      CREATE INDEX IF NOT EXISTS idx_messages_source_created ON messages(source, created_at);
      CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);
      CREATE INDEX IF NOT EXISTS idx_messages_workstream ON messages(workstream_id);

      INSERT OR IGNORE INTO schema_migrations(version) VALUES (11);
    `);

    db.exec("COMMIT;");
  } catch (error) {
    db.exec("ROLLBACK;");
    throw error;
  } finally {
    db.exec("PRAGMA foreign_keys=ON;");
  }
}

function applyV12Migration(db: DatabaseSync): void {
  db.exec("PRAGMA foreign_keys=OFF;");
  db.exec("BEGIN IMMEDIATE;");

  try {
    db.exec(`
      CREATE TABLE messages_v12 (
          id TEXT PRIMARY KEY,
          source TEXT NOT NULL CHECK (source IN ('whatsapp', 'web', 'hook', 'cron', 'init', 'agent', 'pi_outbound')),
          direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
          content TEXT NOT NULL,
          sender TEXT,
          workstream_id TEXT REFERENCES workstreams(id) ON DELETE SET NULL,
          metadata TEXT,
          created_at DATETIME NOT NULL DEFAULT (datetime('now'))
      );

      INSERT INTO messages_v12 (id, source, direction, content, sender, workstream_id, metadata, created_at)
        SELECT CAST(id AS TEXT), source, direction, content, sender, workstream_id, metadata, created_at
        FROM messages;

      DROP TABLE messages;
      ALTER TABLE messages_v12 RENAME TO messages;

      CREATE INDEX IF NOT EXISTS idx_messages_source_created ON messages(source, created_at);
      CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);
      CREATE INDEX IF NOT EXISTS idx_messages_workstream ON messages(workstream_id);

      -- Message ID mapping table
      CREATE TABLE IF NOT EXISTS message_id_map (
          server_id TEXT PRIMARY KEY,
          agent_id TEXT,
          pi_session_id TEXT,
          created_at DATETIME NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_message_id_map_agent ON message_id_map(agent_id);

      INSERT OR IGNORE INTO schema_migrations(version) VALUES (12);
    `);

    db.exec("COMMIT;");
  } catch (error) {
    db.exec("ROLLBACK;");
    throw error;
  } finally {
    db.exec("PRAGMA foreign_keys=ON;");
  }
}

function applyV13Migration(db: DatabaseSync): void {
  db.exec("BEGIN IMMEDIATE;");

  try {
    db.exec(`
      ALTER TABLE messages ADD COLUMN pi_session_id TEXT REFERENCES pi_sessions(pi_session_id) ON DELETE SET NULL;
      CREATE INDEX IF NOT EXISTS idx_messages_pi_session ON messages(pi_session_id);

      INSERT OR IGNORE INTO schema_migrations(version) VALUES (13);
    `);

    db.exec("COMMIT;");
  } catch (error) {
    db.exec("ROLLBACK;");
    throw error;
  }
}

function applyV14Migration(db: DatabaseSync): void {
  db.exec("BEGIN IMMEDIATE;");

  try {
    db.exec(`
      ALTER TABLE pi_sessions ADD COLUMN last_datetime_reported_at DATETIME;

      INSERT OR IGNORE INTO schema_migrations(version) VALUES (14);
    `);

    db.exec("COMMIT;");
  } catch (error) {
    db.exec("ROLLBACK;");
    throw error;
  }
}

function applyV15Migration(db: DatabaseSync): void {
  db.exec("PRAGMA foreign_keys=OFF;");
  db.exec("BEGIN IMMEDIATE;");

  try {
    db.exec(`ALTER TABLE workstreams RENAME TO streams;`);

    db.exec(`
      CREATE TABLE sessions_v15 (
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

      INSERT INTO sessions_v15
        SELECT session_id, tmux_session, cwd, project, project_label,
               model, permission_mode, source, status, transcript_path,
               task_description, todoist_task_id, agent_managed, session_end_reason,
               workstream_id, pi_session_id, started_at, ended_at,
               last_event_at, last_tool_started_at
        FROM sessions;

      DROP TABLE sessions;
      ALTER TABLE sessions_v15 RENAME TO sessions;

      CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
      CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project);
      CREATE INDEX IF NOT EXISTS idx_sessions_last_event_at ON sessions(last_event_at);
      CREATE INDEX IF NOT EXISTS idx_sessions_stream ON sessions(stream_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_pi_session ON sessions(pi_session_id);
    `);

    db.exec(`
      CREATE TABLE pi_sessions_v15 (
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
          last_datetime_reported_at DATETIME
      );

      INSERT INTO pi_sessions_v15
        SELECT pi_session_id, role, status, runtime_instance_id, pid, session_file,
               cwd, agent_dir, model_provider, model_id, thinking_level,
               started_at, last_prompt_at, last_event_at, ended_at, end_reason,
               workstream_id, last_datetime_reported_at
        FROM pi_sessions;

      DROP TABLE pi_sessions;
      ALTER TABLE pi_sessions_v15 RENAME TO pi_sessions;

      CREATE INDEX IF NOT EXISTS idx_pi_sessions_status ON pi_sessions(status);
      CREATE INDEX IF NOT EXISTS idx_pi_sessions_role_status ON pi_sessions(role, status);
      CREATE INDEX IF NOT EXISTS idx_pi_sessions_last_event_at ON pi_sessions(last_event_at);
      CREATE INDEX IF NOT EXISTS idx_pi_sessions_stream ON pi_sessions(stream_id);
    `);

    db.exec(`
      CREATE TABLE messages_v15 (
          id TEXT PRIMARY KEY,
          source TEXT NOT NULL CHECK (source IN ('whatsapp', 'web', 'hook', 'cron', 'init', 'agent', 'pi_outbound')),
          direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
          content TEXT NOT NULL,
          sender TEXT,
          stream_id TEXT REFERENCES streams(id) ON DELETE SET NULL,
          pi_session_id TEXT REFERENCES pi_sessions(pi_session_id) ON DELETE SET NULL,
          metadata TEXT,
          created_at DATETIME NOT NULL DEFAULT (datetime('now'))
      );

      INSERT INTO messages_v15 (id, source, direction, content, sender, stream_id, pi_session_id, metadata, created_at)
        SELECT id, source, direction, content, sender, workstream_id, pi_session_id, metadata, created_at
        FROM messages;

      DROP TABLE messages;
      ALTER TABLE messages_v15 RENAME TO messages;

      CREATE INDEX IF NOT EXISTS idx_messages_source_created ON messages(source, created_at);
      CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);
      CREATE INDEX IF NOT EXISTS idx_messages_stream ON messages(stream_id);
      CREATE INDEX IF NOT EXISTS idx_messages_pi_session ON messages(pi_session_id);

      -- Rename workstreams index
      DROP INDEX IF EXISTS idx_workstreams_name;
      CREATE INDEX IF NOT EXISTS idx_streams_name ON streams(name);

      INSERT OR IGNORE INTO schema_migrations(version) VALUES (15);
    `);

    db.exec("COMMIT;");
  } catch (error) {
    db.exec("ROLLBACK;");
    throw error;
  } finally {
    db.exec("PRAGMA foreign_keys=ON;");
  }
}

export function migrateBlackboard(db: DatabaseSync): number {
  ensureMigrationsTable(db);

  let version = getSchemaVersion(db);
  if (version === 0) {
    applyFullSchema(db);
    db.prepare("INSERT OR IGNORE INTO schema_migrations(version) VALUES (?)").run(
      LATEST_BLACKBOARD_SCHEMA_VERSION,
    );
    return LATEST_BLACKBOARD_SCHEMA_VERSION;
  }

  if (hasLegacyMarkers(db)) {
    applyLegacyUpgrade(db);
    version = getSchemaVersion(db);
  }

  if (version < 4) {
    applyV4Migration(db);
    version = getSchemaVersion(db);
  }

  if (version < 5) {
    applyV5Migration(db);
    version = getSchemaVersion(db);
  }

  if (version < 6) {
    applyV6Migration(db);
    version = getSchemaVersion(db);
  }

  if (version < 7) {
    applyV7Migration(db);
    version = getSchemaVersion(db);
  }

  if (version < 8) {
    applyV8Migration(db);
    version = getSchemaVersion(db);
  }

  if (version < 9) {
    applyV9Migration(db);
    version = getSchemaVersion(db);
  }

  if (version < 10) {
    applyV10Migration(db);
    version = getSchemaVersion(db);
  }

  if (version < 11) {
    applyV11Migration(db);
    version = getSchemaVersion(db);
  }

  if (version < 12) {
    applyV12Migration(db);
    version = getSchemaVersion(db);
  }

  if (version < 13) {
    applyV13Migration(db);
    version = getSchemaVersion(db);
  }

  if (version < 14) {
    applyV14Migration(db);
    version = getSchemaVersion(db);
  }

  if (version < 15) {
    applyV15Migration(db);
    version = getSchemaVersion(db);
  }

  if (version < 16) {
    applyV16Migration(db);
    version = getSchemaVersion(db);
  }

  if (version < 17) {
    applyV17Migration(db);
    version = getSchemaVersion(db);
  }

  if (version < 18) {
    applyV18Migration(db);
    version = getSchemaVersion(db);
  }

  if (version < 19) {
    applyV19Migration(db);
    version = getSchemaVersion(db);
  }

  if (version < 20) {
    applyV20Migration(db);
    version = getSchemaVersion(db);
  }

  if (version < 21) {
    applyV21Migration(db);
    version = getSchemaVersion(db);
  }

  if (version < 22) {
    applyV22Migration(db);
  }
  if (version < 23) {
    applyV23Migration(db);
  }
  if (version < 24) {
    applyV24Migration(db);
  }

  ensureCurrentSchemaInvariants(db);
  return getSchemaVersion(db);
}

function ensureCurrentSchemaInvariants(db: DatabaseSync): void {
  if (!hasTable(db, "streams")) {
    return;
  }

  db.exec("BEGIN IMMEDIATE;");
  try {
    ensureStreamsTypeColumn(db);
    createWorkerTables(db);
    db.exec("UPDATE streams SET type = 'defaultStream' WHERE name LIKE 'flitterbot:%';");
    db.exec("COMMIT;");
  } catch (error) {
    db.exec("ROLLBACK;");
    throw error;
  }
}

function applyV16Migration(db: DatabaseSync): void {
  db.exec("PRAGMA foreign_keys=OFF;");
  db.exec("BEGIN IMMEDIATE;");

  try {
    db.exec(`
      CREATE TABLE stream_sessions (
          stream_session_id TEXT PRIMARY KEY,
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
          last_datetime_reported_at DATETIME
      );

      INSERT INTO stream_sessions
        SELECT pi_session_id, role, status, runtime_instance_id, pid, session_file,
               cwd, agent_dir, model_provider, model_id, thinking_level,
               started_at, last_prompt_at, last_event_at, ended_at, end_reason,
               stream_id, last_datetime_reported_at
        FROM pi_sessions;

      DROP TABLE pi_sessions;

      CREATE INDEX IF NOT EXISTS idx_stream_sessions_status ON stream_sessions(status);
      CREATE INDEX IF NOT EXISTS idx_stream_sessions_role_status ON stream_sessions(role, status);
      CREATE INDEX IF NOT EXISTS idx_stream_sessions_last_event_at ON stream_sessions(last_event_at);
      CREATE INDEX IF NOT EXISTS idx_stream_sessions_stream ON stream_sessions(stream_id);
    `);

    db.exec(`
      CREATE TABLE sessions_v16 (
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
          stream_session_id TEXT REFERENCES stream_sessions(stream_session_id) ON DELETE SET NULL,
          started_at DATETIME NOT NULL,
          ended_at DATETIME,
          last_event_at DATETIME NOT NULL,
          last_tool_started_at DATETIME
      );

      INSERT INTO sessions_v16
        SELECT session_id, tmux_session, cwd, project, project_label,
               model, permission_mode, source, status, transcript_path,
               task_description, todoist_task_id, agent_managed, session_end_reason,
               stream_id, pi_session_id, started_at, ended_at,
               last_event_at, last_tool_started_at
        FROM sessions;

      DROP TABLE sessions;
      ALTER TABLE sessions_v16 RENAME TO sessions;

      CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
      CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project);
      CREATE INDEX IF NOT EXISTS idx_sessions_last_event_at ON sessions(last_event_at);
      CREATE INDEX IF NOT EXISTS idx_sessions_stream ON sessions(stream_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_stream_session ON sessions(stream_session_id);
    `);

    db.exec(`
      CREATE TABLE messages_v16 (
          id TEXT PRIMARY KEY,
          source TEXT NOT NULL CHECK (source IN ('whatsapp', 'web', 'hook', 'cron', 'init', 'agent', 'pi_outbound')),
          direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
          content TEXT NOT NULL,
          sender TEXT,
          stream_id TEXT REFERENCES streams(id) ON DELETE SET NULL,
          stream_session_id TEXT REFERENCES stream_sessions(stream_session_id) ON DELETE SET NULL,
          metadata TEXT,
          created_at DATETIME NOT NULL DEFAULT (datetime('now'))
      );

      INSERT INTO messages_v16
        SELECT id, source, direction, content, sender, stream_id,
               pi_session_id, metadata, created_at
        FROM messages;

      DROP TABLE messages;
      ALTER TABLE messages_v16 RENAME TO messages;

      CREATE INDEX IF NOT EXISTS idx_messages_source_created ON messages(source, created_at);
      CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);
      CREATE INDEX IF NOT EXISTS idx_messages_stream ON messages(stream_id);
      CREATE INDEX IF NOT EXISTS idx_messages_stream_session ON messages(stream_session_id);
    `);

    db.exec(`
      CREATE TABLE message_id_map_v16 (
          server_id TEXT PRIMARY KEY,
          agent_id TEXT,
          stream_session_id TEXT,
          created_at DATETIME NOT NULL DEFAULT (datetime('now'))
      );

      INSERT INTO message_id_map_v16
        SELECT server_id, agent_id, pi_session_id, created_at
        FROM message_id_map;

      DROP TABLE message_id_map;
      ALTER TABLE message_id_map_v16 RENAME TO message_id_map;

      CREATE INDEX IF NOT EXISTS idx_message_id_map_agent ON message_id_map(agent_id);
    `);

    db.exec(`INSERT OR IGNORE INTO schema_migrations(version) VALUES (16);`);
    db.exec("COMMIT;");
  } catch (error) {
    db.exec("ROLLBACK;");
    throw error;
  } finally {
    db.exec("PRAGMA foreign_keys=ON;");
  }
}

function applyV17Migration(db: DatabaseSync): void {
  db.exec("PRAGMA foreign_keys=OFF;");
  db.exec("BEGIN IMMEDIATE;");

  try {
    // transform pi_outbound → stream_outbound on INSERT; old CHECK rejects an in-place UPDATE
    db.exec(`
      CREATE TABLE messages_v17 (
          id TEXT PRIMARY KEY,
          source TEXT NOT NULL CHECK (source IN ('whatsapp', 'web', 'hook', 'cron', 'init', 'agent', 'stream_outbound')),
          direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
          content TEXT NOT NULL,
          sender TEXT,
          stream_id TEXT REFERENCES streams(id) ON DELETE SET NULL,
          stream_session_id TEXT REFERENCES stream_sessions(stream_session_id) ON DELETE SET NULL,
          metadata TEXT,
          created_at DATETIME NOT NULL DEFAULT (datetime('now'))
      );

      INSERT INTO messages_v17
        SELECT id,
               CASE WHEN source = 'pi_outbound' THEN 'stream_outbound' ELSE source END,
               direction, content, sender, stream_id,
               stream_session_id, metadata, created_at
        FROM messages;

      DROP TABLE messages;
      ALTER TABLE messages_v17 RENAME TO messages;

      CREATE INDEX IF NOT EXISTS idx_messages_source_created ON messages(source, created_at);
      CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);
      CREATE INDEX IF NOT EXISTS idx_messages_stream ON messages(stream_id);
      CREATE INDEX IF NOT EXISTS idx_messages_stream_session ON messages(stream_session_id);
    `);

    db.exec(`INSERT OR IGNORE INTO schema_migrations(version) VALUES (17);`);
    db.exec("COMMIT;");
  } catch (error) {
    db.exec("ROLLBACK;");
    throw error;
  } finally {
    db.exec("PRAGMA foreign_keys=ON;");
  }
}

function applyV18Migration(db: DatabaseSync): void {
  db.exec("PRAGMA foreign_keys=OFF;");
  db.exec("BEGIN IMMEDIATE;");

  try {
    db.exec(`
      CREATE TABLE pi_sessions (
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
          last_datetime_reported_at DATETIME
      );

      INSERT INTO pi_sessions
        SELECT stream_session_id, role, status, runtime_instance_id, pid, session_file,
               cwd, agent_dir, model_provider, model_id, thinking_level,
               started_at, last_prompt_at, last_event_at, ended_at, end_reason,
               stream_id, last_datetime_reported_at
        FROM stream_sessions;

      DROP TABLE stream_sessions;

      CREATE INDEX IF NOT EXISTS idx_pi_sessions_status ON pi_sessions(status);
      CREATE INDEX IF NOT EXISTS idx_pi_sessions_role_status ON pi_sessions(role, status);
      CREATE INDEX IF NOT EXISTS idx_pi_sessions_last_event_at ON pi_sessions(last_event_at);
      CREATE INDEX IF NOT EXISTS idx_pi_sessions_stream ON pi_sessions(stream_id);
    `);

    db.exec(`
      CREATE TABLE sessions_v18 (
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

      INSERT INTO sessions_v18
        SELECT session_id, tmux_session, cwd, project, project_label,
               model, permission_mode, source, status, transcript_path,
               task_description, todoist_task_id, agent_managed, session_end_reason,
               stream_id, stream_session_id, started_at, ended_at,
               last_event_at, last_tool_started_at
        FROM sessions;

      DROP TABLE sessions;
      ALTER TABLE sessions_v18 RENAME TO sessions;

      CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
      CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project);
      CREATE INDEX IF NOT EXISTS idx_sessions_last_event_at ON sessions(last_event_at);
      CREATE INDEX IF NOT EXISTS idx_sessions_stream ON sessions(stream_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_pi_session ON sessions(pi_session_id);
    `);

    db.exec(`
      CREATE TABLE messages_v18 (
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

      INSERT INTO messages_v18
        SELECT id, source, direction, content, sender, stream_id,
               stream_session_id, metadata, created_at
        FROM messages;

      DROP TABLE messages;
      ALTER TABLE messages_v18 RENAME TO messages;

      CREATE INDEX IF NOT EXISTS idx_messages_source_created ON messages(source, created_at);
      CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);
      CREATE INDEX IF NOT EXISTS idx_messages_stream ON messages(stream_id);
      CREATE INDEX IF NOT EXISTS idx_messages_pi_session ON messages(pi_session_id);
    `);

    db.exec(`
      CREATE TABLE message_id_map_v18 (
          server_id TEXT PRIMARY KEY,
          agent_id TEXT,
          pi_session_id TEXT,
          created_at DATETIME NOT NULL DEFAULT (datetime('now'))
      );

      INSERT INTO message_id_map_v18
        SELECT server_id, agent_id, stream_session_id, created_at
        FROM message_id_map;

      DROP TABLE message_id_map;
      ALTER TABLE message_id_map_v18 RENAME TO message_id_map;

      CREATE INDEX IF NOT EXISTS idx_message_id_map_agent ON message_id_map(agent_id);
    `);

    db.exec(`INSERT OR IGNORE INTO schema_migrations(version) VALUES (18);`);
    db.exec("COMMIT;");
  } catch (error) {
    db.exec("ROLLBACK;");
    throw error;
  } finally {
    db.exec("PRAGMA foreign_keys=ON;");
  }
}

function applyV19Migration(db: DatabaseSync): void {
  db.exec("BEGIN IMMEDIATE;");

  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS user_config (
          user_id TEXT NOT NULL,
          key TEXT NOT NULL,
          value TEXT NOT NULL,
          updated_at DATETIME NOT NULL DEFAULT (datetime('now')),
          PRIMARY KEY (user_id, key)
      );

      INSERT OR IGNORE INTO schema_migrations(version) VALUES (19);
    `);

    db.exec("COMMIT;");
  } catch (error) {
    db.exec("ROLLBACK;");
    throw error;
  }
}

function applyV20Migration(db: DatabaseSync): void {
  db.exec("BEGIN IMMEDIATE;");

  try {
    db.exec("ALTER TABLE streams ADD COLUMN base_branch TEXT;");
    db.exec("INSERT OR IGNORE INTO schema_migrations(version) VALUES (20);");
    db.exec("COMMIT;");
  } catch (error) {
    db.exec("ROLLBACK;");
    throw error;
  }
}

function applyV21Migration(db: DatabaseSync): void {
  db.exec("BEGIN IMMEDIATE;");

  try {
    db.exec("ALTER TABLE streams ADD COLUMN pinned BOOLEAN NOT NULL DEFAULT 0;");
    db.exec("INSERT OR IGNORE INTO schema_migrations(version) VALUES (21);");
    db.exec("COMMIT;");
  } catch (error) {
    db.exec("ROLLBACK;");
    throw error;
  }
}

function applyV22Migration(db: DatabaseSync): void {
  db.exec("BEGIN IMMEDIATE;");

  try {
    ensureStreamsTypeColumn(db);
    db.exec("UPDATE streams SET type = 'defaultStream' WHERE name LIKE 'flitterbot:%';");
    db.exec("INSERT OR IGNORE INTO schema_migrations(version) VALUES (22);");
    db.exec("COMMIT;");
  } catch (error) {
    db.exec("ROLLBACK;");
    throw error;
  }
}

function ensureStreamsTypeColumn(db: DatabaseSync): void {
  if (hasColumn(db, "streams", "type")) {
    return;
  }
  db.exec(
    "ALTER TABLE streams ADD COLUMN type TEXT NOT NULL DEFAULT 'work' CHECK (type IN ('work', 'defaultStream'));",
  );
}

function applyV23Migration(db: DatabaseSync): void {
  db.exec("BEGIN IMMEDIATE;");

  try {
    if (!hasColumn(db, "streams", "stream_user")) {
      db.exec("ALTER TABLE streams ADD COLUMN stream_user TEXT;");
    }
    if (!hasColumn(db, "pi_sessions", "session_user")) {
      db.exec("ALTER TABLE pi_sessions ADD COLUMN session_user TEXT;");
    }
    // Backfill owner for per-user default streams from their `flitterbot: <userId>` name.
    db.exec(
      "UPDATE streams SET stream_user = TRIM(SUBSTR(name, LENGTH('flitterbot: ') + 1)) WHERE name LIKE 'flitterbot: %' AND stream_user IS NULL;",
    );
    // Trickle owner down to each stream's pi_sessions (1:1 stream↔session).
    db.exec(
      "UPDATE pi_sessions SET session_user = (SELECT stream_user FROM streams WHERE streams.id = pi_sessions.stream_id) WHERE session_user IS NULL AND stream_id IS NOT NULL;",
    );
    db.exec("INSERT OR IGNORE INTO schema_migrations(version) VALUES (23);");
    db.exec("COMMIT;");
  } catch (error) {
    db.exec("ROLLBACK;");
    throw error;
  }
}

function applyV24Migration(db: DatabaseSync): void {
  db.exec("BEGIN IMMEDIATE;");

  try {
    createWorkerTables(db);
    db.exec("INSERT OR IGNORE INTO schema_migrations(version) VALUES (24);");
    db.exec("COMMIT;");
  } catch (error) {
    db.exec("ROLLBACK;");
    throw error;
  }
}

function createWorkerTables(db: DatabaseSync): void {
  db.exec(`
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
  `);
}
