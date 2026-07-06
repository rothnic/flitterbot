#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import {
  readFileSync, writeFileSync, mkdirSync, existsSync, statSync, copyFileSync,
  chmodSync, renameSync, rmSync, readdirSync, unlinkSync,
} from "node:fs";
import { join, dirname, resolve } from "node:path";
import { homedir, platform } from "node:os";
import { execSync } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const HOME = homedir();
const FLITTERBOT_DIR = join(HOME, ".flitterbot");
const MANIFEST = join(FLITTERBOT_DIR, "manifest.json");
const SETTINGS = join(HOME, ".claude", "settings.json");
const PLIST_DEST = join(HOME, "Library", "LaunchAgents", "com.flitterbot.scheduler.plist");
const PLIST_LABEL = "com.flitterbot.scheduler";
const SYSTEMD_USER_DIR = join(HOME, ".config", "systemd", "user");
const SYSTEMD_SERVICE_NAME = "flitterbot-scheduler.service";
const SYSTEMD_TIMER_NAME = "flitterbot-scheduler.timer";
const SYSTEMD_SERVICE_DEST = join(SYSTEMD_USER_DIR, SYSTEMD_SERVICE_NAME);
const SYSTEMD_TIMER_DEST = join(SYSTEMD_USER_DIR, SYSTEMD_TIMER_NAME);
const LEGACY_CRONTAB_TARGET = "crontab:user";
const HOOKS_DIR = join(FLITTERBOT_DIR, "hooks");
const LOG_FILE = join(FLITTERBOT_DIR, "logs", "install.log");
const VERSION_FILE = join(FLITTERBOT_DIR, "VERSION");
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const CURRENT_OS = platform() === "darwin" ? "Darwin" : platform() === "linux" ? "Linux" : platform();

let PROJECT_ROOT = "";

let DRY_RUN = false;
let AUTO_YES = false;
let INSTALL_SCHEDULER = false;

for (const arg of process.argv.slice(2)) {
  if (arg === "--dry-run") DRY_RUN = true;
  else if (arg === "--yes") AUTO_YES = true;
  else if (arg === "--with-scheduler" || arg === "--enable-scheduler") INSTALL_SCHEDULER = true;
  else if (arg === "--without-scheduler" || arg === "--skip-scheduler") INSTALL_SCHEDULER = false;
}

const TOP_LEVEL_FILES = ["uninstall.mjs", "VERSION"];

const HOOK_SCRIPT = "hook-post.mjs";

const HOOKS = [
  { event: "SessionStart", arg: "session-start" },
  { event: "Stop", arg: "stop" },
  { event: "SessionEnd", arg: "session-end" },
];

const SCRIPT_FILES = ["runtime-common.sh"];
const SOURCE_FILES = ["blackboard/schema.sql"];
const SCHEDULER_FILES = ["flitterbot-checkin.sh", "com.flitterbot.scheduler.plist"];
const BIN_FILES = ["flitterbot-up", "flitterbot-wa"];
const WHATSAPP_FILES = ["README.md", "config.json.example"];
const WHATSAPP_EXEC_FILES = ["run-entry.js", "cli.js", "daemon.js"];
const CONTROL_SURFACE_AGENT_FILES = ["AGENTS.md"];
const BUNDLED_SKILLS_DIR = "skills";

