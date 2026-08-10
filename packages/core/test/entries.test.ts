import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlError from "effect/unstable/sql/SqlError";

import * as Db from "../src/db.ts";
import * as Entries from "../src/entries.ts";
import * as Git from "../src/git.ts";
import * as Projects from "../src/projects.ts";

const firstTimestamp = "2026-08-07T10:00:00.000Z";
const secondTimestamp = "2026-08-07T11:00:00.000Z";
const thirdTimestamp = "2026-08-07T12:00:00.000Z";
const fourthTimestamp = "2026-08-07T13:00:00.000Z";
const tombstoneTimestamp = "2026-08-07T14:00:00.000Z";

const uuid = (value: number): string =>
  `00000000-0000-4000-8000-${value.toString(16).padStart(12, "0")}`;

const project = (value: number, rootPath = `/workspace/project-${value}`) =>
  new Projects.Project({
    id: uuid(10_000 + value),
    rootPath,
    name: `project-${value}`,
    remoteUrl: null,
    firstSeen: firstTimestamp,
    lastSeen: firstTimestamp,
    updatedAt: firstTimestamp,
    deletedAt: null,
  });

const projectRepository = (
  resolve: (
    cwd: string,
  ) => Effect.Effect<
    Projects.Project | null,
    Projects.ProjectRepositoryError | Git.GitResolutionError
  >,
) =>
  Projects.ProjectRepository.of({
    resolveForCwd: resolve,
    findByRootPath: () => Effect.succeed(null),
  });

const noProjectRepository = projectRepository(() => Effect.succeed(null));

const testLayer = (
  projects: Projects.ProjectRepository["Service"] = noProjectRepository,
  options: Entries.EntryRepositoryOptions = {},
) =>
  Entries.layerWith(options).pipe(
    Layer.provideMerge(Db.layerMemory),
    Layer.provideMerge(Layer.succeed(Projects.ProjectRepository, projects)),
  );

const insertProject = (value: Projects.Project) =>
  Effect.gen(function* () {
    const { sql } = yield* Db.Database;
    yield* sql`
      INSERT INTO projects (
        id, root_path, name, remote_url,
        first_seen, last_seen, updated_at, deleted_at
      ) VALUES (
        ${value.id}, ${value.rootPath}, ${value.name}, ${value.remoteUrl},
        ${value.firstSeen}, ${value.lastSeen}, ${value.updatedAt}, ${value.deletedAt}
      )
    `;
  });

interface SeedEntry {
  readonly id: string;
  readonly timestamp: string;
  readonly body: string;
  readonly projectId?: string | null;
  readonly mood?: Entries.Mood;
  readonly tags?: string;
  readonly model?: string | null;
  readonly harness?: string | null;
  readonly cwd?: string;
  readonly updatedAt?: string;
  readonly deletedAt?: string | null;
}

const insertEntry = (entry: SeedEntry) =>
  Effect.gen(function* () {
    const { sql } = yield* Db.Database;
    yield* sql`
      INSERT INTO entries (
        id, project_id, ts, model, harness, mood,
        tags, cwd, body, updated_at, deleted_at
      ) VALUES (
        ${entry.id},
        ${entry.projectId ?? null},
        ${entry.timestamp},
        ${entry.model ?? null},
        ${entry.harness ?? null},
        ${entry.mood ?? "note"},
        ${entry.tags ?? ""},
        ${entry.cwd ?? "/workspace"},
        ${entry.body},
        ${entry.updatedAt ?? entry.timestamp},
        ${entry.deletedAt ?? null}
      )
    `;
  });

const seedQueryEntries = Effect.gen(function* () {
  const firstProject = project(1);
  const secondProject = project(2);
  yield* insertProject(firstProject);
  yield* insertProject(secondProject);
  yield* Effect.forEach(
    [
      {
        id: uuid(1),
        projectId: null,
        timestamp: firstTimestamp,
        mood: "note" as const,
        tags: "api,shared",
        model: "gpt-a",
        harness: "codex",
        body: "global oldest",
      },
      {
        id: uuid(2),
        projectId: firstProject.id,
        timestamp: secondTimestamp,
        mood: "win" as const,
        tags: "graphql-api,shared",
        model: "gpt-b",
        harness: "claude",
        body: "project one older",
      },
      {
        id: uuid(3),
        projectId: firstProject.id,
        timestamp: thirdTimestamp,
        mood: "struggled" as const,
        tags: "api,db",
        model: "gpt-a",
        harness: "codex",
        body: "project one newer",
      },
      {
        id: uuid(4),
        projectId: secondProject.id,
        timestamp: fourthTimestamp,
        mood: "idea" as const,
        tags: "other",
        model: "gpt-c",
        harness: "codex",
        body: "project two",
      },
      {
        id: uuid(5),
        projectId: firstProject.id,
        timestamp: fourthTimestamp,
        mood: "rant" as const,
        tags: "api",
        model: "gpt-a",
        harness: "codex",
        body: "deleted",
        deletedAt: tombstoneTimestamp,
      },
    ],
    insertEntry,
  );
  return { firstProject, secondProject };
});

