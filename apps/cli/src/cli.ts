#!/usr/bin/env node

import * as NodeFsPromises from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline/promises";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Database from "@deardiary/core/db";
import * as Entries from "@deardiary/core/entries";
import * as Format from "@deardiary/core/format";
import * as Git from "@deardiary/core/git";
import * as Paths from "@deardiary/core/paths";
import * as Projects from "@deardiary/core/projects";
import { runStdioServer } from "@deardiary/mcp/server";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import cliPackage from "../package.json" with { type: "json" };
import {
  CliUsageError,
  type CommandName,
  type ParsedCommand,
  parseArgs,
  type ScopeSelection,
} from "./args.ts";
import {
  benchStartup,
  checkSetup,
  detectAgents,
  doctor,
  launchSkillSync,
  type LifecyclePaths,
  probeMcpStartup,
  readCanonicalSkill,
  resolveLifecyclePaths,
  setup,
  type SetupAgent,
  type SetupSelection,
  syncInstalledSkills,
  type StartupProbe,
  uninstall,
} from "./lifecycle.ts";
import {
  confirmSetupChanges,
  renderLifecycleOutput,
  startDoctorActivity,
  terminalColorEnabled,
  terminalPresentationEnabled,
} from "./presentation.ts";
import { runSetupWizard, type SetupWizard } from "./setup-wizard.ts";

export const version = cliPackage.version;

const rootHelp = `Dear Diary — a local diary for coding agents

Usage: deardiary <command> [options]

Commands:
  log       Append an entry
  read      Read entries
  context   Render current-project and global context
  stats     Show entry statistics
  random    Show one random entry
  export    Export entries
  mcp       Run the stdio MCP server
  setup     Choose agents and install integrations, skills, and guidance
  doctor    Check runtime, data, integrations, guidance, and MCP startup
  bench-startup  Measure a cold MCP handshake
  uninstall Remove guidance, integrations, CLI, or all data

Options:
  -h, --help       Show help
  -v, --version    Show version

Run 'deardiary <command> --help' for command-specific options.`;

const sharedFilters = `  --mood <mood>       struggled | win | note | idea | rant
  --since <timestamp>  Canonical UTC ISO 8601 timestamp
  --model <model>      Exact model filter
  --harness <harness>  Exact harness filter
  --tag <tag>          Exact tag filter`;

const sharedScopes = `  --global             Global entries only
  --all                Entries from every project and global entries
  --project <path>     Entries for the Git repository containing path
                        (scope options are mutually exclusive)`;

