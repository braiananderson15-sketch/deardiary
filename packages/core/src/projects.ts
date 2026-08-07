import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";

import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import * as Db from "./db.ts";
import * as Git from "./git.ts";

const UtcIsoTimestamp = Schema.String.check(
  Schema.makeFilter(
    (value) => {
      const milliseconds = Date.parse(value);
      return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
    },
    { expected: "a canonical UTC ISO 8601 timestamp" },
  ),
);

export class Project extends Schema.Class<Project>("Project")({
  id: Schema.String.check(Schema.isUUID()),
  rootPath: Schema.NonEmptyString,
  name: Schema.String,
  remoteUrl: Schema.NullOr(Schema.NonEmptyString),
  firstSeen: UtcIsoTimestamp,
  lastSeen: UtcIsoTimestamp,
  updatedAt: UtcIsoTimestamp,
  deletedAt: Schema.NullOr(UtcIsoTimestamp),
}) {}

export const ProjectRepositoryOperation = Schema.Literals(["resolveForCwd", "findByRootPath"]);
export type ProjectRepositoryOperation = typeof ProjectRepositoryOperation.Type;

export const ProjectRepositoryErrorKind = Schema.Literals(["storage", "decode"]);
export type ProjectRepositoryErrorKind = typeof ProjectRepositoryErrorKind.Type;

export class ProjectRepositoryError extends Schema.TaggedErrorClass<ProjectRepositoryError>()(
  "ProjectRepositoryError",
  {
    operation: ProjectRepositoryOperation,
    kind: ProjectRepositoryErrorKind,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return this.kind === "storage"
      ? `Project repository operation '${this.operation}' failed. Check that the Dear Diary database is readable and writable.`
      : `Project repository operation '${this.operation}' received invalid project data from the Dear Diary database.`;
  }
}

export interface ProjectRepositoryOptions {
  /** A reusable effect yielding one canonical UTC ISO timestamp per observation. */
  readonly now?: Effect.Effect<string>;
  /** A reusable effect yielding one UUID candidate per observation. */
  readonly generateId?: Effect.Effect<string>;
}

export class ProjectRepository extends Context.Service<
  ProjectRepository,
  {
    readonly resolveForCwd: (
      cwd: string,
    ) => Effect.Effect<Project | null, ProjectRepositoryError | Git.GitResolutionError>;
    readonly findByRootPath: (
      rootPath: string,
    ) => Effect.Effect<Project | null, ProjectRepositoryError>;
  }
>()("@deardiary/core/projects/ProjectRepository") {}

const FindByRootPathRequest = Schema.Struct({
  rootPath: Schema.NonEmptyString,
});

const currentUtcIsoTimestamp = Clock.currentTimeMillis.pipe(
  Effect.map((milliseconds) => new Date(milliseconds).toISOString()),
);

const randomProjectId = Effect.sync(NodeCrypto.randomUUID);

const toRepositoryError =
  (operation: ProjectRepositoryOperation) =>
  (cause: unknown): ProjectRepositoryError =>
    new ProjectRepositoryError({
      operation,
      kind: Schema.isSchemaError(cause) ? "decode" : "storage",
      cause,
    });

export const make = (options: ProjectRepositoryOptions = {}) =>
  Effect.gen(function* () {
    const { sql } = yield* Db.Database;
    const resolver = yield* Git.RepositoryResolver;
    const now = options.now ?? currentUtcIsoTimestamp;
    const generateId = options.generateId ?? randomProjectId;

    const upsertProject = SqlSchema.findOne({
      Request: Project,
      Result: Project,
      execute: (project) => sql`
        INSERT INTO projects (
          id,
          root_path,
          name,
          remote_url,
          first_seen,
          last_seen,
          updated_at,
          deleted_at
        ) VALUES (
          ${project.id},
          ${project.rootPath},
          ${project.name},
          ${project.remoteUrl},
          ${project.firstSeen},
          ${project.lastSeen},
          ${project.updatedAt},
          ${project.deletedAt}
        )
        ON CONFLICT(root_path) DO UPDATE SET
          name = excluded.name,
          remote_url = COALESCE(excluded.remote_url, projects.remote_url),
          last_seen = excluded.last_seen,
          updated_at = excluded.updated_at,
          deleted_at = NULL
        RETURNING
          id AS "id",
          root_path AS "rootPath",
          name AS "name",
          remote_url AS "remoteUrl",
          first_seen AS "firstSeen",
          last_seen AS "lastSeen",
          updated_at AS "updatedAt",
          deleted_at AS "deletedAt"
      `,
    });

    const findProjectByRootPath = SqlSchema.findOneOption({
      Request: FindByRootPathRequest,
      Result: Project,
      execute: ({ rootPath }) => sql`
        SELECT
          id AS "id",
          root_path AS "rootPath",
          name AS "name",
          remote_url AS "remoteUrl",
          first_seen AS "firstSeen",
          last_seen AS "lastSeen",
          updated_at AS "updatedAt",
          deleted_at AS "deletedAt"
        FROM projects
        WHERE root_path = ${rootPath}
      `,
    });

    const resolveForCwd = Effect.fn("ProjectRepository.resolveForCwd")(function* (cwd: string) {
      const repository = yield* resolver.resolve(cwd);
      if (repository === null) {
        return null;
      }

      const timestamp = yield* now;
      const id = yield* generateId;
      const remoteUrl =
        repository.originRemoteUrl === undefined || repository.originRemoteUrl.length === 0
          ? null
          : repository.originRemoteUrl;
      const candidate = yield* Project.makeEffect({
        id,
        rootPath: repository.canonicalRoot,
        name: NodePath.basename(repository.canonicalRoot),
        remoteUrl,
        firstSeen: timestamp,
        lastSeen: timestamp,
        updatedAt: timestamp,
        deletedAt: null,
      }).pipe(Effect.mapError(toRepositoryError("resolveForCwd")));

      return yield* upsertProject(candidate).pipe(
        Effect.mapError(toRepositoryError("resolveForCwd")),
      );
    });

    const findByRootPath = Effect.fn("ProjectRepository.findByRootPath")(function* (
      rootPath: string,
    ) {
      const project = yield* findProjectByRootPath({ rootPath }).pipe(
        Effect.mapError(toRepositoryError("findByRootPath")),
      );
      return Option.getOrNull(project);
    });

    return ProjectRepository.of({
      resolveForCwd,
      findByRootPath,
    });
  });

export const layerWith = (options: ProjectRepositoryOptions = {}) =>
  Layer.effect(ProjectRepository, make(options));

export const layer = layerWith();