describe("EntryRepository append", () => {
  it.effect("maps fields, canonicalizes tags, and uses exactly one UUID and timestamp", () => {
    let idCalls = 0;
    let timeCalls = 0;
    const entryId = uuid(100);
    const options: Entries.EntryRepositoryOptions = {
      generateId: Effect.sync(() => {
        idCalls += 1;
        return entryId;
      }),
      now: Effect.sync(() => {
        timeCalls += 1;
        return secondTimestamp;
      }),
    };

    return Effect.gen(function* () {
      const repository = yield* Entries.EntryRepository;
      const { sql } = yield* Db.Database;
      const entry = yield* repository.append({
        cwd: "/outside/git",
        body: "A useful observation.",
        mood: "idea",
        tags: [" api ", "db", "api"],
        model: " gpt-5 ",
        harness: " codex ",
      });

      expect(entry).toBeInstanceOf(Entries.Entry);
      expect(entry).toEqual(
        expect.objectContaining({
          id: entryId,
          projectId: null,
          projectRootPath: null,
          timestamp: secondTimestamp,
          updatedAt: secondTimestamp,
          deletedAt: null,
          tags: ["api", "db"],
          model: "gpt-5",
          harness: "codex",
          mood: "idea",
          cwd: "/outside/git",
          body: "A useful observation.",
        }),
      );
      expect({ idCalls, timeCalls }).toEqual({ idCalls: 1, timeCalls: 1 });

      const rows = yield* sql<{
        readonly project_id: string | null;
        readonly ts: string;
        readonly tags: string;
        readonly updated_at: string;
      }>`SELECT project_id, ts, tags, updated_at FROM entries`;
      expect(rows).toEqual([
        {
          project_id: null,
          ts: secondTimestamp,
          tags: "api,db",
          updated_at: secondTimestamp,
        },
      ]);
    }).pipe(Effect.provide(testLayer(noProjectRepository, options)));
  });

  it.effect("stores a resolved project and force-global bypasses project resolution", () => {
    const resolved = project(3);
    let resolutions = 0;
    const projects = projectRepository(() => {
      resolutions += 1;
      return Effect.succeed(resolved);
    });
    const ids = [uuid(101), uuid(102)];
    let idIndex = 0;
    const options: Entries.EntryRepositoryOptions = {
      generateId: Effect.sync(() => ids[idIndex++]!),
      now: Effect.succeed(secondTimestamp),
    };

    return Effect.gen(function* () {
      yield* insertProject(resolved);
      const repository = yield* Entries.EntryRepository;
      const scoped = yield* repository.append({
        cwd: "/workspace/project-3",
        body: "scoped",
        mood: "win",
      });
      const global = yield* repository.append({
        cwd: "/workspace/project-3",
        body: "forced global",
        mood: "note",
        forceGlobal: true,
      });

      expect(scoped.projectId).toBe(resolved.id);
      expect(scoped.projectRootPath).toBe(resolved.rootPath);
      expect(global.projectId).toBeNull();
      expect(global.projectRootPath).toBeNull();
      expect(resolutions).toBe(1);
    }).pipe(Effect.provide(testLayer(projects, options)));
  });

  it.effect("rejects ambiguous comma-text tags before resolving a project", () => {
    let resolutions = 0;
    const projects = projectRepository(() => {
      resolutions += 1;
      return Effect.succeed(null);
    });

    return Effect.gen(function* () {
      const repository = yield* Entries.EntryRepository;
      for (const tags of [[""], ["   "], ["api,db"]]) {
        const error = yield* repository
          .append({ cwd: "/workspace", body: "body", mood: "note", tags })
          .pipe(Effect.flip);
        expect(error).toBeInstanceOf(Entries.EntryValidationError);
        expect(error).toMatchObject({ operation: "append", field: "tags" });
      }
      expect(resolutions).toBe(0);
    }).pipe(Effect.provide(testLayer(projects)));
  });

  it.effect("keeps append immutable when UUIDs collide", () => {
    const options: Entries.EntryRepositoryOptions = {
      generateId: Effect.succeed(uuid(103)),
      now: Effect.succeed(secondTimestamp),
    };

    return Effect.gen(function* () {
      const repository = yield* Entries.EntryRepository;
      yield* repository.append({ cwd: "/workspace", body: "original", mood: "note" });
      const error = yield* repository
        .append({ cwd: "/workspace", body: "replacement", mood: "rant" })
        .pipe(Effect.flip);
      expect(error).toBeInstanceOf(Entries.EntryRepositoryError);
      expect(error).toMatchObject({ operation: "append", kind: "storage" });
      if (!(error instanceof Entries.EntryRepositoryError)) return;
      expect(SqlError.isSqlError(error.cause)).toBe(true);

      const entries = yield* repository.exportEntries({ scope: { kind: "all" } });
      expect(entries.map((entry) => entry.body)).toEqual(["original"]);
    }).pipe(Effect.provide(testLayer(noProjectRepository, options)));
  });

  it.effect("does not lose concurrent appends", () => {
    let nextId = 200;
    const options: Entries.EntryRepositoryOptions = {
      generateId: Effect.sync(() => uuid(nextId++)),
      now: Effect.succeed(secondTimestamp),
    };

    return Effect.gen(function* () {
      const repository = yield* Entries.EntryRepository;
      const entries = yield* Effect.all(
        Array.from({ length: 20 }, (_, index) =>
          repository.append({ cwd: "/workspace", body: `entry ${index}`, mood: "note" }),
        ),
        { concurrency: "unbounded" },
      );
      expect(new Set(entries.map((entry) => entry.id))).toHaveLength(20);
      expect((yield* repository.stats({ scope: { kind: "global" } })).total).toBe(20);
    }).pipe(Effect.provide(testLayer(noProjectRepository, options)));
  });
});

