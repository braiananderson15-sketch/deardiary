import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as SqlError from "effect/unstable/sql/SqlError";

import * as Db from "../src/db.ts";
import * as Git from "../src/git.ts";
import * as Projects from "../src/projects.ts";

const firstTimestamp = "2026-08-07T12:00:00.000Z";
const secondTimestamp = "2026-08-07T13:00:00.000Z";
const thirdTimestamp = "2026-08-07T14:00:00.000Z";
const tombstoneTimestamp = "2026-08-07T12:30:00.000Z";

const projectId = (value: number): string =>
  `00000000-0000-4000-8000-${value.toString(16).padStart(12, "0")}`;

const repositoryRoot = (name: string): string =>
  NodePath.join(NodePath.parse(process.cwd()).root, "workspace", name);

const descriptor = (
  canonicalRoot: string,
  options: {
    readonly workingTreeRoot?: string;
    readonly isLinkedWorktree?: boolean;
    readonly originRemoteUrl?: string;
  } = {},
): Git.RepositoryDescriptor => ({
  workingTreeRoot: options.workingTreeRoot ?? canonicalRoot,
  canonicalRoot,
  isLinkedWorktree: options.isLinkedWorktree ?? false,
  ...(options.originRemoteUrl === undefined ? {} : { originRemoteUrl: options.originRemoteUrl }),
});

const resolverFor = (
  repository: Git.RepositoryDescriptor | null,
): Git.RepositoryResolver["Service"] =>
  Git.RepositoryResolver.of({
    resolve: () => Effect.succeed(repository),
  });

const makeSources = (ids: ReadonlyArray<string>, timestamps: ReadonlyArray<string>) => {
  let idIndex = 0;
  let timestampIndex = 0;

  return {
    options: {
      generateId: Effect.sync(() => {
        const id = ids[idIndex];
        if (id === undefined) {
          throw new Error(`Unexpected project ID request at index ${idIndex}.`);
        }
        idIndex += 1;
        return id;
      }),
      now: Effect.sync(() => {
        const timestamp = timestamps[timestampIndex];
        if (timestamp === undefined) {
          throw new Error(`Unexpected project timestamp request at index ${timestampIndex}.`);
        }
        timestampIndex += 1;
        return timestamp;
      }),
    } satisfies Projects.ProjectRepositoryOptions,
    calls: () => ({ ids: idIndex, timestamps: timestampIndex }),
  };
};

const testLayer = (
  resolver: Git.RepositoryResolver["Service"],
  options: Projects.ProjectRepositoryOptions,
) =>
  Projects.layerWith(options).pipe(
    Layer.provideMerge(Db.layerMemory),
    Layer.provideMerge(Layer.succeed(Git.RepositoryResolver, resolver)),
  );

interface StoredProjectRow {
  readonly id: string;
  readonly root_path: string;
  readonly name: string;
  readonly remote_url: string | null;
  readonly first_seen: string;
  readonly last_seen: string;
  readonly updated_at: string;
  readonly deleted_at: string | null;
}

