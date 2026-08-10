import * as NodeCrypto from "node:crypto";

import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type * as Statement from "effect/unstable/sql/Statement";

import * as Db from "./db.ts";
import * as Git from "./git.ts";
import * as Projects from "./projects.ts";

export const Mood = Schema.Literals(["struggled", "win", "note", "idea", "rant"]);
export type Mood = typeof Mood.Type;

const UtcIsoTimestamp = Schema.String.check(
  Schema.makeFilter(
    (value) => {
      const milliseconds = Date.parse(value);
      return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
    },
    { expected: "a canonical UTC ISO 8601 timestamp" },
  ),
);

export const Tag = Schema.NonEmptyString.check(
  Schema.makeFilter((value) => value.trim() === value && !value.includes(","), {
    expected: "a trimmed, non-empty tag without commas",
  }),
);
export type Tag = typeof Tag.Type;

export class Entry extends Schema.Class<Entry>("Entry")({
  id: Schema.String.check(Schema.isUUID()),
  projectId: Schema.NullOr(Schema.String.check(Schema.isUUID())),
  projectRootPath: Schema.NullOr(Schema.NonEmptyString),
  timestamp: UtcIsoTimestamp,
  model: Schema.NullOr(Schema.NonEmptyString),
  harness: Schema.NullOr(Schema.NonEmptyString),
  mood: Mood,
  tags: Schema.Array(Tag),
  cwd: Schema.NonEmptyString,
  body: Schema.NonEmptyString,
  updatedAt: UtcIsoTimestamp,
  deletedAt: Schema.NullOr(UtcIsoTimestamp),
}) {}

export const EntryScope = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("global") }),
  Schema.Struct({ kind: Schema.Literal("all") }),
  Schema.Struct({
    kind: Schema.Literal("project"),
    projectId: Schema.String.check(Schema.isUUID()),
  }),
]);
export type EntryScope = typeof EntryScope.Type;

export interface EntryFilters {
  readonly mood?: Mood;
  readonly since?: string;
  readonly model?: string;
  readonly harness?: string;
  readonly tag?: string;
}

export interface AppendEntryInput {
  readonly cwd: string;
  readonly body: string;
  readonly mood: Mood;
  readonly tags?: ReadonlyArray<string>;
  readonly model?: string;
  readonly harness?: string;
  readonly forceGlobal?: boolean;
}

export interface ReadEntriesInput extends EntryFilters {
  readonly scope: EntryScope;
  readonly order?: "newest" | "oldest";
  readonly limit?: number;
}

export interface ContextEntriesInput extends EntryFilters {
  readonly cwd: string;
  readonly all?: boolean;
  readonly order?: "newest" | "oldest";
  readonly limit?: number;
}

export interface ScopedEntryQuery extends EntryFilters {
  readonly scope: EntryScope;
}

export interface MoodCount {
  readonly mood: Mood;
  readonly count: number;
}

export interface ProjectCount {
  readonly projectId: string | null;
  readonly name: string | null;
  readonly rootPath: string | null;
  readonly count: number;
}

export interface ModelCount {
  readonly model: string | null;
  readonly count: number;
}

export interface HarnessCount {
  readonly harness: string | null;
  readonly count: number;
}

export interface EntryStats {
  readonly total: number;
  readonly byMood: ReadonlyArray<MoodCount>;
  readonly byProject: ReadonlyArray<ProjectCount>;
  readonly byModel: ReadonlyArray<ModelCount>;
  readonly byHarness: ReadonlyArray<HarnessCount>;
}

export const EntryRepositoryOperation = Schema.Literals([
  "append",
  "read",
  "context",
  "stats",
  "random",
  "export",
]);
export type EntryRepositoryOperation = typeof EntryRepositoryOperation.Type;

export const EntryRepositoryErrorKind = Schema.Literals(["storage", "decode"]);
export type EntryRepositoryErrorKind = typeof EntryRepositoryErrorKind.Type;