describe("EntryRepository queries", () => {
  it.effect("surfaces joined project roots and keeps global entries nullable", () =>
    Effect.gen(function* () {
      const repository = yield* Entries.EntryRepository;
      const joinedProject = project(1);
      yield* insertProject(joinedProject);
      yield* insertEntry({
        id: uuid(30),
        projectId: joinedProject.id,
        timestamp: secondTimestamp,
        cwd: "/workspace/project-1-worktree",
        body: "linked worktree entry",
      });
      yield* insertEntry({ id: uuid(31), timestamp: firstTimestamp, body: "global entry" });

      const entries = yield* repository.context({ cwd: joinedProject.rootPath });
      expect(entries.find((entry) => entry.id === uuid(30))).toMatchObject({
        cwd: "/workspace/project-1-worktree",
        projectRootPath: joinedProject.rootPath,
      });
      expect(entries.find((entry) => entry.id === uuid(31))?.projectRootPath).toBeNull();
    }).pipe(Effect.provide(testLayer(projectRepository(() => Effect.succeed(project(1)))))),
  );

  it.effect("supports project/global/all scope and every settled filter", () =>
    Effect.gen(function* () {
      const repository = yield* Entries.EntryRepository;
      const { firstProject } = yield* seedQueryEntries;

      const global = yield* repository.read({ scope: { kind: "global" } });
      const scoped = yield* repository.read({
        scope: { kind: "project", projectId: firstProject.id },
      });
      const all = yield* repository.read({ scope: { kind: "all" } });
      expect(global.map((entry) => entry.body)).toEqual(["global oldest"]);
      expect(scoped.map((entry) => entry.body)).toEqual(["project one newer", "project one older"]);
      expect(all.map((entry) => entry.body)).toEqual([
        "project two",
        "project one newer",
        "project one older",
        "global oldest",
      ]);

      expect(
        (yield* repository.read({ scope: { kind: "all" }, mood: "struggled" })).map(
          (entry) => entry.body,
        ),
      ).toEqual(["project one newer"]);
      expect(
        (yield* repository.read({ scope: { kind: "all" }, since: thirdTimestamp })).map(
          (entry) => entry.body,
        ),
      ).toEqual(["project two", "project one newer"]);
      expect(
        (yield* repository.read({ scope: { kind: "all" }, model: "gpt-b" })).map(
          (entry) => entry.body,
        ),
      ).toEqual(["project one older"]);
      expect(
        (yield* repository.read({ scope: { kind: "all" }, harness: "claude" })).map(
          (entry) => entry.body,
        ),
      ).toEqual(["project one older"]);
      expect(
        (yield* repository.read({ scope: { kind: "all" }, tag: "api" })).map((entry) => entry.body),
      ).toEqual(["project one newer", "global oldest"]);
    }).pipe(Effect.provide(testLayer())),
  );

  it.effect("matches tags exactly, including SQL wildcard characters", () =>
    Effect.gen(function* () {
      const repository = yield* Entries.EntryRepository;
      yield* insertEntry({
        id: uuid(20),
        timestamp: firstTimestamp,
        body: "percent",
        tags: "%",
      });
      yield* insertEntry({
        id: uuid(21),
        timestamp: secondTimestamp,
        body: "underscore",
        tags: "_",
      });
      yield* insertEntry({
        id: uuid(22),
        timestamp: thirdTimestamp,
        body: "ordinary",
        tags: "anything",
      });

      expect(
        (yield* repository.read({ scope: { kind: "all" }, tag: "%" })).map((entry) => entry.body),
      ).toEqual(["percent"]);
      expect(
        (yield* repository.read({ scope: { kind: "all" }, tag: "_" })).map((entry) => entry.body),
      ).toEqual(["underscore"]);
    }).pipe(Effect.provide(testLayer())),
  );

  it.effect("orders deterministically, bounds limits, and excludes tombstones", () =>
    Effect.gen(function* () {
      const repository = yield* Entries.EntryRepository;
      yield* seedQueryEntries;

      const oldest = yield* repository.read({
        scope: { kind: "all" },
        order: "oldest",
        limit: 2,
      });
      expect(oldest.map((entry) => entry.id)).toEqual([uuid(1), uuid(2)]);

      for (const limit of [0, 1_001, 1.5]) {
        const error = yield* repository.read({ scope: { kind: "all" }, limit }).pipe(Effect.flip);
        expect(error).toMatchObject({ operation: "read", field: "limit" });
      }
      expect(
        (yield* repository.read({ scope: { kind: "all" } })).some(
          (entry) => entry.body === "deleted",
        ),
      ).toBe(false);
    }).pipe(Effect.provide(testLayer())),
  );

  it.effect(
    "returns current project plus global context, global outside Git, and all explicitly",
    () => {
      const firstProject = project(1);
      let resolutions = 0;
      const projects = projectRepository((cwd) => {
        resolutions += 1;
        return Effect.succeed(cwd === firstProject.rootPath ? firstProject : null);
      });

      return Effect.gen(function* () {
        const repository = yield* Entries.EntryRepository;
        yield* seedQueryEntries;

        const current = yield* repository.context({ cwd: firstProject.rootPath });
        expect(current.map((entry) => entry.body)).toEqual([
          "project one newer",
          "project one older",
          "global oldest",
        ]);
        const outside = yield* repository.context({ cwd: "/tmp/not-git" });
        expect(outside.map((entry) => entry.body)).toEqual(["global oldest"]);
        const all = yield* repository.context({ cwd: "/ignored", all: true });
        expect(all.map((entry) => entry.body)).toEqual([
          "project two",
          "project one newer",
          "project one older",
          "global oldest",
        ]);
        expect(resolutions).toBe(2);

        const { sql } = yield* Db.Database;
        const count = yield* sql<{
          readonly count: number;
        }>`SELECT COUNT(*) AS count FROM projects`;
        expect(count[0]?.count).toBe(2);
      }).pipe(Effect.provide(testLayer(projects)));
    },
  );

  it.effect("computes SQL aggregates for every promised dimension within filters", () =>
    Effect.gen(function* () {
      const repository = yield* Entries.EntryRepository;
      const { firstProject } = yield* seedQueryEntries;
      yield* insertEntry({
        id: uuid(6),
        projectId: null,
        timestamp: fourthTimestamp,
        mood: "note",
        tags: "stats",
        model: null,
        harness: "codex",
        body: "unattributed model",
      });
      const stats = yield* repository.stats({
        scope: { kind: "all" },
        harness: "codex",
      });

      expect(stats).toEqual({
        total: 4,
        byMood: [
          { mood: "idea", count: 1 },
          { mood: "note", count: 2 },
          { mood: "struggled", count: 1 },
        ],
        byProject: [
          { projectId: null, name: null, rootPath: null, count: 2 },
          {
            projectId: firstProject.id,
            name: firstProject.name,
            rootPath: firstProject.rootPath,
            count: 1,
          },
          {
            projectId: project(2).id,
            name: project(2).name,
            rootPath: project(2).rootPath,
            count: 1,
          },
        ],
        byModel: [
          { model: null, count: 1 },
          { model: "gpt-a", count: 2 },
          { model: "gpt-c", count: 1 },
        ],
        byHarness: [{ harness: "codex", count: 4 }],
      });
    }).pipe(Effect.provide(testLayer())),
  );

  it.effect(
    "returns null when random has no candidates and deterministically selects an eligible row",
    () => {
      let randomCalls = 0;
      const options: Entries.EntryRepositoryOptions = {
        random: Effect.sync(() => {
          randomCalls += 1;
          return 0.5;
        }),
      };

      return Effect.gen(function* () {
        const repository = yield* Entries.EntryRepository;
        expect(yield* repository.random({ scope: { kind: "all" } })).toBeNull();
        expect(randomCalls).toBe(0);
        yield* seedQueryEntries;

        const selected = yield* repository.random({
          scope: { kind: "all" },
          harness: "codex",
        });
        expect(selected?.body).toBe("project one newer");
        expect(randomCalls).toBe(1);
      }).pipe(Effect.provide(testLayer(noProjectRepository, options)));
    },
  );

  it.effect("exports every eligible row in stable chronological order", () =>
    Effect.gen(function* () {
      const repository = yield* Entries.EntryRepository;
      yield* insertEntry({ id: uuid(32), timestamp: secondTimestamp, body: "same-b" });
      yield* insertEntry({ id: uuid(31), timestamp: secondTimestamp, body: "same-a" });
      yield* insertEntry({ id: uuid(30), timestamp: firstTimestamp, body: "first" });
      const exported = yield* repository.exportEntries({ scope: { kind: "all" } });
      expect(exported.map((entry) => entry.id)).toEqual([uuid(30), uuid(31), uuid(32)]);
    }).pipe(Effect.provide(testLayer())),
  );
});