const commandHelp: Readonly<Record<CommandName, string>> = {
  log: `Usage: deardiary log [options] [--] <body...>

Append an entry. Mood defaults to 'note'. Use '--' before a body beginning with '-'.

Options:
  --mood <mood>       struggled | win | note | idea | rant (default: note)
  --tag <tag>         Add an exact tag; repeat for multiple tags
  --model <model>     Model name
  --harness <name>    Harness name
  --cwd <path>        Working directory (default: current directory)
  --global            Do not associate the entry with a Git project
  --json              Print the canonical entry as JSON
  --help              Show this help`,
  read: `Usage: deardiary read [options]

Read entries. The default scope is the current Git project, or global outside Git.

Options:
${sharedScopes}
${sharedFilters}
  --limit <1-1000>     Maximum entries (default: 50)
  --newest             Newest first (default)
  --oldest             Oldest first
  --json               Print entries as JSON
  --help               Show this help`,
  context: `Usage: deardiary context [options]

Render current-project plus global context. Outside Git, the default is global.

Options:
  --all                 Include every project's entries
  --cwd <path>          Working directory (default: current directory)
${sharedFilters}
  --limit <1-1000>      Maximum entries (default: 50)
  --newest              Newest first (default)
  --oldest              Oldest first
  --json                Print entries as JSON
  --help                Show this help`,
  stats: `Usage: deardiary stats [options]

Show statistics. The default scope is the current Git project, or global outside Git.

Options:
${sharedScopes}
${sharedFilters}
  --json               Print statistics as JSON
  --help               Show this help`,
  random: `Usage: deardiary random [options]

Show one random eligible entry. The default scope is the current Git project, or global outside Git.

Options:
${sharedScopes}
${sharedFilters}
  --json               Print the entry as JSON (null when none is eligible)
  --help               Show this help`,
  export: `Usage: deardiary export --markdown [options]

Write a complete oldest-first Markdown export to stdout.

Options:
  --markdown           Export as Markdown (required)
${sharedScopes}
${sharedFilters}
  --help               Show this help`,
  mcp: `Usage: deardiary mcp

Run the long-lived Dear Diary MCP server over stdio. This command accepts no data-command options.
Protocol messages are written to stdout; diagnostics are written to stderr.`,
  setup: `Usage: deardiary setup [--check] [--yes] [--guidance <global|project|none>]

Open an installation wizard for detected Codex, Claude Code, Grok Build, Cursor, and OpenCode
agents. Choose any detected agents, or choose Custom path to enter a skills directory and an
AGENTS.md file to append to. Dear Diary writes the custom skill to deardiary/SKILL.md inside that
directory. Guidance is global by default. Project guidance targets the Git
repository containing the current directory and requires Git. Existing files are backed up before
changes. Custom paths are saved for future setup checks, doctor runs, skill refresh, and uninstall.
Restart open agent sessions after setup.

Options:
  --check               Read-only integration, skill, and selected-guidance drift check
  --yes                 Install to every detected agent without opening the wizard
  --guidance <scope>    global (default), project, or none
                        none leaves existing passive guidance untouched
  --help                Show this help`,
  doctor: `Usage: deardiary doctor

Read-only checks for the CLI/runtime, existing database, integrations, skill copies, global passive
guidance, and a cold MCP handshake. The handshake uses temporary data and starts no daemon.`,
  "bench-startup": `Usage: deardiary bench-startup

Measure one cold MCP server startup and handshake using temporary data. Starts no daemon.`,
  uninstall: `Usage: deardiary uninstall [--level <integrations|cli|full>] [--yes]
                            [--guidance <global|project>]

Remove tightly scoped Dear Diary files, managed guidance, and config entries. The default level is
integrations and the default guidance scope is global. Project guidance targets the Git repository
containing the current directory. Uninstall never searches other repositories.

Levels:
  integrations  Remove MCP entries, skill copies, and selected managed guidance (default)
  cli           Remove integrations and print the final global CLI removal command; keep data
  full          Remove integrations, print the CLI command, and delete Dear Diary data

Options:
  --level <level>      Select integrations, cli, or full
  --yes                Skip confirmation; requires an explicit --level
  --guidance <scope>   Remove managed global (default) or current-project guidance
  --help               Show this help

Interactive full wipe requires typing 'DELETE DEAR DIARY DATA' exactly.`,
};

export interface CliIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

export interface RunOptions {
  readonly cwd?: string;
  readonly io?: CliIo;
  readonly confirm?: (question: string) => Promise<string>;
  readonly lifecyclePaths?: LifecyclePaths;
  readonly startupProbe?: StartupProbe;
  readonly setupWizard?: SetupWizard;
}

class CliUserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliUserError";
  }
}

const liveLayer = Entries.layer.pipe(
  Layer.provideMerge(Projects.layer),
  Layer.provideMerge(Database.layer),
  Layer.provideMerge(Paths.layer),
  Layer.provideMerge(Git.layer),
  Layer.provideMerge(NodeServices.layer),
);

const json = (value: unknown): string => JSON.stringify(value, null, 2);

const resolveCwd = (baseCwd: string, value: string | undefined): string =>
  NodePath.resolve(baseCwd, value ?? ".");

const resolveScope = Effect.fn("Cli.resolveScope")(function* (
  selection: ScopeSelection,
  cwd: string,
) {
  switch (selection.kind) {
    case "global":
      return { kind: "global" } as const;
    case "all":
      return { kind: "all" } as const;
    case "project-path": {
      const projects = yield* Projects.ProjectRepository;
      const path = resolveCwd(cwd, selection.path);
      const project = yield* projects.resolveForCwd(path);
      if (project === null) {
        return yield* Effect.fail(
          new CliUserError(
            `'${path}' is not inside a Git working tree; project scope was not applied.`,
          ),
        );
      }
      return { kind: "project", projectId: project.id } as const;
    }
    case "default": {
      const projects = yield* Projects.ProjectRepository;
      const project = yield* projects.resolveForCwd(cwd);
      return project === null
        ? ({ kind: "global" } as const)
        : ({ kind: "project", projectId: project.id } as const);
    }
  }
});

const queryFilters = (
  command: Extract<ParsedCommand, { readonly kind: "read" | "stats" | "random" | "export" }>,
) => ({
  ...(command.mood === undefined ? {} : { mood: command.mood }),
  ...(command.since === undefined ? {} : { since: command.since }),
  ...(command.model === undefined ? {} : { model: command.model }),
  ...(command.harness === undefined ? {} : { harness: command.harness }),
  ...(command.tag === undefined ? {} : { tag: command.tag }),
});