export class EntryRepositoryError extends Schema.TaggedErrorClass<EntryRepositoryError>()(
  "EntryRepositoryError",
  {
    operation: EntryRepositoryOperation,
    kind: EntryRepositoryErrorKind,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return this.kind === "storage"
      ? `Entry repository operation '${this.operation}' failed. Check that the Dear Diary database is readable and writable.`
      : `Entry repository operation '${this.operation}' received invalid entry data from the Dear Diary database.`;
  }
}

export class EntryValidationError extends Schema.TaggedErrorClass<EntryValidationError>()(
  "EntryValidationError",
  {
    operation: EntryRepositoryOperation,
    field: Schema.String,
    detail: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Invalid '${this.field}' for entry operation '${this.operation}': ${this.detail}`;
  }
}

export type EntryOperationError = EntryRepositoryError | EntryValidationError;
export type EntryProjectOperationError =
  | EntryOperationError
  | Projects.ProjectRepositoryError
  | Git.GitResolutionError;

export interface EntryRepositoryOptions {
  /** A reusable effect yielding one canonical UTC timestamp per append. */
  readonly now?: Effect.Effect<string>;
  /** A reusable effect yielding one UUID candidate per append. */
  readonly generateId?: Effect.Effect<string>;
  /** A reusable effect yielding a number in [0, 1) per random selection. */
  readonly random?: Effect.Effect<number>;
}

export class EntryRepository extends Context.Service<
  EntryRepository,
  {
    readonly append: (input: AppendEntryInput) => Effect.Effect<Entry, EntryProjectOperationError>;
    readonly read: (
      input: ReadEntriesInput,
    ) => Effect.Effect<ReadonlyArray<Entry>, EntryOperationError>;
    readonly context: (
      input: ContextEntriesInput,
    ) => Effect.Effect<ReadonlyArray<Entry>, EntryProjectOperationError>;
    readonly stats: (input: ScopedEntryQuery) => Effect.Effect<EntryStats, EntryOperationError>;
    readonly random: (input: ScopedEntryQuery) => Effect.Effect<Entry | null, EntryOperationError>;
    readonly exportEntries: (
      input: ScopedEntryQuery,
    ) => Effect.Effect<ReadonlyArray<Entry>, EntryOperationError>;
  }
>()("@deardiary/core/entries/EntryRepository") {}

const EntryDbRow = Schema.Struct({
  id: Schema.String.check(Schema.isUUID()),
  projectId: Schema.NullOr(Schema.String.check(Schema.isUUID())),
  projectRootPath: Schema.NullOr(Schema.NonEmptyString),
  timestamp: UtcIsoTimestamp,
  model: Schema.NullOr(Schema.NonEmptyString),
  harness: Schema.NullOr(Schema.NonEmptyString),
  mood: Mood,
  tags: Schema.String,
  cwd: Schema.NonEmptyString,
  body: Schema.NonEmptyString,
  updatedAt: UtcIsoTimestamp,
  deletedAt: Schema.NullOr(UtcIsoTimestamp),
});

const Count = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0));
const TotalCountRow = Schema.Struct({ count: Count });
const MoodCountRow = Schema.Struct({ mood: Mood, count: Count });
const ProjectCountRow = Schema.Struct({
  projectId: Schema.NullOr(Schema.String.check(Schema.isUUID())),
  name: Schema.NullOr(Schema.String),
  rootPath: Schema.NullOr(Schema.NonEmptyString),
  count: Count,
});
const ModelCountRow = Schema.Struct({ model: Schema.NullOr(Schema.NonEmptyString), count: Count });
const HarnessCountRow = Schema.Struct({
  harness: Schema.NullOr(Schema.NonEmptyString),
  count: Count,
});

type EntryDbRow = typeof EntryDbRow.Type;
type EntryFragment = Statement.Fragment;

const maximumLimit = 1_000;
const defaultLimit = 50;
const EntryOrder = Schema.Literals(["newest", "oldest"]);
type EntryOrder = typeof EntryOrder.Type;

const currentUtcIsoTimestamp = Clock.currentTimeMillis.pipe(
  Effect.map((milliseconds) => new Date(milliseconds).toISOString()),
);
const randomEntryId = Effect.sync(NodeCrypto.randomUUID);
const randomUnit = Effect.sync(Math.random);

const validationError = (
  operation: EntryRepositoryOperation,
  field: string,
  detail: string,
  cause: unknown = new Error(detail),
) => new EntryValidationError({ operation, field, detail, cause });

const repositoryError = (
  operation: EntryRepositoryOperation,
  kind: EntryRepositoryErrorKind,
  cause: unknown,
) => new EntryRepositoryError({ operation, kind, cause });

const toRepositoryError =
  (operation: EntryRepositoryOperation) =>
  (cause: unknown): EntryRepositoryError =>
    repositoryError(operation, Schema.isSchemaError(cause) ? "decode" : "storage", cause);

const decodeUnknown = <A>(
  schema: Schema.Decoder<A, never>,
  value: unknown,
  operation: EntryRepositoryOperation,
): Effect.Effect<A, EntryRepositoryError> =>
  Schema.decodeUnknownEffect(schema)(value).pipe(
    Effect.mapError((cause) => repositoryError(operation, "decode", cause)),
  );

const canonicalizeTags = (
  values: ReadonlyArray<string>,
  operation: EntryRepositoryOperation,
  field = "tags",
): Effect.Effect<ReadonlyArray<Tag>, EntryValidationError> =>
  Effect.gen(function* () {
    const tags: Array<Tag> = [];
    const seen = new Set<string>();
    for (const raw of values) {
      const tag = raw.trim();
      if (tag.length === 0) {
        return yield* Effect.fail(
          validationError(operation, field, "tags must not be empty after trimming"),
        );
      }
      if (tag.includes(",")) {
        return yield* Effect.fail(
          validationError(operation, field, `tag ${JSON.stringify(raw)} must not contain a comma`),
        );
      }
      if (!seen.has(tag)) {
        seen.add(tag);
        tags.push(tag);
      }
    }
    return tags;
  });

const serializeTags = (tags: ReadonlyArray<Tag>): string => tags.join(",");

const decodeEntryRow = (
  row: unknown,
  operation: EntryRepositoryOperation,
): Effect.Effect<Entry, EntryRepositoryError> =>
  Effect.gen(function* () {
    const decoded = yield* decodeUnknown(EntryDbRow, row, operation);
    const rawTags = decoded.tags.length === 0 ? [] : decoded.tags.split(",");
    const tags = yield* canonicalizeTags(rawTags, operation).pipe(
      Effect.mapError((cause) => repositoryError(operation, "decode", cause)),
    );
    if (serializeTags(tags) !== decoded.tags) {
      return yield* Effect.fail(
        repositoryError(
          operation,
          "decode",
          new Error("stored tags are not in canonical comma-text form"),
        ),
      );
    }
    return yield* Entry.makeEffect({ ...decoded, tags }).pipe(
      Effect.mapError((cause) => repositoryError(operation, "decode", cause)),
    );
  });

const decodeEntryRows = (rows: ReadonlyArray<unknown>, operation: EntryRepositoryOperation) =>
  Effect.forEach(rows, (row) => decodeEntryRow(row, operation));

const normalizeOptional = (value: string | undefined): string | null => {
  if (value === undefined) return null;
  const normalized = value.trim();
  return normalized.length === 0 ? null : normalized;
};

const validateNonEmpty = (
  value: unknown,
  operation: EntryRepositoryOperation,
  field: string,
): Effect.Effect<string, EntryValidationError> =>
  Schema.decodeUnknownEffect(Schema.NonEmptyString)(value).pipe(
    Effect.mapError((cause) =>
      validationError(operation, field, `${field} must be a non-empty string`, cause),
    ),
  );

const validateTimestamp = (
  value: unknown,
  operation: EntryRepositoryOperation,
  field: string,
): Effect.Effect<string, EntryValidationError> =>
  Schema.decodeUnknownEffect(UtcIsoTimestamp)(value).pipe(
    Effect.mapError((cause) =>
      validationError(operation, field, "expected a canonical UTC ISO 8601 timestamp", cause),
    ),
  );

const validateUuid = (
  value: unknown,
  operation: EntryRepositoryOperation,
  field: string,
): Effect.Effect<string, EntryValidationError> =>
  Schema.decodeUnknownEffect(Schema.String.check(Schema.isUUID()))(value).pipe(
    Effect.mapError((cause) => validationError(operation, field, "expected a UUID", cause)),
  );

interface ValidatedFilters {
  readonly mood?: Mood;
  readonly since?: string;
  readonly model?: string;
  readonly harness?: string;
  readonly tag?: Tag;
}

const validateFilters = (
  filters: EntryFilters,
  operation: EntryRepositoryOperation,
): Effect.Effect<ValidatedFilters, EntryValidationError> =>
  Effect.gen(function* () {
    const mood =
      filters.mood === undefined
        ? undefined
        : yield* Schema.decodeUnknownEffect(Mood)(filters.mood).pipe(
            Effect.mapError((cause) =>
              validationError(operation, "mood", "expected a supported mood", cause),
            ),
          );
    const since =
      filters.since === undefined
        ? undefined
        : yield* validateTimestamp(filters.since, operation, "since");
    const rawTag =
      filters.tag === undefined
        ? undefined
        : yield* Schema.decodeUnknownEffect(Schema.String)(filters.tag).pipe(
            Effect.mapError((cause) =>
              validationError(operation, "tag", "tag must be a string", cause),
            ),
          );
    const tag =
      rawTag === undefined ? undefined : (yield* canonicalizeTags([rawTag], operation, "tag"))[0];
    const rawModel =
      filters.model === undefined
        ? undefined
        : yield* Schema.decodeUnknownEffect(Schema.String)(filters.model).pipe(
            Effect.mapError((cause) =>
              validationError(operation, "model", "model must be a string", cause),
            ),
          );
    const rawHarness =
      filters.harness === undefined
        ? undefined
        : yield* Schema.decodeUnknownEffect(Schema.String)(filters.harness).pipe(
            Effect.mapError((cause) =>
              validationError(operation, "harness", "harness must be a string", cause),
            ),
          );
    const model = normalizeOptional(rawModel);
    const harness = normalizeOptional(rawHarness);
    return {
      ...(mood === undefined ? {} : { mood }),
      ...(since === undefined ? {} : { since }),
      ...(model === null ? {} : { model }),
      ...(harness === null ? {} : { harness }),
      ...(tag === undefined ? {} : { tag }),
    };
  });

const validateScope = (
  scope: unknown,
  operation: EntryRepositoryOperation,
): Effect.Effect<EntryScope, EntryValidationError> =>
  Schema.decodeUnknownEffect(EntryScope)(scope).pipe(
    Effect.mapError((cause) =>
      validationError(
        operation,
        "scope",
        "expected global, all, or project scope with a UUID projectId",
        cause,
      ),
    ),
  );

const validateOrder = (
  order: unknown,
  operation: EntryRepositoryOperation,
): Effect.Effect<EntryOrder, EntryValidationError> =>
  order === undefined
    ? Effect.succeed("newest")
    : Schema.decodeUnknownEffect(EntryOrder)(order).pipe(
        Effect.mapError((cause) =>
          validationError(operation, "order", "expected newest or oldest", cause),
        ),
      );

const validateOptionalBoolean = (
  value: unknown,
  operation: EntryRepositoryOperation,
  field: string,
): Effect.Effect<boolean | undefined, EntryValidationError> =>
  value === undefined
    ? Effect.succeed(undefined)
    : Schema.decodeUnknownEffect(Schema.Boolean)(value).pipe(
        Effect.mapError((cause) =>
          validationError(operation, field, `${field} must be a boolean`, cause),
        ),
      );

const validateOptionalString = (
  value: unknown,
  operation: EntryRepositoryOperation,
  field: string,
): Effect.Effect<string | undefined, EntryValidationError> =>
  value === undefined
    ? Effect.succeed(undefined)
    : Schema.decodeUnknownEffect(Schema.String)(value).pipe(
        Effect.mapError((cause) =>
          validationError(operation, field, `${field} must be a string`, cause),
        ),
      );

const validateLimit = (
  limit: number | undefined,
  operation: EntryRepositoryOperation,
): Effect.Effect<number, EntryValidationError> => {
  const value = limit ?? defaultLimit;
  return Number.isInteger(value) && value >= 1 && value <= maximumLimit
    ? Effect.succeed(value)
    : Effect.fail(
        validationError(
          operation,
          "limit",
          `limit must be an integer between 1 and ${maximumLimit}`,
        ),
      );
};

const selectEntryColumns = `
  entries.id AS "id",
  entries.project_id AS "projectId",
  projects.root_path AS "projectRootPath",
  entries.ts AS "timestamp",
  entries.model AS "model",
  entries.harness AS "harness",
  entries.mood AS "mood",
  entries.tags AS "tags",
  entries.cwd AS "cwd",
  entries.body AS "body",
  entries.updated_at AS "updatedAt",
  entries.deleted_at AS "deletedAt"
`;

const insertReturningColumns = `
  id AS "id",
  project_id AS "projectId",
  ts AS "timestamp",
  model AS "model",
  harness AS "harness",
  mood AS "mood",
  tags AS "tags",
  cwd AS "cwd",
  body AS "body",
  updated_at AS "updatedAt",
  deleted_at AS "deletedAt"
`;

type QueryScope = EntryScope | { readonly kind: "project-and-global"; readonly projectId: string };

export const make = (options: EntryRepositoryOptions = {}) =>
  Effect.gen(function* () {
    const { sql } = yield* Db.Database;
    const projects = yield* Projects.ProjectRepository;
    const now = options.now ?? currentUtcIsoTimestamp;
    const generateId = options.generateId ?? randomEntryId;
    const random = options.random ?? randomUnit;

    const makeWhere = (scope: QueryScope, filters: ValidatedFilters): EntryFragment => {
      const clauses: Array<EntryFragment> = [sql`entries.deleted_at IS NULL`];
      switch (scope.kind) {
        case "global":
          clauses.push(sql`entries.project_id IS NULL`);
          break;
        case "project":
          clauses.push(sql`entries.project_id = ${scope.projectId}`);
          break;
        case "project-and-global":
          clauses.push(
            sql`(entries.project_id = ${scope.projectId} OR entries.project_id IS NULL)`,
          );
          break;
        case "all":
          break;
      }
      if (filters.mood !== undefined) clauses.push(sql`entries.mood = ${filters.mood}`);
      if (filters.since !== undefined) clauses.push(sql`entries.ts >= ${filters.since}`);
      if (filters.model !== undefined) clauses.push(sql`entries.model = ${filters.model}`);
      if (filters.harness !== undefined) clauses.push(sql`entries.harness = ${filters.harness}`);
      if (filters.tag !== undefined) {
        clauses.push(sql`instr(',' || entries.tags || ',', ',' || ${filters.tag} || ',') > 0`);
      }
      return sql.and(clauses);
    };

    const selectEntries = (
      scope: QueryScope,
      filters: ValidatedFilters,
      operation: EntryRepositoryOperation,
      order: "newest" | "oldest",
      limit?: number,
      offset?: number,
    ): Effect.Effect<ReadonlyArray<Entry>, EntryRepositoryError> => {
      const direction = order === "newest" ? sql.literal("DESC") : sql.literal("ASC");
      const limitClause =
        limit === undefined
          ? sql.literal("")
          : offset === undefined
            ? sql`LIMIT ${limit}`
            : sql`LIMIT ${limit} OFFSET ${offset}`;
      return sql<EntryDbRow>`
        SELECT ${sql.literal(selectEntryColumns)}
        FROM entries LEFT JOIN projects ON projects.id = entries.project_id
        WHERE ${makeWhere(scope, filters)}
        ORDER BY entries.ts ${direction}, entries.id ${direction}
        ${limitClause}
      `.pipe(
        Effect.mapError(toRepositoryError(operation)),
        Effect.flatMap((rows) => decodeEntryRows(rows, operation)),
      );
    };

    const append = Effect.fn("EntryRepository.append")(function* (input: AppendEntryInput) {
      const cwd = yield* validateNonEmpty(input.cwd, "append", "cwd");
      const body = yield* validateNonEmpty(input.body, "append", "body");
      const mood = yield* Schema.decodeUnknownEffect(Mood)(input.mood).pipe(
        Effect.mapError((cause) =>
          validationError("append", "mood", "expected a supported mood", cause),
        ),
      );
      const rawTags =
        input.tags === undefined
          ? []
          : yield* Schema.decodeUnknownEffect(Schema.Array(Schema.String))(input.tags).pipe(
              Effect.mapError((cause) =>
                validationError("append", "tags", "tags must be an array of strings", cause),
              ),
            );
      const tags = yield* canonicalizeTags(rawTags, "append");
      const model = yield* validateOptionalString(input.model, "append", "model");
      const harness = yield* validateOptionalString(input.harness, "append", "harness");
      const forceGlobal = yield* validateOptionalBoolean(
        input.forceGlobal,
        "append",
        "forceGlobal",
      );
      const project = forceGlobal === true ? null : yield* projects.resolveForCwd(cwd);
      const timestamp = yield* now.pipe(
        Effect.flatMap((value) => validateTimestamp(value, "append", "timestamp")),
      );
      const id = yield* generateId.pipe(
        Effect.flatMap((value) => validateUuid(value, "append", "id")),
      );
      const candidate = yield* Entry.makeEffect({
        id,
        projectId: project?.id ?? null,
        projectRootPath: project?.rootPath ?? null,
        timestamp,
        model: normalizeOptional(model),
        harness: normalizeOptional(harness),
        mood,
        tags,
        cwd,
        body,
        updatedAt: timestamp,
        deletedAt: null,
      }).pipe(
        Effect.mapError((cause) =>
          validationError("append", "entry", "entry fields did not satisfy the schema", cause),
        ),
      );

      const rows = yield* sql<Omit<EntryDbRow, "projectRootPath">>`
        INSERT INTO entries (
          id,
          project_id,
          ts,
          model,
          harness,
          mood,
          tags,
          cwd,
          body,
          updated_at,
          deleted_at
        ) VALUES (
          ${candidate.id},
          ${candidate.projectId},
          ${candidate.timestamp},
          ${candidate.model},
          ${candidate.harness},
          ${candidate.mood},
          ${serializeTags(candidate.tags)},
          ${candidate.cwd},
          ${candidate.body},
          ${candidate.updatedAt},
          ${candidate.deletedAt}
        )
        RETURNING ${sql.literal(insertReturningColumns)}
      `.pipe(Effect.mapError(toRepositoryError("append")));
      const row = rows[0];
      if (row === undefined) {
        return yield* Effect.fail(
          repositoryError("append", "decode", new Error("INSERT RETURNING produced no entry row")),
        );
      }
      return yield* decodeEntryRow(
        { ...row, projectRootPath: project?.rootPath ?? null },
        "append",
      );
    });

    const read = Effect.fn("EntryRepository.read")(function* (input: ReadEntriesInput) {
      const scope = yield* validateScope(input.scope, "read");
      const filters = yield* validateFilters(input, "read");
      const limit = yield* validateLimit(input.limit, "read");
      const order = yield* validateOrder(input.order, "read");
      return yield* selectEntries(scope, filters, "read", order, limit);
    });

    const context = Effect.fn("EntryRepository.context")(function* (input: ContextEntriesInput) {
      const cwd = yield* validateNonEmpty(input.cwd, "context", "cwd");
      const filters = yield* validateFilters(input, "context");
      const limit = yield* validateLimit(input.limit, "context");
      const order = yield* validateOrder(input.order, "context");
      const all = yield* validateOptionalBoolean(input.all, "context", "all");
      let scope: QueryScope;
      if (all === true) {
        scope = { kind: "all" };
      } else {
        const project = yield* projects.resolveForCwd(cwd);
        scope =
          project === null
            ? { kind: "global" }
            : { kind: "project-and-global", projectId: project.id };
      }
      return yield* selectEntries(scope, filters, "context", order, limit);
    });

    const validateScopedQuery = (input: ScopedEntryQuery, operation: EntryRepositoryOperation) =>
      Effect.all({
        scope: validateScope(input.scope, operation),
        filters: validateFilters(input, operation),
      });

    const stats = Effect.fn("EntryRepository.stats")(function* (input: ScopedEntryQuery) {
      const { scope, filters } = yield* validateScopedQuery(input, "stats");
      const where = makeWhere(scope, filters);
      const result = yield* sql
        .withTransaction(
          Effect.all(
            {
              total: sql`SELECT COUNT(*) AS "count" FROM entries WHERE ${where}`,
              byMood: sql`
                SELECT mood AS "mood", COUNT(*) AS "count"
                FROM entries WHERE ${where}
                GROUP BY mood ORDER BY mood ASC
              `,
              byProject: sql`
                SELECT
                  entries.project_id AS "projectId",
                  projects.name AS "name",
                  projects.root_path AS "rootPath",
                  COUNT(*) AS "count"
                FROM entries
                LEFT JOIN projects ON projects.id = entries.project_id
                WHERE ${where}
                GROUP BY entries.project_id, projects.name, projects.root_path
                ORDER BY entries.project_id ASC
              `,
              byModel: sql`
                SELECT model AS "model", COUNT(*) AS "count"
                FROM entries WHERE ${where}
                GROUP BY model ORDER BY model ASC
              `,
              byHarness: sql`
                SELECT harness AS "harness", COUNT(*) AS "count"
                FROM entries WHERE ${where}
                GROUP BY harness ORDER BY harness ASC
              `,
            },
            { concurrency: "unbounded" },
          ),
        )
        .pipe(Effect.mapError(toRepositoryError("stats")));

      const [totalRows, byMood, byProject, byModel, byHarness] = yield* Effect.all([
        decodeUnknown(Schema.Array(TotalCountRow), result.total, "stats"),
        decodeUnknown(Schema.Array(MoodCountRow), result.byMood, "stats"),
        decodeUnknown(Schema.Array(ProjectCountRow), result.byProject, "stats"),
        decodeUnknown(Schema.Array(ModelCountRow), result.byModel, "stats"),
        decodeUnknown(Schema.Array(HarnessCountRow), result.byHarness, "stats"),
      ]);
      const total = totalRows[0]?.count;
      if (total === undefined) {
        return yield* Effect.fail(
          repositoryError("stats", "decode", new Error("COUNT query produced no row")),
        );
      }
      return { total, byMood, byProject, byModel, byHarness };
    });

    const randomEntry = Effect.fn("EntryRepository.random")(function* (input: ScopedEntryQuery) {
      const { scope, filters } = yield* validateScopedQuery(input, "random");
      return yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const countRows = yield* sql`
            SELECT COUNT(*) AS "count"
            FROM entries
            WHERE ${makeWhere(scope, filters)}
          `;
            const decoded = yield* decodeUnknown(Schema.Array(TotalCountRow), countRows, "random");
            const count = decoded[0]?.count;
            if (count === undefined) {
              return yield* Effect.fail(
                repositoryError("random", "decode", new Error("COUNT query produced no row")),
              );
            }
            if (count === 0) return null;
            const unit = yield* random;
            if (!Number.isFinite(unit) || unit < 0 || unit >= 1) {
              return yield* Effect.fail(
                validationError("random", "random", "random source must yield a number in [0, 1)"),
              );
            }
            const entries = yield* selectEntries(
              scope,
              filters,
              "random",
              "oldest",
              1,
              Math.floor(unit * count),
            );
            const entry = entries[0];
            if (entry === undefined) {
              return yield* Effect.fail(
                repositoryError("random", "decode", new Error("random OFFSET produced no row")),
              );
            }
            return entry;
          }),
        )
        .pipe(
          Effect.mapError((cause) =>
            cause instanceof EntryValidationError || cause instanceof EntryRepositoryError
              ? cause
              : toRepositoryError("random")(cause),
          ),
        );
    });

    const exportEntries = Effect.fn("EntryRepository.exportEntries")(function* (
      input: ScopedEntryQuery,
    ) {
      const { scope, filters } = yield* validateScopedQuery(input, "export");
      return yield* selectEntries(scope, filters, "export", "oldest");
    });

    return EntryRepository.of({
      append,
      read,
      context,
      stats,
      random: randomEntry,
      exportEntries,
    });
  });

export const layerWith = (options: EntryRepositoryOptions = {}) =>
  Layer.effect(EntryRepository, make(options));

export const layer = layerWith();
