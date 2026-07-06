import "dotenv/config";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ShortcutBindingsConfig } from "../contracts/control-surface-api.ts";

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];
export type PiTransport = "sse" | "websocket" | "websocket-cached" | "auto";
export const CLASSIFIER_PROVIDERS = [
  "groq",
  "openai",
  "openai-compatible",
  "pi",
  "disabled",
] as const;
export type ClassifierProvider = (typeof CLASSIFIER_PROVIDERS)[number];
export const CODEX_APPROVAL_POLICIES = ["never", "on-request", "on-failure", "untrusted"] as const;
export type CodexApprovalPolicy = (typeof CODEX_APPROVAL_POLICIES)[number];
export const CODEX_SANDBOX_POLICIES = [
  "read-only",
  "workspace-write",
  "danger-full-access",
] as const;
export type CodexSandboxPolicy = (typeof CODEX_SANDBOX_POLICIES)[number];

export function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value);
}

export type ModelConfigEntry = {
  id: string;
  label: string;
  provider: string;
  modelId: string;
  thinkingLevel?: ThinkingLevel;
};

export type ClassifierConfig = {
  provider: ClassifierProvider;
  model: string;
  apiKeyEnv: string;
  baseURL?: string;
  maxTokens: number;
};

export type CodexWorkerProfile = {
  id: string;
  label: string;
  model?: string;
  approvalPolicy: CodexApprovalPolicy;
  sandbox: CodexSandboxPolicy;
  baseInstructions?: string;
  developerInstructions?: string;
  context?: string;
  skillNames: string[];
  skillPaths: string[];
};

export type WorkerHostConfig = {
  id: string;
  displayName: string;
  connectionMode: "local-stdio" | "ssh-stdio" | "unix-socket" | "websocket-auth";
  connectionTarget?: string;
  projectsRoot?: string;
  codexHome?: string;
  maxConcurrentWorkers: number;
  capabilities: Record<string, unknown>;
};

type RawConfigJson = {
  controlSurfaceHost?: unknown;
  controlSurfacePort?: unknown;
  controlSurfaceToken?: unknown;
  controlSurfaceCommand?: unknown;
  models?: unknown;
  defaultModel?: unknown;
  defaultThinkingLevel?: unknown;
  classifier?: unknown;
  defaultCodexWorkerProfile?: unknown;
  codexWorkerProfiles?: unknown;
  workerHosts?: unknown;
  piTransport?: unknown;
  stallMinutes?: unknown;
  toolTimeoutMinutes?: unknown;
  blackboardPath?: unknown;
  whatsappAuthDir?: unknown;
  whatsappSocketPath?: unknown;
  whatsappPidPath?: unknown;
  whatsappCliPath?: unknown;
  whatsappDaemonPath?: unknown;
  claudeCliCommand?: unknown;
  projectsDir?: unknown;
  projectRoot?: unknown;
  sourceRoot?: unknown;
  wipeStreamsOnStart?: unknown;
  whatsappEnabled?: unknown;
  shortcuts?: unknown;
  defaultAgentFirstMessage?: unknown;
  newStreamFirstMessageFooter?: unknown;
  tmuxEnabled?: unknown;
  extraSkillPaths?: unknown;
  learningsNotePath?: unknown;
  todoistApiKey?: unknown;
  linearApiKey?: unknown;
};

// ponytail: this accepted-key list duplicates RawConfigJson; derive it from a schema object if config keeps growing.
const ACCEPTED_CONFIG_KEYS = [
  "controlSurfaceHost",
  "controlSurfacePort",
  "controlSurfaceToken",
  "controlSurfaceCommand",
  "models",
  "defaultModel",
  "defaultThinkingLevel",
  "classifier",
  "defaultCodexWorkerProfile",
  "codexWorkerProfiles",
  "workerHosts",
  "piTransport",
  "stallMinutes",
  "toolTimeoutMinutes",
  "blackboardPath",
  "whatsappAuthDir",
  "whatsappSocketPath",
  "whatsappPidPath",
  "whatsappCliPath",
  "whatsappDaemonPath",
  "claudeCliCommand",
  "projectsDir",
  "projectRoot",
  "sourceRoot",
  "wipeStreamsOnStart",
  "whatsappEnabled",
  "shortcuts",
  "defaultAgentFirstMessage",
  "newStreamFirstMessageFooter",
  "tmuxEnabled",
  "extraSkillPaths",
  "learningsNotePath",
  "todoistApiKey",
  "linearApiKey",
] as const satisfies readonly (keyof RawConfigJson)[];