function sha256Text(text) {
  return createHash("sha256").update(text).digest("hex");
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function fileSizeBytes(path) {
  try { return statSync(path).size; } catch { return 0; }
}

// ponytail: install/uninstall/hook-post each carry log rotation; share one installer utility.
function rotateLog(path) {
  mkdirSync(dirname(path), { recursive: true });
  if (fileSizeBytes(path) < 10 * 1024 * 1024) return;
  try { rmSync(path + ".1", { force: true }); } catch {}
  try { renameSync(path, path + ".1"); } catch {}
}

function log(msg) {
  rotateLog(LOG_FILE);
  const ts = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  try { writeFileSync(LOG_FILE, `[${ts}] ${msg}\n`, { flag: "a" }); } catch {}
}

function info(msg) { console.log(msg); log(`INFO: ${msg}`); }
function warn(msg) { console.error(`WARNING: ${msg}`); log(`WARN: ${msg}`); }
function error(msg) { console.error(`ERROR: ${msg}`); log(`ERROR: ${msg}`); }

function atomicWrite(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.flitterbot.tmp.${randomUUID()}`);
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

function readJsonFile(path) {
  const raw = readFileSync(path, "utf8").trim();
  return raw ? JSON.parse(raw) : {};
}

function writeJsonFile(path, obj, mode) {
  atomicWrite(path, JSON.stringify(obj, null, 2) + "\n");
  if (mode != null) chmodSync(path, mode);
}

function canonicalJson(obj) {
  return JSON.stringify(sortKeys(obj));
}

function sortKeys(obj) {
  if (obj === null || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(sortKeys);
  const sorted = {};
  for (const key of Object.keys(obj).sort()) sorted[key] = sortKeys(obj[key]);
  return sorted;
}

function sortedPrettyJson(obj) {
  return JSON.stringify(sortKeys(obj), null, 2);
}

// ponytail: use execFileSync('diff', ['-u', a, b]) or JS diff; shell-quoted temp paths are repeated in uninstall too.
function diffText(before, after) {
  try {
    const tmpA = join("/tmp", `.flitterbot-diff-a.${process.pid}`);
    const tmpB = join("/tmp", `.flitterbot-diff-b.${process.pid}`);
    writeFileSync(tmpA, before);
    writeFileSync(tmpB, after);
    const result = execSync(`diff -u "${tmpA}" "${tmpB}"`, { encoding: "utf8" });
    rmSync(tmpA, { force: true });
    rmSync(tmpB, { force: true });
    return result;
  } catch (e) {
    try { rmSync(`/tmp/.flitterbot-diff-a.${process.pid}`, { force: true }); } catch {}
    try { rmSync(`/tmp/.flitterbot-diff-b.${process.pid}`, { force: true }); } catch {}
    return e.stdout || "";
  }
}

function showJsonDiff(beforePath, afterObj) {
  if (existsSync(beforePath)) {
    const before = sortedPrettyJson(readJsonFile(beforePath)) + "\n";
    const after = sortedPrettyJson(afterObj) + "\n";
    return diffText(before, after);
  }
  return `--- /dev/null\n+++ proposed\n${sortedPrettyJson(afterObj)}\n`;
}

function showTextDiff(beforePath, afterText) {
  if (existsSync(beforePath)) {
    const before = readFileSync(beforePath, "utf8");
    return diffText(before, afterText);
  }
  return `--- /dev/null\n+++ proposed\n${afterText}${afterText.endsWith("\n") ? "" : "\n"}`;
}

async function confirm(prompt) {
  if (AUTO_YES) return true;
  if (DRY_RUN) {
    info("(dry-run) Would apply above changes.");
    return false;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(prompt || "Apply these changes? [y/N] ", (answer) => {
      rl.close();
      resolve(/^[Yy]$/.test(answer.trim()));
    });
  });
}

function commandExists(cmd) {
  try { execSync(`command -v ${cmd}`, { stdio: "pipe" }); return true; } catch { return false; }
}

function codexAuthConfigured() {
  return Boolean(process.env.CODEX_ACCESS_TOKEN) || existsSync(join(HOME, ".codex", "auth.json"));
}

function generateToken() {
  return randomUUID();
}

// ponytail: walkDir and walkFiles overlap; keep one recursive walker.
function walkDir(dir, prefix = "") {
  const entries = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    entries.push(rel);
    if (entry.isDirectory()) entries.push(...walkDir(join(dir, entry.name), rel));
  }
  return entries.sort();
}

function manifestInit() {
  mkdirSync(FLITTERBOT_DIR, { recursive: true });
  if (existsSync(MANIFEST)) {
    try { readJsonFile(MANIFEST); } catch {
      const backup = `${MANIFEST}.bak.${new Date().toISOString().replace(/[-:.]/g, "").replace("T", "T").slice(0, 15)}Z`;
      warn(`Manifest is malformed. Backing it up to ${backup} and recreating.`);
      renameSync(MANIFEST, backup);
    }
  }
  if (!existsSync(MANIFEST)) {
    atomicWrite(MANIFEST, JSON.stringify({
      version: "1", flitterbot_version: "0.0.0", installed_at: null, targets: {},
    }, null, 2) + "\n");
    chmodSync(MANIFEST, 0o600);
  }
}

function manifestWriteTarget(targetKey, targetObj) {
  manifestInit();
  const manifest = readJsonFile(MANIFEST);
  const version = readFileSync(VERSION_FILE, "utf8").trim();
  const now = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  manifest.version = "1";
  manifest.flitterbot_version = version;
  manifest.installed_at = now;
  manifest.targets[targetKey] = targetObj;
  writeJsonFile(MANIFEST, manifest, 0o600);
}

function manifestDeleteTarget(targetKey) {
  if (!existsSync(MANIFEST)) return;
  let manifest;
  try { manifest = readJsonFile(MANIFEST); } catch { return; }
  if (!manifest.targets || manifest.targets[targetKey] == null) return;
  delete manifest.targets[targetKey];
  writeJsonFile(MANIFEST, manifest, 0o600);
}

function resolvePackagedRuntimeFile(rel) {
  const candidates = [
    PROJECT_ROOT && join(PROJECT_ROOT, "installer", rel),
    join(SCRIPT_DIR, rel),
    join(FLITTERBOT_DIR, rel),
  ].filter(Boolean);
  for (const c of candidates) if (existsSync(c)) return c;
  return null;
}

function resolvePackagedSrcFile(rel) {
  const candidates = [
    PROJECT_ROOT && join(PROJECT_ROOT, "src", rel),
    join(FLITTERBOT_DIR, "src", rel),
    join(SCRIPT_DIR, "src", rel),
    join(SCRIPT_DIR, "..", "src", rel),
  ].filter(Boolean);
  for (const c of candidates) if (existsSync(c)) return c;
  return null;
}

function resolvePackagedRepoDir(rel) {
  const candidates = [
    PROJECT_ROOT && join(PROJECT_ROOT, rel),
    join(SCRIPT_DIR, "..", rel),
    join(SCRIPT_DIR, rel),
  ].filter(Boolean);
  for (const c of candidates) if (existsSync(c)) return c;
  return null;
}

function walkFiles(dir, prefix = "") {
  const entries = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) entries.push(...walkFiles(full, rel));
    else if (entry.isFile()) entries.push(rel);
  }
  return entries.sort();
}

function copyRuntimeFile(src, dest, mode) {
  mkdirSync(dirname(dest), { recursive: true });
  if (src !== dest) copyFileSync(src, dest);
  chmodSync(dest, mode);
}

function writeRuntimeFile(dest, content, mode) {
  mkdirSync(dirname(dest), { recursive: true });
  atomicWrite(dest, content);
  chmodSync(dest, mode);
}

let RUNTIME_CHANGES = "";

function appendRuntimeChange(action, path) {
  RUNTIME_CHANGES += `${action} ${path}\n`;
}

function noteRuntimeFile(src, dest) {
  if (!existsSync(dest)) {
    appendRuntimeChange("create", dest);
    return;
  }
  if (sha256File(src) !== sha256File(dest)) appendRuntimeChange("update", dest);
}

function noteRuntimeFileIfMissing(_src, dest) {
  if (!existsSync(dest)) appendRuntimeChange("create", dest);
}

function noteTextFile(dest, content) {
  if (!existsSync(dest)) {
    appendRuntimeChange("create", dest);
    return;
  }
  const existing = readFileSync(dest, "utf8");
  if (existing !== content) appendRuntimeChange("update", dest);
}

function snapshotRuntimeTree() {
  if (!existsSync(FLITTERBOT_DIR)) return [];
  return walkDir(FLITTERBOT_DIR);
}

function recordRuntimeTreeTarget() {
  if (DRY_RUN) return;
  const paths = snapshotRuntimeTree();
  const treeHash = sha256Text(JSON.stringify(paths));
  manifestWriteTarget("~/.flitterbot", {
    type: "owned-tree",
    modifications: [{
      id: "flitterbot:home-tree",
      action: "sync-tree",
      paths,
      content_sha256: treeHash,
    }],
    checksums: {
      algorithm: "sha256",
      file_before_install: null,
      file_after_install: treeHash,
    },
  });
}

function systemctlUserAvailable() {
  try {
    execSync("systemctl --user show-environment", { stdio: "pipe" });
    return true;
  } catch { return false; }
}

function renderSystemdService() {
  return `[Unit]
Description=Flitterbot scheduler check-in
After=default.target

[Service]
Type=oneshot
ExecStart=/bin/bash ${FLITTERBOT_DIR}/scheduler/flitterbot-checkin.sh
WorkingDirectory=${HOME}
`;
}

function renderSystemdTimer() {
  return `[Unit]
Description=Run Flitterbot scheduler every 10 minutes

[Timer]
OnBootSec=2m
OnUnitActiveSec=10m
AccuracySec=1m
Persistent=true
Unit=${SYSTEMD_SERVICE_NAME}

[Install]
WantedBy=timers.target
`;
}

function computeLegacyCrontabAfterText(beforeText) {
  return beforeText
    .split("\n")
    .filter((line) => !line.includes("# flitterbot-scheduler"))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\n+/, "")
    .replace(/\n+$/, "");
}

function applyLegacyCrontabText(afterText) {
  const trimmed = afterText.replace(/\s/g, "");
  if (trimmed) {
    const tmp = `/tmp/flitterbot-crontab.${process.pid}`;
    writeFileSync(tmp, afterText + "\n");
    try { execSync(`crontab "${tmp}"`, { stdio: "pipe" }); } finally { rmSync(tmp, { force: true }); }
  } else {
    try { execSync("crontab -r", { stdio: "pipe" }); } catch {}
  }
}

function computeProjectRoot() {
  if (existsSync(join(SCRIPT_DIR, "..", "src")) && existsSync(join(SCRIPT_DIR, "..", "package.json"))) {
    PROJECT_ROOT = resolve(SCRIPT_DIR, "..");
    return;
  }
  const sourceRootFile = join(FLITTERBOT_DIR, "source-root");
  if (existsSync(sourceRootFile)) {
    PROJECT_ROOT = readFileSync(sourceRootFile, "utf8").trim();
    return;
  }
  PROJECT_ROOT = "";
}

function prepareDirectories() {
  const dirs = [
    FLITTERBOT_DIR,
    join(FLITTERBOT_DIR, "bin"),
    ...(INSTALL_SCHEDULER ? [join(FLITTERBOT_DIR, "scheduler")] : []),
    join(FLITTERBOT_DIR, "control-surface"),
    join(FLITTERBOT_DIR, "control-surface", "agent"),
    join(FLITTERBOT_DIR, "hooks"),
    join(FLITTERBOT_DIR, "logs"),
    join(FLITTERBOT_DIR, "scripts"),
    join(FLITTERBOT_DIR, "skills"),
    join(FLITTERBOT_DIR, "data", "tasks"),
    join(FLITTERBOT_DIR, "data", "notes"),
    join(FLITTERBOT_DIR, "src", "blackboard"),
    join(FLITTERBOT_DIR, "whatsapp", "auth"),
    join(FLITTERBOT_DIR, "whatsapp", "logs"),
  ];
  for (const d of dirs) mkdirSync(d, { recursive: true });
  try { chmodSync(join(FLITTERBOT_DIR, "whatsapp", "auth"), 0o700); } catch {}
  try { chmodSync(join(FLITTERBOT_DIR, "whatsapp", "logs"), 0o700); } catch {}
}

function preflight() {
  if (CURRENT_OS === "Darwin") {
    if (!commandExists("plutil")) { error("plutil is required on macOS."); process.exit(1); }
    if (!commandExists("launchctl")) { error("launchctl is required on macOS."); process.exit(1); }
  } else if (CURRENT_OS === "Linux") {
    if (!commandExists("systemctl")) {
      warn("systemctl not found; Linux scheduler install will be skipped.");
    }
  } else {
    warn(`Unsupported OS: ${CURRENT_OS}. Hooks will install, scheduler may be skipped.`);
  }

  if (!commandExists("codex")) {
    warn("codex CLI not found on PATH. Install Codex and sign in before starting Flitterbot's Codex worker runner.");
  } else if (!codexAuthConfigured()) {
    warn("Codex auth not found. Run `codex login` or provide CODEX_ACCESS_TOKEN before starting Flitterbot's Codex worker runner.");
  }

  computeProjectRoot();
  prepareDirectories();

  let version = "0.1.0";
  const versionSrc = join(SCRIPT_DIR, "VERSION");
  if (existsSync(versionSrc)) version = readFileSync(versionSrc, "utf8").trim();
  writeFileSync(VERSION_FILE, version + "\n");

  info(`Flitterbot Installer v${version}`);
  info("==========================");
  if (DRY_RUN) info("(dry-run mode — no changes will be written)");
  info(INSTALL_SCHEDULER
    ? "Scheduler install: enabled"
    : "Scheduler install: skipped by default (pass --with-scheduler to enable)");
  info("");
}

async function bootstrapConfig() {
  const configPath = join(FLITTERBOT_DIR, "config.json");
  let configBefore = {};
  let beforeHash = "null";

  if (existsSync(configPath)) {
    try { configBefore = readJsonFile(configPath); } catch {
      error(`Config is malformed JSON: ${configPath}`);
      process.exit(1);
    }
    beforeHash = sha256File(configPath);
  }

  let token = configBefore.controlSurfaceToken || "";
  if (!token) token = generateToken();

  let projectRoot = configBefore.projectRoot || configBefore.sourceRoot || "";
  if (!projectRoot && PROJECT_ROOT) projectRoot = PROJECT_ROOT;

  let commandHint = configBefore.controlSurfaceCommand || "";
  if (commandHint) {
    const match = commandHint.match(/(?:node\S*\s+(?:--\S+\s+)*)(\S+\.(?:ts|js))$/);
    if (match && !existsSync(match[1])) commandHint = "";
  }
  if (!commandHint && projectRoot) {
    if (existsSync(join(projectRoot, "src", "server.ts"))) {
      commandHint = `cd ${projectRoot} && exec node --experimental-strip-types ${join(projectRoot, "src", "server.ts")}`;
    }
  }

  const DEFAULT_MODELS = [
    {
      id: "gpt-5.5",
      label: "GPT 5.5",
      provider: "openai-codex",
      modelId: "gpt-5.5",
    },
    {
      id: "claude-opus-4-7",
      label: "Claude Opus 4.7",
      provider: "anthropic",
      modelId: "claude-opus-4-7",
    },
  ];
  const DEFAULT_CLASSIFIER = {
    provider: "groq",
    model: "openai/gpt-oss-120b",
    apiKeyEnv: "GROQ_API_KEY",
    baseURL: "https://api.groq.com/openai/v1",
    maxTokens: 1024,
  };
  const DEFAULT_CODEX_WORKER_PROFILES = [
    {
      id: "coding",
      label: "Coding worker",
      model: "gpt-5.5",
      approvalPolicy: "never",
      sandbox: "workspace-write",
      developerInstructions:
        "You are a Flitterbot coding worker. Focus on the delegated task, make scoped changes, and report concise final output.",
      skillNames: [],
      skillPaths: [],
    },
    {
      id: "light",
      label: "Light coding worker",
      model: "gpt-5.4-mini",
      approvalPolicy: "never",
      sandbox: "workspace-write",
      developerInstructions:
        "Use this profile for simple edits, classification support, and quick repo inspection tasks.",
      skillNames: [],
      skillPaths: [],
    },
  ];
  const DEFAULT_AGENT_FIRST_MESSAGE =
    "Load up /skill:tasks /skill:notes and run ls on the project repositories directory. Then wait for the user";
  const DEFAULT_NEW_STREAM_FIRST_MESSAGE_FOOTER =
    "IMPORTANT! Before doing  anything else, load the /skill:tmux pls";

  const STATIC_DEFAULTS = {
    controlSurfaceHost: "127.0.0.1",
    controlSurfacePort: 18820,
    models: DEFAULT_MODELS,
    defaultModel: DEFAULT_MODELS[0].id,
    defaultThinkingLevel: "high",
    classifier: DEFAULT_CLASSIFIER,
    defaultCodexWorkerProfile: DEFAULT_CODEX_WORKER_PROFILES[0].id,
    codexWorkerProfiles: DEFAULT_CODEX_WORKER_PROFILES,
    piTransport: "websocket-cached",
    stallMinutes: 15,
    toolTimeoutMinutes: 4,
    blackboardPath: "~/.flitterbot/blackboard.db",
    whatsappAuthDir: "~/.flitterbot/whatsapp/auth",
    whatsappSocketPath: "~/.flitterbot/whatsapp/daemon.sock",
    whatsappPidPath: "~/.flitterbot/whatsapp/daemon.pid",
    whatsappCliPath: "~/.flitterbot/whatsapp/cli.js",
    whatsappDaemonPath: "~/.flitterbot/whatsapp/daemon.js",
    whatsappEnabled: true,
    wipeStreamsOnStart: false,
    shortcuts: {},
    claudeCliCommand: "claude --dangerously-skip-permissions",
    projectsDir: "~/development",
    defaultAgentFirstMessage: DEFAULT_AGENT_FIRST_MESSAGE,
    newStreamFirstMessageFooter: DEFAULT_NEW_STREAM_FIRST_MESSAGE_FOOTER,
    tmuxEnabled: true,
    extraSkillPaths: [],
    learningsNotePath: "~/.flitterbot/data/learnings.md",
    todoistApiKey: "",
    linearApiKey: "",
  };

  const configAfter = { ...configBefore };
  const setDefault = (key, value) => {
    if (configAfter[key] == null) configAfter[key] = value;
  };

  for (const [key, value] of Object.entries(STATIC_DEFAULTS)) setDefault(key, value);

  setDefault("controlSurfaceToken", token);
  setDefault("projectRoot", projectRoot);
  setDefault("sourceRoot", configAfter.projectRoot ?? projectRoot);
  setDefault("controlSurfaceCommand", commandHint);

  if (canonicalJson(configBefore) !== canonicalJson(configAfter)) {
    info("=== Runtime config changes ===");
    console.log(showJsonDiff(configPath, configAfter));
    info("");

    if (await confirm()) {
      if (!DRY_RUN) {
        writeJsonFile(configPath, configAfter, 0o600);
        const afterHash = sha256File(configPath);
        log(`INFO: Bootstrapped config.json before=${beforeHash} after=${afterHash}`);
      }
    } else {
      info("Skipped config bootstrap update.");
    }
  }

  reportConfigOverrides(configAfter, STATIC_DEFAULTS);

  await syncWebEnv(configAfter);
}

function formatConfigValue(v) {
  const s = JSON.stringify(v);
  if (s == null) return String(v);
  const flat = s.replace(/\\n/g, " ⏎ ");
  return flat.length > 60 ? flat.slice(0, 57) + "..." : flat;
}

function normalizeHomePath(v) {
  if (typeof v !== "string") return v;
  if (v.startsWith(HOME + "/")) return "~" + v.slice(HOME.length);
  return v;
}

function reportConfigOverrides(config, defaults) {
  const overrides = [];
  for (const [key, def] of Object.entries(defaults)) {
    if (key === "todoistApiKey" || key === "linearApiKey") continue;
    const a = canonicalJson(normalizeHomePath(config[key]));
    const b = canonicalJson(normalizeHomePath(def));
    if (a !== b) {
      overrides.push({ key, value: config[key], default: def });
    }
  }
  if (overrides.length === 0) return;

  const keyWidth = Math.max(...overrides.map((o) => o.key.length));
  info("=== Config overrides (non-default values preserved) ===");
  for (const { key, value, default: def } of overrides) {
    info(`  ${key.padEnd(keyWidth)} = ${formatConfigValue(value)}  (default: ${formatConfigValue(def)})`);
  }
  info("");
}

async function syncWebEnv(config) {
  if (!PROJECT_ROOT) return;
  const webEnvPath = join(PROJECT_ROOT, "web", ".env");
  const baseUrl = `http://${config.controlSurfaceHost}:${config.controlSurfacePort}`;
  const token = config.controlSurfaceToken;
  const desired = `VITE_FLITTERBOT_BASE_URL=${baseUrl}\nVITE_FLITTERBOT_TOKEN=${token}\n`;

  const beforeHash = existsSync(webEnvPath) ? sha256File(webEnvPath) : "";

  if (existsSync(webEnvPath)) {
    const existing = readFileSync(webEnvPath, "utf8");
    if (existing === desired) return;
  }

  info("=== Web app .env sync ===");
  console.log(showTextDiff(webEnvPath, desired));
  info("");

  if (await confirm()) {
    if (!DRY_RUN) {
      writeRuntimeFile(webEnvPath, desired, 0o600);
      const afterHash = sha256File(webEnvPath);
      manifestWriteTarget("web/.env", {
        type: "file-create",
        modifications: [{ id: "web-env:sync", action: "upsert", content_sha256: afterHash }],
        checksums: {
          algorithm: "sha256",
          file_before_install: beforeHash || null,
          file_after_install: afterHash,
        },
      });
      info(`Wrote ${webEnvPath}`);
    }
  } else {
    info("Skipped web .env sync.");
  }
}

async function promptString(promptText) {
  if (AUTO_YES || DRY_RUN) return "";
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(promptText, (answer) => {
      rl.close();
      resolve(answer.replace(/[\t\r\n]/g, "").trim());
    });
  });
}

