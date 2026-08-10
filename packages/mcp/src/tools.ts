import * as NodePath from "node:path";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import * as Entries from "@deardiary/core/entries";
import * as Format from "@deardiary/core/format";
import * as Git from "@deardiary/core/git";
import * as Projects from "@deardiary/core/projects";
import * as Effect from "effect/Effect";
import * as z from "zod/v4";

const moods = ["struggled", "win", "note", "idea", "rant"] as const;
const orders = ["newest", "oldest"] as const;

const nonBlank = (label: string) =>
  z.string().refine((value) => value.trim().length > 0, `${label} must not be blank`);

const exactNonBlank = (label: string) =>
  z
    .string()
    .refine(
      (value) => value.length > 0 && value.trim() === value,
      `${label} must be non-empty and trimmed`,
    );

const tag = z
  .string()
  .refine(
    (value) => value.length > 0 && value.trim() === value && !value.includes(","),
    "tag must be trimmed, non-empty, and contain no commas",
  );

const timestamp = z.string().refine((value) => {
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}, "must be a canonical UTC ISO 8601 timestamp");

const filters = {
  mood: z.enum(moods).optional().describe("Exact mood filter."),
  since: timestamp.optional().describe("Include entries at or after this canonical UTC timestamp."),
  model: exactNonBlank("model").optional().describe("Exact model filter."),
  harness: exactNonBlank("harness").optional().describe("Exact harness filter."),
  tag: tag.optional().describe("Exact tag filter."),
};

const queryOptions = {
  ...filters,
  limit: z.number().int().min(1).max(1_000).optional().describe("Maximum entries (default 50)."),
  order: z.enum(orders).default("newest").describe("Result order (default newest)."),
};

export const DiaryLogInput = z.strictObject({
  body: nonBlank("body").describe("Diary prose to append."),
  mood: z.enum(moods).default("note").describe("Entry mood (default note)."),
  tags: z.array(tag).optional().describe("Exact tags."),
  model: exactNonBlank("model").optional().describe("Model name."),
  harness: exactNonBlank("harness").optional().describe("Agent harness name."),
  cwd: nonBlank("cwd").optional().describe("Working directory, relative to server startup cwd."),
  global: z.boolean().default(false).describe("Store as global even when cwd is inside Git."),
});

export const DiaryReadInput = z
  .strictObject({
    scope: z
      .enum(["current", "global", "all", "project"])
      .default("current")
      .describe("current (default), global, all, or an explicit Git project."),
    cwd: nonBlank("cwd")
      .optional()
      .describe("Working directory for current scope, relative to server startup cwd."),
    project: nonBlank("project")
      .optional()
      .describe("Git project path when scope is project, relative to server startup cwd."),
    ...queryOptions,
  })
  .superRefine((value, context) => {
    if (value.scope === "project" && value.project === undefined) {
      context.addIssue({
        code: "custom",
        path: ["project"],
        message: "project is required when scope is project",
      });
    }
    if (value.scope !== "project" && value.project !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["project"],
        message: "project is only allowed when scope is project",
      });
    }
  });

export const DiaryContextInput = z.strictObject({
  cwd: nonBlank("cwd").optional().describe("Working directory, relative to server startup cwd."),
  all: z.boolean().default(false).describe("Explicitly include every project's entries."),
  ...queryOptions,
});

const EntryOutput = z.strictObject({
  id: z.uuid(),
  projectId: z.uuid().nullable(),
  projectRootPath: z.string().min(1).nullable(),
  timestamp,
  model: z.string().nullable(),
  harness: z.string().nullable(),
  mood: z.enum(moods),
  tags: z.array(tag),
  cwd: z.string().min(1),
  body: z.string().min(1),
  updatedAt: timestamp,
  deletedAt: timestamp.nullable(),
});

const LogOutput = z.strictObject({ entry: EntryOutput });
const EntriesOutput = z.strictObject({ entries: z.array(EntryOutput) });

const structuredEntry = (entry: Entries.Entry): z.output<typeof EntryOutput> => ({
  id: entry.id,
  projectId: entry.projectId,
  projectRootPath: entry.projectRootPath,
  timestamp: entry.timestamp,
  model: entry.model,
  harness: entry.harness,
  mood: entry.mood,
  tags: [...entry.tags],
  cwd: entry.cwd,
  body: entry.body,
  updatedAt: entry.updatedAt,
  deletedAt: entry.deletedAt,
});

export interface DiaryToolServices {
  readonly entries: Entries.EntryRepository["Service"];
  readonly projects: Projects.ProjectRepository["Service"];
  readonly startupCwd: string;
}

class ToolInputError extends Error {}

const resolveCwd = (startupCwd: string, cwd: string | undefined): string =>
  NodePath.resolve(startupCwd, cwd ?? ".");

const safeErrorMessage = (error: unknown): string => {
  if (error instanceof ToolInputError) return error.message;
  if (error instanceof Git.GitCommandExitError) {
    const detail = error.stderr.trim();
    return detail.length === 0 ? error.message : `${error.message} ${detail}`;
  }
  if (
    error instanceof Git.GitCommandExecutionError ||
    error instanceof Git.GitProtocolError ||
    error instanceof Entries.EntryRepositoryError ||
    error instanceof Entries.EntryValidationError ||
    error instanceof Projects.ProjectRepositoryError
  ) {
    return error.message;
  }
  return "Dear Diary could not complete this tool call. Check the server diagnostics and try again.";
};

