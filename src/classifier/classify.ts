import type { BlackboardDatabase } from "../blackboard/db.ts";
import {
  getRecentConversationByWorkstream,
  getRecentDefaultConversation,
} from "../blackboard/query-messages.ts";
import { getLatestStreamCreatedAt, listOpenWorkStreams } from "../blackboard/query-streams.ts";
import type { FlitterbotConfig } from "../config/load-config.ts";
import type { StreamRow } from "../contracts/index.ts";
import { buildClassificationPrompts } from "../prompts/classifier.ts";
import { type ClassifyResult, callClassifierClassify } from "./groq-client.ts";

const DEFAULT_AGENT_PATTERNS = [
  /^\s*\/new-stream\b/i,
  /^\s*(new|create|launch|start|open)\s+stream/i,
  /^\s*help me do\b/i,
];

function shouldShortCircuitToDefault(message: string): boolean {
  return DEFAULT_AGENT_PATTERNS.some((p) => p.test(message));
}

function indent(text: string, pad = "    "): string {
  return text
    .split("\n")
    .map((line) => `${pad}${line}`)
    .join("\n");
}

function logClassifierPrompt(prompts: { systemPrompt: string; userPrompt: string }): void {
  const bar = "━".repeat(72);
  console.log(
    [
      `\n┏${bar}`,
      `┃ [router] CLASSIFIER PROMPT`,
      `┣${bar}`,
      `┃ SYSTEM PROMPT:`,
      indent(prompts.systemPrompt),
      `┣${bar}`,
      `┃ USER PROMPT (what the classifier was fed):`,
      indent(prompts.userPrompt),
      `┗${bar}\n`,
    ].join("\n"),
  );
}

function logClassifierResult(result: ClassifyResult, matched: StreamRow | null): void {
  const bar = "━".repeat(72);
  const outcome = matched
    ? `MATCHED → stream_name="${matched.name}" stream_id=${matched.id}`
    : result.stream_id
      ? `NO MATCH → model returned unknown stream_id=${result.stream_id}`
      : `NO MATCH → routing to default agent (stream_id=null)`;
  console.log(
    [
      `\n┏${bar}`,
      `┃ [router] CLASSIFIER RESULT`,
      `┣${bar}`,
      `┃ ${outcome}`,
      `┃ reasoning: ${result.reasoning || "(none)"}`,
      `┗${bar}\n`,
    ].join("\n"),
  );
}

export type ClassificationResult = {
  stream: StreamRow | null;
  action: "matched" | "none";
};

export async function classifyMessage(
  message: string,
  db: BlackboardDatabase,
  config: FlitterbotConfig,
  defaultPiSessionId?: string,
  ownerUser?: string,
): Promise<ClassificationResult> {
  if (shouldShortCircuitToDefault(message)) {
    console.log("[router] short-circuit to default agent: %s", message.slice(0, 120));
    return { stream: null, action: "none" };
  }

  const streams = listOpenWorkStreams(db, ownerUser);
  if (streams.length === 0) {
    console.log("[router] short-circuit: no open streams, routing to default");
    return { stream: null, action: "none" };
  }

  const recentConversation = getRecentConversationByWorkstream(db, 4);
  const defaultBoundary = getLatestStreamCreatedAt(db, ownerUser);
  const defaultConversation = defaultPiSessionId
    ? getRecentDefaultConversation(db, defaultPiSessionId, 4, defaultBoundary)
    : [];
  const prompts = buildClassificationPrompts(
    message,
    streams,
    recentConversation,
    defaultConversation,
  );
  console.log(
    "[router] classifying: %d open streams | message: %s",
    streams.length,
    message.slice(0, 120),
  );
  logClassifierPrompt(prompts);
  let result: ClassifyResult;
  try {
    result = await callClassifierClassify(config, prompts);
  } catch (error) {
    console.error(
      `[router] classification failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return { stream: null, action: "none" };
  }

  const matched = result.stream_id
    ? (streams.find((ws) => ws.id === result.stream_id) ?? null)
    : null;
  logClassifierResult(result, matched);
  if (matched) {
    return { stream: matched, action: "matched" };
  }

  return { stream: null, action: "none" };
}
