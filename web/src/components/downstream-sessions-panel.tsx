import { useQuery } from "@tanstack/react-query";
import { RotateCcwIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Diff, type FileData, Hunk, type HunkData, parseDiff } from "react-diff-view";
import "react-diff-view/style/index.css";
import { toast } from "sonner";
import { CopyableCode } from "~/components/common/copyable-code";
import { ShortcutHint } from "~/components/common/kbd";
import { Button } from "~/components/ui/button";
import { ToggleGroup, ToggleGroupItem } from "~/components/ui/toggle-group";
import { useCopyToClipboard } from "~/hooks/use-copy-to-clipboard";
import { useWhyDidYouRender } from "~/hooks/use-why-did-you-render";
import {
  getTmuxAttachShortcutActionId,
  registerShortcutHandlers,
  SHORTCUT_ACTIONS,
  setActiveScrollContainer,
  useShortcutBindingLabel,
} from "~/lib/global-shortcuts";
import {
  streamsDiffQueryOptions,
  streamsDownstreamSessionsQueryOptions,
  streamsWorkerSessionsQueryOptions,
  streamsWorktreeQueryOptions,
} from "~/lib/queries";
import type { DownstreamSessionItem, PiSessionStatus, WorkerSessionItem } from "~/lib/types";
import { cn } from "~/lib/utils";

function piStatusBanner(
  status: PiSessionStatus | undefined,
): { label: string; colorClass: string } | null {
  switch (status) {
    case "active":
      return {
        label: "Inferring",
        colorClass: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
      };
    case "waiting_for_sessions":
      return {
        label: "Supervising",
        colorClass: "bg-lime-500/15 text-lime-600 dark:text-lime-400",
      };
    case "waiting_for_user":
      return {
        label: "Idle",
        colorClass: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
      };
    case "ended":
      return { label: "Ended", colorClass: "bg-zinc-500/15 text-zinc-500" };
    case "crashed":
      return {
        label: "Crashed",
        colorClass: "bg-red-500/15 text-red-600 dark:text-red-400",
      };
    default:
      return null;
  }
}

function statusDotColor(status: DownstreamSessionItem["status"]): string {
  switch (status) {
    case "working":
      return "bg-emerald-500";
    case "idle":
      return "bg-blue-400";
    case "stale":
      return "bg-amber-500";
    case "ended":
      return "bg-zinc-500";
  }
}

function statusLabel(status: DownstreamSessionItem["status"]): string {
  switch (status) {
    case "working":
      return "working";
    case "idle":
      return "idle";
    case "stale":
      return "stale";
    case "ended":
      return "ended";
  }
}

function workerStatusDotColor(status: WorkerSessionItem["status"]): string {
  switch (status) {
    case "starting":
    case "running":
    case "waiting_for_user":
      return "bg-emerald-500";
    case "idle":
    case "completed":
      return "bg-blue-400";
    case "canceled":
    case "unreachable":
      return "bg-amber-500";
    case "failed":
      return "bg-red-500";
  }
}

function workerStatusLabel(status: WorkerSessionItem["status"]): string {
  return status.replaceAll("_", " ");
}

function sessionDescription(session: DownstreamSessionItem): string {
  return session.taskDescription ?? session.project ?? session.streamName ?? "no stream";
}

function workerLabel(worker: WorkerSessionItem): string {
  if (worker.profileId && worker.modelId) return `${worker.profileId} · ${worker.modelId}`;
  return worker.profileId ?? worker.modelId ?? worker.runnerType.replaceAll("_", " ");
}

function latestWorkerTurn(worker: WorkerSessionItem) {
  return worker.turns.at(-1);
}

function tmuxShortcutHintLabel(tmuxSession: string): string {
  if (tmuxSession.length === 1) return `t then ${tmuxSession}`;
  return ["t", ...tmuxSession.split("")].join("+");
}