const ACCEPTED_MODEL_CONFIG_KEYS = ["id", "label", "provider", "modelId", "thinkingLevel"] as const;
const ACCEPTED_CLASSIFIER_CONFIG_KEYS = [
  "provider",
  "model",
  "apiKeyEnv",
  "baseURL",
  "maxTokens",
] as const;
const ACCEPTED_CODEX_WORKER_PROFILE_KEYS = [
  "id",
  "label",
  "model",
  "approvalPolicy",
  "sandbox",
  "baseInstructions",
  "developerInstructions",
  "context",
  "skillNames",
  "skillPaths",
] as const;
const ACCEPTED_WORKER_HOST_KEYS = [
  "id",
  "displayName",
  "connectionMode",
  "connectionTarget",
  "projectsRoot",
  "codexHome",
  "maxConcurrentWorkers",
  "capabilities",
] as const;

const ACCEPTED_CONFIG_KEY_SET = new Set<string>(ACCEPTED_CONFIG_KEYS);
const ACCEPTED_MODEL_CONFIG_KEY_SET = new Set<string>(ACCEPTED_MODEL_CONFIG_KEYS);
const ACCEPTED_CLASSIFIER_CONFIG_KEY_SET = new Set<string>(ACCEPTED_CLASSIFIER_CONFIG_KEYS);
const ACCEPTED_CODEX_WORKER_PROFILE_KEY_SET = new Set<string>(ACCEPTED_CODEX_WORKER_PROFILE_KEYS);
const ACCEPTED_WORKER_HOST_KEY_SET = new Set<string>(ACCEPTED_WORKER_HOST_KEYS);

export type FlitterbotConfig = {
  controlSurfaceHost: string;
  controlSurfacePort: number;
  controlSurfaceToken: string;
  models: ModelConfigEntry[];
  defaultModel: string;
  defaultThinkingLevel: ThinkingLevel;
  classifier: ClassifierConfig;
  defaultCodexWorkerProfile: string;
  codexWorkerProfiles: CodexWorkerProfile[];
  workerHosts: WorkerHostConfig[];
  piTransport: PiTransport;
  stallMinutes: number;
  toolTimeoutMinutes: number;
  blackboardPath: string;
  whatsappAuthDir: string;
  whatsappSocketPath: string;
  whatsappPidPath: string;
  whatsappCliPath: string;
  whatsappDaemonPath: string;
  claudeCliCommand: string;
  controlSurfaceDir: string;
  controlSurfaceSessionsDir: string;
  controlSurfaceAgentDir: string;
  controlSurfacePidPath: string;
  controlSurfaceLogPath: string;
  projectsDir: string;
  wipeStreamsOnStart: boolean;
  whatsappEnabled: boolean;
  shortcuts: ShortcutBindingsConfig;
  defaultAgentFirstMessage: string;
  newStreamFirstMessageFooter: string;
  flitterbotSkillsDir: string;
  tmuxEnabled: boolean;
  extraSkillPaths: string[];
  learningsNotePath: string;
};

export const TMUX_SKILL_DIRECTIVE = "/skill:tmux";
export const SUGGESTED_TMUX_FIRST_MESSAGE_FOOTER =
  "IMPORTANT! Before doing  anything else, load the /skill:tmux pls";

const HOME = os.homedir();
const FLITTERBOT_DIR = path.join(HOME, ".flitterbot");
const CONFIG_PATH = path.join(FLITTERBOT_DIR, "config.json");
export const FLITTERBOT_CONFIG_PATH = CONFIG_PATH;

export const DEFAULT_CLASSIFIER_CONFIG: ClassifierConfig = {
  provider: "groq",
  model: "openai/gpt-oss-120b",
  apiKeyEnv: "GROQ_API_KEY",
  baseURL: "https://api.groq.com/openai/v1",
  maxTokens: 1024,
};

