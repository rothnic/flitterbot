import type { KnownProvider } from "@earendil-works/pi-ai";
import { complete, type UserMessage } from "@earendil-works/pi-ai/compat";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import OpenAI from "openai";
import {
  type ClassifierConfig,
  DEFAULT_CLASSIFIER_CONFIG,
  type FlitterbotConfig,
} from "../config/load-config.ts";
import { resolveModelEntry } from "../config/models.ts";
import { createPiAuthStorage, createPiModelRegistry } from "../pi-auth.ts";
import type { ClassifierPrompts } from "../prompts/classifier.ts";

const MAX_RETRIES = 3;

const cachedClients = new Map<string, OpenAI>();

export type ClassifyResult = {
  stream_id: string | null;
  reasoning: string;
};

type ClassifierRuntimeConfig = Pick<
  FlitterbotConfig,
  "classifier" | "controlSurfaceAgentDir" | "models" | "defaultModel" | "defaultThinkingLevel"
>;

export function resolveClassifierApiKey(config: ClassifierConfig): string | undefined {
  if (config.provider === "disabled" || config.provider === "pi") return undefined;
  return process.env[config.apiKeyEnv];
}

export function resolveGroqApiKey(): string | undefined {
  return resolveClassifierApiKey(DEFAULT_CLASSIFIER_CONFIG);
}

function getOpenAIClient(apiKey: string, config: ClassifierConfig): OpenAI {
  const cacheKey = `${config.provider}:${config.baseURL ?? "default"}:${apiKey}`;
  const cached = cachedClients.get(cacheKey);
  if (cached) return cached;
  const client = new OpenAI({
    apiKey,
    ...(config.baseURL ? { baseURL: config.baseURL } : {}),
  });
  cachedClients.set(cacheKey, client);
  return client;
}

function classifierLabel(config: ClassifierConfig): string {
  return `${config.provider}/${config.model}`;
}

function extractAssistantText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      const block = part as { type?: string; text?: unknown };
      return block.type === "text" && typeof block.text === "string" ? block.text : "";
    })
    .filter(Boolean)
    .join("\n");
}

async function callOpenAICompatible(
  apiKey: string,
  config: ClassifierConfig,
  prompts: ClassifierPrompts,
): Promise<string> {
  const client = getOpenAIClient(apiKey, config);
  const response = await client.chat.completions.create({
    model: config.model,
    max_tokens: config.maxTokens,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: prompts.systemPrompt },
      { role: "user", content: prompts.userPrompt },
    ],
  });
  return response.choices[0]?.message?.content ?? "";
}

async function callPiClassifier(
  runtimeConfig: ClassifierRuntimeConfig,
  prompts: ClassifierPrompts,
): Promise<string> {
  const modelEntry = resolveModelEntry(runtimeConfig, runtimeConfig.classifier.model);
  const model = getBuiltinModel(modelEntry.provider as KnownProvider, modelEntry.modelId as never);
  if (!model) {
    throw new Error(
      `Unable to resolve Pi classifier model: provider=${modelEntry.provider} modelId=${modelEntry.modelId}`,
    );
  }

  const authStorage = createPiAuthStorage(runtimeConfig.controlSurfaceAgentDir);
  const modelRegistry = createPiModelRegistry(authStorage, runtimeConfig.controlSurfaceAgentDir);
  const auth = await modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok || !auth.apiKey) {
    throw new Error(auth.ok ? `No API key for ${model.provider}` : auth.error);
  }

  const userMessage: UserMessage = {
    role: "user",
    content: [{ type: "text", text: prompts.userPrompt }],
    timestamp: Date.now(),
  };
  const response = await complete(
    model,
    { systemPrompt: prompts.systemPrompt, messages: [userMessage] },
    { apiKey: auth.apiKey, headers: auth.headers, env: auth.env },
  );

  return extractAssistantText(response.content);
}

async function callClassifierText(
  runtimeConfig: ClassifierRuntimeConfig,
  prompts: ClassifierPrompts,
): Promise<string> {
  const config = runtimeConfig.classifier;
  if (config.provider === "disabled") {
    throw new Error("Classifier is disabled");
  }
  if (config.provider === "pi") {
    return callPiClassifier(runtimeConfig, prompts);
  }

  const apiKey = resolveClassifierApiKey(config);
  if (!apiKey) throw new Error(`No API key found in ${config.apiKeyEnv}`);
  return callOpenAICompatible(apiKey, config, prompts);
}

export async function callClassifierJson<T>(
  runtimeConfig: ClassifierRuntimeConfig,
  prompts: ClassifierPrompts,
): Promise<T> {
  let lastError: Error | undefined;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      const text = await callClassifierText(runtimeConfig, prompts);
      if (!text) {
        lastError = new Error(
          `${classifierLabel(runtimeConfig.classifier)} response missing content`,
        );
        continue;
      }
      return JSON.parse(text) as T;
    } catch (error) {
      console.warn(
        "[classifier] JSON call error (attempt %d/%d, %s): %s",
        attempt,
        MAX_RETRIES,
        classifierLabel(runtimeConfig.classifier),
        error instanceof Error ? error.message : String(error),
      );
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }

  throw lastError;
}

export async function callClassifierClassify(
  runtimeConfig: ClassifierRuntimeConfig,
  prompts: ClassifierPrompts,
): Promise<ClassifyResult> {
  const parsed = await callClassifierJson<ClassifyResult>(runtimeConfig, prompts);
  return {
    stream_id: parsed.stream_id || null,
    reasoning: parsed.reasoning || "",
  };
}

export async function callGroqClassify(
  apiKey: string,
  prompts: ClassifierPrompts,
): Promise<ClassifyResult> {
  const text = await callOpenAICompatible(apiKey, DEFAULT_CLASSIFIER_CONFIG, prompts);
  const parsed = JSON.parse(text) as ClassifyResult;
  return {
    stream_id: parsed.stream_id || null,
    reasoning: parsed.reasoning || "",
  };
}

export async function callGroqJson<T>(apiKey: string, prompts: ClassifierPrompts): Promise<T> {
  const text = await callOpenAICompatible(apiKey, DEFAULT_CLASSIFIER_CONFIG, prompts);
  return JSON.parse(text) as T;
}

export function resetGroqClient(): void {
  cachedClients.clear();
}

export const resetClassifierClients = resetGroqClient;
