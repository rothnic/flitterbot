import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { KnownProvider } from "@earendil-works/pi-ai";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  type AgentSessionRuntime,
  type CreateAgentSessionRuntimeFactory,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { FlitterbotConfig, ThinkingLevel } from "../config/load-config.ts";
import { resolveModelEntry } from "../config/models.ts";
import { createPiAuthStorage, createPiModelRegistry } from "../pi-auth.ts";
import type { OrchestratorContext } from "../prompts/index.ts";
import { buildDefaultAgentPrompt, buildOrchestratorPrompt } from "../prompts/index.ts";

type OrchestratorInput = Omit<OrchestratorContext, "piSessionId" | "cwd">;

const HOME = os.homedir();

type StreamsRole = "default" | "orchestrator";

type CreateFlitterbotAgentOptions = {
  config: FlitterbotConfig;
  customTools: unknown[];
  role?: StreamsRole;
  orchestratorContext?: OrchestratorInput;
  resumeSessionFile?: string;
  cwd?: string;
  modelId?: string;
  tmuxEnabled?: boolean;
};

export type CreateFlitterbotAgentResult = {
  runtime: AgentSessionRuntime;
  modelInfo: {
    provider: string;
    id: string;
    entryId: string;
    thinkingLevel: ThinkingLevel;
  };
  resourceInfo: {
    skillNames: string[];
    agentsFilePaths: string[];
    skillMessages: string[];
  };
};