export const DEFAULT_CODEX_WORKER_PROFILES: CodexWorkerProfile[] = [
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

export const DEFAULT_WORKER_HOSTS: WorkerHostConfig[] = [
  {
    id: "local",
    displayName: "Local machine",
    connectionMode: "local-stdio",
    projectsRoot: "~/workspace",
    codexHome: "~/.codex",
    maxConcurrentWorkers: 1,
    capabilities: {
      role: "local",
    },
  },
];

function expandHome(value: string): string {
  if (!value) return value;
  if (value === "~") return HOME;
  if (value.startsWith("~/")) return path.join(HOME, value.slice(2));
  return value;
}

function ensureDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readRequiredJsonFile(filePath: string): RawConfigJson {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Missing config file: ${filePath}. Run installer to populate config.json.`);
  }
  const raw = fs.readFileSync(filePath, "utf8").trim();
  if (!raw)
    throw new Error(`Empty config file: ${filePath}. Run installer to populate config.json.`);
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Invalid config file: ${filePath} must contain a JSON object.`);
  }

  validateKnownConfigKeys(parsed as Record<string, unknown>, filePath);
  return parsed as RawConfigJson;
}

function collectUnknownConfigKeys(raw: Record<string, unknown>): string[] {
  const unknownKeys = Object.keys(raw)
    .filter((key) => !ACCEPTED_CONFIG_KEY_SET.has(key))
    .map((key) => `"${key}"`);

  if (Array.isArray(raw.models)) {
    for (const [index, entry] of raw.models.entries()) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      for (const key of Object.keys(entry)) {
        if (!ACCEPTED_MODEL_CONFIG_KEY_SET.has(key)) {
          unknownKeys.push(`"models[${index}].${key}"`);
        }
      }
    }
  }

  if (raw.classifier && typeof raw.classifier === "object" && !Array.isArray(raw.classifier)) {
    for (const key of Object.keys(raw.classifier)) {
      if (!ACCEPTED_CLASSIFIER_CONFIG_KEY_SET.has(key)) {
        unknownKeys.push(`"classifier.${key}"`);
      }
    }
  }

  if (Array.isArray(raw.codexWorkerProfiles)) {
    for (const [index, entry] of raw.codexWorkerProfiles.entries()) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      for (const key of Object.keys(entry)) {
        if (!ACCEPTED_CODEX_WORKER_PROFILE_KEY_SET.has(key)) {
          unknownKeys.push(`"codexWorkerProfiles[${index}].${key}"`);
        }
      }
    }
  }

  if (Array.isArray(raw.workerHosts)) {
    for (const [index, entry] of raw.workerHosts.entries()) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      for (const key of Object.keys(entry)) {
        if (!ACCEPTED_WORKER_HOST_KEY_SET.has(key)) {
          unknownKeys.push(`"workerHosts[${index}].${key}"`);
        }
      }
    }
  }

  return unknownKeys.sort();
}

export function validateKnownConfigKeys(
  raw: Record<string, unknown>,
  filePath = FLITTERBOT_CONFIG_PATH,
): void {
  const unknownKeys = collectUnknownConfigKeys(raw);
  if (unknownKeys.length === 0) return;

  const keyNoun = unknownKeys.length === 1 ? "key" : "keys";
  const removePhrase = unknownKeys.length === 1 ? "Remove this key" : "Remove these keys";
  throw new Error(
    `Invalid startup config ${filePath}: unknown config ${keyNoun}: ${unknownKeys.join(", ")}. ${removePhrase} from ${filePath}.`,
  );
}

function requireConfigString(raw: RawConfigJson, key: keyof RawConfigJson): string {
  const value = raw[key];
  if (typeof value === "string") return value;
  throw new Error(`Missing required string config key: ${String(key)}`);
}

