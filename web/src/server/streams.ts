import { createServerFn } from "@tanstack/react-start";
import type { ChatTimelineItem, DownstreamSessionItem, WorkerSessionItem } from "~/lib/types";

const BASE_URL = process.env.VITE_FLITTERBOT_BASE_URL || "http://127.0.0.1:18820";
const TOKEN = process.env.VITE_FLITTERBOT_TOKEN || "";

async function streamsRequest(path: string, init?: RequestInit): Promise<unknown> {
  const url = `${BASE_URL.replace(/\/$/, "")}${path}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
    ...(init?.headers as Record<string, string> | undefined),
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);

  try {
    const res = await fetch(url, { ...init, headers, signal: controller.signal });
    if (!res.ok) throw await responseError(res, path);
    return res.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function responseError(res: Response, path: string): Promise<Error> {
  const body = await res.text().catch(() => "");
  const message = extractErrorMessage(body) ?? `${res.status} ${res.statusText}`;

  console.error("flitterbot streams request failed", {
    path,
    status: res.status,
    statusText: res.statusText,
    body,
  });

  return new Error(message);
}

function extractErrorMessage(body: string): string | null {
  if (!body.trim()) return null;

  try {
    const parsed = JSON.parse(body) as unknown;
    if (typeof parsed === "object" && parsed && "error" in parsed) {
      const error = (parsed as { error?: unknown }).error;
      if (typeof error === "string" && error.trim()) return error;
    }
  } catch {
    return body;
  }

  return body;
}

export const fetchStreamsHistory = createServerFn({ method: "GET" })
  .inputValidator((input: { piSessionId?: string; surface?: "input" | "agent" }) => input)
  .handler(async ({ data }): Promise<ChatTimelineItem[]> => {
    const qs = new URLSearchParams([
      ...(data.piSessionId ? [["piSessionId", data.piSessionId] as [string, string]] : []),
      ...(data.surface ? [["surface", data.surface] as [string, string]] : []),
    ]).toString();
    const path = qs ? `/api/streams/history?${qs}` : "/api/streams/history";
    try {
      const res = (await streamsRequest(path)) as { items: ChatTimelineItem[] };
      return res.items;
    } catch (err) {
      console.error(
        "fetchStreamsHistory failed (piSessionId=%s, surface=%s):",
        data.piSessionId ?? "none",
        data.surface ?? "none",
        err,
      );
      throw err;
    }
  });

export const fetchDownstreamSessions = createServerFn({ method: "GET" })
  .inputValidator((input: { piSessionId: string }) => input)
  .handler(async ({ data }): Promise<DownstreamSessionItem[]> => {
    const path = `/api/pi-sessions/${encodeURIComponent(data.piSessionId)}/sessions`;
    try {
      const res = (await streamsRequest(path)) as { items: DownstreamSessionItem[] };
      return res.items;
    } catch (err) {
      console.error("fetchDownstreamSessions failed (piSessionId=%s):", data.piSessionId, err);
      throw err;
    }
  });

export const fetchWorkerSessions = createServerFn({ method: "GET" })
  .inputValidator((input: { streamId: string }) => input)
  .handler(async ({ data }): Promise<WorkerSessionItem[]> => {
    const path = `/api/streams/${encodeURIComponent(data.streamId)}/workers`;
    try {
      const res = (await streamsRequest(path)) as { items: WorkerSessionItem[] };
      return res.items;
    } catch (err) {
      console.error("fetchWorkerSessions failed (streamId=%s):", data.streamId, err);
      throw err;
    }
  });

export type StreamInfo = {
  streamId: string | null;
  name: string | null;
  repoPath: string | null;
  repo: string | null;
  worktreePath: string | null;
  branch: string | null;
  baseBranch: string | null;
  cwd: string | null;
  cwdAbsolute: string | null;
  copyPaths: string[];
  postCreate: string[];
  configuredBaseRef: string | null;
};

export const setStreamCwd = createServerFn({ method: "POST" })
  .inputValidator((input: { streamId: string; cwd: string }) => input)
  .handler(
    async ({ data }): Promise<{ ok: true; streamId: string; cwd: string; piSessionId: string }> => {
      return (await streamsRequest(`/api/streams/${encodeURIComponent(data.streamId)}/cwd`, {
        method: "POST",
        body: JSON.stringify({ cwd: data.cwd }),
      })) as { ok: true; streamId: string; cwd: string; piSessionId: string };
    },
  );

export const fetchStreamsWorktree = createServerFn({ method: "GET" })
  .inputValidator((input: { piSessionId: string }) => input)
  .handler(async ({ data }): Promise<StreamInfo | null> => {
    const path = `/api/pi-sessions/${encodeURIComponent(data.piSessionId)}/stream`;
    try {
      return (await streamsRequest(path)) as StreamInfo;
    } catch {
      return null;
    }
  });

export type DiffResult =
  | { mode: "diff"; diff: string }
  | { mode: "summary"; stat: string; files: number; insertions: number; deletions: number };

// ponytail: route this through streamsRequest so timeout/auth/error handling has one implementation.
export const fetchStreamsDiff = createServerFn({ method: "GET" })
  .inputValidator((input: { piSessionId: string }) => input)
  .handler(async ({ data }): Promise<DiffResult | null> => {
    const url = `${BASE_URL.replace(/\/$/, "")}/api/pi-sessions/${encodeURIComponent(data.piSessionId)}/diff`;
    const headers: Record<string, string> = {
      ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
    };
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      const res = await fetch(url, { headers, signal: controller.signal });
      if (res.status === 204) return null;
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      return (await res.json()) as DiffResult;
    } catch {
      return null;
    } finally {
      clearTimeout(timeout);
    }
  });

export const fetchStreamsInputHistory = createServerFn({ method: "GET" }).handler(
  async (): Promise<ChatTimelineItem[]> => {
    try {
      const res = (await streamsRequest("/api/streams/history?surface=input")) as {
        items: ChatTimelineItem[];
      };
      return res.items;
    } catch (err) {
      console.error("fetchStreamsInputHistory failed:", err);
      throw err;
    }
  },
);
