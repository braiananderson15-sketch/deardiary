import type { EntryFilters, Mood } from "@deardiary/core/entries";

export const moods = ["struggled", "win", "note", "idea", "rant"] as const;

export type Order = "newest" | "oldest";

export type ScopeSelection =
  | { readonly kind: "default" }
  | { readonly kind: "global" }
  | { readonly kind: "all" }
  | { readonly kind: "project-path"; readonly path: string };

interface OutputOptions {
  readonly json: boolean;
}

interface FilterOptions extends EntryFilters {}

interface QueryOptions extends OutputOptions, FilterOptions {
  readonly scope: ScopeSelection;
}

export type ParsedCommand =
  | { readonly kind: "help"; readonly command?: CommandName }
  | { readonly kind: "version" }
  | { readonly kind: "mcp" }
  | {
      readonly kind: "setup";
      readonly check: boolean;
      readonly yes: boolean;
      readonly guidance: SetupGuidanceScope;
    }
  | { readonly kind: "doctor" }
  | { readonly kind: "bench-startup" }
  | {
      readonly kind: "uninstall";
      readonly level: UninstallLevel;
      readonly explicitLevel: boolean;
      readonly yes: boolean;
      readonly guidance: UninstallGuidanceScope;
    }
  | {
      readonly kind: "log";
      readonly body: string;
      readonly mood: Mood;
      readonly tags: ReadonlyArray<string>;
      readonly cwd?: string;
      readonly model?: string;
      readonly harness?: string;
      readonly global: boolean;
      readonly json: boolean;
    }
  | (QueryOptions & {
      readonly kind: "read";
      readonly order: Order;
      readonly limit?: number;
    })
  | (OutputOptions &
      FilterOptions & {
        readonly kind: "context";
        readonly cwd?: string;
        readonly all: boolean;
        readonly order: Order;
        readonly limit?: number;
      })
  | (QueryOptions & { readonly kind: "stats" })
  | (QueryOptions & { readonly kind: "random" })
  | (FilterOptions & {
      readonly kind: "export";
      readonly scope: ScopeSelection;
      readonly markdown: true;
    });

export type UninstallLevel = "integrations" | "cli" | "full";
export type SetupGuidanceScope = "global" | "project" | "none";
export type UninstallGuidanceScope = Exclude<SetupGuidanceScope, "none">;

export type CommandName =
  | "log"
  | "read"
  | "context"
  | "stats"
  | "random"
  | "export"
  | "mcp"
  | "setup"
  | "doctor"
  | "bench-startup"
  | "uninstall";

export class CliUsageError extends Error {
  readonly command?: CommandName;

  constructor(message: string, command?: CommandName) {
    super(message);
    this.name = "CliUsageError";
    if (command !== undefined) this.command = command;
  }
}

type FlagKind = "boolean" | "value" | "repeat";
type FlagSpec = Readonly<Record<string, FlagKind>>;

interface ParsedTokens {
  readonly flags: ReadonlyMap<string, ReadonlyArray<string>>;
  readonly positionals: ReadonlyArray<string>;
}

const parseTokens = (
  argv: ReadonlyArray<string>,
  specs: FlagSpec,
  command: CommandName,
): ParsedTokens => {
  const flags = new Map<string, Array<string>>();
  const positionals: Array<string> = [];
  let afterSeparator = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) continue;
    if (afterSeparator) {
      positionals.push(token);
      continue;
    }
    if (token === "--") {
      afterSeparator = true;
      continue;
    }
    if (!token.startsWith("-")) {
      positionals.push(token);
      continue;
    }
    if (!token.startsWith("--")) {
      throw new CliUsageError(`Unknown argument '${token}'.`, command);
    }

    const equals = token.indexOf("=");
    const name = equals === -1 ? token : token.slice(0, equals);
    const inlineValue = equals === -1 ? undefined : token.slice(equals + 1);
    const spec = specs[name];
    if (spec === undefined) {
      throw new CliUsageError(`Unknown option '${name}'.`, command);
    }

    const previous = flags.get(name);
    if (spec !== "repeat" && previous !== undefined) {
      throw new CliUsageError(`Option '${name}' may only be specified once.`, command);
    }
    if (spec === "boolean") {
      if (inlineValue !== undefined) {
        throw new CliUsageError(`Option '${name}' does not accept a value.`, command);
      }
      flags.set(name, ["true"]);
      continue;
    }

    let value = inlineValue;
    if (value === undefined) {
      const candidate = argv[index + 1];
      if (candidate === undefined || candidate.startsWith("--")) {
        throw new CliUsageError(`Option '${name}' requires a value.`, command);
      }
      value = candidate;
      index += 1;
    }
    if (value.length === 0) {
      throw new CliUsageError(`Option '${name}' requires a non-empty value.`, command);
    }
    flags.set(name, [...(previous ?? []), value]);
  }

  return { flags, positionals };
};