function requireConfigNumber(raw: RawConfigJson, key: keyof RawConfigJson): number {
  const value = raw[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  throw new Error(`Missing required numeric config key: ${String(key)}`);
}

function requireConfigBoolean(raw: RawConfigJson, key: keyof RawConfigJson): boolean {
  const value = raw[key];
  if (typeof value === "boolean") return value;
  throw new Error(`Missing required boolean config key: ${String(key)}`);
}

function requireConfigArray(raw: RawConfigJson, key: keyof RawConfigJson): unknown[] {
  const value = raw[key];
  if (Array.isArray(value)) return value;
  throw new Error(`Missing required array config key: ${String(key)}`);
}

function requireConfigObject<T extends Record<string, unknown>>(
  raw: RawConfigJson,
  key: keyof RawConfigJson,
): T {
  const value = raw[key];
  if (value && typeof value === "object" && !Array.isArray(value)) return value as T;
  throw new Error(`Missing required object config key: ${String(key)}`);
}

function requireThinkingLevel(raw: RawConfigJson): ThinkingLevel {
  const value = raw.defaultThinkingLevel;
  if (isThinkingLevel(value)) return value;
  throw new Error(
    `Invalid required config key defaultThinkingLevel: expected one of ${THINKING_LEVELS.join(", ")}`,
  );
}

function requirePiTransport(raw: RawConfigJson): PiTransport {
  const value = raw.piTransport;
  if (
    value === "sse" ||
    value === "websocket" ||
    value === "websocket-cached" ||
    value === "auto"
  ) {
    return value;
  }
  throw new Error(
    "Invalid required config key piTransport: expected sse, websocket, websocket-cached, or auto",
  );
}

function parseExtraSkillPaths(raw: RawConfigJson): string[] {
  const input = requireConfigArray(raw, "extraSkillPaths");
  const seen = new Set<string>();
  const out: string[] = [];
  for (const [index, entry] of input.entries()) {
    if (typeof entry !== "string" || !entry.trim()) {
      throw new Error(`Invalid extraSkillPaths[${index}]: expected non-empty string`);
    }
    const expanded = expandHome(entry.trim());
    const absolute = path.resolve(expanded);
    if (seen.has(absolute)) continue;
    seen.add(absolute);
    out.push(absolute);
  }
  return out;
}

function isClassifierProvider(value: unknown): value is ClassifierProvider {
  return typeof value === "string" && (CLASSIFIER_PROVIDERS as readonly string[]).includes(value);
}

function isCodexApprovalPolicy(value: unknown): value is CodexApprovalPolicy {
  return (
    typeof value === "string" && (CODEX_APPROVAL_POLICIES as readonly string[]).includes(value)
  );
}

function isCodexSandboxPolicy(value: unknown): value is CodexSandboxPolicy {
  return typeof value === "string" && (CODEX_SANDBOX_POLICIES as readonly string[]).includes(value);
}

function optionalNonEmptyString(
  obj: Record<string, unknown>,
  key: string,
  context: string,
): string | undefined {
  const value = obj[key];
  if (value === undefined) return undefined;
  if (typeof value === "string" && value.trim()) return value.trim();
  throw new Error(`Invalid ${context}.${key}: expected non-empty string`);
}

function parseStringList(
  value: unknown,
  context: string,
  options: { expandPaths?: boolean } = {},
): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`Invalid ${context}: expected array`);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const [index, entry] of value.entries()) {
    if (typeof entry !== "string" || !entry.trim()) {
      throw new Error(`Invalid ${context}[${index}]: expected non-empty string`);
    }
    const parsed = options.expandPaths ? path.resolve(expandHome(entry.trim())) : entry.trim();
    if (seen.has(parsed)) continue;
    seen.add(parsed);
    out.push(parsed);
  }
  return out;
}

