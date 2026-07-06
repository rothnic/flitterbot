#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function hostConfig() {
  return {
    workerHosts: [
      {
        id: "local",
        displayName: "Local machine",
        connectionMode: "local-stdio",
        projectsRoot: process.cwd(),
        codexHome: path.join(os.homedir(), ".codex"),
        maxConcurrentWorkers: 1,
        capabilities: { role: "local" },
      },
      {
        id: "vps-auto",
        displayName: "Auto SSH worker",
        connectionMode: "ssh-stdio",
        connectionTarget: "vps-auto",
        projectsRoot: "/home/ubuntu/data/projects",
        codexHome: "~/.codex",
        maxConcurrentWorkers: 2,
        capabilities: { role: "high-memory", autoSelect: true },
      },
      {
        id: "vps-manual",
        displayName: "Manual SSH worker",
        connectionMode: "ssh-stdio",
        connectionTarget: "vps-manual",
        projectsRoot: "/home/ubuntu/data/projects",
        codexHome: "~/.codex",
        maxConcurrentWorkers: 2,
        capabilities: { role: "gateway" },
      },
    ],
  };
}

function seedActiveSession(db, hostId, status = "running") {
  return db.prepare(
    `INSERT INTO worker_sessions (
       worker_session_id, runner_type, status, host_id, cwd
     ) VALUES (?, 'codex_app_server', ?, ?, ?)`,
  ).run(`session-${hostId}-${Date.now()}-${Math.random().toString(16).slice(2)}`, status, hostId, process.cwd());
}

async function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "flitterbot-host-scheduler-"));
  const dbPath = path.join(tempDir, "blackboard.db");
  const [
    { openBlackboard },
    { selectCodexWorkerHost, syncConfiguredWorkerHosts },
    { updateWorkerHostStatus },
  ] = await Promise.all([
    import("../src/blackboard/db.ts"),
    import("../src/workers/worker-hosts.ts"),
    import("../src/blackboard/query-workers.ts"),
  ]);
  const db = openBlackboard(dbPath);
  const config = hostConfig();

  try {
    syncConfiguredWorkerHosts(db, config);
    updateWorkerHostStatus(db, "local", { status: "ready" });
    updateWorkerHostStatus(db, "vps-auto", { status: "ready" });
    updateWorkerHostStatus(db, "vps-manual", { status: "ready" });

    const localDefault = selectCodexWorkerHost(db, config);
    assert(localDefault.host.id === "local", `expected local default, got ${localDefault.host.id}`);
    assert(localDefault.reason === "local-default", `unexpected local reason ${localDefault.reason}`);

    const remoteByReservation = selectCodexWorkerHost(db, config, {
      reservedSessionCounts: { local: 1 },
    });
    assert(
      remoteByReservation.host.id === "vps-auto",
      `expected reserved local capacity to select vps-auto, got ${remoteByReservation.host.id}`,
    );
    assert(
      remoteByReservation.reservedSessions === 0,
      `unexpected remote reserved count ${remoteByReservation.reservedSessions}`,
    );

    seedActiveSession(db, "local");
    const remoteAuto = selectCodexWorkerHost(db, config);
    assert(remoteAuto.host.id === "vps-auto", `expected vps-auto, got ${remoteAuto.host.id}`);
    assert(remoteAuto.reason === "remote-auto", `unexpected remote reason ${remoteAuto.reason}`);

    const explicitManual = selectCodexWorkerHost(db, config, "vps-manual");
    assert(explicitManual.host.id === "vps-manual", "explicit manual host selection failed");
    assert(explicitManual.reason === "explicit", `unexpected explicit reason ${explicitManual.reason}`);

    const explicitLocalOverCapacity = selectCodexWorkerHost(db, config, "local");
    assert(explicitLocalOverCapacity.host.id === "local", "explicit local selection should override capacity");

    seedActiveSession(db, "vps-auto");
    seedActiveSession(db, "vps-auto");
    let unavailableError = "";
    try {
      selectCodexWorkerHost(db, config);
    } catch (error) {
      unavailableError = error instanceof Error ? error.message : String(error);
    }
    assert(
      unavailableError.includes("No available Codex worker host"),
      `expected no-host capacity error, got ${unavailableError || "no error"}`,
    );

    db.prepare("UPDATE worker_sessions SET status = 'completed' WHERE host_id = 'vps-auto'").run();
    updateWorkerHostStatus(db, "vps-auto", { status: "ready" });
    db.prepare(
      "UPDATE worker_hosts SET last_heartbeat_at = '2000-01-01T00:00:00Z' WHERE host_id = 'vps-auto'",
    ).run();
    let staleError = "";
    try {
      selectCodexWorkerHost(db, config);
    } catch (error) {
      staleError = error instanceof Error ? error.message : String(error);
    }
    assert(
      staleError.includes("no ready fresh remote host"),
      `expected stale remote to be skipped, got ${staleError || "no error"}`,
    );

    updateWorkerHostStatus(db, "vps-auto", { status: "unreachable" });
    let unreachableError = "";
    try {
      selectCodexWorkerHost(db, config);
    } catch (error) {
      unreachableError = error instanceof Error ? error.message : String(error);
    }
    assert(
      unreachableError.includes("no ready fresh remote host"),
      `expected unreachable remote to be skipped, got ${unreachableError || "no error"}`,
    );

    const result = {
      ok: true,
      dbPath,
      localDefault: {
        hostId: localDefault.host.id,
        reason: localDefault.reason,
      },
      remoteAuto: {
        hostId: remoteAuto.host.id,
        reason: remoteAuto.reason,
        activeSessions: remoteAuto.activeSessions,
        maxConcurrentWorkers: remoteAuto.maxConcurrentWorkers,
      },
      remoteByReservation: {
        hostId: remoteByReservation.host.id,
        reason: remoteByReservation.reason,
      },
      explicitManual: {
        hostId: explicitManual.host.id,
        reason: explicitManual.reason,
      },
      capacityError: unavailableError,
      staleError,
      unreachableError,
    };
    console.log(JSON.stringify(result, null, 2));
  } finally {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
});
