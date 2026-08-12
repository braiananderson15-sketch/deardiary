import * as NodeFs from "node:fs";
import * as NodeFsPromises from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";

import * as Paths from "@deardiary/core/paths";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import * as Effect from "effect/Effect";

export type LifecycleStatus = "current" | "drifted" | "missing";
export type GuidanceScope = "global" | "project" | "none";
export type ManagedGuidanceScope = Exclude<GuidanceScope, "none">;

export interface LifecyclePaths {
  readonly homeDir: string;
  readonly claudeConfig: string;
  readonly codexConfig: string;
  readonly openCodeConfig: string;
  readonly claudeSkill: string;
  readonly agentsSkill: string;
  readonly claudeGuidance: string;
  readonly codexGuidance: string;
  readonly codexGuidanceOverride: string;
  readonly dataDir: string;
  readonly databasePath: string;
}

export interface DetectedHarnesses {
  readonly claude: boolean;
  readonly codex: boolean;
  readonly openCode: boolean;
}

export interface ResolveLifecyclePathsOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly homeDir?: string;
  readonly platform?: NodeJS.Platform;
}

export interface LifecycleResult {
  readonly exitCode: number;
  readonly output: string;
}

export interface StartupMeasurement {
  readonly milliseconds: number;
  readonly toolCount: number;
}

export type StartupProbe = () => Promise<StartupMeasurement>;

interface PlannedFile {
  readonly label: string;
  readonly path: string;
  readonly previous: string | null;
  readonly next: string;
  readonly status: LifecycleStatus;
}

interface RemovedFile {
  readonly label: string;
  readonly path: string;
  readonly previous: string;
  readonly next: string | null;
}

const claudeEntry = {
  type: "stdio",
  command: "npx",
  args: ["-y", "@p4cs/deardiary@latest", "mcp"],
  env: {},
} as const;

const openCodeV1Entry = {
  type: "local",
  command: ["npx", "-y", "@p4cs/deardiary@latest", "mcp"],
  enabled: true,
} as const;

const openCodeV2Entry = {
  type: "local",
  command: ["npx", "-y", "@p4cs/deardiary@latest", "mcp"],
} as const;

const codexSection = `[mcp_servers.deardiary]
command = "npx"
args = ["-y", "@p4cs/deardiary@latest", "mcp"]
startup_timeout_sec = 30
`;

const guidanceStartMarker = "<!-- deardiary:start -->";
const guidanceEndMarker = "<!-- deardiary:end -->";

const guidanceBlock = (invocation: string): string => `${guidanceStartMarker}

## Dear Diary

When work reveals a blocker that cost meaningful effort, a reusable win, or an actionable observation worth carrying forward, invoke ${invocation} at the next natural pause. Also invoke it when the user asks to recall diary history.
${guidanceEndMarker}`;

const codexGuidanceBlock = guidanceBlock("`$deardiary`");
const claudeGuidanceBlock = guidanceBlock("`/deardiary`");

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const sameJson = (left: unknown, right: unknown): boolean => isDeepStrictEqual(left, right);

const hasCommand = (value: unknown, type: "local" | "stdio"): boolean =>
  isRecord(value) &&
  value.type === type &&
  (type === "stdio"
    ? (value.command === "npx" && sameJson(value.args, ["-y", "@p4cs/deardiary@latest", "mcp"])) ||
      (value.command === "deardiary" && sameJson(value.args, ["mcp"]))
    : sameJson(value.command, ["npx", "-y", "@p4cs/deardiary@latest", "mcp"]) ||
      sameJson(value.command, ["deardiary", "mcp"]));

const readFile = (path: string): string | null => {
  try {
    return NodeFs.readFileSync(path, "utf8");
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      try {
        if (NodeFs.lstatSync(path).isSymbolicLink()) {
          throw new Error(`Cannot safely update dangling symlink '${path}'.`, { cause: error });
        }
      } catch (metadataError) {
        if (!isNodeError(metadataError, "ENOENT")) throw metadataError;
      }
      return null;
    }
    throw error;
  }
};

const isNodeError = (error: unknown, code: string): boolean =>
  error instanceof Error && "code" in error && error.code === code;

const isSymbolicLink = (path: string): boolean => {
  try {
    return NodeFs.lstatSync(path).isSymbolicLink();
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return false;
    throw error;
  }
};

const parseJsonConfig = (text: string, path: string): Record<string, unknown> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`Cannot safely update invalid JSON config '${path}'.`);
  }
  if (!isRecord(parsed)) {
    throw new Error(`Cannot safely update non-object JSON config '${path}'.`);
  }
  return parsed;
};

const formatJson = (value: Record<string, unknown>): string =>
  `${JSON.stringify(value, null, 2)}\n`;

const statusOf = (previous: string | null, current: boolean): LifecycleStatus =>
  previous === null ? "missing" : current ? "current" : "drifted";

