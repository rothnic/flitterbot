#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CONNECTION_MODES = new Set(["local-stdio", "ssh-stdio", "unix-socket", "websocket-auth"]);

function parseArgs(argv) {
  const opts = { capabilities: {}, dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--") {
      continue;
    } else if (arg === "--config" && next) {
      opts.configPath = path.resolve(next);
      i += 1;
    } else if (arg === "--home" && next) {
      opts.home = path.resolve(next);
      i += 1;
    } else if (arg === "--id" && next) {
      opts.id = next;
      i += 1;
    } else if (arg === "--display-name" && next) {
      opts.displayName = next;
      i += 1;
    } else if (arg === "--connection-mode" && next) {
      opts.connectionMode = next;
      i += 1;
    } else if ((arg === "--ssh-target" || arg === "--connection-target") && next) {
      opts.connectionTarget = next;
      i += 1;
    } else if (arg === "--projects-root" && next) {
      opts.projectsRoot = next;
      i += 1;
    } else if (arg === "--codex-home" && next) {
      opts.codexHome = next;
      i += 1;
    } else if (arg === "--max-concurrent-workers" && next) {
      opts.maxConcurrentWorkers = Number(next);
      i += 1;
    } else if (arg === "--role" && next) {
      opts.capabilities.role = next;
      i += 1;
    } else if (arg === "--auto-select") {
      opts.capabilities.autoSelect = true;
    } else if (arg === "--scheduler-auto") {
      opts.capabilities.scheduler = "auto";
    } else if (arg === "--capability" && next) {
      const [key, ...valueParts] = next.split("=");
      if (!key || valueParts.length === 0) {
        throw new Error("--capability expects key=value");
      }
      opts.capabilities[key] = parseCapabilityValue(valueParts.join("="));
      i += 1;
    } else if (arg === "--dry-run") {
      opts.dryRun = true;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`);
    }
  }
  return opts;
}

function printHelp() {
  console.log(`Usage: pnpm run worker-host:configure -- --id <host-id> [options]

Adds or updates one Codex worker host in Flitterbot config.

Examples:
  pnpm run worker-host:configure -- --id vps-dev --ssh-target vps-dev --projects-root ~/data/projects --max-concurrent-workers 4 --role high-memory --auto-select
  pnpm run worker-host:configure -- --id vps-gw --ssh-target vps-gw --projects-root ~/data/projects --role gateway

Options:
  --config <path>                 Config path. Default: ~/.flitterbot/config.json
  --home <path>                   Resolve default config under this HOME
  --id <host-id>                  Stable worker host id
  --display-name <name>           Human-readable name. Default: host id
  --connection-mode <mode>        local-stdio, ssh-stdio, unix-socket, websocket-auth
  --ssh-target <target>           SSH target; implies ssh-stdio if mode omitted
  --projects-root <path>          Project root on the worker host
  --codex-home <path>             CODEX_HOME on the worker host. Default: ~/.codex
  --max-concurrent-workers <n>    Host worker capacity. Default: existing value or 1
  --role <label>                  capabilities.role value
  --auto-select                   Opt remote host into no-host scheduling
  --scheduler-auto                Set capabilities.scheduler="auto"
  --capability <key=value>        Add a primitive capability value
  --dry-run                       Print the resulting host without writing`);
}

function parseCapabilityValue(value) {
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null") return null;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  return value;
}

function configPathFor(opts) {
  if (opts.configPath) return opts.configPath;
  const home = opts.home ?? os.homedir();
  return path.join(home, ".flitterbot", "config.json");
}

function readConfig(configPath) {
  if (!fs.existsSync(configPath)) {
    throw new Error(`Missing config file: ${configPath}`);
  }
  const parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Invalid config file: ${configPath} must contain a JSON object`);
  }
  return parsed;
}

function nonEmpty(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required`);
  return value.trim();
}

function buildHost(opts, existing) {
  const id = nonEmpty(opts.id, "--id");
  const connectionMode =
    opts.connectionMode ?? (opts.connectionTarget ? "ssh-stdio" : existing?.connectionMode ?? "local-stdio");
  if (!CONNECTION_MODES.has(connectionMode)) {
    throw new Error(`Invalid --connection-mode: ${connectionMode}`);
  }
  const requestedConnectionTarget = opts.connectionTarget?.trim();
  const existingConnectionTarget =
    opts.connectionMode === "local-stdio" && !requestedConnectionTarget
      ? undefined
      : existing?.connectionTarget;
  const connectionTarget = requestedConnectionTarget || existingConnectionTarget;
  if (connectionMode === "local-stdio" && requestedConnectionTarget) {
    throw new Error("--ssh-target cannot be used with local-stdio worker hosts");
  }
  if (connectionMode === "ssh-stdio" && !connectionTarget) {
    throw new Error("--ssh-target is required for ssh-stdio worker hosts");
  }
  const maxConcurrentWorkers = opts.maxConcurrentWorkers ?? existing?.maxConcurrentWorkers ?? 1;
  if (!Number.isInteger(maxConcurrentWorkers) || maxConcurrentWorkers <= 0) {
    throw new Error("--max-concurrent-workers must be a positive integer");
  }

  const capabilities =
    existing?.capabilities && typeof existing.capabilities === "object" && !Array.isArray(existing.capabilities)
      ? { ...existing.capabilities }
      : {};
  Object.assign(capabilities, opts.capabilities);

  const host = {
    id,
    displayName: opts.displayName?.trim() || existing?.displayName || id,
    connectionMode,
    ...(connectionTarget ? { connectionTarget } : {}),
    projectsRoot: opts.projectsRoot?.trim() || existing?.projectsRoot || "~/data/projects",
    codexHome: opts.codexHome?.trim() || existing?.codexHome || "~/.codex",
    maxConcurrentWorkers,
    capabilities,
  };

  if (connectionMode === "local-stdio") delete host.connectionTarget;
  return host;
}

function writeConfig(configPath, config) {
  const tempPath = `${configPath}.${process.pid}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tempPath, configPath);
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const configPath = configPathFor(opts);
  const config = readConfig(configPath);
  const hosts = Array.isArray(config.workerHosts) ? [...config.workerHosts] : [];
  const id = nonEmpty(opts.id, "--id");
  const index = hosts.findIndex((host) => host && typeof host === "object" && host.id === id);
  const existing = index >= 0 ? hosts[index] : undefined;
  const host = buildHost(opts, existing);
  const action = existing ? "updated" : "added";

  if (index >= 0) hosts[index] = host;
  else hosts.push(host);
  config.workerHosts = hosts;

  if (!opts.dryRun) writeConfig(configPath, config);

  console.log(
    JSON.stringify(
      {
        ok: true,
        action,
        dryRun: opts.dryRun,
        configPath,
        host,
        workerHostCount: hosts.length,
      },
      null,
      2,
    ),
  );
}

main();