const execute = Effect.fn("Cli.execute")(function* (
  command: Extract<
    ParsedCommand,
    {
      readonly kind:
        | "help"
        | "version"
        | "log"
        | "read"
        | "context"
        | "stats"
        | "random"
        | "export";
    }
  >,
  cwd: string,
) {
  switch (command.kind) {
    case "help":
      return command.command === undefined ? rootHelp : commandHelp[command.command];
    case "version":
      return version;
    case "log": {
      const repository = yield* Entries.EntryRepository;
      const entry = yield* repository.append({
        cwd: resolveCwd(cwd, command.cwd),
        body: command.body,
        mood: command.mood,
        tags: command.tags,
        ...(command.model === undefined ? {} : { model: command.model }),
        ...(command.harness === undefined ? {} : { harness: command.harness }),
        ...(command.global ? { forceGlobal: true } : {}),
      });
      return command.json ? json(entry) : `Logged ${entry.mood} entry ${entry.id}.`;
    }
    case "read": {
      const repository = yield* Entries.EntryRepository;
      const scope = yield* resolveScope(command.scope, cwd);
      const entries = yield* repository.read({
        scope,
        ...queryFilters(command),
        order: command.order,
        ...(command.limit === undefined ? {} : { limit: command.limit }),
      });
      return command.json ? json(entries) : Format.renderEntries(entries);
    }
    case "context": {
      const repository = yield* Entries.EntryRepository;
      const entries = yield* repository.context({
        cwd: resolveCwd(cwd, command.cwd),
        ...(command.all ? { all: true } : {}),
        ...(command.mood === undefined ? {} : { mood: command.mood }),
        ...(command.since === undefined ? {} : { since: command.since }),
        ...(command.model === undefined ? {} : { model: command.model }),
        ...(command.harness === undefined ? {} : { harness: command.harness }),
        ...(command.tag === undefined ? {} : { tag: command.tag }),
        order: command.order,
        ...(command.limit === undefined ? {} : { limit: command.limit }),
      });
      return command.json ? json(entries) : Format.renderContext(entries);
    }
    case "stats": {
      const repository = yield* Entries.EntryRepository;
      const scope = yield* resolveScope(command.scope, cwd);
      const stats = yield* repository.stats({ scope, ...queryFilters(command) });
      return command.json ? json(stats) : Format.renderStats(stats);
    }
    case "random": {
      const repository = yield* Entries.EntryRepository;
      const scope = yield* resolveScope(command.scope, cwd);
      const entry = yield* repository.random({ scope, ...queryFilters(command) });
      return command.json ? json(entry) : Format.renderEntries(entry === null ? [] : [entry]);
    }
    case "export": {
      const repository = yield* Entries.EntryRepository;
      const scope = yield* resolveScope(command.scope, cwd);
      const entries = yield* repository.exportEntries({ scope, ...queryFilters(command) });
      return Format.renderMarkdown(entries);
    }
  }
});

const defaultIo: CliIo = {
  stdout: (text) => process.stdout.write(`${text}\n`),
  stderr: (text) => process.stderr.write(`${text}\n`),
};

const errorMessage = (error: unknown): string => {
  if (error instanceof Git.GitCommandExitError) {
    const detail = error.stderr.trim();
    return detail.length === 0 ? error.message : `${error.message} ${detail}`;
  }
  if (error instanceof Error) return error.message;
  return "An unexpected error occurred.";
};

const usageHint = (command: CommandName | undefined): string =>
  command === undefined
    ? "Try 'deardiary --help' for usage."
    : `Try 'deardiary ${command} --help' for usage.`;

const defaultConfirm = async (question: string): Promise<string> => {
  const readline = NodeReadline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await readline.question(question);
  } finally {
    readline.close();
  }
};

