import type { QueryClient } from "@tanstack/react-query";
import { useQuery } from "@tanstack/react-query";
import {
  createRootRouteWithContext,
  type ErrorComponentProps,
  HeadContent,
  Scripts,
} from "@tanstack/react-router";
import type * as React from "react";
import { useEffect, useMemo } from "react";
import { Toaster } from "sonner";
import { AppShell } from "~/components/app-shell";
import { DefaultCatchBoundary } from "~/components/default-catch-boundary";
import { NotFound } from "~/components/not-found";
import { useGlobalShortcuts } from "~/hooks/use-global-shortcuts";
import { useTheme } from "~/hooks/use-theme";
import { useWhyDidYouRender } from "~/hooks/use-why-did-you-render";
import type { FlitterbotApiClient } from "~/lib/api";
import { skillsQueryOptions, statusQueryOptions, userConfigQueryOptions } from "~/lib/queries";
import type { SettingsStore } from "~/lib/settings-store";
import type { StatusResponse } from "~/lib/types";
import type { FlitterbotWsClient } from "~/lib/ws";
import type { WsConnectionStore } from "~/lib/ws-connection-store";
import type { SendMessageFn } from "~/lib/ws-query-bridge";
import appCss from "~/styles.css?url";
import { seo } from "~/utils/seo";

export const Route = createRootRouteWithContext<{
  queryClient: QueryClient;
  apiClient: FlitterbotApiClient;
  wsClient: FlitterbotWsClient;
  wsConnectionStore: WsConnectionStore;
  settingsStore: SettingsStore;
  sendMessage: SendMessageFn;
  startRealtime: () => () => void;
}>()({
  loader: async ({ context }) => {
    await Promise.all([
      context.queryClient.ensureQueryData(statusQueryOptions(context.apiClient)),
      context.queryClient.ensureQueryData(userConfigQueryOptions()).catch(() => ({})),
      context.queryClient.ensureQueryData(skillsQueryOptions(context.apiClient)).catch(() => []),
    ]);
  },
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      ...seo({
        title: "Flitterbot",
        description: "Orchestration runtime for Pi-managed streams and coding workers.",
      }),
    ],
    links: [
      { rel: "stylesheet", href: appCss },
      {
        rel: "apple-touch-icon",
        sizes: "180x180",
        href: "/apple-touch-icon.png",
      },
      {
        rel: "icon",
        type: "image/png",
        sizes: "32x32",
        href: "/favicon-32x32.png",
      },
      {
        rel: "icon",
        type: "image/png",
        sizes: "16x16",
        href: "/favicon-16x16.png",
      },
      { rel: "manifest", href: "/site.webmanifest" },
      { rel: "icon", href: "/favicon.ico" },
    ],
  }),
  errorComponent: (props: ErrorComponentProps) => (
    <RootDocument>
      <DefaultCatchBoundary {...props} />
    </RootDocument>
  ),
  notFoundComponent: () => <NotFound />,
  component: RootComponent,
});

function useShortcutStatus(apiClient: FlitterbotApiClient) {
  const { data } = useQuery({
    ...statusQueryOptions(apiClient),
    retry: 1,
    select: (d) => ({
      piAgent: d.piAgent,
      streams: d.streams,
      shortcuts: d.shortcuts,
    }),
  });
  return data;
}

function useStreamPaths(status: Pick<StatusResponse, "piAgent" | "streams"> | undefined): string[] {
  return useMemo(() => {
    const paths: string[] = [];
    if (status?.piAgent?.default?.piSessionId) {
      paths.push(`/streams/${status.piAgent.default.piSessionId}`);
    }
    for (const s of status?.streams ?? []) {
      if (s.status === "open" && s.piSessionId) paths.push(`/streams/${s.piSessionId}`);
    }
    return paths.slice(0, 9);
  }, [status?.piAgent, status?.streams]);
}

function RootComponent() {
  const { startRealtime, apiClient } = Route.useRouteContext();
  useWhyDidYouRender("RootComponent", {});
  const { resolvedTheme } = useTheme();
  const shortcutStatus = useShortcutStatus(apiClient);
  const streamPaths = useStreamPaths(shortcutStatus);
  useGlobalShortcuts({ streamPaths, shortcutBindings: shortcutStatus?.shortcuts });

  useEffect(() => startRealtime(), [startRealtime]);

  useEffect(() => {
    if (import.meta.env.DEV) {
      void import("react-grab");
    }
  }, []);

  const children = useMemo(
    () => (
      <>
        <AppShell />
      </>
    ),
    [],
  );

  return <RootDocument resolvedTheme={resolvedTheme}>{children}</RootDocument>;
}

function RootDocument({
  children,
  resolvedTheme = "light",
}: {
  children: React.ReactNode;
  resolvedTheme?: "light" | "dark";
}) {
  useWhyDidYouRender("RootDocument", { children });
  return (
    <html
      lang="en"
      className={resolvedTheme === "dark" ? "dark" : ""}
      style={{ colorScheme: resolvedTheme }}
      suppressHydrationWarning
    >
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Toaster
          theme={resolvedTheme}
          duration={4000}
          toastOptions={{
            style: {
              background: "var(--background)",
              color: "var(--foreground)",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius)",
            },
          }}
        />
        <Scripts />
      </body>
    </html>
  );
}