async function promptWhatsappPhone(promptText) {
  if (AUTO_YES || DRY_RUN) return "";
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(promptText, (answer) => {
      rl.close();
      const entered = answer.replace(/[\t\r\n]/g, "").trim();
      if (!entered) { resolve(""); return; }
      const normalized = entered.replace(/\D/g, "");
      if (normalized) { resolve(normalized); return; }
      warn("Please enter digits only (country code included), or leave blank to skip.");
      resolve("");
    });
  });
}

async function bootstrapWhatsappConfig() {
  const whatsappConfig = join(FLITTERBOT_DIR, "whatsapp", "config.json");
  let before = {};
  if (existsSync(whatsappConfig)) {
    try { before = readJsonFile(whatsappConfig); } catch {
      error(`WhatsApp config is malformed JSON: ${whatsappConfig}`);
      process.exit(1);
    }
  }

  const after = { ...before };
  delete after.recipientJid;
  delete after.allowedJids;
  if (after.pairingPhoneNumber === undefined) {
    const entered = await promptWhatsappPhone(
      "WhatsApp phone number for pairing (digits with country code, blank to skip for now): ",
    );
    if (entered) after.pairingPhoneNumber = entered;
  }
  if (!after.users || typeof after.users !== "object" || Array.isArray(after.users)) after.users = {};
  if (typeof after.defaultUser !== "string" || !after.defaultUser.trim()) {
    const [firstUser] = Object.keys(after.users);
    if (firstUser) after.defaultUser = firstUser;
  }
  if (after.typingDelayMs === undefined) after.typingDelayMs = 800;

  if (canonicalJson(before) === canonicalJson(after)) return;

  info("=== WhatsApp config changes ===");
  console.log(showJsonDiff(whatsappConfig, after));
  info("");

  if (await confirm()) {
    if (!DRY_RUN) writeJsonFile(whatsappConfig, after, 0o600);
  } else {
    info("Skipped WhatsApp config update.");
  }
}