export const run = async (
  argv: ReadonlyArray<string>,
  options: RunOptions = {},
): Promise<number> => {
  const io = options.io ?? defaultIo;
  let parsed: ParsedCommand;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    if (error instanceof CliUsageError) {
      io.stderr(`deardiary: ${error.message}\n${usageHint(error.command)}`);
      return 2;
    }
    io.stderr(`deardiary: ${errorMessage(error)}`);
    return 1;
  }

  if (parsed.kind === "help") {
    io.stdout(parsed.command === undefined ? rootHelp : commandHelp[parsed.command]);
    return 0;
  }
  if (parsed.kind === "version") {
    io.stdout(version);
    return 0;
  }
  if (parsed.kind === "mcp") {
    try {
      const server = runStdioServer({
        startupCwd: NodePath.resolve(options.cwd ?? process.cwd()),
        version,
      });
      launchSkillSync(async () => {
        const paths = options.lifecyclePaths ?? resolveLifecyclePaths();
        const skillSource = await NodeFsPromises.readFile(
          new URL("../skill/SKILL.md", import.meta.url),
          "utf8",
        );
        await syncInstalledSkills(paths, skillSource);
      });
      await server;
      return 0;
    } catch (error) {
      io.stderr(`deardiary: ${errorMessage(error)}`);
      return 1;
    }
  }
  if (
    parsed.kind === "setup" ||
    parsed.kind === "doctor" ||
    parsed.kind === "bench-startup" ||
    parsed.kind === "uninstall"
  ) {
    let paths: LifecyclePaths;
    try {
      paths = options.lifecyclePaths ?? resolveLifecyclePaths();
    } catch (error) {
      io.stderr(`deardiary: ${errorMessage(error)}`);
      return 1;
    }
    const interactive = options.io === undefined && terminalPresentationEnabled();
    const confirm =
      options.confirm ??
      (parsed.kind === "setup" && interactive ? confirmSetupChanges : defaultConfirm);
    let result;
    const cwd = NodePath.resolve(options.cwd ?? process.cwd());
    if (parsed.kind === "bench-startup") {
      result = await benchStartup(options.startupProbe ?? probeMcpStartup);
    } else if (parsed.kind === "uninstall") {
      result = await uninstall({
        paths,
        level: parsed.level,
        yes: parsed.yes,
        confirm,
        guidance: parsed.guidance,
        cwd,
      });
    } else {
      let skillSource: string;
      try {
        skillSource = readCanonicalSkill(new URL("../skill/SKILL.md", import.meta.url));
      } catch (error) {
        io.stderr(`deardiary: Failed to read the canonical skill: ${errorMessage(error)}`);
        return 1;
      }
      if (parsed.kind === "setup") {
        const detected = detectAgents(paths);
        const detectedSelection: SetupSelection = {
          agents: (Object.entries(detected) as ReadonlyArray<[SetupAgent, boolean]>)
            .filter(([, installed]) => installed)
            .map(([agent]) => agent),
        };
        const selection =
          parsed.check || parsed.yes
            ? detectedSelection
            : await (options.setupWizard ?? runSetupWizard)({ paths, detected, cwd });
        if (selection === null) {
          if (options.setupWizard !== undefined || !interactive) {
            io.stdout("Setup cancelled; no files changed.");
          }
          return 0;
        }
        const selected = new Set(selection.agents);
        const harnesses = {
          claude: selected.has("claude"),
          codex: selected.has("codex"),
          openCode: selected.has("openCode"),
        };
        result = parsed.check
          ? checkSetup(paths, skillSource, harnesses, parsed.guidance, cwd, selection)
          : await setup({
              paths,
              skillSource,
              yes: parsed.yes,
              confirm,
              guidance: parsed.guidance,
              cwd,
              selection,
            });
      } else {
        const activity = interactive ? startDoctorActivity() : null;
        try {
          result = await doctor({
            paths,
            skillSource,
            version,
            probe: options.startupProbe ?? probeMcpStartup,
            cwd,
          });
          activity?.finish(result.exitCode === 0);
        } catch (error) {
          activity?.finish(false);
          throw error;
        }
      }
    }
    io.stdout(
      interactive
        ? renderLifecycleOutput({
            command: parsed.kind,
            output: result.output,
            exitCode: result.exitCode,
            color: terminalColorEnabled(),
            continuation: parsed.kind === "setup" && !parsed.check && !parsed.yes,
          })
        : result.output,
    );
    return result.exitCode;
  }

  const result = await Effect.runPromise(
    execute(parsed, NodePath.resolve(options.cwd ?? process.cwd())).pipe(
      Effect.scoped,
      Effect.provide(liveLayer),
      Effect.match({
        onFailure: (error) => ({ ok: false as const, error }),
        onSuccess: (output) => ({ ok: true as const, output }),
      }),
    ),
  );
  if (!result.ok) {
    io.stderr(`deardiary: ${errorMessage(result.error)}`);
    return 1;
  }
  io.stdout(result.output);
  return 0;
};

if (import.meta.main) {
  run(process.argv.slice(2)).then(
    (exitCode) => {
      process.exitCode = exitCode;
    },
    (error: unknown) => {
      defaultIo.stderr(`deardiary: ${errorMessage(error)}`);
      process.exitCode = 1;
    },
  );
}