// ponytail: extract one copy-with-shortcut row; worktree/repo/branch/tmux copy blocks repeat below.
function ActiveSessionTmuxCopy({ tmuxSession }: { tmuxSession: string }) {
  const tmuxCopy = useCopyToClipboard(600);
  const actionId = getTmuxAttachShortcutActionId(tmuxSession);
  const configuredShortcutLabel = useShortcutBindingLabel(actionId, { compact: true });
  const shortcutLabel =
    tmuxSession.length === 1 ? configuredShortcutLabel : tmuxShortcutHintLabel(tmuxSession);
  const command = `tmux attach -t ${tmuxSession}`;

  useEffect(() => {
    return registerShortcutHandlers([
      {
        actionId,
        priority: 20,
        handler: () => {
          void tmuxCopy.copy(command).catch(() => toast.error("Failed to copy"));
          return true;
        },
      },
    ]);
  }, [actionId, command, tmuxCopy.copy]);

  return (
    <>
      <CopyableCode text={command} copied={tmuxCopy.copied} onCopy={() => tmuxCopy.copy(command)} />
      {tmuxCopy.copied ? (
        <span className="text-muted-foreground/50 text-[10px]">Copied!</span>
      ) : (
        <ShortcutHint label={shortcutLabel || tmuxShortcutHintLabel(tmuxSession)} />
      )}
    </>
  );
}