describe("ProjectRepository", () => {
  it.effect("returns null without creating a row outside Git", () => {
    const sources = makeSources([], []);

    return Effect.gen(function* () {
      const repository = yield* Projects.ProjectRepository;
      const { sql } = yield* Db.Database;

      expect(yield* repository.resolveForCwd("/outside/git")).toBeNull();

      const rows = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count
        FROM projects
      `;
      expect(rows[0]?.count).toBe(0);
      expect(sources.calls()).toEqual({ ids: 0, timestamps: 0 });
    }).pipe(Effect.provide(testLayer(resolverFor(null), sources.options)));
  });

  it.effect("creates an ordinary repository with deterministic project fields", () => {
    const root = repositoryRoot("Acme Project");
    const remoteUrl = "git@example.invalid:acme/project.git";
    const id = projectId(1);
    const sources = makeSources([id], [firstTimestamp]);

    return Effect.gen(function* () {
      const repository = yield* Projects.ProjectRepository;
      const { sql } = yield* Db.Database;

      const project = yield* repository.resolveForCwd(NodePath.join(root, "packages", "core"));
      expect(project).not.toBeNull();
      if (project === null) return;

      expect(project).toBeInstanceOf(Projects.Project);
      expect(project).toMatchObject({
        id,
        rootPath: root,
        name: "Acme Project",
        remoteUrl,
        firstSeen: firstTimestamp,
        lastSeen: firstTimestamp,
        updatedAt: firstTimestamp,
        deletedAt: null,
      });

      const rows = yield* sql<StoredProjectRow>`
        SELECT
          id,
          root_path,
          name,
          remote_url,
          first_seen,
          last_seen,
          updated_at,
          deleted_at
        FROM projects
      `;
      expect(rows).toEqual([
        {
          id,
          root_path: root,
          name: "Acme Project",
          remote_url: remoteUrl,
          first_seen: firstTimestamp,
          last_seen: firstTimestamp,
          updated_at: firstTimestamp,
          deleted_at: null,
        },
      ]);
      expect(sources.calls()).toEqual({ ids: 1, timestamps: 1 });
    }).pipe(
      Effect.provide(
        testLayer(resolverFor(descriptor(root, { originRemoteUrl: remoteUrl })), sources.options),
      ),
    );
  });

  it.effect("preserves identity and firstSeen while advancing observation timestamps", () => {
    const root = repositoryRoot("repeat-observation");
    const firstId = projectId(2);
    const sources = makeSources([firstId, projectId(3)], [firstTimestamp, secondTimestamp]);

    return Effect.gen(function* () {
      const repository = yield* Projects.ProjectRepository;
      const { sql } = yield* Db.Database;

      const first = yield* repository.resolveForCwd(root);
      const second = yield* repository.resolveForCwd(root);
      expect(first).not.toBeNull();
      expect(second).not.toBeNull();
      if (first === null || second === null) return;

      expect(second).toMatchObject({
        id: firstId,
        firstSeen: firstTimestamp,
        lastSeen: secondTimestamp,
        updatedAt: secondTimestamp,
      });
      expect(second.id).toBe(first.id);

      const rows = yield* sql<StoredProjectRow>`
        SELECT
          id,
          root_path,
          name,
          remote_url,
          first_seen,
          last_seen,
          updated_at,
          deleted_at
        FROM projects
      `;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        id: firstId,
        first_seen: firstTimestamp,
        last_seen: secondTimestamp,
        updated_at: secondTimestamp,
      });
      expect(sources.calls()).toEqual({ ids: 2, timestamps: 2 });
    }).pipe(Effect.provide(testLayer(resolverFor(descriptor(root)), sources.options)));
  });

  it.effect("maps a linked worktree and its main checkout to one project", () => {
    const mainRoot = repositoryRoot("main-checkout");
    const linkedRoot = repositoryRoot("linked-checkout");
    const mainCwd = NodePath.join(mainRoot, "packages");
    const linkedCwd = NodePath.join(linkedRoot, "packages");
    const sources = makeSources([projectId(4), projectId(5)], [firstTimestamp, secondTimestamp]);
    const resolver = Git.RepositoryResolver.of({
      resolve: (cwd) =>
        Effect.succeed(
          cwd === linkedCwd
            ? descriptor(mainRoot, {
                workingTreeRoot: linkedRoot,
                isLinkedWorktree: true,
              })
            : descriptor(mainRoot),
        ),
    });

    return Effect.gen(function* () {
      const repository = yield* Projects.ProjectRepository;
      const { sql } = yield* Db.Database;

      const main = yield* repository.resolveForCwd(mainCwd);
      const linked = yield* repository.resolveForCwd(linkedCwd);
      expect(main).not.toBeNull();
      expect(linked).not.toBeNull();
      if (main === null || linked === null) return;

      expect(linked.id).toBe(main.id);
      expect(linked.rootPath).toBe(mainRoot);
      expect(linked.name).toBe("main-checkout");

      const rows = yield* sql<{ readonly count: number; readonly id: string }>`
        SELECT COUNT(*) AS count, id
        FROM projects
      `;
      expect(rows).toEqual([{ count: 1, id: main.id }]);
    }).pipe(Effect.provide(testLayer(resolver, sources.options)));
  });

  it.effect("updates an observed remote and preserves it when Git later returns undefined", () => {
    const root = repositoryRoot("remote-observations");
    const originalRemote = "https://example.invalid/original.git";
    const updatedRemote = "ssh://git@example.invalid/updated.git";
    const remotes: ReadonlyArray<string | undefined> = [originalRemote, updatedRemote, undefined];
    let observation = 0;
    const resolver = Git.RepositoryResolver.of({
      resolve: () => {
        const originRemoteUrl = remotes[observation];
        observation += 1;
        return Effect.succeed(
          descriptor(root, originRemoteUrl === undefined ? {} : { originRemoteUrl }),
        );
      },
    });
    const id = projectId(6);
    const sources = makeSources(
      [id, projectId(7), projectId(8)],
      [firstTimestamp, secondTimestamp, thirdTimestamp],
    );

    return Effect.gen(function* () {
      const repository = yield* Projects.ProjectRepository;

      const first = yield* repository.resolveForCwd(root);
      const second = yield* repository.resolveForCwd(root);
      const third = yield* repository.resolveForCwd(root);
      const stored = yield* repository.findByRootPath(root);

      expect(first?.remoteUrl).toBe(originalRemote);
      expect(second?.remoteUrl).toBe(updatedRemote);
      expect(third?.remoteUrl).toBe(updatedRemote);
      expect(stored).toMatchObject({
        id,
        remoteUrl: updatedRemote,
        firstSeen: firstTimestamp,
        lastSeen: thirdTimestamp,
        updatedAt: thirdTimestamp,
      });
    }).pipe(Effect.provide(testLayer(resolver, sources.options)));
  });

  it.effect("reactivates a soft-deleted project without changing identity or firstSeen", () => {
    const root = repositoryRoot("reactivated-project");
    const remoteUrl = "https://example.invalid/reactivated.git";
    const id = projectId(9);
    let observation = 0;
    const resolver = Git.RepositoryResolver.of({
      resolve: () => {
        observation += 1;
        return Effect.succeed(
          observation === 1 ? descriptor(root, { originRemoteUrl: remoteUrl }) : descriptor(root),
        );
      },
    });
    const sources = makeSources([id, projectId(10)], [firstTimestamp, secondTimestamp]);

    return Effect.gen(function* () {
      const repository = yield* Projects.ProjectRepository;
      const { sql } = yield* Db.Database;

      yield* repository.resolveForCwd(root);
      yield* sql`
        UPDATE projects
        SET
          name = ${"stale name"},
          deleted_at = ${tombstoneTimestamp}
        WHERE root_path = ${root}
      `;

      const reactivated = yield* repository.resolveForCwd(root);
      expect(reactivated).toMatchObject({
        id,
        rootPath: root,
        name: "reactivated-project",
        remoteUrl,
        firstSeen: firstTimestamp,
        lastSeen: secondTimestamp,
        updatedAt: secondTimestamp,
        deletedAt: null,
      });

      const rows = yield* sql<StoredProjectRow>`
        SELECT
          id,
          root_path,
          name,
          remote_url,
          first_seen,
          last_seen,
          updated_at,
          deleted_at
        FROM projects
        WHERE root_path = ${root}
      `;
      expect(rows[0]).toMatchObject({
        id,
        first_seen: firstTimestamp,
        deleted_at: null,
      });
    }).pipe(Effect.provide(testLayer(resolver, sources.options)));
  });

  it.effect("atomically converges concurrent observations on one project row and id", () =>
    Effect.gen(function* () {
      const callerCount = 12;
      const root = repositoryRoot("concurrent-project");
      const release = yield* Deferred.make<void>();
      const arrivals = yield* Ref.make(0);
      const resolver = Git.RepositoryResolver.of({
        resolve: () =>
          Effect.gen(function* () {
            const arrived = yield* Ref.updateAndGet(arrivals, (count) => count + 1);
            if (arrived === callerCount) {
              yield* Deferred.succeed(release, undefined);
            }
            yield* Deferred.await(release);
            return descriptor(root);
          }),
      });
      const candidateIds = Array.from({ length: callerCount }, (_, index) =>
        projectId(100 + index),
      );
      const sources = makeSources(
        candidateIds,
        Array.from({ length: callerCount }, () => firstTimestamp),
      );

      yield* Effect.gen(function* () {
        const repository = yield* Projects.ProjectRepository;
        const { sql } = yield* Db.Database;

        const observed = yield* Effect.all(
          Array.from({ length: callerCount }, (_, index) =>
            repository.resolveForCwd(NodePath.join(root, String(index))),
          ),
          { concurrency: "unbounded" },
        );
        const observedIds = observed.map((project) => project?.id);
        expect(observed.every((project) => project !== null)).toBe(true);
        expect(new Set(observedIds)).toHaveLength(1);

        const rows = yield* sql<{ readonly count: number; readonly id: string }>`
          SELECT COUNT(*) AS count, id
          FROM projects
        `;
        expect(rows).toHaveLength(1);
        expect(rows[0]?.count).toBe(1);
        expect(rows[0]?.id).toBe(observedIds[0]);
        expect(candidateIds).toContain(rows[0]?.id);
        expect(sources.calls()).toEqual({ ids: callerCount, timestamps: callerCount });
      }).pipe(Effect.provide(testLayer(resolver, sources.options)));
    }),
  );

  it.effect("maps SQLite failures to ProjectRepositoryError with operation and cause", () => {
    const root = repositoryRoot("sql-failure");
    const sources = makeSources([projectId(20)], [firstTimestamp]);

    return Effect.gen(function* () {
      const repository = yield* Projects.ProjectRepository;
      const { sql } = yield* Db.Database;
      yield* sql`DROP TABLE projects`;

      const error = yield* repository.resolveForCwd(root).pipe(Effect.flip);
      expect(error).toBeInstanceOf(Projects.ProjectRepositoryError);
      if (!(error instanceof Projects.ProjectRepositoryError)) return;

      expect(error).toMatchObject({
        operation: "resolveForCwd",
        kind: "storage",
      });
      expect(SqlError.isSqlError(error.cause)).toBe(true);
    }).pipe(Effect.provide(testLayer(resolverFor(descriptor(root)), sources.options)));
  });

  it.effect("maps malformed stored rows to a typed decode repository error", () => {
    const root = repositoryRoot("malformed-project");
    const sources = makeSources([], []);

    return Effect.gen(function* () {
      const repository = yield* Projects.ProjectRepository;
      const { sql } = yield* Db.Database;
      yield* sql`
        INSERT INTO projects (
          id,
          root_path,
          name,
          first_seen,
          last_seen,
          updated_at
        ) VALUES (
          ${"not-a-uuid"},
          ${root},
          ${"malformed-project"},
          ${firstTimestamp},
          ${firstTimestamp},
          ${firstTimestamp}
        )
      `;

      const error = yield* repository.findByRootPath(root).pipe(Effect.flip);
      expect(error).toBeInstanceOf(Projects.ProjectRepositoryError);
      expect(error).toMatchObject({
        operation: "findByRootPath",
        kind: "decode",
      });
      expect(Schema.isSchemaError(error.cause)).toBe(true);
    }).pipe(Effect.provide(testLayer(resolverFor(null), sources.options)));
  });

  it.effect("preserves Git resolution failures and does not create a row", () => {
    const cwd = repositoryRoot("git-failure");
    const gitCause = new Error("spawn git failed");
    const gitError = new Git.GitCommandExecutionError({
      operation: "inspectRepository",
      command: "git",
      cwd,
      args: ["rev-parse"],
      cause: gitCause,
    });
    const resolver = Git.RepositoryResolver.of({
      resolve: () => Effect.fail(gitError),
    });
    const sources = makeSources([], []);

    return Effect.gen(function* () {
      const repository = yield* Projects.ProjectRepository;
      const { sql } = yield* Db.Database;

      const error = yield* repository.resolveForCwd(cwd).pipe(Effect.flip);
      expect(error).toBe(gitError);
      expect(error).toBeInstanceOf(Git.GitCommandExecutionError);

      const rows = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count
        FROM projects
      `;
      expect(rows[0]?.count).toBe(0);
      expect(sources.calls()).toEqual({ ids: 0, timestamps: 0 });
    }).pipe(Effect.provide(testLayer(resolver, sources.options)));
  });
});