const booleanFlag = (tokens: ParsedTokens, name: string): boolean => tokens.flags.has(name);
const valueFlag = (tokens: ParsedTokens, name: string): string | undefined =>
  tokens.flags.get(name)?.[0];
const repeatedFlag = (tokens: ParsedTokens, name: string): ReadonlyArray<string> =>
  tokens.flags.get(name) ?? [];

const rejectPositionals = (tokens: ParsedTokens, command: CommandName): void => {
  const positional = tokens.positionals[0];
  if (positional !== undefined) {
    throw new CliUsageError(`Unexpected positional argument '${positional}'.`, command);
  }
};

const parseNonBlank = (
  tokens: ParsedTokens,
  name: string,
  command: CommandName,
): string | undefined => {
  const value = valueFlag(tokens, name);
  if (value !== undefined && value.trim().length === 0) {
    throw new CliUsageError(`Option '${name}' must not be blank.`, command);
  }
  return value;
};

const parseMood = (value: string | undefined, command: CommandName): Mood | undefined => {
  if (value === undefined) return undefined;
  if (!(moods as ReadonlyArray<string>).includes(value)) {
    throw new CliUsageError(
      `Invalid mood '${value}'. Expected one of: ${moods.join(", ")}.`,
      command,
    );
  }
  return value as Mood;
};

const parseTimestamp = (value: string | undefined, command: CommandName): string | undefined => {
  if (value === undefined) return undefined;
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw new CliUsageError(
      `Invalid timestamp '${value}'. Expected a canonical UTC ISO 8601 timestamp.`,
      command,
    );
  }
  return value;
};

const parseLimit = (value: string | undefined, command: CommandName): number | undefined => {
  if (value === undefined) return undefined;
  if (!/^[0-9]+$/u.test(value)) {
    throw new CliUsageError("Limit must be an integer between 1 and 1000.", command);
  }
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
    throw new CliUsageError("Limit must be an integer between 1 and 1000.", command);
  }
  return limit;
};

const parseOrder = (tokens: ParsedTokens, command: CommandName): Order => {
  const newest = booleanFlag(tokens, "--newest");
  const oldest = booleanFlag(tokens, "--oldest");
  if (newest && oldest) {
    throw new CliUsageError("Options '--newest' and '--oldest' are mutually exclusive.", command);
  }
  return oldest ? "oldest" : "newest";
};

const parseScope = (tokens: ParsedTokens, command: CommandName): ScopeSelection => {
  const global = booleanFlag(tokens, "--global");
  const all = booleanFlag(tokens, "--all");
  const project = valueFlag(tokens, "--project");
  const selected = Number(global) + Number(all) + Number(project !== undefined);
  if (selected > 1) {
    throw new CliUsageError(
      "Options '--global', '--all', and '--project' are mutually exclusive.",
      command,
    );
  }
  if (global) return { kind: "global" };
  if (all) return { kind: "all" };
  if (project !== undefined) return { kind: "project-path", path: project };
  return { kind: "default" };
};

const parseFilters = (tokens: ParsedTokens, command: CommandName): EntryFilters => {
  const mood = parseMood(valueFlag(tokens, "--mood"), command);
  const since = parseTimestamp(valueFlag(tokens, "--since"), command);
  const model = parseNonBlank(tokens, "--model", command);
  const harness = parseNonBlank(tokens, "--harness", command);
  const tag = parseNonBlank(tokens, "--tag", command);
  if (tag !== undefined && (tag.trim() !== tag || tag.includes(","))) {
    throw new CliUsageError("Option '--tag' must be a trimmed tag without commas.", command);
  }
  return {
    ...(mood === undefined ? {} : { mood }),
    ...(since === undefined ? {} : { since }),
    ...(model === undefined ? {} : { model }),
    ...(harness === undefined ? {} : { harness }),
    ...(tag === undefined ? {} : { tag }),
  };
};

const commonQueryFlags = {
  "--global": "boolean",
  "--all": "boolean",
  "--project": "value",
  "--mood": "value",
  "--since": "value",
  "--model": "value",
  "--harness": "value",
  "--tag": "value",
  "--help": "boolean",
} as const satisfies FlagSpec;