export function DownstreamSessionsPanel({
  piSessionId,
  piSessionStatus,
}: {
  piSessionId: string | undefined;
  piSessionStatus?: PiSessionStatus;
}) {
  useWhyDidYouRender("DownstreamSessionsPanel", { piSessionId, piSessionStatus });
  const [panelView, setPanelView] = useState<"info" | "diff">("info");
  const [diffRefreshNudged, setDiffRefreshNudged] = useState(false);

  const { data, isPending, isError } = useQuery(
    streamsDownstreamSessionsQueryOptions(piSessionId ?? ""),
  );

  const worktreeQuery = useQuery(streamsWorktreeQueryOptions(piSessionId ?? ""));
  const worktree = worktreeQuery.data;
  const streamId = worktree?.streamId ?? null;
  const workerSessionsQuery = useQuery(streamsWorkerSessionsQueryOptions(streamId));
  const hasWorktree = !!worktree?.worktreePath;
  const showDiff = panelView === "diff";

  const diffQuery = useQuery(streamsDiffQueryOptions(piSessionId ?? "", showDiff && hasWorktree));

  const currentWorktreePath = worktree?.worktreePath ?? null;
  const currentRepoPath = worktree?.repoPath ?? null;
  const currentBranch = worktree?.branch ?? null;
  const targetBranch = worktree?.baseBranch ?? (hasWorktree ? "main" : null);
  const worktreeShortcutLabel =
    useShortcutBindingLabel(SHORTCUT_ACTIONS.streamCopyWorktreePath, { compact: true }) ||
    "c then w";
  const repoShortcutLabel =
    useShortcutBindingLabel(SHORTCUT_ACTIONS.streamCopyRepoPath, { compact: true }) || "c then r";
  const branchShortcutLabel =
    useShortcutBindingLabel(SHORTCUT_ACTIONS.streamCopyBranch, { compact: true }) || "c then b";
  const targetBranchShortcutLabel =
    useShortcutBindingLabel(SHORTCUT_ACTIONS.streamCopyTargetBranch, { compact: true }) ||
    "c then t";
  const infoShortcutLabel = useShortcutBindingLabel(SHORTCUT_ACTIONS.panelViewInfo);
  const diffShortcutLabel = useShortcutBindingLabel(SHORTCUT_ACTIONS.panelViewDiff);

  const worktreeCopy = useCopyToClipboard(600);
  const repoCopy = useCopyToClipboard(600);
  const branchCopy = useCopyToClipboard(600);
  const baseBranchCopy = useCopyToClipboard(600);

  const showInfoPanel = useCallback(() => {
    (document.activeElement as HTMLElement)?.blur?.();
    setActiveScrollContainer("main");
    setPanelView("info");
  }, []);

  const showDiffPanel = useCallback(() => {
    (document.activeElement as HTMLElement)?.blur?.();
    setActiveScrollContainer("diff");
    setPanelView("diff");
  }, []);

  useEffect(() => {
    return registerShortcutHandlers([
      {
        actionId: SHORTCUT_ACTIONS.streamCopyWorktreePath,
        priority: 10,
        handler: () => {
          if (!currentWorktreePath) return false;
          void worktreeCopy.copy(currentWorktreePath).catch(() => toast.error("Failed to copy"));
          return true;
        },
      },
      {
        actionId: SHORTCUT_ACTIONS.streamCopyRepoPath,
        priority: 10,
        handler: () => {
          if (!currentRepoPath) return false;
          void repoCopy.copy(currentRepoPath).catch(() => toast.error("Failed to copy"));
          return true;
        },
      },
      {
        actionId: SHORTCUT_ACTIONS.streamCopyBranch,
        priority: 10,
        handler: () => {
          if (!currentBranch) return false;
          void branchCopy.copy(currentBranch).catch(() => toast.error("Failed to copy"));
          return true;
        },
      },
      {
        actionId: SHORTCUT_ACTIONS.streamCopyTargetBranch,
        priority: 10,
        handler: () => {
          if (!targetBranch) return false;
          void baseBranchCopy.copy(targetBranch).catch(() => toast.error("Failed to copy"));
          return true;
        },
      },
      {
        actionId: SHORTCUT_ACTIONS.panelViewInfo,
        handler: () => {
          showInfoPanel();
          return true;
        },
      },
      {
        actionId: SHORTCUT_ACTIONS.panelViewDiff,
        handler: () => {
          if (!hasWorktree) return false;
          showDiffPanel();
          return true;
        },
      },
    ]);
  }, [
    currentWorktreePath,
    currentRepoPath,
    currentBranch,
    targetBranch,
    worktreeCopy.copy,
    repoCopy.copy,
    branchCopy.copy,
    baseBranchCopy.copy,
    hasWorktree,
    showInfoPanel,
    showDiffPanel,
  ]);

  const diffFiles = useMemo<FileData[]>(() => {
    if (diffQuery.data?.mode !== "diff") return [];
    const files = parseDiff(diffQuery.data.diff);
    for (const file of files) {
      for (const hunk of file.hunks) {
        for (const change of hunk.changes) {
          const sign = change.type === "insert" ? "+" : change.type === "delete" ? "-" : " ";
          change.content = sign + change.content;
        }
      }
    }
    return files;
  }, [diffQuery.data]);

  if (!piSessionId) {
    return (
      <div className="flex flex-col h-full border-l border-border bg-background">
        <p className="px-4 pt-3 pb-2 text-[10px] uppercase tracking-wider text-muted-foreground font-medium">
          Active Sessions
        </p>
        <div className="flex-1 flex items-center justify-center">
          <p className="text-xs text-muted-foreground">Waiting for session…</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full border-l border-border bg-background">
      <div className="flex justify-between items-center gap-1 mx-3 mt-3 mb-2">
        {(() => {
          const banner = piStatusBanner(piSessionStatus);
          return banner ? (
            <div className={cn("px-3 py-1.5 rounded-md text-xs font-medium", banner.colorClass)}>
              {banner.label}
            </div>
          ) : (
            <div />
          );
        })()}
        <ToggleGroup
          value={[panelView]}
          onValueChange={(newValue) => {
            const val = newValue[newValue.length - 1];
            if (val === "info" || val === "diff") {
              setActiveScrollContainer(val === "diff" ? "diff" : "main");
              setPanelView(val);
            }
          }}
          variant="outline"
          size="sm"
        >
          <ToggleGroupItem
            value="info"
            className="text-sm aria-pressed:bg-accent aria-pressed:text-accent-foreground"
          >
            Info
            {infoShortcutLabel && (
              <ShortcutHint label={infoShortcutLabel} className="ml-1" kbdSize="compact" />
            )}
          </ToggleGroupItem>
          <ToggleGroupItem
            value="diff"
            disabled={!hasWorktree}
            className="text-sm aria-pressed:bg-accent aria-pressed:text-accent-foreground"
          >
            Diff
            {diffShortcutLabel && (
              <ShortcutHint label={diffShortcutLabel} className="ml-1" kbdSize="compact" />
            )}
          </ToggleGroupItem>
        </ToggleGroup>
      </div>

      {showDiff && hasWorktree ? (
        <div className="relative flex-1 min-h-0">
          <Button
            type="button"
            variant="outline"
            size="icon-xs"
            className="absolute right-3 top-[-0.3125rem] z-30 rounded-md bg-background/95 shadow-sm backdrop-blur-sm active:not-aria-[haspopup]:translate-y-0"
            aria-label="Refresh diff"
            title="Refresh diff"
            aria-disabled={diffQuery.isFetching}
            onClick={() => {
              if (diffQuery.isFetching) return;
              setDiffRefreshNudged(true);
              void diffQuery.refetch();
            }}
          >
            <RotateCcwIcon
              className={cn(
                "size-3 transition-transform duration-150",
                diffRefreshNudged && "-rotate-45",
                diffQuery.isFetching && !diffRefreshNudged && "animate-spin",
              )}
              onTransitionEnd={() => setDiffRefreshNudged(false)}
            />
          </Button>
          <div data-scroll-container="diff" className="h-full overflow-y-auto">
            {diffQuery.isPending && (
              <p className="px-4 py-3 text-[11px] text-muted-foreground">Loading diff…</p>
            )}
            {diffQuery.isError && (
              <p className="px-4 py-3 text-xs text-destructive">Failed to load diff.</p>
            )}
            {diffQuery.isSuccess && !diffQuery.data && (
              <p className="px-4 py-3 text-xs text-muted-foreground">
                No changes against {worktree?.baseBranch ?? "main"}.
              </p>
            )}
            {diffQuery.isSuccess && diffQuery.data?.mode === "summary" && (
              <>
                <div className="mx-3 mt-2 mb-1 px-3 py-1.5 rounded-md text-xs font-medium bg-amber-500/15 text-amber-600 dark:text-amber-400">
                  Diff too large ({diffQuery.data.files} files,{" "}
                  {diffQuery.data.insertions.toLocaleString()}+ /{" "}
                  {diffQuery.data.deletions.toLocaleString()}&minus;), showing summary only
                </div>
                <pre className="px-4 py-2 text-xs text-muted-foreground whitespace-pre-wrap font-mono overflow-x-auto">
                  {diffQuery.data.stat}
                </pre>
              </>
            )}
            {diffQuery.isSuccess && diffQuery.data?.mode === "diff" && (
              <div className="diff-viewer-panel text-xs">
                {diffFiles.map((file) => {
                  const path = file.newPath || file.oldPath || "(unknown)";
                  const key = `${file.oldRevision}-${file.newRevision}-${path}`;
                  return (
                    <div key={key} className="mb-3 last:mb-0">
                      <div className="sticky top-0 z-10 px-3 py-1 text-[11px] font-mono text-muted-foreground border-b border-border bg-background/95 backdrop-blur-sm truncate">
                        {path}
                      </div>
                      <Diff viewType="unified" diffType={file.type} hunks={file.hunks}>
                        {(hunks: HunkData[]) =>
                          hunks.map((hunk: HunkData) => (
                            <Hunk
                              key={`${hunk.oldStart},${hunk.oldLines} ${hunk.newStart},${hunk.newLines}`}
                              hunk={hunk}
                            />
                          ))
                        }
                      </Diff>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto">
          <p className="px-4 pt-3 pb-2 text-[10px] uppercase tracking-wider text-muted-foreground font-medium">
            Active Sessions
          </p>
          {isPending && (
            <p className="px-4 py-3 text-xs text-muted-foreground">Loading sessions…</p>
          )}
          {isError && (
            <p className="px-4 py-3 text-xs text-destructive">Failed to load sessions.</p>
          )}
          {data && data.length === 0 && (workerSessionsQuery.data?.length ?? 0) === 0 && (
            <p className="px-4 py-3 text-xs text-muted-foreground">No active sessions</p>
          )}
          {workerSessionsQuery.isPending && streamId && (
            <p className="px-4 py-3 text-xs text-muted-foreground">Loading Codex workers…</p>
          )}
          {workerSessionsQuery.isError && (
            <p className="px-4 py-3 text-xs text-destructive">Failed to load Codex workers.</p>
          )}
          {(workerSessionsQuery.data?.length ?? 0) > 0 && (
            <div className="border-b border-border pb-2">
              <p className="px-4 pt-1 pb-2 text-[10px] uppercase tracking-wider text-muted-foreground font-medium">
                Codex Workers
              </p>
              <ul className="divide-y divide-border">
                {workerSessionsQuery.data?.map((worker) => {
                  const latestTurn = latestWorkerTurn(worker);
                  return (
                    <li key={worker.workerSessionId} className="flex flex-col gap-1 px-4 py-2.5">
                      <div className="flex items-center gap-2 min-w-0">
                        <span
                          className={cn(
                            "shrink-0 h-2 w-2 rounded-full",
                            workerStatusDotColor(worker.status),
                          )}
                          title={workerStatusLabel(worker.status)}
                        />
                        <span className="truncate font-mono text-xs text-foreground">
                          {worker.workerSessionId.slice(0, 8)}
                        </span>
                        <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                          {workerStatusLabel(worker.status)}
                        </span>
                      </div>
                      <span className="pl-2 text-xs text-muted-foreground truncate">
                        {workerLabel(worker)}
                        {worker.hostDisplayName ? ` on ${worker.hostDisplayName}` : ""}
                      </span>
                      {worker.externalThreadId && (
                        <span className="pl-2 text-xs text-muted-foreground truncate">
                          thread: {worker.externalThreadId}
                        </span>
                      )}
                      {latestTurn?.finalOutput && (
                        <span className="pl-2 text-xs text-muted-foreground line-clamp-2">
                          {latestTurn.finalOutput}
                        </span>
                      )}
                      {latestTurn?.errorMessage && (
                        <span className="pl-2 text-xs text-destructive line-clamp-2">
                          {latestTurn.errorMessage}
                        </span>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
          {data && data.length > 0 && (
            <ul className="divide-y divide-border">
              {data.map((session) => (
                <li key={session.sessionId} className="flex flex-col gap-1 px-4 py-2.5">
                  <div className="flex items-center gap-2 min-w-0">
                    <span
                      className={cn(
                        "shrink-0 h-2 w-2 rounded-full",
                        statusDotColor(session.status),
                      )}
                      title={statusLabel(session.status)}
                    />
                    <span className="truncate font-mono text-xs text-foreground">
                      {session.sessionId.slice(0, 8)}
                    </span>
                  </div>

                  {session.tmuxSession && (
                    <span className="pl-2 text-xs text-muted-foreground flex items-center gap-1 min-w-0">
                      tmux: <ActiveSessionTmuxCopy tmuxSession={session.tmuxSession} />
                    </span>
                  )}

                  <span className="pl-2 text-xs text-muted-foreground truncate">
                    cwd: {sessionDescription(session)}
                  </span>
                </li>
              ))}
            </ul>
          )}

          {worktree?.worktreePath && (
            <div className="px-4 py-3 border-t border-border">
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium mb-2">
                Active Worktree
              </p>
              <div className="flex flex-col gap-0.5 py-1.5">
                <span className="pl-2 truncate text-xs text-muted-foreground flex items-center gap-1 min-w-0">
                  Repo:{" "}
                  {currentRepoPath && (
                    <CopyableCode
                      text={currentRepoPath}
                      displayText={worktree.repo ?? currentRepoPath}
                      copied={repoCopy.copied}
                      onCopy={() => repoCopy.copy(currentRepoPath)}
                    />
                  )}
                  {repoCopy.copied ? (
                    <span className="text-muted-foreground/50 text-[10px]">Copied!</span>
                  ) : (
                    <ShortcutHint label={repoShortcutLabel} />
                  )}
                </span>
                <span className="pl-2 truncate text-xs text-muted-foreground flex items-center gap-1 min-w-0">
                  Branch:{" "}
                  <CopyableCode
                    text={currentBranch ?? ""}
                    copied={branchCopy.copied}
                    onCopy={() => currentBranch && branchCopy.copy(currentBranch)}
                  />
                  {branchCopy.copied ? (
                    <span className="text-muted-foreground/50 text-[10px]">Copied!</span>
                  ) : (
                    <ShortcutHint label={branchShortcutLabel} />
                  )}
                </span>
                <span className="pl-2 text-xs text-muted-foreground flex items-center gap-1 min-w-0">
                  Merge Target:{" "}
                  <CopyableCode
                    text={targetBranch ?? ""}
                    copied={baseBranchCopy.copied}
                    onCopy={() => targetBranch && baseBranchCopy.copy(targetBranch)}
                  />
                  {baseBranchCopy.copied ? (
                    <span className="text-muted-foreground/50 text-[10px]">Copied!</span>
                  ) : (
                    <ShortcutHint label={targetBranchShortcutLabel} />
                  )}
                </span>
                <span className="pl-2 text-xs text-muted-foreground flex items-center gap-1 min-w-0">
                  Worktree:{" "}
                  <CopyableCode
                    text={worktree.worktreePath ?? ""}
                    displayText={(() => {
                      const parts = (worktree.worktreePath ?? "").split("/");
                      const leaf = parts[parts.length - 1] ?? "";
                      return `../${leaf}`;
                    })()}
                    copied={worktreeCopy.copied}
                    onCopy={() => worktreeCopy.copy(worktree.worktreePath ?? "")}
                  />
                  {worktreeCopy.copied ? (
                    <span className="text-muted-foreground/50 text-[10px]">Copied!</span>
                  ) : (
                    <ShortcutHint label={worktreeShortcutLabel} />
                  )}
                </span>
              </div>
            </div>
          )}

          {((worktree?.copyPaths?.length ?? 0) > 0 ||
            (worktree?.postCreate?.length ?? 0) > 0 ||
            !!worktree?.configuredBaseRef) && (
            <div className="px-4 py-3 border-t border-border">
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium mb-1">
                Bootstrap Config
              </p>
              {worktree?.configuredBaseRef && (
                <div className="pl-2 py-0.5">
                  <span className="text-[10px] text-muted-foreground/70">baseRef</span>
                  <p className="mt-0.5 text-xs text-muted-foreground font-mono truncate">
                    {worktree.configuredBaseRef}
                  </p>
                </div>
              )}
              {(worktree?.copyPaths?.length ?? 0) > 0 && (
                <div className="pl-2 py-0.5">
                  <span className="text-[10px] text-muted-foreground/70">copyPaths</span>
                  <ul className="mt-0.5 flex flex-col gap-0.5">
                    {worktree?.copyPaths?.map((p) => (
                      <li
                        key={p}
                        className="text-xs text-muted-foreground font-mono truncate"
                        title={p}
                      >
                        {p}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {(worktree?.postCreate?.length ?? 0) > 0 && (
                <div className="pl-2 py-0.5">
                  <span className="text-[10px] text-muted-foreground/70">postCreate</span>
                  <ul className="mt-0.5 flex flex-col gap-0.5">
                    {worktree?.postCreate?.map((c) => (
                      <li
                        key={c}
                        className="text-xs text-muted-foreground font-mono truncate"
                        title={c}
                      >
                        {c}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
