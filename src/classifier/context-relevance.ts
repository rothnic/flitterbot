import type { FlitterbotConfig } from "../config/load-config.ts";
import { buildContextRelevancePrompts } from "../prompts/context-relevance.ts";
import { callClassifierJson } from "./groq-client.ts";

type ContextRelevanceResult = {
  relevant: boolean[];
};

export async function classifyContextRelevance(
  messages: { content: string; created_at: string }[],
  streamName: string,
  config: FlitterbotConfig,
  agentContext?: string,
  logClassifierPrompt?: (message: string) => void,
): Promise<boolean[]> {
  const prompts = buildContextRelevancePrompts(messages, streamName, agentContext);
  logClassifierPrompt?.(`[context classifier] system prompt\n${prompts.systemPrompt}`);
  logClassifierPrompt?.(`[context classifier] user prompt\n${prompts.userPrompt}`);
  const result = await callClassifierJson<ContextRelevanceResult>(config, prompts);

  if (!Array.isArray(result.relevant) || result.relevant.length !== messages.length) {
    throw new Error(
      `Invalid context relevance response: expected ${messages.length} booleans, got ${JSON.stringify(result.relevant)}`,
    );
  }

  return result.relevant;
}