export function parseClassifierConfig(raw: RawConfigJson): ClassifierConfig {
  if (raw.classifier === undefined) return { ...DEFAULT_CLASSIFIER_CONFIG };
  if (!raw.classifier || typeof raw.classifier !== "object" || Array.isArray(raw.classifier)) {
    throw new Error("Invalid classifier: expected object");
  }
  const input = raw.classifier as Record<string, unknown>;
  const provider = input.provider ?? DEFAULT_CLASSIFIER_CONFIG.provider;
  if (!isClassifierProvider(provider)) {
    throw new Error(
      `Invalid classifier.provider: expected one of ${CLASSIFIER_PROVIDERS.join(", ")}`,
    );
  }
  if (provider === "disabled") {
    return {
      provider,
      model:
        typeof input.model === "string" && input.model.trim()
          ? input.model.trim()
          : DEFAULT_CLASSIFIER_CONFIG.model,
      apiKeyEnv:
        typeof input.apiKeyEnv === "string" && input.apiKeyEnv.trim()
          ? input.apiKeyEnv.trim()
          : DEFAULT_CLASSIFIER_CONFIG.apiKeyEnv,
      baseURL:
        typeof input.baseURL === "string" && input.baseURL.trim()
          ? input.baseURL.trim()
          : undefined,
      maxTokens:
        typeof input.maxTokens === "number" && Number.isFinite(input.maxTokens)
          ? Math.trunc(input.maxTokens)
          : DEFAULT_CLASSIFIER_CONFIG.maxTokens,
    };
  }

  const model = input.model ?? DEFAULT_CLASSIFIER_CONFIG.model;
  const apiKeyEnv = input.apiKeyEnv ?? DEFAULT_CLASSIFIER_CONFIG.apiKeyEnv;
  if (typeof model !== "string" || !model.trim()) {
    throw new Error("Invalid classifier.model: expected non-empty string");
  }
  if (typeof apiKeyEnv !== "string" || !apiKeyEnv.trim()) {
    throw new Error("Invalid classifier.apiKeyEnv: expected non-empty string");
  }

  const maxTokens = input.maxTokens ?? DEFAULT_CLASSIFIER_CONFIG.maxTokens;
  if (typeof maxTokens !== "number" || !Number.isFinite(maxTokens) || maxTokens <= 0) {
    throw new Error("Invalid classifier.maxTokens: expected positive number");
  }

  const parsed: ClassifierConfig = {
    provider,
    model: model.trim(),
    apiKeyEnv: apiKeyEnv.trim(),
    maxTokens: Math.trunc(maxTokens),
  };
  const baseURL =
    input.baseURL ?? (provider === "groq" ? DEFAULT_CLASSIFIER_CONFIG.baseURL : undefined);
  if (baseURL !== undefined) {
    if (typeof baseURL !== "string" || !baseURL.trim()) {
      throw new Error("Invalid classifier.baseURL: expected non-empty string");
    }
    parsed.baseURL = baseURL.trim();
  }
  return parsed;
}

export function parseCodexWorkerProfiles(raw: RawConfigJson): {
  defaultCodexWorkerProfile: string;
  codexWorkerProfiles: CodexWorkerProfile[];
} {
  const input = raw.codexWorkerProfiles ?? DEFAULT_CODEX_WORKER_PROFILES;
  if (!Array.isArray(input) || input.length === 0) {
    throw new Error("Invalid codexWorkerProfiles: expected non-empty array");
  }

  const seen = new Set<string>();
  const profiles = input.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`Invalid codexWorkerProfiles[${index}]: expected object`);
    }
    const profile = entry as Record<string, unknown>;
    const id = profile.id;
    const label = profile.label;
    if (typeof id !== "string" || !id.trim()) {
      throw new Error(`Invalid codexWorkerProfiles[${index}].id: expected non-empty string`);
    }
    const trimmedId = id.trim();
    if (seen.has(trimmedId)) throw new Error(`Duplicate codex worker profile id: ${trimmedId}`);
    seen.add(trimmedId);
    if (typeof label !== "string" || !label.trim()) {
      throw new Error(`Invalid codexWorkerProfiles[${index}].label: expected non-empty string`);
    }

    const approvalPolicy = profile.approvalPolicy ?? "never";
    if (!isCodexApprovalPolicy(approvalPolicy)) {
      throw new Error(
        `Invalid codexWorkerProfiles[${index}].approvalPolicy: expected one of ${CODEX_APPROVAL_POLICIES.join(", ")}`,
      );
    }
    const sandbox = profile.sandbox ?? "workspace-write";
    if (!isCodexSandboxPolicy(sandbox)) {
      throw new Error(
        `Invalid codexWorkerProfiles[${index}].sandbox: expected one of ${CODEX_SANDBOX_POLICIES.join(", ")}`,
      );
    }

    const parsed: CodexWorkerProfile = {
      id: trimmedId,
      label: label.trim(),
      approvalPolicy,
      sandbox,
      skillNames: parseStringList(profile.skillNames, `codexWorkerProfiles[${index}].skillNames`),
      skillPaths: parseStringList(profile.skillPaths, `codexWorkerProfiles[${index}].skillPaths`, {
        expandPaths: true,
      }),
    };
    const model = optionalNonEmptyString(profile, "model", `codexWorkerProfiles[${index}]`);
    const baseInstructions = optionalNonEmptyString(
      profile,
      "baseInstructions",
      `codexWorkerProfiles[${index}]`,
    );
    const developerInstructions = optionalNonEmptyString(
      profile,
      "developerInstructions",
      `codexWorkerProfiles[${index}]`,
    );
    const context = optionalNonEmptyString(profile, "context", `codexWorkerProfiles[${index}]`);
    if (model) parsed.model = model;
    if (baseInstructions) parsed.baseInstructions = baseInstructions;
    if (developerInstructions) parsed.developerInstructions = developerInstructions;
    if (context) parsed.context = context;
    return parsed;
  });

  const defaultProfile =
    typeof raw.defaultCodexWorkerProfile === "string" && raw.defaultCodexWorkerProfile.trim()
      ? raw.defaultCodexWorkerProfile.trim()
      : DEFAULT_CODEX_WORKER_PROFILES[0]!.id;
  if (!profiles.some((profile) => profile.id === defaultProfile)) {
    throw new Error(
      `Invalid defaultCodexWorkerProfile "${defaultProfile}": expected one of ${profiles
        .map((profile) => profile.id)
        .join(", ")}`,
    );
  }

  return {
    defaultCodexWorkerProfile: defaultProfile,
    codexWorkerProfiles: profiles,
  };
}

