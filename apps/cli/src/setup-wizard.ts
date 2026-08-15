import * as NodePath from "node:path";

import * as Prompts from "@clack/prompts";

import type { DetectedAgents, LifecyclePaths, SetupAgent, SetupSelection } from "./lifecycle.ts";

const agentLabels: Readonly<Record<SetupAgent, string>> = {
  codex: "Codex",
  claude: "Claude Code",
  grok: "Grok Build",
  cursor: "Cursor",
  openCode: "OpenCode",
};

const agentOrder: ReadonlyArray<SetupAgent> = ["codex", "claude", "grok", "cursor", "openCode"];

type WizardChoice = SetupAgent | "custom";

export interface SetupWizardOptions {
  readonly paths: LifecyclePaths;
  readonly detected: DetectedAgents;
  readonly cwd: string;
}

export type SetupWizard = (options: SetupWizardOptions) => Promise<SetupSelection | null>;

export const resolveWizardPath = (value: string, homeDir: string, cwd: string): string => {
  const trimmed = value.trim();
  if (trimmed === "~") return homeDir;
  if (trimmed.startsWith(`~${NodePath.sep}`)) {
    return NodePath.resolve(homeDir, trimmed.slice(2));
  }
  return NodePath.resolve(cwd, trimmed);
};

const requiredPath = (value: string | undefined): string | undefined =>
  value === undefined || value.trim().length === 0 ? "Enter a path." : undefined;

export const runSetupWizard: SetupWizard = async ({ paths, detected, cwd }) => {
  const detectedAgents = agentOrder.filter((agent) => detected[agent]);
  Prompts.intro("Dear Diary setup");
  if (detectedAgents.length === 0) {
    Prompts.log.info("No supported agents were detected. Choose Custom path to continue.");
  } else {
    Prompts.log.info(`Detected ${detectedAgents.map((agent) => agentLabels[agent]).join(", ")}.`);
  }

  const choices = await Prompts.multiselect<WizardChoice>({
    message: "Where should Dear Diary be installed?",
    options: [
      ...detectedAgents.map((agent) => ({ value: agent, label: agentLabels[agent] })),
      {
        value: "custom" as const,
        label: "Custom path",
        hint: "choose skills directory + AGENTS.md path",
      },
    ],
    initialValues: detectedAgents.length === 0 ? ["custom" as const] : detectedAgents,
    required: true,
  });
  if (Prompts.isCancel(choices)) {
    Prompts.cancel("Setup cancelled.");
    return null;
  }

  const agents = choices.filter((choice): choice is SetupAgent => choice !== "custom");
  if (!choices.includes("custom")) return { agents };

  const skillFolder = await Prompts.text({
    message: "Skills directory",
    placeholder: "/path/to/agent/skills",
    validate: requiredPath,
  });
  if (Prompts.isCancel(skillFolder)) {
    Prompts.cancel("Setup cancelled.");
    return null;
  }

  const guidancePath = await Prompts.text({
    message: "AGENTS.md file to append to",
    placeholder: "/path/to/AGENTS.md",
    validate: requiredPath,
  });
  if (Prompts.isCancel(guidancePath)) {
    Prompts.cancel("Setup cancelled.");
    return null;
  }

  return {
    agents,
    custom: {
      skillFolder: resolveWizardPath(skillFolder, paths.homeDir, cwd),
      guidancePath: resolveWizardPath(guidancePath, paths.homeDir, cwd),
    },
  };
};