export async function createFlitterbotAgent(
  options: CreateFlitterbotAgentOptions,
): Promise<CreateFlitterbotAgentResult> {
  const {
    config,
    customTools,
    role = "default",
    orchestratorContext,
    resumeSessionFile,
    cwd,
  } = options;
  const workingDir = cwd ?? config.projectsDir;

  const sessionManager = resumeSessionFile
    ? SessionManager.open(resumeSessionFile, config.controlSurfaceSessionsDir)
    : SessionManager.create(workingDir, config.controlSurfaceSessionsDir);

  const promptRef = { value: "" };

  const builtInSkillPaths = [
    path.join(HOME, ".claude", "skills"),
    path.join(HOME, ".agents", "skills"),
  ];
  const skillPathWarnings: string[] = [];
  const additionalSkillPaths: string[] = [];
  if (fs.existsSync(config.flitterbotSkillsDir)) {
    additionalSkillPaths.push(config.flitterbotSkillsDir);
  } else {
    skillPathWarnings.push(`bundled skills directory missing: ${config.flitterbotSkillsDir}`);
  }
  additionalSkillPaths.push(...builtInSkillPaths.filter((entry) => fs.existsSync(entry)));
  for (const entry of config.extraSkillPaths) {
    if (fs.existsSync(entry)) {
      additionalSkillPaths.push(entry);
    } else {
      skillPathWarnings.push(`extraSkillPaths: missing directory skipped: ${entry}`);
    }
  }

  const homeAgentsMdPath = path.join(HOME, ".agents", "AGENTS.md");
  let homeAgentsMdEntry: { path: string; content: string } | null = null;
  try {
    if (fs.existsSync(homeAgentsMdPath)) {
      homeAgentsMdEntry = {
        path: homeAgentsMdPath,
        content: fs.readFileSync(homeAgentsMdPath, "utf-8"),
      };
    }
  } catch (err) {
    skillPathWarnings.push(
      `failed to read ${homeAgentsMdPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const shouldLetSessionRestoreModel = Boolean(resumeSessionFile) && !options.modelId;
  const modelEntry = shouldLetSessionRestoreModel
    ? undefined
    : resolveModelEntry(config, options.modelId);
  const model = modelEntry
    ? getBuiltinModel(modelEntry.provider as KnownProvider, modelEntry.modelId as never)
    : undefined;
  if (modelEntry && !model) {
    throw new Error(
      `Unable to resolve Pi model: provider=${modelEntry.provider} modelId=${modelEntry.modelId} (entry id=${modelEntry.id})`,
    );
  }
  const effectiveThinkingLevel: ThinkingLevel | undefined = modelEntry
    ? (modelEntry.thinkingLevel ?? config.defaultThinkingLevel)
    : undefined;
  const agentDir = config.controlSurfaceAgentDir;
  const authStorage = createPiAuthStorage(
    agentDir,
    modelEntry?.provider ?? resolveModelEntry(config).provider,
  );
  const modelRegistry = createPiModelRegistry(authStorage, agentDir);
  const settingsManager = SettingsManager.inMemory();
  settingsManager.setTransport(config.piTransport);

  const runtimeFactory: CreateAgentSessionRuntimeFactory = async (factoryOpts) => {
    const factoryPiSessionId = factoryOpts.sessionManager.getSessionId();
    promptRef.value = resolveSystemPrompt(
      role,
      factoryPiSessionId,
      factoryOpts.cwd,
      orchestratorContext,
      config.projectsDir,
      options.tmuxEnabled ?? false,
    );

    const services = await createAgentSessionServices({
      cwd: factoryOpts.cwd,
      agentDir: factoryOpts.agentDir,
      authStorage,
      settingsManager,
      modelRegistry,
      resourceLoaderOptions: {
        additionalSkillPaths,
        appendSystemPromptOverride: (base) => [...base, promptRef.value],
        agentsFilesOverride: (baseAgents) => {
          if (!homeAgentsMdEntry) return baseAgents;
          const already = baseAgents.agentsFiles.some((f) => f.path === homeAgentsMdEntry?.path);
          if (already) return baseAgents;
          return {
            agentsFiles: [homeAgentsMdEntry, ...baseAgents.agentsFiles],
          };
        },
      },
    });

    const result = await createAgentSessionFromServices({
      services,
      sessionManager: factoryOpts.sessionManager,
      sessionStartEvent: factoryOpts.sessionStartEvent,
      ...(model ? { model } : {}),
      ...(effectiveThinkingLevel ? { thinkingLevel: effectiveThinkingLevel } : {}),
      customTools: customTools as ToolDefinition[],
    });

    return { ...result, services, diagnostics: services.diagnostics };
  };

  const runtime = await createAgentSessionRuntime(runtimeFactory, {
    cwd: workingDir,
    agentDir,
    sessionManager,
  });

  const resourceLoader = runtime.services.resourceLoader;
  const { skills, diagnostics: skillDiagnostics } = resourceLoader.getSkills();
  const { agentsFiles } = resourceLoader.getAgentsFiles();
  const skillNames = skills.map((s) => s.name);
  const agentsFilePaths = agentsFiles.map((f) => f.path);
  const skillMessages: string[] = [...skillPathWarnings];
  for (const d of skillDiagnostics) {
    if (d.type === "collision" && d.collision) {
      skillMessages.push(
        `skill name collision: "${d.collision.name}" — keeping ${d.collision.winnerPath}, ignoring ${d.collision.loserPath}`,
      );
    } else if (d.type === "warning" || d.type === "error") {
      skillMessages.push(`skill ${d.type}: ${d.message}${d.path ? ` (${d.path})` : ""}`);
    }
  }

  const currentModel = runtime.session.model;
  if (!currentModel) {
    throw new Error("Pi session started without a resolved model");
  }
  const currentThinkingLevel = runtime.session.thinkingLevel;

  return {
    runtime,
    modelInfo: {
      provider: currentModel.provider,
      id: currentModel.id,
      entryId: resolveModelEntryId(config, currentModel.provider, currentModel.id),
      thinkingLevel: currentThinkingLevel,
    },
    resourceInfo: {
      skillNames,
      agentsFilePaths,
      skillMessages,
    },
  };
}

function resolveModelEntryId(config: FlitterbotConfig, provider: string, modelId: string): string {
  return (
    config.models.find((entry) => entry.provider === provider && entry.modelId === modelId)?.id ??
    `${provider}/${modelId}`
  );
}

function resolveSystemPrompt(
  role: StreamsRole,
  piSessionId: string,
  cwd: string,
  ctx?: OrchestratorInput,
  projectsDir?: string,
  tmuxEnabled = false,
): string {
  if (role === "orchestrator") {
    if (!ctx) throw new Error("orchestratorContext is required for orchestrator role");
    return buildOrchestratorPrompt({ ...ctx, piSessionId, cwd }, { tmux: tmuxEnabled });
  }
  return buildDefaultAgentPrompt(piSessionId, projectsDir ?? cwd);
}