function isWorkerHostConnectionMode(value: unknown): value is WorkerHostConfig["connectionMode"] {
  return (
    value === "local-stdio" ||
    value === "ssh-stdio" ||
    value === "unix-socket" ||
    value === "websocket-auth"
  );
}

export function parseWorkerHosts(raw: RawConfigJson): WorkerHostConfig[] {
  const input = raw.workerHosts ?? DEFAULT_WORKER_HOSTS;
  if (!Array.isArray(input) || input.length === 0) {
    throw new Error("Invalid workerHosts: expected non-empty array");
  }

  const seen = new Set<string>();
  return input.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`Invalid workerHosts[${index}]: expected object`);
    }
    const host = entry as Record<string, unknown>;
    const id = host.id;
    const displayName = host.displayName;
    const connectionMode = host.connectionMode;
    if (typeof id !== "string" || !id.trim()) {
      throw new Error(`Invalid workerHosts[${index}].id: expected non-empty string`);
    }
    const trimmedId = id.trim();
    if (seen.has(trimmedId)) throw new Error(`Duplicate worker host id: ${trimmedId}`);
    seen.add(trimmedId);
    if (typeof displayName !== "string" || !displayName.trim()) {
      throw new Error(`Invalid workerHosts[${index}].displayName: expected non-empty string`);
    }
    if (!isWorkerHostConnectionMode(connectionMode)) {
      throw new Error(
        "Invalid workerHosts[" +
          index +
          "].connectionMode: expected local-stdio, ssh-stdio, unix-socket, or websocket-auth",
      );
    }

    const maxConcurrentWorkers = host.maxConcurrentWorkers ?? 1;
    if (
      typeof maxConcurrentWorkers !== "number" ||
      !Number.isFinite(maxConcurrentWorkers) ||
      maxConcurrentWorkers <= 0
    ) {
      throw new Error(
        `Invalid workerHosts[${index}].maxConcurrentWorkers: expected positive number`,
      );
    }
    const capabilities = host.capabilities ?? {};
    if (!capabilities || typeof capabilities !== "object" || Array.isArray(capabilities)) {
      throw new Error(`Invalid workerHosts[${index}].capabilities: expected object`);
    }

    const parsed: WorkerHostConfig = {
      id: trimmedId,
      displayName: displayName.trim(),
      connectionMode,
      maxConcurrentWorkers: Math.trunc(maxConcurrentWorkers),
      capabilities: capabilities as Record<string, unknown>,
    };
    const connectionTarget = optionalNonEmptyString(
      host,
      "connectionTarget",
      `workerHosts[${index}]`,
    );
    const projectsRoot = optionalNonEmptyString(host, "projectsRoot", `workerHosts[${index}]`);
    const codexHome = optionalNonEmptyString(host, "codexHome", `workerHosts[${index}]`);
    if (connectionTarget) parsed.connectionTarget = connectionTarget;
    if (projectsRoot) parsed.projectsRoot = path.resolve(expandHome(projectsRoot));
    if (codexHome) parsed.codexHome = path.resolve(expandHome(codexHome));
    if (connectionMode === "ssh-stdio" && !parsed.connectionTarget) {
      throw new Error(`Invalid workerHosts[${index}]: ssh-stdio requires connectionTarget`);
    }
    return parsed;
  });
}

