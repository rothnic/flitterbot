import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import type { BlackboardDatabase } from "../blackboard/db.ts";
import {
  getWorkerHost,
  getWorkerHostActiveSessionCount,
  listWorkerHosts,
  updateWorkerHostStatus,
  upsertWorkerHost,
} from "../blackboard/query-workers.ts";
import type { FlitterbotConfig, WorkerHostConfig } from "../config/load-config.ts";
import type { WorkerHostRow, WorkerHostStatus } from "../contracts/index.ts";

export type WorkerHostCheckResult = {
  hostId: string;
  displayName: string;
  connectionMode: WorkerHostConfig["connectionMode"];
  connectionTarget?: string;
  status: WorkerHostStatus;
  codexVersion?: string;
  authStatus?: string;
  error?: string;
};

export type WorkerHostSelection = {
  host: WorkerHostConfig;
  activeSessions: number;
  reservedSessions: number;
  maxConcurrentWorkers: number;
  reason: "explicit" | "local-default" | "remote-auto";
};

export type WorkerHostSelectionOptions = {
  requestedHostId?: string;
  reservedSessionCounts?: ReadonlyMap<string, number> | Record<string, number>;
  remoteHeartbeatMaxAgeMs?: number;
};

const DEFAULT_REMOTE_HEARTBEAT_MAX_AGE_MS = 10 * 60 * 1000;

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function remoteShellValue(value: string): string {
  if (value === "~") return '"$HOME"';
  if (value.startsWith("~/")) return `"${"$HOME"}/${value.slice(2).replaceAll('"', '\\"')}"`;
  return shellQuote(value);
}

