import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import type { BlackboardDatabase } from "../blackboard/db.ts";
import {
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