const parseLog = (argv: ReadonlyArray<string>): ParsedCommand => {
  const command = "log";
  const tokens = parseTokens(
    argv,
    {
      "--mood": "value",
      "--tag": "repeat",
      "--model": "value",
      "--harness": "value",
      "--cwd": "value",
      "--global": "boolean",
      "--json": "boolean",
      "--help": "boolean",
    },
    command,
  );
  if (booleanFlag(tokens, "--help")) return { kind: "help", command };
  const body = tokens.positionals.join(" ");
  if (body.trim().length === 0) {
    throw new CliUsageError("A non-empty diary entry body is required.", command);
  }
  const tags = repeatedFlag(tokens, "--tag");
  for (const tag of tags) {
    if (tag.trim() !== tag || tag.length === 0 || tag.includes(",")) {
      throw new CliUsageError("Each '--tag' must be a trimmed tag without commas.", command);
    }
  }
  const cwd = parseNonBlank(tokens, "--cwd", command);
  const model = parseNonBlank(tokens, "--model", command);
  const harness = parseNonBlank(tokens, "--harness", command);
  return {
    kind: command,
    body,
    mood: parseMood(valueFlag(tokens, "--mood"), command) ?? "note",
    tags,
    ...(cwd === undefined ? {} : { cwd }),
    ...(model === undefined ? {} : { model }),
    ...(harness === undefined ? {} : { harness }),
    global: booleanFlag(tokens, "--global"),
    json: booleanFlag(tokens, "--json"),
  };
};

const parseRead = (argv: ReadonlyArray<string>): ParsedCommand => {
  const command = "read";
  const tokens = parseTokens(
    argv,
    {
      ...commonQueryFlags,
      "--limit": "value",
      "--newest": "boolean",
      "--oldest": "boolean",
      "--json": "boolean",
    },
    command,
  );
  if (booleanFlag(tokens, "--help")) return { kind: "help", command };
  rejectPositionals(tokens, command);
  const limit = parseLimit(valueFlag(tokens, "--limit"), command);
  return {
    kind: command,
    scope: parseScope(tokens, command),
    order: parseOrder(tokens, command),
    ...parseFilters(tokens, command),
    ...(limit === undefined ? {} : { limit }),
    json: booleanFlag(tokens, "--json"),
  };
};

const parseContext = (argv: ReadonlyArray<string>): ParsedCommand => {
  const command = "context";
  const tokens = parseTokens(
    argv,
    {
      "--all": "boolean",
      "--cwd": "value",
      "--mood": "value",
      "--since": "value",
      "--model": "value",
      "--harness": "value",
      "--tag": "value",
      "--limit": "value",
      "--newest": "boolean",
      "--oldest": "boolean",
      "--json": "boolean",
      "--help": "boolean",
    },
    command,
  );
  if (booleanFlag(tokens, "--help")) return { kind: "help", command };
  rejectPositionals(tokens, command);
  const cwd = parseNonBlank(tokens, "--cwd", command);
  const limit = parseLimit(valueFlag(tokens, "--limit"), command);
  return {
    kind: command,
    ...(cwd === undefined ? {} : { cwd }),
    all: booleanFlag(tokens, "--all"),
    order: parseOrder(tokens, command),
    ...parseFilters(tokens, command),
    ...(limit === undefined ? {} : { limit }),
    json: booleanFlag(tokens, "--json"),
  };
};

const parseSimpleQuery = (kind: "stats" | "random", argv: ReadonlyArray<string>): ParsedCommand => {
  const tokens = parseTokens(argv, { ...commonQueryFlags, "--json": "boolean" }, kind);
  if (booleanFlag(tokens, "--help")) return { kind: "help", command: kind };
  rejectPositionals(tokens, kind);
  return {
    kind,
    scope: parseScope(tokens, kind),
    ...parseFilters(tokens, kind),
    json: booleanFlag(tokens, "--json"),
  };
};

const parseExport = (argv: ReadonlyArray<string>): ParsedCommand => {
  const command = "export";
  const tokens = parseTokens(argv, { ...commonQueryFlags, "--markdown": "boolean" }, command);
  if (booleanFlag(tokens, "--help")) return { kind: "help", command };
  rejectPositionals(tokens, command);
  if (!booleanFlag(tokens, "--markdown")) {
    throw new CliUsageError(
      "Export format is required; currently supported: '--markdown'.",
      command,
    );
  }
  return {
    kind: command,
    markdown: true,
    scope: parseScope(tokens, command),
    ...parseFilters(tokens, command),
  };
};

const parseMcp = (argv: ReadonlyArray<string>): ParsedCommand => {
  const command = "mcp";
  const tokens = parseTokens(argv, { "--help": "boolean" }, command);
  if (booleanFlag(tokens, "--help")) return { kind: "help", command };
  rejectPositionals(tokens, command);
  return { kind: command };
};

