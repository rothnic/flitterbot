import type { CodexWorkerProfile, FlitterbotConfig } from "../config/load-config.ts";

export function resolveCodexWorkerProfile(
  config: Pick<FlitterbotConfig, "codexWorkerProfiles" | "defaultCodexWorkerProfile">,
  profileId?: string,
): CodexWorkerProfile {
  const requested = profileId?.trim() || config.defaultCodexWorkerProfile;
  const profile = config.codexWorkerProfiles.find((entry) => entry.id === requested);
  if (!profile) {
    throw new Error(
      `Unknown Codex worker profile "${requested}". Expected one of ${config.codexWorkerProfiles
        .map((entry) => entry.id)
        .join(", ")}`,
    );
  }
  return profile;
}

export function buildCodexProfileDeveloperInstructions(profile: CodexWorkerProfile): string {
  const sections: string[] = [];
  if (profile.developerInstructions) sections.push(profile.developerInstructions);
  if (profile.context) {
    sections.push(["Profile context:", profile.context].join("\n"));
  }
  if (profile.skillNames.length > 0) {
    sections.push(
      [
        "Relevant Codex skills:",
        ...profile.skillNames.map(
          (skillName) => `- ${skillName.startsWith("$") ? skillName : `$${skillName}`}`,
        ),
      ].join("\n"),
    );
  }
  if (profile.skillPaths.length > 0) {
    sections.push(
      [
        "Additional skill/context paths:",
        ...profile.skillPaths.map((skillPath) => `- ${skillPath}`),
      ].join("\n"),
    );
  }
  return sections.join("\n\n");
}