function runShell(script: string, options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): string {
  return execFileSync("sh", ["-lc", script], {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function runSshShell(target: string, script: string): string {
  return execFileSync("ssh", [target, "sh", "-lc", shellQuote(script)], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function checkScript(codexHome?: string): string {
  const envPrefix = codexHome ? `export CODEX_HOME=${remoteShellValue(codexHome)}\n` : "";
  return `${envPrefix}command -v codex >/dev/null
codex --version
codex login status`;
}

function parseCodexCheckOutput(output: string): { codexVersion?: string; authStatus?: string } {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return {
    codexVersion: lines[0],
    authStatus: lines.slice(1).join("\n") || undefined,
  };
}

export function syncConfiguredWorkerHosts(
  db: BlackboardDatabase,
  config: Pick<FlitterbotConfig, "workerHosts">,
): WorkerHostRow[] {
  for (const host of config.workerHosts) {
    upsertWorkerHost(db, {
      hostId: host.id,
      displayName: host.displayName,
      connectionMode: host.connectionMode,
      connectionTarget: host.connectionTarget,
      projectsRoot: host.projectsRoot,
      codexHome: host.codexHome,
      maxConcurrentWorkers: host.maxConcurrentWorkers,
      status: "unknown",
      capabilities: {
        ...host.capabilities,
        controllerPlatform: process.platform,
        controllerArch: process.arch,
        controllerHostname: os.hostname(),
      },
    });
  }
  return listWorkerHosts(db);
}

function isRemoteAutoSelectable(host: WorkerHostConfig): boolean {
  return host.capabilities.autoSelect === true || host.capabilities.scheduler === "auto";
}

function isSchedulingEligible(row: WorkerHostRow | null): boolean {
  return !row || row.status === "ready" || row.status === "unknown" || row.status === "busy";
}

function reservedSessionCount(
  reserved: WorkerHostSelectionOptions["reservedSessionCounts"],
  hostId: string,
): number {
  if (!reserved) return 0;
  const maybeMap = reserved as ReadonlyMap<string, number>;
  if (typeof maybeMap.get === "function") return maybeMap.get(hostId) ?? 0;
  return (reserved as Record<string, number>)[hostId] ?? 0;
}

function isFreshHeartbeat(row: WorkerHostRow, nowMs: number, maxAgeMs: number): boolean {
  if (!row.last_heartbeat_at) return false;
  const heartbeatMs = Date.parse(row.last_heartbeat_at);
  return Number.isFinite(heartbeatMs) && nowMs - heartbeatMs <= maxAgeMs;
}

function isRemoteSchedulingEligible(
  row: WorkerHostRow | null,
  nowMs: number,
  maxAgeMs: number,
): row is WorkerHostRow {
  return (
    !!row &&
    (row.status === "ready" || row.status === "busy") &&
    isFreshHeartbeat(row, nowMs, maxAgeMs)
  );
}

function hostCapacity(
  db: BlackboardDatabase,
  host: WorkerHostConfig,
  reservedCounts?: WorkerHostSelectionOptions["reservedSessionCounts"],
): {
  activeSessions: number;
  reservedSessions: number;
  maxConcurrentWorkers: number;
  hasCapacity: boolean;
} {
  const activeSessions = getWorkerHostActiveSessionCount(db, host.id);
  const reservedSessions = reservedSessionCount(reservedCounts, host.id);
  const maxConcurrentWorkers = host.maxConcurrentWorkers;
  return {
    activeSessions,
    reservedSessions,
    maxConcurrentWorkers,
    hasCapacity: activeSessions + reservedSessions < maxConcurrentWorkers,
  };
}

export function selectCodexWorkerHost(
  db: BlackboardDatabase,
  config: Pick<FlitterbotConfig, "workerHosts">,
  options: string | WorkerHostSelectionOptions = {},
): WorkerHostSelection {
  const selectionOptions = typeof options === "string" ? { requestedHostId: options } : options;
  const remoteHeartbeatMaxAgeMs =
    selectionOptions.remoteHeartbeatMaxAgeMs ?? DEFAULT_REMOTE_HEARTBEAT_MAX_AGE_MS;
  const nowMs = Date.now();
  const requestedHostId = selectionOptions.requestedHostId;
  const requested = requestedHostId?.trim();
  if (requested) {
    const host = config.workerHosts.find((candidate) => candidate.id === requested);
    if (!host) throw new Error(`Unknown worker host: ${requestedHostId}`);
    const capacity = hostCapacity(db, host, selectionOptions.reservedSessionCounts);
    return {
      host,
      activeSessions: capacity.activeSessions,
      reservedSessions: capacity.reservedSessions,
      maxConcurrentWorkers: capacity.maxConcurrentWorkers,
      reason: "explicit",
    };
  }

  const local = config.workerHosts.find((host) => host.connectionMode === "local-stdio");
  if (local) {
    const row = getWorkerHost(db, local.id);
    const capacity = hostCapacity(db, local, selectionOptions.reservedSessionCounts);
    if (isSchedulingEligible(row) && capacity.hasCapacity) {
      return {
        host: local,
        activeSessions: capacity.activeSessions,
        reservedSessions: capacity.reservedSessions,
        maxConcurrentWorkers: capacity.maxConcurrentWorkers,
        reason: "local-default",
      };
    }
  }

  const remoteCandidates = config.workerHosts
    .filter((host) => host.connectionMode !== "local-stdio" && isRemoteAutoSelectable(host))
    .map((host) => {
      const row = getWorkerHost(db, host.id);
      const capacity = hostCapacity(db, host, selectionOptions.reservedSessionCounts);
      return { host, row, ...capacity };
    })
    .filter(
      (candidate) =>
        isRemoteSchedulingEligible(candidate.row, nowMs, remoteHeartbeatMaxAgeMs) &&
        candidate.hasCapacity,
    )
    .sort((a, b) => {
      const aRemaining = a.maxConcurrentWorkers - a.activeSessions - a.reservedSessions;
      const bRemaining = b.maxConcurrentWorkers - b.activeSessions - b.reservedSessions;
      return bRemaining - aRemaining || a.host.id.localeCompare(b.host.id);
    });

  const selected = remoteCandidates[0];
  if (selected) {
    return {
      host: selected.host,
      activeSessions: selected.activeSessions,
      reservedSessions: selected.reservedSessions,
      maxConcurrentWorkers: selected.maxConcurrentWorkers,
      reason: "remote-auto",
    };
  }

  const localCapacity = local
    ? hostCapacity(db, local, selectionOptions.reservedSessionCounts)
    : null;
  const localPart = local
    ? `${local.id} has ${(localCapacity?.activeSessions ?? 0) + (localCapacity?.reservedSessions ?? 0)}/${local.maxConcurrentWorkers} active or reserved workers`
    : "no local worker host is configured";
  throw new Error(
    `No available Codex worker host: ${localPart}, and no ready fresh remote host has opted into auto-selection`,
  );
}

export function checkConfiguredWorkerHost(
  db: BlackboardDatabase,
  host: WorkerHostConfig,
): WorkerHostCheckResult {
  try {
    let output: string;
    if (host.connectionMode === "local-stdio") {
      output = runShell(checkScript(host.codexHome), {
        cwd: host.projectsRoot ? path.resolve(host.projectsRoot) : undefined,
        env: host.codexHome ? { CODEX_HOME: host.codexHome } : undefined,
      });
    } else if (host.connectionMode === "ssh-stdio") {
      output = runSshShell(host.connectionTarget!, checkScript(host.codexHome));
    } else {
      throw new Error(`${host.connectionMode} health checks are not implemented yet`);
    }
    const parsed = parseCodexCheckOutput(output);
    updateWorkerHostStatus(db, host.id, {
      status: "ready",
      capabilities: {
        ...host.capabilities,
        codexVersion: parsed.codexVersion ?? null,
        authStatus: parsed.authStatus ?? null,
        checkedAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      },
    });
    return {
      hostId: host.id,
      displayName: host.displayName,
      connectionMode: host.connectionMode,
      connectionTarget: host.connectionTarget,
      status: "ready",
      ...parsed,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    updateWorkerHostStatus(db, host.id, {
      status: "unreachable",
      capabilities: {
        ...host.capabilities,
        checkedAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
        error: message,
      },
    });
    return {
      hostId: host.id,
      displayName: host.displayName,
      connectionMode: host.connectionMode,
      connectionTarget: host.connectionTarget,
      status: "unreachable",
      error: message,
    };
  }
}

export function checkConfiguredWorkerHosts(
  db: BlackboardDatabase,
  config: Pick<FlitterbotConfig, "workerHosts">,
): WorkerHostCheckResult[] {
  syncConfiguredWorkerHosts(db, config);
  return config.workerHosts.map((host) => checkConfiguredWorkerHost(db, host));
}