function parseModels(raw: RawConfigJson): ModelConfigEntry[] {
  const input = requireConfigArray(raw, "models");
  if (input.length === 0) throw new Error("Config key models must contain at least one model");

  const seen = new Set<string>();
  return input.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`Invalid models[${index}]: expected object`);
    }
    const model = entry as Record<string, unknown>;
    const id = model.id;
    const label = model.label;
    const provider = model.provider;
    const modelId = model.modelId;
    if (typeof id !== "string" || !id.trim()) {
      throw new Error(`Invalid models[${index}].id: expected non-empty string`);
    }
    if (seen.has(id)) throw new Error(`Duplicate model id in config.models: ${id}`);
    seen.add(id);
    if (typeof label !== "string" || !label.trim()) {
      throw new Error(`Invalid models[${index}].label: expected non-empty string`);
    }
    if (typeof provider !== "string" || !provider.trim()) {
      throw new Error(`Invalid models[${index}].provider: expected non-empty string`);
    }
    if (typeof modelId !== "string" || !modelId.trim()) {
      throw new Error(`Invalid models[${index}].modelId: expected non-empty string`);
    }

    const parsed: ModelConfigEntry = { id, label, provider, modelId };
    if (model.thinkingLevel !== undefined) {
      if (!isThinkingLevel(model.thinkingLevel)) {
        throw new Error(
          `Invalid models[${index}].thinkingLevel: expected one of ${THINKING_LEVELS.join(", ")}`,
        );
      }
      parsed.thinkingLevel = model.thinkingLevel;
    }
    return parsed;
  });
}

function resolveDefaultModel(raw: RawConfigJson, models: ModelConfigEntry[]): string {
  const configured = requireConfigString(raw, "defaultModel");
  if (models.some((m) => m.id === configured)) return configured;
  const [provider, modelId] = configured.split("/", 2);
  if (provider && modelId) return configured;
  throw new Error(
    `Invalid defaultModel "${configured}": expected a models[].id or provider/modelId pair`,
  );
}

export function validateTmuxStreamFooterConfig(
  config: Pick<FlitterbotConfig, "newStreamFirstMessageFooter" | "tmuxEnabled">,
): void {
  const footerHasTmuxSkill = config.newStreamFirstMessageFooter.includes(TMUX_SKILL_DIRECTIVE);

  if (!config.tmuxEnabled && footerHasTmuxSkill) {
    throw new Error(
      `Invalid startup config ${FLITTERBOT_CONFIG_PATH}: newStreamFirstMessageFooter includes ${TMUX_SKILL_DIRECTIVE} but tmuxEnabled is false. Remove the tmux skill footer or set "tmuxEnabled": true.`,
    );
  }

  if (config.tmuxEnabled && !footerHasTmuxSkill) {
    throw new Error(
      `Invalid startup config ${FLITTERBOT_CONFIG_PATH}: tmuxEnabled is true but newStreamFirstMessageFooter does not include ${TMUX_SKILL_DIRECTIVE}. Add "newStreamFirstMessageFooter": "${SUGGESTED_TMUX_FIRST_MESSAGE_FOOTER}" to ${FLITTERBOT_CONFIG_PATH}.`,
    );
  }
}