const parseSetup = (argv: ReadonlyArray<string>): ParsedCommand => {
  const command = "setup";
  const tokens = parseTokens(
    argv,
    {
      "--check": "boolean",
      "--yes": "boolean",
      "--guidance": "value",
      "--help": "boolean",
    },
    command,
  );
  if (booleanFlag(tokens, "--help")) return { kind: "help", command };
  rejectPositionals(tokens, command);
  const check = booleanFlag(tokens, "--check");
  const yes = booleanFlag(tokens, "--yes");
  if (check && yes) {
    throw new CliUsageError("Options '--check' and '--yes' are mutually exclusive.", command);
  }
  const guidance = valueFlag(tokens, "--guidance");
  const guidanceScopes = ["global", "project", "none"] as const;
  if (guidance !== undefined && !(guidanceScopes as ReadonlyArray<string>).includes(guidance)) {
    throw new CliUsageError(
      `Invalid guidance scope '${guidance}'. Expected one of: ${guidanceScopes.join(", ")}.`,
      command,
    );
  }
  return {
    kind: command,
    check,
    yes,
    guidance: (guidance as SetupGuidanceScope | undefined) ?? "global",
  };
};

const parseNoOptions = (
  command: "doctor" | "bench-startup",
  argv: ReadonlyArray<string>,
): ParsedCommand => {
  const tokens = parseTokens(argv, { "--help": "boolean" }, command);
  if (booleanFlag(tokens, "--help")) return { kind: "help", command };
  rejectPositionals(tokens, command);
  return { kind: command };
};

const uninstallLevels = ["integrations", "cli", "full"] as const;

const parseUninstall = (argv: ReadonlyArray<string>): ParsedCommand => {
  const command = "uninstall";
  const tokens = parseTokens(
    argv,
    {
      "--level": "value",
      "--yes": "boolean",
      "--guidance": "value",
      "--help": "boolean",
    },
    command,
  );
  if (booleanFlag(tokens, "--help")) return { kind: "help", command };
  rejectPositionals(tokens, command);
  const selected = valueFlag(tokens, "--level");
  if (selected !== undefined && !(uninstallLevels as ReadonlyArray<string>).includes(selected)) {
    throw new CliUsageError(
      `Invalid uninstall level '${selected}'. Expected one of: ${uninstallLevels.join(", ")}.`,
      command,
    );
  }
  const explicitLevel = selected !== undefined;
  const yes = booleanFlag(tokens, "--yes");
  if (yes && !explicitLevel) {
    throw new CliUsageError("Option '--yes' requires an explicit '--level'.", command);
  }
  const guidance = valueFlag(tokens, "--guidance");
  const guidanceScopes = ["global", "project"] as const;
  if (guidance !== undefined && !(guidanceScopes as ReadonlyArray<string>).includes(guidance)) {
    throw new CliUsageError(
      `Invalid guidance scope '${guidance}'. Expected one of: ${guidanceScopes.join(", ")}.`,
      command,
    );
  }
  return {
    kind: command,
    level: (selected as UninstallLevel | undefined) ?? "integrations",
    explicitLevel,
    yes,
    guidance: (guidance as UninstallGuidanceScope | undefined) ?? "global",
  };
};

const commandNames = [
  "log",
  "read",
  "context",
  "stats",
  "random",
  "export",
  "mcp",
  "setup",
  "doctor",
  "bench-startup",
  "uninstall",
] as const;

export const parseArgs = (argv: ReadonlyArray<string>): ParsedCommand => {
  const [command, ...rest] = argv;
  if (command === undefined || command === "--help" || command === "-h" || command === "help") {
    if (rest.length > 0) throw new CliUsageError(`Unexpected argument '${rest[0]}'.`);
    return { kind: "help" };
  }
  if (command === "--version" || command === "-v") {
    if (rest.length > 0) throw new CliUsageError(`Unexpected argument '${rest[0]}'.`);
    return { kind: "version" };
  }
  if (!(commandNames as ReadonlyArray<string>).includes(command)) {
    throw new CliUsageError(`Unknown command '${command}'.`);
  }

  switch (command as CommandName) {
    case "log":
      return parseLog(rest);
    case "read":
      return parseRead(rest);
    case "context":
      return parseContext(rest);
    case "stats":
      return parseSimpleQuery("stats", rest);
    case "random":
      return parseSimpleQuery("random", rest);
    case "export":
      return parseExport(rest);
    case "mcp":
      return parseMcp(rest);
    case "setup":
      return parseSetup(rest);
    case "doctor":
      return parseNoOptions("doctor", rest);
    case "bench-startup":
      return parseNoOptions("bench-startup", rest);
    case "uninstall":
      return parseUninstall(rest);
  }
};