describe("EntryRepository failures", () => {
  it.effect("reports malformed SQL rows as decode failures", () =>
    Effect.gen(function* () {
      const repository = yield* Entries.EntryRepository;
      yield* insertEntry({
        id: uuid(40),
        timestamp: firstTimestamp,
        body: "malformed tags",
        tags: "api,api",
      });
      const error = yield* repository.read({ scope: { kind: "all" } }).pipe(Effect.flip);
      expect(error).toBeInstanceOf(Entries.EntryRepositoryError);
      expect(error).toMatchObject({ operation: "read", kind: "decode" });
    }).pipe(Effect.provide(testLayer())),
  );

  it.effect("reports SQL failures with the original storage cause", () =>
    Effect.gen(function* () {
      const repository = yield* Entries.EntryRepository;
      const { sql } = yield* Db.Database;
      yield* sql`DROP TABLE entries`;

      const error = yield* repository.read({ scope: { kind: "all" } }).pipe(Effect.flip);
      expect(error).toBeInstanceOf(Entries.EntryRepositoryError);
      expect(error).toMatchObject({ operation: "read", kind: "storage" });
      if (!(error instanceof Entries.EntryRepositoryError)) return;
      expect(SqlError.isSqlError(error.cause)).toBe(true);
    }).pipe(Effect.provide(testLayer())),
  );

  it.effect("preserves project and Git failures from append/context", () => {
    const projectFailure = new Projects.ProjectRepositoryError({
      operation: "resolveForCwd",
      kind: "storage",
      cause: new Error("project storage failed"),
    });
    const gitFailure = new Git.GitCommandExecutionError({
      operation: "inspectRepository",
      command: "git",
      cwd: "/workspace",
      args: ["rev-parse"],
      cause: new Error("spawn failed"),
    });
    let useGitFailure = false;
    const projects = projectRepository(() =>
      useGitFailure ? Effect.fail(gitFailure) : Effect.fail(projectFailure),
    );

    return Effect.gen(function* () {
      const repository = yield* Entries.EntryRepository;
      const appendFailure = yield* repository
        .append({ cwd: "/workspace", body: "body", mood: "note" })
        .pipe(Effect.flip);
      expect(appendFailure).toBe(projectFailure);

      useGitFailure = true;
      const contextFailure = yield* repository.context({ cwd: "/workspace" }).pipe(Effect.flip);
      expect(contextFailure).toBe(gitFailure);

      const forced = yield* repository.append({
        cwd: "/workspace",
        body: "still global",
        mood: "note",
        forceGlobal: true,
      });
      expect(forced.projectId).toBeNull();
    }).pipe(
      Effect.provide(
        testLayer(projects, {
          generateId: Effect.succeed(uuid(50)),
          now: Effect.succeed(firstTimestamp),
        }),
      ),
    );
  });

  it.effect("validates scope and time filters before touching storage", () =>
    Effect.gen(function* () {
      const repository = yield* Entries.EntryRepository;
      const badScope = yield* repository
        .read({ scope: { kind: "project", projectId: "not-a-uuid" } })
        .pipe(Effect.flip);
      expect(badScope).toMatchObject({ operation: "read", field: "scope" });

      const badTime = yield* repository
        .read({ scope: { kind: "all" }, since: "yesterday" })
        .pipe(Effect.flip);
      expect(badTime).toMatchObject({ operation: "read", field: "since" });
      expect(badTime).toBeInstanceOf(Entries.EntryValidationError);
      expect(Schema.isSchemaError(badTime.cause)).toBe(true);
    }).pipe(Effect.provide(testLayer())),
  );

  it.effect("rejects an unknown runtime scope before executing SQL", () =>
    Effect.gen(function* () {
      const repository = yield* Entries.EntryRepository;
      const { sql } = yield* Db.Database;
      yield* sql`DROP TABLE entries`;

      const error = yield* repository
        .read({ scope: { kind: "unexpected" } } as unknown as Entries.ReadEntriesInput)
        .pipe(Effect.flip);
      expect(error).toBeInstanceOf(Entries.EntryValidationError);
      expect(error).toMatchObject({ operation: "read", field: "scope" });
      expect(Schema.isSchemaError(error.cause)).toBe(true);
    }).pipe(Effect.provide(testLayer())),
  );

  it.effect("rejects runtime append mood before project resolution or storage", () => {
    let resolutions = 0;
    const projects = projectRepository(() => {
      resolutions += 1;
      return Effect.succeed(null);
    });

    return Effect.gen(function* () {
      const repository = yield* Entries.EntryRepository;
      const { sql } = yield* Db.Database;
      const error = yield* repository
        .append({
          cwd: "/workspace",
          body: "must not be stored",
          mood: "unexpected",
        } as unknown as Entries.AppendEntryInput)
        .pipe(Effect.flip);

      expect(error).toBeInstanceOf(Entries.EntryValidationError);
      expect(error).toMatchObject({ operation: "append", field: "mood" });
      expect(resolutions).toBe(0);
      const rows = yield* sql<{ readonly count: number }>`SELECT COUNT(*) AS count FROM entries`;
      expect(rows[0]?.count).toBe(0);
    }).pipe(Effect.provide(testLayer(projects)));
  });

  it.effect("rejects runtime mood filters and order values without resolving context", () => {
    let resolutions = 0;
    const projects = projectRepository(() => {
      resolutions += 1;
      return Effect.succeed(null);
    });

    return Effect.gen(function* () {
      const repository = yield* Entries.EntryRepository;
      const moodError = yield* repository
        .read({
          scope: { kind: "all" },
          mood: "unexpected",
        } as unknown as Entries.ReadEntriesInput)
        .pipe(Effect.flip);
      expect(moodError).toMatchObject({ operation: "read", field: "mood" });

      const readOrderError = yield* repository
        .read({
          scope: { kind: "all" },
          order: "sideways",
        } as unknown as Entries.ReadEntriesInput)
        .pipe(Effect.flip);
      expect(readOrderError).toMatchObject({ operation: "read", field: "order" });

      const contextOrderError = yield* repository
        .context({
          cwd: "/workspace",
          order: "sideways",
        } as unknown as Entries.ContextEntriesInput)
        .pipe(Effect.flip);
      expect(contextOrderError).toMatchObject({ operation: "context", field: "order" });
      expect(resolutions).toBe(0);
    }).pipe(Effect.provide(testLayer(projects)));
  });
});