const toolError = (error: unknown): CallToolResult => ({
  content: [{ type: "text" as const, text: safeErrorMessage(error) }],
  isError: true,
});

const runTool = async <A>(
  effect: Effect.Effect<A, unknown>,
  success: (value: A) => CallToolResult & { readonly structuredContent: Record<string, unknown> },
): Promise<CallToolResult> => {
  try {
    const result = await Effect.runPromise(
      effect.pipe(
        Effect.match({
          onFailure: (error) => ({ ok: false as const, error }),
          onSuccess: (value) => ({ ok: true as const, value }),
        }),
      ),
    );
    return result.ok ? success(result.value) : toolError(result.error);
  } catch {
    return toolError(undefined);
  }
};

const filtersFrom = (input: {
  readonly mood?: Entries.Mood | undefined;
  readonly since?: string | undefined;
  readonly model?: string | undefined;
  readonly harness?: string | undefined;
  readonly tag?: string | undefined;
}) => ({
  ...(input.mood === undefined ? {} : { mood: input.mood }),
  ...(input.since === undefined ? {} : { since: input.since }),
  ...(input.model === undefined ? {} : { model: input.model }),
  ...(input.harness === undefined ? {} : { harness: input.harness }),
  ...(input.tag === undefined ? {} : { tag: input.tag }),
});

const resolveReadScope = Effect.fn("Mcp.resolveReadScope")(function* (
  input: z.output<typeof DiaryReadInput>,
  services: DiaryToolServices,
) {
  switch (input.scope) {
    case "global":
      return { kind: "global" } as const;
    case "all":
      return { kind: "all" } as const;
    case "current": {
      const cwd = resolveCwd(services.startupCwd, input.cwd);
      const project = yield* services.projects.resolveForCwd(cwd);
      return project === null
        ? ({ kind: "global" } as const)
        : ({ kind: "project", projectId: project.id } as const);
    }
    case "project": {
      // The strict input schema guarantees this before any repository work.
      const path = resolveCwd(services.startupCwd, input.project);
      const project = yield* services.projects.resolveForCwd(path);
      if (project === null) {
        return yield* Effect.fail(
          new ToolInputError(
            `'${path}' is not inside a Git working tree; explicit project scope was not applied.`,
          ),
        );
      }
      return { kind: "project", projectId: project.id } as const;
    }
  }
});

export const registerDiaryTools = (server: McpServer, services: DiaryToolServices): void => {
  server.registerTool(
    "diary_log",
    {
      title: "Log diary entry",
      description:
        "Append a local Dear Diary entry for the current Git project, or globally when requested/outside Git.",
      inputSchema: DiaryLogInput,
      outputSchema: LogOutput,
      annotations: {
        title: "Log diary entry",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    (input) =>
      runTool(
        services.entries.append({
          cwd: resolveCwd(services.startupCwd, input.cwd),
          body: input.body,
          mood: input.mood,
          ...(input.tags === undefined ? {} : { tags: input.tags }),
          ...(input.model === undefined ? {} : { model: input.model }),
          ...(input.harness === undefined ? {} : { harness: input.harness }),
          ...(input.global ? { forceGlobal: true } : {}),
        }),
        (entry) => ({
          content: [{ type: "text", text: `Logged ${entry.mood} entry ${entry.id}.` }],
          structuredContent: { entry: structuredEntry(entry) },
        }),
      ),
  );

  server.registerTool(
    "diary_read",
    {
      title: "Read diary entries",
      description:
        "Read local diary entries with an explicit safe scope. Defaults to the current Git project, or global outside Git.",
      inputSchema: DiaryReadInput,
      outputSchema: EntriesOutput,
      annotations: {
        title: "Read diary entries",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    (input) =>
      runTool(
        Effect.gen(function* () {
          const scope = yield* resolveReadScope(input, services);
          return yield* services.entries.read({
            scope,
            ...filtersFrom(input),
            order: input.order,
            ...(input.limit === undefined ? {} : { limit: input.limit }),
          });
        }),
        (entries) => ({
          content: [{ type: "text", text: Format.renderEntries(entries) }],
          structuredContent: { entries: entries.map(structuredEntry) },
        }),
      ),
  );

  server.registerTool(
    "diary_context",
    {
      title: "Render diary context",
      description:
        "Render current-project plus global diary context, or every project only when all is explicitly true.",
      inputSchema: DiaryContextInput,
      outputSchema: EntriesOutput,
      annotations: {
        title: "Render diary context",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    (input) =>
      runTool(
        services.entries.context({
          cwd: resolveCwd(services.startupCwd, input.cwd),
          ...(input.all ? { all: true } : {}),
          ...filtersFrom(input),
          order: input.order,
          ...(input.limit === undefined ? {} : { limit: input.limit }),
        }),
        (entries) => ({
          content: [{ type: "text", text: Format.renderContext(entries) }],
          structuredContent: { entries: entries.map(structuredEntry) },
        }),
      ),
  );
};