const planClaude = (path: string): PlannedFile => {
  const previous = readFile(path);
  const root = previous === null ? {} : parseJsonConfig(previous, path);
  if (root.mcpServers !== undefined && !isRecord(root.mcpServers)) {
    throw new Error(`Cannot safely update non-object 'mcpServers' in '${path}'.`);
  }
  const servers = isRecord(root.mcpServers) ? root.mcpServers : {};
  const current = hasCommand(servers.deardiary, "stdio");
  if (!current) {
    const existing = isRecord(servers.deardiary) ? servers.deardiary : {};
    root.mcpServers = {
      ...servers,
      deardiary: {
        ...existing,
        type: claudeEntry.type,
        command: claudeEntry.command,
        args: claudeEntry.args,
        ...(existing.env === undefined ? { env: claudeEntry.env } : {}),
      },
    };
  }
  return {
    label: "Claude Code MCP",
    path,
    previous,
    next: current && previous !== null ? previous : formatJson(root),
    status: statusOf(previous, current),
  };
};

const findCodexSection = (
  text: string,
): { readonly start: number; readonly end: number } | null => {
  const headers = Array.from(text.matchAll(/^\s*\[(.+)\]\s*(?:#.*)?$/gmu));
  const index = headers.findIndex((match) => {
    const name = match[1]?.trim();
    return (
      name === "mcp_servers.deardiary" ||
      name === 'mcp_servers."deardiary"' ||
      name === "mcp_servers.'deardiary'"
    );
  });
  if (index === -1) return null;
  const match = headers[index];
  if (match?.index === undefined) return null;
  let end = headers[index + 1]?.index ?? text.length;
  for (let next = index + 1; next < headers.length; next += 1) {
    const name = headers[next]?.[1]?.trim();
    const related =
      name?.startsWith("mcp_servers.deardiary.") === true ||
      name?.startsWith('mcp_servers."deardiary".') === true ||
      name?.startsWith("mcp_servers.'deardiary'.") === true;
    if (!related) {
      end = headers[next]?.index ?? text.length;
      break;
    }
    end = headers[next + 1]?.index ?? text.length;
  }
  return {
    start: match.index,
    end,
  };
};

const codexSectionIsCurrent = (
  text: string,
  section: { readonly start: number; readonly end: number },
) => {
  const body = text.slice(section.start, section.end);
  const packageRunner =
    /^\s*command\s*=\s*["']npx["']\s*(?:#.*)?$/mu.test(body) &&
    /^\s*args\s*=\s*\[\s*["']-y["']\s*,\s*["']@p4cs\/deardiary@latest["']\s*,\s*["']mcp["']\s*\]\s*(?:#.*)?$/mu.test(
      body,
    ) &&
    /^\s*startup_timeout_sec\s*=\s*[1-9][0-9]*(?:\.[0-9]+)?\s*(?:#.*)?$/mu.test(body);
  const direct =
    /^\s*command\s*=\s*["']deardiary["']\s*(?:#.*)?$/mu.test(body) &&
    /^\s*args\s*=\s*\[\s*["']mcp["']\s*\]\s*(?:#.*)?$/mu.test(body);
  return (packageRunner || direct) && !/^\s*enabled\s*=\s*false\s*(?:#.*)?$/mu.test(body);
};

const withoutCodexSection = (
  text: string,
  section: { readonly start: number; readonly end: number },
): string => `${text.slice(0, section.start)}${text.slice(section.end)}`;

const repairCodexSection = (
  text: string,
  section: { readonly start: number; readonly end: number },
): string => {
  let body = text.slice(section.start, section.end);
  const replaceOrInsert = (pattern: RegExp, replacement: string): void => {
    if (pattern.test(body)) {
      body = body.replace(pattern, replacement);
      return;
    }
    const headerEnd = body.indexOf("\n");
    body =
      headerEnd === -1
        ? `${body}\n${replacement}\n`
        : `${body.slice(0, headerEnd + 1)}${replacement}\n${body.slice(headerEnd + 1)}`;
  };
  replaceOrInsert(/^\s*command\s*=.*$/mu, 'command = "npx"');
  replaceOrInsert(/^\s*args\s*=.*$/mu, 'args = ["-y", "@p4cs/deardiary@latest", "mcp"]');
  if (!/^\s*startup_timeout_sec\s*=\s*[1-9][0-9]*(?:\.[0-9]+)?\s*(?:#.*)?$/mu.test(body)) {
    replaceOrInsert(/^\s*startup_timeout_sec\s*=.*$/mu, "startup_timeout_sec = 30");
  }
  body = body.replace(/^\s*enabled\s*=\s*false\s*(?:#.*)?$/gmu, "enabled = true");
  return `${text.slice(0, section.start)}${body}${text.slice(section.end)}`;
};

const withCodexSection = (text: string): string => {
  const section = findCodexSection(text);
  if (section !== null) return repairCodexSection(text, section);
  const prefix = text.trimEnd();
  return `${prefix}${prefix.length === 0 ? "" : "\n\n"}${codexSection}`;
};

const planCodex = (path: string): PlannedFile => {
  const previous = readFile(path);
  const text = previous ?? "";
  const section = findCodexSection(text);
  const current = section !== null && codexSectionIsCurrent(text, section);
  return {
    label: "Codex MCP",
    path,
    previous,
    next: current && previous !== null ? previous : withCodexSection(text),
    status: statusOf(previous, current),
  };
};

const planOpenCode = (path: string): PlannedFile => {
  const previous = readFile(path);
  const root = previous === null ? {} : parseJsonConfig(previous, path);
  if (root.mcp !== undefined && !isRecord(root.mcp)) {
    throw new Error(`Cannot safely update non-object 'mcp' in '${path}'.`);
  }
  const mcp = isRecord(root.mcp) ? root.mcp : {};
  const usesV2 = isRecord(mcp.servers);
  const servers = usesV2 ? (mcp.servers as Record<string, unknown>) : mcp;
  const expected = usesV2 ? openCodeV2Entry : openCodeV1Entry;
  const entry = servers.deardiary;
  const current =
    hasCommand(entry, "local") &&
    isRecord(entry) &&
    (usesV2 ? entry.disabled !== true : entry.enabled === true);
  if (!current) {
    const existing = isRecord(entry) ? entry : {};
    const repaired = usesV2
      ? { ...existing, ...expected, ...(existing.disabled === true ? { disabled: false } : {}) }
      : { ...existing, ...expected };
    root.mcp = usesV2
      ? { ...mcp, servers: { ...servers, deardiary: repaired } }
      : { ...mcp, deardiary: repaired };
  }
  return {
    label: `OpenCode MCP (${usesV2 ? "v2" : "v1"} config)`,
    path,
    previous,
    next: current && previous !== null ? previous : formatJson(root),
    status: statusOf(previous, current),
  };
};

const planSkill = (label: string, path: string, source: string): PlannedFile => {
  const previous = readFile(path);
  return {
    label,
    path,
    previous,
    next: source,
    status: statusOf(previous, previous === source),
  };
};

interface GuidanceTarget {
  readonly label: string;
  readonly path: string;
  readonly block: string;
}

const managedBlockRange = (
  text: string,
  path: string,
): { readonly start: number; readonly end: number } | null => {
  const starts = text.split(guidanceStartMarker).length - 1;
  const ends = text.split(guidanceEndMarker).length - 1;
  if (starts === 0 && ends === 0) return null;
  const start = text.indexOf(guidanceStartMarker);
  const endMarkerStart = text.indexOf(guidanceEndMarker);
  if (starts !== 1 || ends !== 1 || start > endMarkerStart) {
    throw new Error(`Cannot safely update malformed Dear Diary guidance markers in '${path}'.`);
  }
  return { start, end: endMarkerStart + guidanceEndMarker.length };
};

const appendGuidanceBlock = (text: string, block: string): string => {
  if (text.length === 0) return block;
  return `${text}\n${block}`;
};

const planGuidance = (target: GuidanceTarget): PlannedFile => {
  const previous = readFile(target.path);
  const text = previous ?? "";
  const range = managedBlockRange(text, target.path);
  const current = range !== null && text.slice(range.start, range.end) === target.block;
  const next =
    current && previous !== null
      ? previous
      : range === null
        ? appendGuidanceBlock(text, target.block)
        : `${text.slice(0, range.start)}${target.block}${text.slice(range.end)}`;
  return {
    label: target.label,
    path: target.path,
    previous,
    next,
    status: range === null ? "missing" : current ? "current" : "drifted",
  };
};

const resolveGitRoot = (cwd: string): string => {
  try {
    const output = NodeChildProcess.execFileSync(
      "git",
      ["-C", NodePath.resolve(cwd), "rev-parse", "--show-toplevel"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    if (output.length === 0) throw new Error("Git returned an empty repository root.");
    return ensureAbsolute(output, "Git repository root");
  } catch (error) {
    throw new Error(`Project guidance requires a Git repository (current directory: '${cwd}').`, {
      cause: error,
    });
  }
};

const guidanceTargets = (
  paths: LifecyclePaths,
  harnesses: DetectedHarnesses,
  scope: GuidanceScope,
  cwd: string,
): ReadonlyArray<GuidanceTarget> => {
  if (scope === "none") return [];
  if (scope === "project") {
    const root = resolveGitRoot(cwd);
    const codexGuidance = NodePath.join(root, "AGENTS.md");
    const codexGuidanceOverride = NodePath.join(root, "AGENTS.override.md");
    return [
      ...(harnesses.codex
        ? [
            {
              label: "Codex project guidance",
              path: codexGuidance,
              block: codexGuidanceBlock,
            },
            ...(readFile(codexGuidanceOverride)?.trim().length
              ? [
                  {
                    label: "Codex project override guidance",
                    path: codexGuidanceOverride,
                    block: codexGuidanceBlock,
                  },
                ]
              : []),
          ]
        : []),
      ...(harnesses.claude
        ? [
            {
              label: "Claude Code project guidance",
              path: NodePath.join(root, "CLAUDE.md"),
              block: claudeGuidanceBlock,
            },
          ]
        : []),
    ];
  }
  const codexTargets: ReadonlyArray<GuidanceTarget> = harnesses.codex
    ? [
        {
          label: "Codex global guidance",
          path: paths.codexGuidance,
          block: codexGuidanceBlock,
        },
        ...(readFile(paths.codexGuidanceOverride)?.trim().length
          ? [
              {
                label: "Codex global override guidance",
                path: paths.codexGuidanceOverride,
                block: codexGuidanceBlock,
              },
            ]
          : []),
      ]
    : [];
  return [
    ...codexTargets,
    ...(harnesses.claude
      ? [
          {
            label: "Claude Code global guidance",
            path: paths.claudeGuidance,
            block: claudeGuidanceBlock,
          },
        ]
      : []),
  ];
};

const plansFor = (
  paths: LifecyclePaths,
  skillSource: string,
  harnesses: DetectedHarnesses,
  guidance: GuidanceScope = "global",
  cwd: string = process.cwd(),
): ReadonlyArray<PlannedFile> => [
  ...(harnesses.claude ? [planClaude(paths.claudeConfig)] : []),
  ...(harnesses.codex ? [planCodex(paths.codexConfig)] : []),
  ...(harnesses.openCode ? [planOpenCode(paths.openCodeConfig)] : []),
  planSkill("Claude Code skill", paths.claudeSkill, skillSource),
  planSkill("shared agents skill", paths.agentsSkill, skillSource),
  ...guidanceTargets(paths, harnesses, guidance, cwd).map(planGuidance),
];

const executableOnPath = (
  names: ReadonlyArray<string>,
  env: Readonly<Record<string, string | undefined>>,
): boolean => {
  const path = env.PATH;
  if (path === undefined) return false;
  for (const directory of path.split(NodePath.delimiter)) {
    if (directory.length === 0) continue;
    for (const name of names) {
      try {
        NodeFs.accessSync(NodePath.join(directory, name), NodeFs.constants.X_OK);
        return true;
      } catch {
        // Keep looking through PATH without executing a harness.
      }
    }
  }
  return false;
};

export const detectHarnesses = (
  paths: LifecyclePaths,
  env: Readonly<Record<string, string | undefined>> = process.env,
): DetectedHarnesses => ({
  claude: NodeFs.existsSync(paths.claudeConfig) || executableOnPath(["claude"], env),
  codex: NodeFs.existsSync(paths.codexConfig) || executableOnPath(["codex"], env),
  openCode:
    NodeFs.existsSync(paths.openCodeConfig) || executableOnPath(["opencode", "opencode2"], env),
});

const ensureAbsolute = (path: string, source: string): string => {
  if (!NodePath.isAbsolute(path)) throw new Error(`${source} must be an absolute path.`);
  return NodePath.normalize(path);
};

export const resolveLifecyclePaths = (
  options: ResolveLifecyclePathsOptions = {},
): LifecyclePaths => {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const homeDir = ensureAbsolute(options.homeDir ?? env.HOME ?? NodeOS.homedir(), "HOME");
  const configHome = ensureAbsolute(
    env.XDG_CONFIG_HOME ?? NodePath.join(homeDir, ".config"),
    "XDG_CONFIG_HOME",
  );
  const codexHome = ensureAbsolute(
    env.CODEX_HOME ?? NodePath.join(homeDir, ".codex"),
    "CODEX_HOME",
  );
  const data = Effect.runSync(
    Paths.resolvePaths({
      env,
      platform,
      homeDir,
    }),
  );
  return {
    homeDir,
    claudeConfig: NodePath.join(homeDir, ".claude.json"),
    codexConfig: NodePath.join(codexHome, "config.toml"),
    openCodeConfig: NodePath.join(configHome, "opencode", "opencode.json"),
    claudeSkill: NodePath.join(homeDir, ".claude", "skills", "deardiary", "SKILL.md"),
    agentsSkill: NodePath.join(homeDir, ".agents", "skills", "deardiary", "SKILL.md"),
    claudeGuidance: NodePath.join(homeDir, ".claude", "CLAUDE.md"),
    codexGuidance: NodePath.join(codexHome, "AGENTS.md"),
    codexGuidanceOverride: NodePath.join(codexHome, "AGENTS.override.md"),
    dataDir: data.dataDir,
    databasePath: data.databasePath,
  };
};

const nextBackupPath = (path: string): string => {
  let candidate = `${path}.bak`;
  let suffix = 1;
  while (NodeFs.existsSync(candidate)) {
    candidate = `${path}.bak.${String(suffix)}`;
    suffix += 1;
  }
  return candidate;
};

const atomicWrite = (path: string, content: string): void => {
  let destination = path;
  if (isSymbolicLink(path)) {
    try {
      destination = NodeFs.realpathSync(path);
    } catch (error) {
      throw new Error(`Cannot safely update dangling symlink '${path}'.`, { cause: error });
    }
  }
  NodeFs.mkdirSync(NodePath.dirname(destination), { recursive: true });
  const temporary = NodePath.join(
    NodePath.dirname(destination),
    `.${NodePath.basename(destination)}.${String(process.pid)}.tmp`,
  );
  try {
    NodeFs.writeFileSync(temporary, content, { flag: "wx" });
    if (NodeFs.existsSync(destination))
      NodeFs.chmodSync(temporary, NodeFs.statSync(destination).mode);
    NodeFs.renameSync(temporary, destination);
  } catch (error) {
    NodeFs.rmSync(temporary, { force: true });
    throw error;
  }
};

const atomicWriteAsync = async (path: string, content: string): Promise<void> => {
  let destination = path;
  let metadata = await NodeFsPromises.lstat(path);
  if (metadata.isSymbolicLink()) {
    try {
      destination = await NodeFsPromises.realpath(path);
      metadata = await NodeFsPromises.stat(destination);
    } catch (error) {
      throw new Error(`Cannot safely update dangling symlink '${path}'.`, { cause: error });
    }
  }
  const temporary = NodePath.join(
    NodePath.dirname(destination),
    `.${NodePath.basename(destination)}.${String(process.pid)}.${NodeCrypto.randomUUID()}.tmp`,
  );
  try {
    await NodeFsPromises.writeFile(temporary, content, { flag: "wx" });
    await NodeFsPromises.chmod(temporary, metadata.mode);
    await NodeFsPromises.rename(temporary, destination);
  } catch (error) {
    await NodeFsPromises.rm(temporary, { force: true });
    throw error;
  }
};

const syncInstalledSkill = async (path: string, source: string): Promise<void> => {
  let installed: string;
  try {
    installed = await NodeFsPromises.readFile(path, "utf8");
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return;
    throw error;
  }
  if (installed !== source) await atomicWriteAsync(path, source);
};

/** Run a best-effort skill refresh outside the caller's startup path. */
export const launchSkillSync = (sync: () => Promise<void>): void => {
  setImmediate(() => {
    void Promise.resolve()
      .then(sync)
      .catch(() => undefined);
  });
};

/** Refresh skill copies that the user has already installed. */
export const syncInstalledSkills = async (
  paths: Pick<LifecyclePaths, "claudeSkill" | "agentsSkill">,
  skillSource: string,
): Promise<void> => {
  await Promise.allSettled([
    syncInstalledSkill(paths.claudeSkill, skillSource),
    syncInstalledSkill(paths.agentsSkill, skillSource),
  ]);
};

const assertFilesUnchanged = (
  files: ReadonlyArray<{ readonly path: string; readonly previous: string | null }>,
  operation: string,
): void => {
  for (const file of files) {
    if (readFile(file.path) !== file.previous) {
      throw new Error(
        `Cannot safely ${operation} because '${file.path}' changed after the preview. Run the command again.`,
      );
    }
  }
};

const checkLines = (plans: ReadonlyArray<PlannedFile>): ReadonlyArray<string> =>
  plans.map((plan) => `${plan.status.toUpperCase()} ${plan.label}: ${plan.path}`);

const skippedHarnessLines = (
  paths: LifecyclePaths,
  harnesses: DetectedHarnesses,
): ReadonlyArray<string> => [
  ...(harnesses.claude
    ? []
    : [`SKIPPED Claude Code MCP: harness not detected (${paths.claudeConfig})`]),
  ...(harnesses.codex ? [] : [`SKIPPED Codex MCP: harness not detected (${paths.codexConfig})`]),
  ...(harnesses.openCode
    ? []
    : [`SKIPPED OpenCode MCP: harness not detected (${paths.openCodeConfig})`]),
];

export const checkSetup = (
  paths: LifecyclePaths,
  skillSource: string,
  harnesses: DetectedHarnesses = detectHarnesses(paths),
  guidance: GuidanceScope = "global",
  cwd: string = process.cwd(),
): LifecycleResult => {
  try {
    const plans = plansFor(paths, skillSource, harnesses, guidance, cwd);
    const current = plans.every((plan) => plan.status === "current");
    return {
      exitCode: current ? 0 : 1,
      output: [...checkLines(plans), ...skippedHarnessLines(paths, harnesses)].join("\n"),
    };
  } catch (error) {
    return { exitCode: 1, output: `ERROR ${errorMessage(error)}` };
  }
};

export interface SetupOptions {
  readonly paths: LifecyclePaths;
  readonly skillSource: string;
  readonly yes: boolean;
  readonly confirm: (question: string) => Promise<string>;
  readonly harnesses?: DetectedHarnesses;
  readonly guidance?: GuidanceScope;
  readonly cwd?: string;
}

const changePreview = (plan: PlannedFile): ReadonlyArray<string> => {
  const isMcp = plan.label.includes("MCP");
  const isGuidance = plan.label.includes("guidance");
  const before = plan.previous === null ? "absent" : "different";
  if (isMcp)
    return [
      `    - deardiary entry: ${before}`,
      '    + command: "npx"; args: ["-y", "@p4cs/deardiary@latest", "mcp"]',
    ];
  if (isGuidance)
    return [
      `    - managed guidance: ${before}`,
      `    + ${guidanceStartMarker} … ${guidanceEndMarker}`,
    ];
  return [`    - skill copy: ${before}`, "    + skill copy: canonical apps/cli/skill/SKILL.md"];
};

export const setup = async (options: SetupOptions): Promise<LifecycleResult> => {
  let plans: ReadonlyArray<PlannedFile>;
  const harnesses = options.harnesses ?? detectHarnesses(options.paths);
  const guidance = options.guidance ?? "global";
  try {
    plans = plansFor(
      options.paths,
      options.skillSource,
      harnesses,
      guidance,
      options.cwd ?? process.cwd(),
    );
  } catch (error) {
    return { exitCode: 1, output: `Setup failed before making changes: ${errorMessage(error)}` };
  }
  const changes = plans.filter((plan) => plan.status !== "current");
  const preview = [
    `Setup preview (${guidance === "project" ? "project configuration" : "global user configuration"}):`,
    ...plans.map((plan) => {
      if (plan.status === "current") return `  UNCHANGED ${plan.path}`;
      const diff = changePreview(plan).join("\n");
      if (plan.previous === null) return `  CREATE ${plan.path}\n${diff}`;
      return `  UPDATE ${plan.path}\n${diff}\n    backup: ${nextBackupPath(plan.path)}`;
    }),
    ...skippedHarnessLines(options.paths, harnesses).map((line) => `  ${line}`),
    "  MCP command: npx -y @p4cs/deardiary@latest mcp",
  ];
  if (changes.length === 0) {
    return { exitCode: 0, output: [...preview, "Dear Diary setup is already current."].join("\n") };
  }
  if (!options.yes) {
    const answer = await options.confirm(
      `${preview.join("\n")}\nApply these changes? Type 'yes': `,
    );
    if (answer.trim() !== "yes") {
      return { exitCode: 0, output: "Setup cancelled; no files changed." };
    }
  }

  try {
    assertFilesUnchanged(changes, "apply setup");
  } catch (error) {
    return { exitCode: 1, output: `Setup aborted before making changes: ${errorMessage(error)}` };
  }

  const output = options.yes ? preview : [];
  try {
    for (const change of changes) {
      if (change.previous !== null) {
        const backup = nextBackupPath(change.path);
        NodeFs.mkdirSync(NodePath.dirname(backup), { recursive: true });
        NodeFs.copyFileSync(change.path, backup, NodeFs.constants.COPYFILE_EXCL);
        output.push(`Backed up ${change.path} -> ${backup}`);
      }
      atomicWrite(change.path, change.next);
      output.push(`${change.previous === null ? "Created" : "Updated"} ${change.path}`);
    }
  } catch (error) {
    output.push(`Setup failed: ${errorMessage(error)}`);
    return { exitCode: 1, output: output.join("\n") };
  }
  output.push(
    "Setup complete. Restart open harness sessions, then run 'npx -y @p4cs/deardiary@latest doctor'.",
  );
  return { exitCode: 0, output: output.join("\n") };
};

const removeClaude = (path: string): RemovedFile | null => {
  const previous = readFile(path);
  if (previous === null) return null;
  const root = parseJsonConfig(previous, path);
  if (!isRecord(root.mcpServers) || !("deardiary" in root.mcpServers)) return null;
  const { deardiary: _, ...servers } = root.mcpServers;
  root.mcpServers = servers;
  return { label: "Claude Code MCP", path, previous, next: formatJson(root) };
};

const removeCodex = (path: string): RemovedFile | null => {
  const previous = readFile(path);
  if (previous === null) return null;
  const section = findCodexSection(previous);
  return section === null
    ? null
    : {
        label: "Codex MCP",
        path,
        previous,
        next: withoutCodexSection(previous, section),
      };
};

const removeOpenCode = (path: string): RemovedFile | null => {
  const previous = readFile(path);
  if (previous === null) return null;
  const root = parseJsonConfig(previous, path);
  if (!isRecord(root.mcp)) return null;
  if (isRecord(root.mcp.servers) && "deardiary" in root.mcp.servers) {
    const { deardiary: _, ...servers } = root.mcp.servers;
    root.mcp = { ...root.mcp, servers };
  } else if ("deardiary" in root.mcp) {
    const { deardiary: _, ...mcp } = root.mcp;
    root.mcp = mcp;
  } else {
    return null;
  }
  return { label: "OpenCode MCP", path, previous, next: formatJson(root) };
};

const isDearDiarySkill = (content: string): boolean =>
  /^---\s*$[\s\S]*?^name:\s*deardiary\s*$[\s\S]*?^---\s*$/mu.test(content);

const removeSkill = (label: string, path: string): RemovedFile | null => {
  const previous = readFile(path);
  return previous !== null && isDearDiarySkill(previous)
    ? { label, path, previous, next: null }
    : null;
};

const removeGuidance = (target: GuidanceTarget): RemovedFile | null => {
  const previous = readFile(target.path);
  if (previous === null) return null;
  const range = managedBlockRange(previous, target.path);
  if (range === null) return null;
  const start =
    range.start > 0 && previous[range.start - 1] === "\n" ? range.start - 1 : range.start;
  const next = `${previous.slice(0, start)}${previous.slice(range.end)}`;
  return {
    label: target.label,
    path: target.path,
    previous,
    next: next.length === 0 ? null : next,
  };
};

const removePlans = (
  paths: LifecyclePaths,
  guidance: ManagedGuidanceScope,
  cwd: string,
): ReadonlyArray<RemovedFile> =>
  [
    removeClaude(paths.claudeConfig),
    removeCodex(paths.codexConfig),
    removeOpenCode(paths.openCodeConfig),
    removeSkill("Claude Code skill", paths.claudeSkill),
    removeSkill("shared agents skill", paths.agentsSkill),
    ...guidanceTargets(paths, { claude: true, codex: true, openCode: false }, guidance, cwd).map(
      removeGuidance,
    ),
  ].filter((plan): plan is RemovedFile => plan !== null);

const removeEmptyParent = (path: string): void => {
  try {
    NodeFs.rmdirSync(NodePath.dirname(path));
  } catch (error) {
    if (!isNodeError(error, "ENOTEMPTY") && !isNodeError(error, "ENOENT")) throw error;
  }
};

const pathContains = (parent: string, child: string): boolean => {
  const relative = NodePath.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !NodePath.isAbsolute(relative));
};

const validateDataDeletionTarget = (paths: LifecyclePaths, cwd: string): void => {
  const root = NodePath.parse(paths.dataDir).root;
  const resolvedCwd = NodePath.resolve(cwd);
  const depthBelowRoot = NodePath.relative(root, paths.dataDir)
    .split(NodePath.sep)
    .filter(Boolean).length;
  if (
    paths.dataDir === root ||
    depthBelowRoot <= 1 ||
    pathContains(paths.dataDir, paths.homeDir) ||
    pathContains(paths.dataDir, resolvedCwd)
  ) {
    throw new Error(`Refusing unsafe data deletion target '${paths.dataDir}'.`);
  }
  if (NodeFs.existsSync(paths.dataDir)) {
    const realTarget = NodeFs.realpathSync(paths.dataDir);
    if (
      realTarget === root ||
      pathContains(realTarget, NodeFs.realpathSync(paths.homeDir)) ||
      pathContains(realTarget, NodeFs.realpathSync(resolvedCwd))
    ) {
      throw new Error(`Refusing unsafe data deletion target '${paths.dataDir}'.`);
    }
  }
};

export interface UninstallOptions {
  readonly paths: LifecyclePaths;
  readonly level: "integrations" | "cli" | "full";
  readonly yes: boolean;
  readonly confirm: (question: string) => Promise<string>;
  readonly guidance?: ManagedGuidanceScope;
  readonly cwd?: string;
}

const cliRemovalInstruction = "Remove the CLI after this command exits: npm rm -g @p4cs/deardiary";
export const fullWipeConfirmation = "DELETE DEAR DIARY DATA";

export const uninstall = async (options: UninstallOptions): Promise<LifecycleResult> => {
  let removals: ReadonlyArray<RemovedFile>;
  const cwd = options.cwd ?? process.cwd();
  try {
    removals = removePlans(options.paths, options.guidance ?? "global", cwd);
    if (options.level === "full") validateDataDeletionTarget(options.paths, cwd);
  } catch (error) {
    return {
      exitCode: 1,
      output: `Uninstall failed before making changes: ${errorMessage(error)}`,
    };
  }
  const dataExists = options.level === "full" && NodeFs.existsSync(options.paths.dataDir);
  const preview = [
    `Uninstall preview (level: ${options.level}):`,
    ...removals.map((removal) => `  REMOVE ${removal.label}: ${removal.path}`),
    ...(dataExists ? [`  DELETE data: ${options.paths.dataDir}`] : []),
    ...(options.level === "integrations" ? [] : [`  CLI instruction: npm rm -g @p4cs/deardiary`]),
  ];
  if (!options.yes) {
    const required = options.level === "full" ? fullWipeConfirmation : "yes";
    const answer = await options.confirm(`${preview.join("\n")}\nType '${required}' to continue: `);
    if (answer.trim() !== required) {
      return { exitCode: 0, output: "Uninstall cancelled; no files removed." };
    }
  }

  try {
    assertFilesUnchanged(removals, "apply uninstall");
  } catch (error) {
    return {
      exitCode: 1,
      output: `Uninstall aborted before making changes: ${errorMessage(error)}`,
    };
  }

  const output = options.yes ? preview : [];
  try {
    for (const removal of removals) {
      if (removal.next === null) {
        if (isSymbolicLink(removal.path)) atomicWrite(removal.path, "");
        else {
          NodeFs.unlinkSync(removal.path);
          removeEmptyParent(removal.path);
        }
      } else {
        atomicWrite(removal.path, removal.next);
      }
      output.push(`Removed ${removal.label}: ${removal.path}`);
    }
    if (dataExists) {
      NodeFs.rmSync(options.paths.dataDir, { recursive: true });
      output.push(`Deleted data: ${options.paths.dataDir}`);
    }
  } catch (error) {
    output.push(`Uninstall failed: ${errorMessage(error)}`);
    return { exitCode: 1, output: output.join("\n") };
  }
  if (removals.length === 0 && !dataExists) output.push("No Dear Diary files or entries found.");
  if (options.level !== "integrations") output.push(cliRemovalInstruction);
  return { exitCode: 0, output: output.join("\n") };
};

const processEnvironment = (): Record<string, string> =>
  Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );

export const probeMcpStartup: StartupProbe = async () => {
  const temporaryData = NodeFs.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "deardiary-startup-"));
  const cliPath = process.argv[1];
  if (cliPath === undefined) throw new Error("Cannot resolve the running Dear Diary CLI path.");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [...process.execArgv, cliPath, "mcp"],
    env: { ...processEnvironment(), DEARDIARY_HOME: temporaryData, NO_COLOR: "1" },
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  const client = new Client({ name: "deardiary-lifecycle", version: "0.0.1" });
  const started = performance.now();
  try {
    await client.connect(transport, { timeout: 5_000 });
    const tools = await client.listTools(undefined, { timeout: 5_000 });
    return { milliseconds: performance.now() - started, toolCount: tools.tools.length };
  } catch (error) {
    const detail = stderr.trim();
    throw new Error(`${errorMessage(error)}${detail.length === 0 ? "" : ` (${detail})`}`, {
      cause: error,
    });
  } finally {
    await client.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
    NodeFs.rmSync(temporaryData, { recursive: true, force: true });
  }
};

export const benchStartup = async (
  probe: StartupProbe = probeMcpStartup,
): Promise<LifecycleResult> => {
  try {
    const result = await probe();
    if (result.toolCount !== 3) {
      return {
        exitCode: 1,
        output: `MCP startup failed: expected 3 tools, received ${String(result.toolCount)}.`,
      };
    }
    return {
      exitCode: 0,
      output: `MCP startup OK: ${String(Math.round(result.milliseconds))} ms cold handshake, 3 tools, no daemon.`,
    };
  } catch (error) {
    return { exitCode: 1, output: `MCP startup failed: ${errorMessage(error)}` };
  }
};

const databaseHealth = (paths: LifecyclePaths): { readonly ok: boolean; readonly line: string } => {
  if (!NodeFs.existsSync(paths.databasePath)) {
    return { ok: true, line: `OK Data: database not created yet (${paths.databasePath})` };
  }
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(paths.databasePath, { readOnly: true });
    const quickCheck = database.prepare("PRAGMA quick_check").get() as
      | { readonly quick_check?: unknown }
      | undefined;
    const tables = database
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('entries', 'projects')",
      )
      .all() as unknown as ReadonlyArray<{ readonly name: string }>;
    if (quickCheck?.quick_check !== "ok") {
      return { ok: false, line: `FAIL Data: SQLite quick_check failed (${paths.databasePath})` };
    }
    if (new Set(tables.map((table) => table.name)).size !== 2) {
      return {
        ok: false,
        line: `FAIL Data: Dear Diary schema is incomplete (${paths.databasePath})`,
      };
    }
    return { ok: true, line: `OK Data: SQLite healthy (${paths.databasePath})` };
  } catch (error) {
    return { ok: false, line: `FAIL Data: ${errorMessage(error)} (${paths.databasePath})` };
  } finally {
    database?.close();
  }
};

export interface DoctorOptions {
  readonly paths: LifecyclePaths;
  readonly skillSource: string;
  readonly version: string;
  readonly probe?: StartupProbe;
  readonly harnesses?: DetectedHarnesses;
  readonly guidance?: GuidanceScope;
  readonly cwd?: string;
}

export const doctor = async (options: DoctorOptions): Promise<LifecycleResult> => {
  const lines = [`OK CLI: Dear Diary ${options.version}, ${process.version}`];
  let failed = false;
  const data = databaseHealth(options.paths);
  lines.push(data.line);
  failed ||= !data.ok;
  const harnesses = options.harnesses ?? detectHarnesses(options.paths);
  try {
    for (const plan of plansFor(
      options.paths,
      options.skillSource,
      harnesses,
      options.guidance ?? "global",
      options.cwd ?? process.cwd(),
    )) {
      if (plan.status === "current") lines.push(`OK ${plan.label}: ${plan.path}`);
      else
        lines.push(
          `WARN ${plan.label}: ${plan.status}; run 'npx -y @p4cs/deardiary@latest setup' (${plan.path})`,
        );
    }
    lines.push(...skippedHarnessLines(options.paths, harnesses));
  } catch (error) {
    failed = true;
    lines.push(`FAIL Integrations: ${errorMessage(error)}`);
  }
  const startup = await benchStartup(options.probe ?? probeMcpStartup);
  lines.push(startup.exitCode === 0 ? `OK ${startup.output}` : `FAIL ${startup.output}`);
  failed ||= startup.exitCode !== 0;
  return { exitCode: failed ? 1 : 0, output: lines.join("\n") };
};

export const readCanonicalSkill = (url: URL): string => NodeFs.readFileSync(url, "utf8");

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : "An unexpected lifecycle error occurred.";