export function loadConfig(): FlitterbotConfig {
  ensureDir(FLITTERBOT_DIR);
  ensureDir(path.join(FLITTERBOT_DIR, "logs"));

  const raw = readRequiredJsonFile(CONFIG_PATH);
  const controlSurfaceDir = path.join(FLITTERBOT_DIR, "control-surface");
  const sessionsDir = path.join(controlSurfaceDir, "sessions");
  const agentDir = path.join(controlSurfaceDir, "agent");
  const pidPath = path.join(controlSurfaceDir, "server.pid");
  const logPath = path.join(FLITTERBOT_DIR, "logs", "control-surface.log");

  const models = parseModels(raw);
  const defaultModel = resolveDefaultModel(raw, models);
  const workerProfiles = parseCodexWorkerProfiles(raw);
  const workerHosts = parseWorkerHosts(raw);
  const config: FlitterbotConfig = {
    controlSurfaceHost: requireConfigString(raw, "controlSurfaceHost"),
    controlSurfacePort: requireConfigNumber(raw, "controlSurfacePort"),
    controlSurfaceToken: requireConfigString(raw, "controlSurfaceToken"),
    models,
    defaultModel,
    defaultThinkingLevel: requireThinkingLevel(raw),
    classifier: parseClassifierConfig(raw),
    defaultCodexWorkerProfile: workerProfiles.defaultCodexWorkerProfile,
    codexWorkerProfiles: workerProfiles.codexWorkerProfiles,
    workerHosts,
    piTransport: requirePiTransport(raw),
    stallMinutes: requireConfigNumber(raw, "stallMinutes"),
    toolTimeoutMinutes: requireConfigNumber(raw, "toolTimeoutMinutes"),
    blackboardPath: expandHome(requireConfigString(raw, "blackboardPath")),
    whatsappAuthDir: expandHome(requireConfigString(raw, "whatsappAuthDir")),
    whatsappSocketPath: expandHome(requireConfigString(raw, "whatsappSocketPath")),
    whatsappPidPath: expandHome(requireConfigString(raw, "whatsappPidPath")),
    whatsappCliPath: expandHome(requireConfigString(raw, "whatsappCliPath")),
    whatsappDaemonPath: expandHome(requireConfigString(raw, "whatsappDaemonPath")),
    claudeCliCommand: requireConfigString(raw, "claudeCliCommand"),
    projectsDir: expandHome(requireConfigString(raw, "projectsDir")),
    wipeStreamsOnStart: requireConfigBoolean(raw, "wipeStreamsOnStart"),
    whatsappEnabled: requireConfigBoolean(raw, "whatsappEnabled"),
    shortcuts: requireConfigObject<ShortcutBindingsConfig>(raw, "shortcuts"),
    defaultAgentFirstMessage: requireConfigString(raw, "defaultAgentFirstMessage"),
    newStreamFirstMessageFooter: requireConfigString(raw, "newStreamFirstMessageFooter"),
    flitterbotSkillsDir: path.join(FLITTERBOT_DIR, "skills"),
    tmuxEnabled: requireConfigBoolean(raw, "tmuxEnabled"),
    extraSkillPaths: parseExtraSkillPaths(raw),
    learningsNotePath: expandHome(requireConfigString(raw, "learningsNotePath")),

    controlSurfaceDir,
    controlSurfaceSessionsDir: sessionsDir,
    controlSurfaceAgentDir: agentDir,
    controlSurfacePidPath: pidPath,
    controlSurfaceLogPath: logPath,
  };

  validateTmuxStreamFooterConfig(config);

  ensureDir(config.projectsDir);
  ensureDir(controlSurfaceDir);
  ensureDir(sessionsDir);
  ensureDir(agentDir);
  ensureDir(config.flitterbotSkillsDir);
  ensureDir(path.join(FLITTERBOT_DIR, "data", "tasks"));
  ensureDir(path.join(FLITTERBOT_DIR, "data", "notes"));
  ensureDir(path.dirname(config.learningsNotePath));
  ensureDir(path.dirname(logPath));
  ensureDir(path.dirname(config.blackboardPath));
  ensureDir(path.dirname(config.whatsappSocketPath));
  ensureDir(path.dirname(config.whatsappPidPath));
  ensureDir(config.whatsappAuthDir);

  return config;
}