function readBlackboardSchemaVersion(schemaFile) {
  try {
    const schema = readFileSync(schemaFile, "utf8");
    const match = schema.match(/blackboard schema \(v(\d+)\)/i);
    if (match) return Number.parseInt(match[1], 10);
  } catch {}
  return 0;
}

function initBlackboard() {
  if (DRY_RUN) {
    info("(dry-run) Would initialize blackboard.db");
    return;
  }

  const schemaFile = resolvePackagedSrcFile("blackboard/schema.sql")
    || join(FLITTERBOT_DIR, "src", "blackboard", "schema.sql");
  if (!existsSync(schemaFile)) {
    warn(`Schema file not found at ${schemaFile}; skipping blackboard initialization`);
    return;
  }
  const schemaVersion = readBlackboardSchemaVersion(schemaFile);
  if (!schemaVersion) {
    warn(`Could not determine blackboard schema version from ${schemaFile}; skipping blackboard initialization`);
    return;
  }

  let dbPath = join(FLITTERBOT_DIR, "blackboard.db");
  const configPath = join(FLITTERBOT_DIR, "config.json");
  if (existsSync(configPath)) {
    try {
      const cfg = readJsonFile(configPath);
      if (cfg.blackboardPath) dbPath = cfg.blackboardPath.replace(/^~/, HOME);
    } catch {}
  }

  mkdirSync(dirname(dbPath), { recursive: true });

  const sqlite = (sql) => execSync(
    `sqlite3 "${dbPath}" "${sql.replace(/"/g, '\\"')}"`,
    { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
  ).trim();

  try {
    let hasSessions = false;
    if (existsSync(dbPath)) {
      try {
        hasSessions = sqlite(
          "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='sessions';",
        ) !== "0";
      } catch {}
    }

    if (!hasSessions) {
      execSync(`sqlite3 "${dbPath}" < "${schemaFile}"`, { stdio: "pipe" });
      sqlite(`INSERT OR IGNORE INTO schema_migrations(version) VALUES (${schemaVersion});`);
      info(`blackboard.db created at ${dbPath} (schema v${schemaVersion})`);
    } else {
      let current = "0";
      try { current = sqlite("SELECT COALESCE(MAX(version), 0) FROM schema_migrations;"); } catch {}
      info(`blackboard.db exists at ${dbPath} (schema v${current})`);
      if (parseInt(current, 10) < schemaVersion) {
        info(`  note: server will migrate v${current} → v${schemaVersion} on next startup`);
      }
    }
  } catch (e) {
    warn(`Blackboard initialization reported an error: ${e.message}`);
  }
}

async function deployRuntimeFiles() {
  RUNTIME_CHANGES = "";

  for (const file of TOP_LEVEL_FILES) {
    const src = resolvePackagedRuntimeFile(file);
    if (!src) continue;
    noteRuntimeFile(src, join(FLITTERBOT_DIR, file));
  }

  {
    const src = resolvePackagedRuntimeFile(`hooks/${HOOK_SCRIPT}`);
    if (src) noteRuntimeFile(src, join(FLITTERBOT_DIR, "hooks", HOOK_SCRIPT));
  }

  for (const file of SCRIPT_FILES) {
    const src = resolvePackagedRuntimeFile(`scripts/${file}`);
    if (!src) continue;
    noteRuntimeFile(src, join(FLITTERBOT_DIR, "scripts", file));
  }

  if (INSTALL_SCHEDULER) {
    for (const file of SCHEDULER_FILES) {
      const src = resolvePackagedRuntimeFile(`scheduler/${file}`);
      if (!src) continue;
      noteRuntimeFile(src, join(FLITTERBOT_DIR, "scheduler", file));
    }
  }

  for (const file of SOURCE_FILES) {
    const src = resolvePackagedSrcFile(file);
    if (!src) continue;
    noteRuntimeFile(src, join(FLITTERBOT_DIR, "src", file));
  }

  for (const file of BIN_FILES) {
    const src = resolvePackagedRuntimeFile(`bin/${file}`);
    if (!src) continue;
    noteRuntimeFile(src, join(FLITTERBOT_DIR, "bin", file));
  }

  for (const file of WHATSAPP_FILES) {
    const src = resolvePackagedRuntimeFile(`whatsapp/${file}`);
    if (!src) continue;
    noteRuntimeFile(src, join(FLITTERBOT_DIR, "whatsapp", file));
  }

  for (const file of WHATSAPP_EXEC_FILES) {
    const src = resolvePackagedRuntimeFile(`whatsapp/${file}`);
    if (!src) continue;
    noteRuntimeFile(src, join(FLITTERBOT_DIR, "whatsapp", file));
  }

  for (const file of CONTROL_SURFACE_AGENT_FILES) {
    const src = resolvePackagedRuntimeFile(`agent/${file}`);
    if (!src) continue;
    noteRuntimeFileIfMissing(src, join(FLITTERBOT_DIR, "control-surface", "agent", file));
  }

  const skillsSrcDir = resolvePackagedRepoDir(BUNDLED_SKILLS_DIR);
  const bundledSkillFiles = skillsSrcDir ? walkFiles(skillsSrcDir) : [];
  for (const file of bundledSkillFiles) {
    noteRuntimeFile(join(skillsSrcDir, file), join(FLITTERBOT_DIR, "skills", file));
  }

  if (PROJECT_ROOT) {
    noteTextFile(join(FLITTERBOT_DIR, "source-root"), PROJECT_ROOT + "\n");
  }

  if (!RUNTIME_CHANGES) {
    info("Runtime files already up to date.");
  } else {
    info("=== Runtime file deployment ===");
    process.stdout.write(RUNTIME_CHANGES);
    info("");

    if (await confirm()) {
      if (!DRY_RUN) {
        for (const file of TOP_LEVEL_FILES) {
          const src = resolvePackagedRuntimeFile(file);
          if (!src) continue;
          copyRuntimeFile(src, join(FLITTERBOT_DIR, file), 0o755);
        }

        {
          const src = resolvePackagedRuntimeFile(`hooks/${HOOK_SCRIPT}`);
          if (src) copyRuntimeFile(src, join(FLITTERBOT_DIR, "hooks", HOOK_SCRIPT), 0o755);
        }

        for (const file of SCRIPT_FILES) {
          const src = resolvePackagedRuntimeFile(`scripts/${file}`);
          if (!src) continue;
          copyRuntimeFile(src, join(FLITTERBOT_DIR, "scripts", file), 0o755);
        }

        if (INSTALL_SCHEDULER) {
          for (const file of SCHEDULER_FILES) {
            const src = resolvePackagedRuntimeFile(`scheduler/${file}`);
            if (!src) continue;
            copyRuntimeFile(src, join(FLITTERBOT_DIR, "scheduler", file), 0o755);
          }
        }

        for (const file of SOURCE_FILES) {
          const src = resolvePackagedSrcFile(file);
          if (!src) continue;
          copyRuntimeFile(src, join(FLITTERBOT_DIR, "src", file), 0o644);
        }

        for (const file of BIN_FILES) {
          const src = resolvePackagedRuntimeFile(`bin/${file}`);
          if (!src) continue;
          copyRuntimeFile(src, join(FLITTERBOT_DIR, "bin", file), 0o755);
        }

        for (const file of WHATSAPP_FILES) {
          const src = resolvePackagedRuntimeFile(`whatsapp/${file}`);
          if (!src) continue;
          copyRuntimeFile(src, join(FLITTERBOT_DIR, "whatsapp", file), 0o644);
        }

        for (const file of WHATSAPP_EXEC_FILES) {
          const src = resolvePackagedRuntimeFile(`whatsapp/${file}`);
          if (!src) continue;
          copyRuntimeFile(src, join(FLITTERBOT_DIR, "whatsapp", file), 0o755);
        }

        for (const file of CONTROL_SURFACE_AGENT_FILES) {
          const src = resolvePackagedRuntimeFile(`agent/${file}`);
          const dest = join(FLITTERBOT_DIR, "control-surface", "agent", file);
          if (!src || existsSync(dest)) continue;
          copyRuntimeFile(src, dest, 0o644);
        }

        for (const file of bundledSkillFiles) {
          copyRuntimeFile(join(skillsSrcDir, file), join(FLITTERBOT_DIR, "skills", file), 0o644);
        }

        if (PROJECT_ROOT) {
          writeRuntimeFile(join(FLITTERBOT_DIR, "source-root"), PROJECT_ROOT + "\n", 0o644);
        }
      }
    } else {
      info("Skipped runtime file deployment.");
    }
  }

  await bootstrapConfig();
  await bootstrapWhatsappConfig();
  initBlackboard();
  recordRuntimeTreeTarget();
}

async function installHooks() {
  let settingsBefore = {};
  let beforeHash = "null";
  const prefix = `${HOOKS_DIR}/`;
  const prefixNode = `node ${HOOKS_DIR}/`;

  if (existsSync(SETTINGS)) {
    try { settingsBefore = readJsonFile(SETTINGS); } catch {
      error("settings.json is malformed JSON. Aborting.");
      process.exit(1);
    }
    beforeHash = sha256File(SETTINGS);
  }

  let current = { ...settingsBefore };
  if (!current.hooks || typeof current.hooks !== "object") current.hooks = {};

  const isFlitterbotGroup = (group) => {
    return (group.hooks || []).some((h) => {
      const cmd = h.command || "";
      return cmd.startsWith(prefix) || cmd.startsWith(prefixNode);
    });
  };

  let changes = false;
  const deprecatedEvents = ["PreToolUse", "PostToolUse", "PostToolUseFailure", "SubagentStart", "SubagentStop"];
  for (const event of deprecatedEvents) {
    const groups = current.hooks[event] || [];
    const filtered = groups.filter((g) => !isFlitterbotGroup(g));
    if (filtered.length !== groups.length) {
      if (filtered.length === 0) {
        delete current.hooks[event];
      } else {
        current.hooks[event] = filtered;
      }
      changes = true;
    }
  }

  const modifications = [];
  for (const { event, arg } of HOOKS) {
    const hookCmd = `node ${HOOKS_DIR}/${HOOK_SCRIPT} ${arg}`;
    const desiredGroup = {
      matcher: "",
      hooks: [{ type: "command", command: hookCmd, async: true, timeout: 15 }],
    };

    const groups = current.hooks[event] || [];
    const flitterbotGroups = groups.filter(isFlitterbotGroup);
    const identicalGroups = flitterbotGroups.filter((g) => canonicalJson(g) === canonicalJson(desiredGroup));

    if (flitterbotGroups.length !== 1 || identicalGroups.length !== 1) {
      const nonFlitterbot = groups.filter((g) => !isFlitterbotGroup(g));
      current.hooks[event] = [...nonFlitterbot, desiredGroup];
      changes = true;
    }

    modifications.push({
      id: `hook:${event}`,
      action: "append",
      content: desiredGroup,
      content_sha256: sha256Text(canonicalJson(desiredGroup)),
    });
  }

  if (Object.keys(current.hooks).length === 0) delete current.hooks;

  if (!changes && existsSync(SETTINGS)) {
    info("Hooks already installed. No changes needed.");
  } else {
    info(`=== Hook changes to ${SETTINGS} ===`);
    console.log(showJsonDiff(SETTINGS, current));
    info("");

    if (await confirm()) {
      if (!DRY_RUN) {
        mkdirSync(dirname(SETTINGS), { recursive: true });
        writeJsonFile(SETTINGS, current);
      }
    } else {
      info("Skipped hooks install.");
      return;
    }
  }

  if (!DRY_RUN) {
    let afterHash = beforeHash;
    if (existsSync(SETTINGS)) afterHash = sha256File(SETTINGS);

    manifestWriteTarget("~/.claude/settings.json", {
      type: "json-merge",
      modifications,
      checksums: {
        algorithm: "sha256",
        file_before_install: beforeHash === "null" ? null : beforeHash,
        file_after_install: afterHash === "null" ? null : afterHash,
      },
    });
  }
}

async function installLaunchd() {
  if (CURRENT_OS !== "Darwin") return;

  const plistSrc = join(SCRIPT_DIR, "scheduler", "com.flitterbot.scheduler.plist");
  if (!existsSync(plistSrc)) { warn(`Missing plist template: ${plistSrc}`); return; }

  let plistContent = readFileSync(plistSrc, "utf8");
  plistContent = plistContent.replaceAll("__HOME__", HOME);
  plistContent = plistContent.replaceAll("__FLITTERBOT_DIR__", FLITTERBOT_DIR);

  let beforeHash = "null";
  if (existsSync(PLIST_DEST)) beforeHash = sha256File(PLIST_DEST);

  const tmpPlist = `/tmp/flitterbot-plist.${process.pid}`;
  writeFileSync(tmpPlist, plistContent);
  try {
    execSync(`plutil -lint "${tmpPlist}"`, { stdio: "pipe" });
  } catch {
    rmSync(tmpPlist, { force: true });
    error("Generated plist is invalid.");
    process.exit(1);
  }

  const newHash = sha256Text(plistContent);
  const existingHash = existsSync(PLIST_DEST) ? sha256File(PLIST_DEST) : "";

  if (existingHash === newHash) {
    info("launchd plist already installed. No changes needed.");
  } else {
    info("=== launchd changes ===");
    console.log(showTextDiff(PLIST_DEST, plistContent));
    info("");

    if (await confirm()) {
      if (!DRY_RUN) {
        mkdirSync(dirname(PLIST_DEST), { recursive: true });
        try { execSync(`launchctl bootout gui/$(id -u) "${PLIST_DEST}"`, { stdio: "pipe" }); } catch {}
        atomicWrite(PLIST_DEST, plistContent);
        chmodSync(PLIST_DEST, 0o644);
        try { execSync(`launchctl bootstrap gui/$(id -u) "${PLIST_DEST}"`, { stdio: "pipe" }); } catch {}
      }
    } else {
      rmSync(tmpPlist, { force: true });
      info("Skipped launchd install.");
      return;
    }
  }
  rmSync(tmpPlist, { force: true });

  if (!DRY_RUN) {
    const afterHash = sha256File(PLIST_DEST);
    manifestWriteTarget("~/Library/LaunchAgents/com.flitterbot.scheduler.plist", {
      type: "file-create",
      modifications: [{ id: "launchd:scheduler", action: "insert", content_sha256: afterHash }],
      checksums: {
        algorithm: "sha256",
        file_before_install: beforeHash === "null" ? null : beforeHash,
        file_after_install: afterHash,
      },
    });
  }
}

async function installLinuxSystemd() {
  if (CURRENT_OS !== "Linux") return;
  if (!systemctlUserAvailable()) {
    warn("systemd --user is unavailable; skipping Linux scheduler install.");
    return;
  }

  const serviceContent = renderSystemdService();
  const timerContent = renderSystemdTimer();

  let serviceBeforeHash = "null";
  let timerBeforeHash = "null";
  let serviceExistingHash = "";
  let timerExistingHash = "";

  if (existsSync(SYSTEMD_SERVICE_DEST)) {
    serviceBeforeHash = sha256File(SYSTEMD_SERVICE_DEST);
    serviceExistingHash = serviceBeforeHash;
  }
  if (existsSync(SYSTEMD_TIMER_DEST)) {
    timerBeforeHash = sha256File(SYSTEMD_TIMER_DEST);
    timerExistingHash = timerBeforeHash;
  }

  let needsChanges = false;
  if (serviceExistingHash !== sha256Text(serviceContent)) needsChanges = true;
  if (timerExistingHash !== sha256Text(timerContent)) needsChanges = true;

  let timerEnabled = false;
  let timerActive = false;
  try { execSync(`systemctl --user is-enabled ${SYSTEMD_TIMER_NAME}`, { stdio: "pipe" }); timerEnabled = true; } catch {}
  try { execSync(`systemctl --user is-active ${SYSTEMD_TIMER_NAME}`, { stdio: "pipe" }); timerActive = true; } catch {}
  if (!timerEnabled || !timerActive) needsChanges = true;

  let legacyBeforeText = "";
  let legacyAfterText = "";
  let legacyCleanupNeeded = false;
  if (commandExists("crontab")) {
    try { legacyBeforeText = execSync("crontab -l", { encoding: "utf8" }); } catch { legacyBeforeText = ""; }
    legacyAfterText = computeLegacyCrontabAfterText(legacyBeforeText);
    if (legacyBeforeText !== legacyAfterText) {
      legacyCleanupNeeded = true;
      needsChanges = true;
    }
  }

  if (!needsChanges) {
    info("Linux systemd user timer already installed. No changes needed.");
  } else {
    info("=== systemd user scheduler changes ===");
    console.log(showTextDiff(SYSTEMD_SERVICE_DEST, serviceContent));
    info("");
    console.log(showTextDiff(SYSTEMD_TIMER_DEST, timerContent));
    info("");
    if (!timerEnabled || !timerActive) {
      info(`Will run: systemctl --user enable --now ${SYSTEMD_TIMER_NAME}`);
      info("");
    }
    if (legacyCleanupNeeded) {
      info("=== Legacy crontab cleanup ===");
      console.log(diffText(legacyBeforeText + "\n", legacyAfterText + "\n"));
      info("");
    }

    if (await confirm()) {
      if (!DRY_RUN) {
        mkdirSync(SYSTEMD_USER_DIR, { recursive: true });
        atomicWrite(SYSTEMD_SERVICE_DEST, serviceContent);
        chmodSync(SYSTEMD_SERVICE_DEST, 0o644);
        atomicWrite(SYSTEMD_TIMER_DEST, timerContent);
        chmodSync(SYSTEMD_TIMER_DEST, 0o644);
        execSync("systemctl --user daemon-reload", { stdio: "pipe" });
        try {
          execSync(`systemctl --user enable --now ${SYSTEMD_TIMER_NAME}`, { stdio: "pipe" });
        } catch {
          warn(`Failed to enable/start ${SYSTEMD_TIMER_NAME}`);
        }
        if (legacyCleanupNeeded) {
          applyLegacyCrontabText(legacyAfterText);
          manifestDeleteTarget(LEGACY_CRONTAB_TARGET);
        }
      }
    } else {
      info("Skipped Linux systemd scheduler install.");
      return;
    }
  }

  if (!DRY_RUN) {
    const serviceAfterHash = sha256File(SYSTEMD_SERVICE_DEST);
    const timerAfterHash = sha256File(SYSTEMD_TIMER_DEST);

    manifestWriteTarget("~/.config/systemd/user/flitterbot-scheduler.service", {
      type: "file-create",
      modifications: [{ id: "systemd-user:scheduler-service", action: "upsert", content_sha256: serviceAfterHash }],
      checksums: {
        algorithm: "sha256",
        file_before_install: serviceBeforeHash === "null" ? null : serviceBeforeHash,
        file_after_install: serviceAfterHash,
      },
    });

    manifestWriteTarget("~/.config/systemd/user/flitterbot-scheduler.timer", {
      type: "file-create",
      modifications: [{ id: "systemd-user:scheduler-timer", action: "upsert", content_sha256: timerAfterHash }],
      checksums: {
        algorithm: "sha256",
        file_before_install: timerBeforeHash === "null" ? null : timerBeforeHash,
        file_after_install: timerAfterHash,
      },
    });
  }
}

async function installScheduler() {
  await installLaunchd();
  await installLinuxSystemd();
}

async function main() {
  preflight();
  await deployRuntimeFiles();
  await installHooks();
  if (INSTALL_SCHEDULER) {
    await installScheduler();
  } else {
    info("Skipping scheduler installation.");
  }
  info("");
  info("Installation complete.");
  if (!INSTALL_SCHEDULER) {
    info("Scheduler not installed. Re-run with --with-scheduler when ready.");
  }
  info(`To uninstall: ${FLITTERBOT_DIR}/uninstall.mjs`);
}

main().catch((e) => {
  error(`Install failed: ${e.message}`);
  process.exit(1);
});
