import { keepPreviousData, replaceEqualDeep } from "@tanstack/react-query";
import type { FlitterbotApiClient } from "~/lib/api";
import { INTERNAL_COMMANDS } from "~/lib/internal-commands";
import type {
  ChatTimelineItem,
  DownstreamSessionItem,
  SkillListItem,
  StatusResponse,
  WorkerSessionItem,
} from "~/lib/types";
import {
  type DirectoryCompletionsResult,
  fetchDirectoryCompletions,
} from "~/server/directory-completions";
import {
  type DiffResult,
  fetchDownstreamSessions,
  fetchStreamsDiff,
  fetchStreamsHistory,
  fetchStreamsInputHistory,
  fetchStreamsWorktree,
  fetchWorkerSessions,
  type StreamInfo,
} from "~/server/streams";
import { fetchUserConfig } from "~/server/user-config";

function mergeTimelineItems(oldData: unknown, newData: unknown): unknown {
  const prev = oldData as ChatTimelineItem[] | undefined;
  const next = newData as ChatTimelineItem[];

  if (!prev?.length) return next;

  const serverIds = new Set<string>();
  for (const item of next) {
    serverIds.add(item.id);
    const smId = (item as Record<string, unknown>).serverMessageId;
    if (typeof smId === "string") serverIds.add(smId);
    const cmId = (item as Record<string, unknown>).clientMessageId;
    if (typeof cmId === "string") serverIds.add(cmId);
    if (item.kind === "tool" && item.toolUseId) serverIds.add(item.toolUseId);
  }

  const extras = prev.filter((item) => {
    if (serverIds.has(item.id)) return false;
    const smId = (item as Record<string, unknown>).serverMessageId;
    if (typeof smId === "string" && serverIds.has(smId)) return false;
    const cmId = (item as Record<string, unknown>).clientMessageId;
    if (typeof cmId === "string" && serverIds.has(cmId)) return false;
    if (item.kind === "tool" && item.toolUseId && serverIds.has(item.toolUseId)) return false;
    return true;
  });

  if (!extras.length) {
    return replaceEqualDeep(prev, next);
  }

  return replaceEqualDeep(prev, [...next, ...extras]);
}

export function statusQueryOptions(apiClient: FlitterbotApiClient) {
  return {
    queryKey: ["status"] as const,
    queryFn: async (): Promise<StatusResponse> => {
      try {
        return await apiClient.getStatus();
      } catch {
        return {
          source: "offline",
          uptime: 0,
          blackboard: "",
          whatsapp: { status: "disconnected" },
          streams: [],
          shortcuts: {},
        };
      }
    },
    staleTime: 3_000,
  };
}

export function streamsHistoryQueryOptions(
  piSessionId: string | undefined,
  surface?: "input" | "agent",
) {
  return {
    queryKey: ["streams-history", piSessionId ?? "default", surface ?? "agent"] as const,
    queryFn: async (): Promise<ChatTimelineItem[]> =>
      (await fetchStreamsHistory({
        data: {
          ...(piSessionId ? { piSessionId } : {}),
          ...(surface ? { surface } : {}),
        },
      })) as ChatTimelineItem[],
    enabled: piSessionId !== undefined,
    staleTime: 0, // WS setQueryData resets dataUpdatedAt while viewing; on route leave WS unsubscribes so data goes stale naturally
    placeholderData: [],
    structuralSharing: mergeTimelineItems,
  };
}

export function streamsDownstreamSessionsQueryOptions(piSessionId: string) {
  return {
    queryKey: ["streams-downstream-sessions", piSessionId] as const,
    queryFn: (): Promise<DownstreamSessionItem[]> =>
      fetchDownstreamSessions({ data: { piSessionId } }),
    enabled: !!piSessionId,
    staleTime: 30_000,
  };
}

export function streamsWorkerSessionsQueryOptions(streamId: string | undefined | null) {
  return {
    queryKey: ["streams-worker-sessions", streamId ?? "none"] as const,
    queryFn: (): Promise<WorkerSessionItem[]> =>
      fetchWorkerSessions({ data: { streamId: streamId ?? "" } }),
    enabled: !!streamId,
    staleTime: 10_000,
  };
}

export function streamsWorktreeQueryOptions(piSessionId: string) {
  return {
    queryKey: ["streams-worktree", piSessionId] as const,
    queryFn: (): Promise<StreamInfo | null> => fetchStreamsWorktree({ data: { piSessionId } }),
    enabled: !!piSessionId,
    staleTime: 30_000,
  };
}

export function streamsDiffQueryOptions(piSessionId: string, enabled: boolean) {
  return {
    queryKey: ["streams-diff", piSessionId] as const,
    queryFn: (): Promise<DiffResult | null> => fetchStreamsDiff({ data: { piSessionId } }),
    enabled: !!piSessionId && enabled,
    staleTime: 10_000,
  };
}

export function userConfigQueryOptions() {
  return {
    queryKey: ["user-config"] as const,
    queryFn: async () => {
      try {
        return await fetchUserConfig();
      } catch {
        return {};
      }
    },
    staleTime: 30_000,
  };
}

export function surfaceTimelineQueryOptions() {
  return {
    queryKey: ["surface-timeline"] as const,
    queryFn: async (): Promise<ChatTimelineItem[]> =>
      (await fetchStreamsInputHistory()) as ChatTimelineItem[],
    staleTime: 0, // WS setQueryData resets dataUpdatedAt while viewing; on route leave WS unsubscribes so data goes stale naturally
    structuralSharing: mergeTimelineItems,
  };
}

export function skillsQueryOptions(apiClient: FlitterbotApiClient) {
  return {
    queryKey: ["skills"] as const,
    queryFn: async (): Promise<SkillListItem[]> => {
      try {
        const res = await apiClient.listSkills();
        return [...INTERNAL_COMMANDS, ...res.items];
      } catch {
        return INTERNAL_COMMANDS;
      }
    },
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
  };
}

export function directoryCompletionsQueryOptions(
  query: string,
  enabled: boolean,
  opts?: { streamId?: string; directoriesOnly?: boolean },
) {
  const streamId = opts?.streamId;
  const directoriesOnly = opts?.directoriesOnly ?? false;
  return {
    queryKey: ["directory-completions", query, streamId ?? "", directoriesOnly] as const,
    queryFn: (): Promise<DirectoryCompletionsResult> =>
      fetchDirectoryCompletions({
        data: { query, streamId, directoriesOnly },
      }),
    enabled,
    placeholderData: keepPreviousData,
    staleTime: 5_000,
  };
}
