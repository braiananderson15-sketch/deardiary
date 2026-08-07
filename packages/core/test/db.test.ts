import { DatabaseSync } from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlError from "effect/unstable/sql/SqlError";

import * as Db from "../src/db.ts";
import * as Paths from "../src/paths.ts";

const timestamp = "2026-08-07T12:00:00.000Z";

const makeDatabaseFilename = Effect.fn("makeDatabaseFilename")(function* (prefix: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const tempDir = yield* fileSystem.makeTempDirectoryScoped({ prefix });
  return path.join(tempDir, "deardiary.db");
});

interface TableInfoRow {
  readonly cid: number;
  readonly name: string;
  readonly type: string;
  readonly notnull: number;
  readonly dflt_value: string | null;
  readonly pk: number;
}

const tests = it.layer(NodeServices.layer);

tests("database infrastructure", (test) => {
  test.effect("constructs from Paths, creates its data directory, and creates schema v1", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "deardiary-db-paths-",
      });
      const dataDir = path.join(tempDir, "nested", "data");
      const databasePath = path.join(dataDir, "deardiary.db");
      const paths = Paths.Paths.of({ dataDir, databasePath });
      const databaseLayer = Db.layer.pipe(Layer.provideMerge(Layer.succeed(Paths.Paths, paths)));

      yield* Effect.gen(function* () {
        const database = yield* Db.Database;
        const sql = yield* SqlClient.SqlClient;
        expect(database.filename).toBe(databasePath);
        expect(database.sql).toBe(sql);

        const tables = yield* sql<{ readonly name: string }>`
          SELECT name
          FROM sqlite_schema
          WHERE type = 'table'
          ORDER BY name
        `;
        expect(tables.map((row) => row.name)).toEqual([
          "effect_sql_migrations",
          "entries",
          "projects",
        ]);

        const indexes = yield* sql<{ readonly name: string }>`
          SELECT name
          FROM sqlite_schema
          WHERE type = 'index'
            AND name NOT LIKE 'sqlite_autoindex_%'
          ORDER BY name
        `;
        expect(indexes.map((row) => row.name)).toEqual([
          "idx_entries_mood_ts",
          "idx_entries_project_ts",
          "idx_entries_ts",
        ]);

        const projectIndex = yield* sql<{ readonly name: string }>`
          PRAGMA index_info(idx_entries_project_ts)
        `;
        const moodIndex = yield* sql<{ readonly name: string }>`
          PRAGMA index_info(idx_entries_mood_ts)
        `;
        const timestampIndex = yield* sql<{ readonly name: string }>`
          PRAGMA index_info(idx_entries_ts)
        `;
        expect(projectIndex.map((row) => row.name)).toEqual(["project_id", "ts"]);
        expect(moodIndex.map((row) => row.name)).toEqual(["mood", "ts"]);
        expect(timestampIndex.map((row) => row.name)).toEqual(["ts"]);
      }).pipe(Effect.provide(databaseLayer));

      expect((yield* fileSystem.stat(dataDir)).type).toBe("Directory");
      expect((yield* fileSystem.stat(databasePath)).type).toBe("File");
    }),
  );

  test.effect("is idempotent across reopen and preserves existing data", () =>
    Effect.gen(function* () {
      const filename = yield* makeDatabaseFilename("deardiary-db-reopen-");

      yield* Effect.gen(function* () {
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
            ${"project-reopen"},
            ${"/tmp/reopen-project"},
            ${"Reopen Project"},
            ${timestamp},
            ${timestamp},
            ${timestamp}
          )
        `;
      }).pipe(Effect.provide(Db.layerFromFilename(filename)));

      const result = yield* Effect.gen(function* () {
        const { sql } = yield* Db.Database;
        const migrations = yield* sql<{
          readonly migration_id: number;
          readonly name: string;
        }>`
          SELECT migration_id, name
          FROM effect_sql_migrations
          ORDER BY migration_id
        `;
        const projects = yield* sql<{ readonly name: string }>`
          SELECT name
          FROM projects
          WHERE id = ${"project-reopen"}
        `;
        return { migrations, projects };
      }).pipe(Effect.provide(Db.layerFromFilename(filename)));

      expect(result.migrations).toEqual([
        {
          migration_id: 1,
          name: "InitialSchema",
        },
      ]);
      expect(result.projects).toEqual([{ name: "Reopen Project" }]);
    }),
  );

  test.effect("commits successful transactions and rolls back failed transactions", () =>
    Effect.gen(function* () {
      const filename = yield* makeDatabaseFilename("deardiary-db-transactions-");

      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;

        yield* sql.withTransaction(
          sql`
            INSERT INTO projects (
              id,
              root_path,
              name,
              first_seen,
              last_seen,
              updated_at
            ) VALUES (
              ${"project-committed"},
              ${"/tmp/project-committed"},
              ${"Committed Project"},
              ${timestamp},
              ${timestamp},
              ${timestamp}
            )
          `,
        );

        const rollbackReason = new Error("force transaction rollback");
        const failure = yield* sql
          .withTransaction(
            Effect.gen(function* () {
              yield* sql`
                INSERT INTO projects (
                  id,
                  root_path,
                  name,
                  first_seen,
                  last_seen,
                  updated_at
                ) VALUES (
                  ${"project-rolled-back"},
                  ${"/tmp/project-rolled-back"},
                  ${"Rolled Back Project"},
                  ${timestamp},
                  ${timestamp},
                  ${timestamp}
                )
              `;
              return yield* Effect.fail(rollbackReason);
            }),
          )
          .pipe(Effect.flip);
        expect(failure).toBe(rollbackReason);
      }).pipe(Effect.provide(Db.layerFromFilename(filename)));

      const projects = yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        return yield* sql<{ readonly id: string }>`
          SELECT id
          FROM projects
          WHERE id IN (${"project-committed"}, ${"project-rolled-back"})
          ORDER BY id
        `;
      }).pipe(Effect.provide(Db.layerFromFilename(filename)));
      expect(projects).toEqual([{ id: "project-committed" }]);
    }),
  );

  test.effect("enables foreign keys, a finite busy timeout, and WAL for file databases", () =>
    Effect.gen(function* () {
      const filename = yield* makeDatabaseFilename("deardiary-db-pragmas-");

      const filePragmas = yield* Effect.gen(function* () {
        const { sql } = yield* Db.Database;
        const foreignKeys = yield* sql<{ readonly foreign_keys: number }>`PRAGMA foreign_keys`;
        const busyTimeout = yield* sql<{ readonly timeout: number }>`PRAGMA busy_timeout`;
        const journalMode = yield* sql<{
          readonly journal_mode: string;
        }>`PRAGMA journal_mode`;
        return {
          foreignKeys: foreignKeys[0]?.foreign_keys,
          busyTimeout: busyTimeout[0]?.timeout,
          journalMode: journalMode[0]?.journal_mode,
        };
      }).pipe(Effect.provide(Db.layerFromFilename(filename)));

      expect(filePragmas.foreignKeys).toBe(1);
      expect(filePragmas.busyTimeout).toBeGreaterThan(0);
      expect(Number.isFinite(filePragmas.busyTimeout)).toBe(true);
      expect(filePragmas.journalMode).toBe("wal");

      const memoryPragmas = yield* Effect.gen(function* () {
        const { sql } = yield* Db.Database;
        const foreignKeys = yield* sql<{ readonly foreign_keys: number }>`PRAGMA foreign_keys`;
        const journalMode = yield* sql<{
          readonly journal_mode: string;
        }>`PRAGMA journal_mode`;
        const tables = yield* sql<{ readonly name: string }>`
          SELECT name
          FROM sqlite_schema
          WHERE type = 'table' AND name IN ('projects', 'entries')
          ORDER BY name
        `;
        return {
          foreignKeys: foreignKeys[0]?.foreign_keys,
          journalMode: journalMode[0]?.journal_mode,
          tables: tables.map((row) => row.name),
        };
      }).pipe(Effect.provide(Db.layerMemory));

      expect(memoryPragmas).toEqual({
        foreignKeys: 1,
        journalMode: "memory",
        tables: ["entries", "projects"],
      });
    }),
  );

  test.effect("creates the required columns and enforces every NOT NULL column", () =>
    Effect.gen(function* () {
      const filename = yield* makeDatabaseFilename("deardiary-db-columns-");

      yield* Effect.gen(function* () {
        const { sql } = yield* Db.Database;
        const projectColumns = yield* sql<TableInfoRow>`PRAGMA table_info(projects)`;
        const entryColumns = yield* sql<TableInfoRow>`PRAGMA table_info(entries)`;

        expect(
          projectColumns.map(({ name, notnull, pk, type }) => ({ name, notnull, pk, type })),
        ).toEqual([
          { name: "id", notnull: 1, pk: 1, type: "TEXT" },
          { name: "root_path", notnull: 1, pk: 0, type: "TEXT" },
          { name: "name", notnull: 1, pk: 0, type: "TEXT" },
          { name: "remote_url", notnull: 0, pk: 0, type: "TEXT" },
          { name: "first_seen", notnull: 1, pk: 0, type: "TEXT" },
          { name: "last_seen", notnull: 1, pk: 0, type: "TEXT" },
          { name: "updated_at", notnull: 1, pk: 0, type: "TEXT" },
          { name: "deleted_at", notnull: 0, pk: 0, type: "TEXT" },
        ]);
        expect(
          entryColumns.map(({ name, notnull, pk, type }) => ({ name, notnull, pk, type })),
        ).toEqual([
          { name: "id", notnull: 1, pk: 1, type: "TEXT" },
          { name: "project_id", notnull: 0, pk: 0, type: "TEXT" },
          { name: "ts", notnull: 1, pk: 0, type: "TEXT" },
          { name: "model", notnull: 0, pk: 0, type: "TEXT" },
          { name: "harness", notnull: 0, pk: 0, type: "TEXT" },
          { name: "mood", notnull: 1, pk: 0, type: "TEXT" },
          { name: "tags", notnull: 1, pk: 0, type: "TEXT" },
          { name: "cwd", notnull: 1, pk: 0, type: "TEXT" },
          { name: "body", notnull: 1, pk: 0, type: "TEXT" },
          { name: "updated_at", notnull: 1, pk: 0, type: "TEXT" },
          { name: "deleted_at", notnull: 0, pk: 0, type: "TEXT" },
        ]);
        expect(entryColumns.find((column) => column.name === "tags")?.dflt_value).toBe("''");

        const projectRequiredColumns = [
          ["id", 0],
          ["root_path", 1],
          ["name", 2],
          ["first_seen", 4],
          ["last_seen", 5],
          ["updated_at", 6],
        ] as const;
        for (const [column, valueIndex] of projectRequiredColumns) {
          const values: Array<unknown> = [
            `project-null-${column}`,
            `/tmp/project-null-${column}`,
            "Required Project",
            null,
            timestamp,
            timestamp,
            timestamp,
            null,
          ];
          values[valueIndex] = null;
          const error = yield* Effect.flip(
            sql.unsafe(
              `INSERT INTO projects (
                id, root_path, name, remote_url,
                first_seen, last_seen, updated_at, deleted_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
              values,
            ),
          );
          expect(error.reason).toBeInstanceOf(SqlError.ConstraintError);
        }

        const entryRequiredColumns = [
          ["id", 0],
          ["ts", 2],
          ["mood", 5],
          ["tags", 6],
          ["cwd", 7],
          ["body", 8],
          ["updated_at", 9],
        ] as const;
        for (const [column, valueIndex] of entryRequiredColumns) {
          const values: Array<unknown> = [
            `entry-null-${column}`,
            null,
            timestamp,
            null,
            null,
            "note",
            "test",
            "/tmp",
            "Required entry",
            timestamp,
            null,
          ];
          values[valueIndex] = null;
          const error = yield* Effect.flip(
            sql.unsafe(
              `INSERT INTO entries (
                id, project_id, ts, model, harness, mood,
                tags, cwd, body, updated_at, deleted_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              values,
            ),
          );
          expect(error.reason).toBeInstanceOf(SqlError.ConstraintError);
        }

        yield* sql`
          INSERT INTO entries (
            id,
            ts,
            mood,
            cwd,
            body,
            updated_at
          ) VALUES (
            ${"entry-default-tags"},
            ${timestamp},
            ${"note"},
            ${"/tmp"},
            ${"Default tags"},
            ${timestamp}
          )
        `;
        const defaultTags = yield* sql<{ readonly tags: string }>`
          SELECT tags
          FROM entries
          WHERE id = ${"entry-default-tags"}
        `;
        expect(defaultTags[0]?.tags).toBe("");
      }).pipe(Effect.provide(Db.layerFromFilename(filename)));
    }),
  );

  test.effect("enforces uniqueness, mood values, and history-preserving foreign keys", () =>
    Effect.gen(function* () {
      const filename = yield* makeDatabaseFilename("deardiary-db-constraints-");

      yield* Effect.gen(function* () {
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
            ${"project-main"},
            ${"/tmp/project-main"},
            ${"Main Project"},
            ${timestamp},
            ${timestamp},
            ${timestamp}
          )
        `;

        const uniqueError = yield* Effect.flip(sql`
          INSERT INTO projects (
            id,
            root_path,
            name,
            first_seen,
            last_seen,
            updated_at
          ) VALUES (
            ${"project-duplicate-root"},
            ${"/tmp/project-main"},
            ${"Duplicate Root"},
            ${timestamp},
            ${timestamp},
            ${timestamp}
          )
        `);
        expect(uniqueError.reason).toBeInstanceOf(SqlError.UniqueViolation);

        const foreignKeyError = yield* Effect.flip(sql`
          INSERT INTO entries (
            id,
            project_id,
            ts,
            mood,
            cwd,
            body,
            updated_at
          ) VALUES (
            ${"entry-bad-project"},
            ${"missing-project"},
            ${timestamp},
            ${"note"},
            ${"/tmp"},
            ${"Bad project"},
            ${timestamp}
          )
        `);
        expect(foreignKeyError.reason).toBeInstanceOf(SqlError.ConstraintError);

        const moodError = yield* Effect.flip(sql`
          INSERT INTO entries (
            id,
            ts,
            mood,
            cwd,
            body,
            updated_at
          ) VALUES (
            ${"entry-bad-mood"},
            ${timestamp},
            ${"meh"},
            ${"/tmp"},
            ${"Bad mood"},
            ${timestamp}
          )
        `);
        expect(moodError.reason).toBeInstanceOf(SqlError.ConstraintError);

        yield* sql`
          INSERT INTO entries (
            id,
            project_id,
            ts,
            mood,
            cwd,
            body,
            updated_at
          ) VALUES (
            ${"entry-history"},
            ${"project-main"},
            ${timestamp},
            ${"win"},
            ${"/tmp/project-main"},
            ${"History survives project removal"},
            ${timestamp}
          )
        `;
        yield* sql`DELETE FROM projects WHERE id = ${"project-main"}`;

        const history = yield* sql<{
          readonly body: string;
          readonly project_id: string | null;
        }>`
          SELECT body, project_id
          FROM entries
          WHERE id = ${"entry-history"}
        `;
        expect(history).toEqual([
          {
            body: "History survives project removal",
            project_id: null,
          },
        ]);

        const foreignKeys = yield* sql<{
          readonly from: string;
          readonly on_delete: string;
          readonly table: string;
          readonly to: string;
        }>`PRAGMA foreign_key_list(entries)`;
        expect(foreignKeys).toMatchObject([
          {
            from: "project_id",
            on_delete: "SET NULL",
            table: "projects",
            to: "id",
          },
        ]);
      }).pipe(Effect.provide(Db.layerFromFilename(filename)));
    }),
  );

  test.effect("initializes safely with several concurrent instances and reopens cleanly", () =>
    Effect.gen(function* () {
      const filename = yield* makeDatabaseFilename("deardiary-db-concurrent-");
      const openAndInspect = Effect.gen(function* () {
        const { sql } = yield* Db.Database;
        const migrations = yield* sql<{ readonly count: number }>`
          SELECT COUNT(*) AS count
          FROM effect_sql_migrations
        `;
        const tables = yield* sql<{ readonly count: number }>`
          SELECT COUNT(*) AS count
          FROM sqlite_schema
          WHERE type = 'table' AND name IN ('projects', 'entries')
        `;
        return {
          migrations: migrations[0]?.count,
          tables: tables[0]?.count,
        };
      }).pipe(Effect.provide(Db.layerFromFilename(filename)));

      const concurrentResults = yield* Effect.all(
        [openAndInspect, openAndInspect, openAndInspect, openAndInspect],
        { concurrency: "unbounded" },
      );
      expect(concurrentResults).toEqual([
        { migrations: 1, tables: 2 },
        { migrations: 1, tables: 2 },
        { migrations: 1, tables: 2 },
        { migrations: 1, tables: 2 },
      ]);

      const reopened = yield* openAndInspect;
      expect(reopened).toEqual({ migrations: 1, tables: 2 });
    }),
  );

  test.effect("closes the native connection when its Effect scope exits", () =>
    Effect.gen(function* () {
      const filename = yield* makeDatabaseFilename("deardiary-db-close-");

      yield* Effect.acquireUseRelease(
        Scope.make(),
        (scope) =>
          Effect.gen(function* () {
            const context = yield* Layer.buildWithScope(Db.layerFromFilename(filename), scope);
            const database = Context.get(context, Db.Database);

            const beforeClose = yield* database.sql<{ readonly value: number }>`
              SELECT 1 AS value
            `;
            expect(beforeClose[0]?.value).toBe(1);

            yield* Scope.close(scope, Exit.void);

            const afterClose = yield* Effect.flip(database.sql`SELECT 1 AS value`);
            expect(SqlError.isSqlError(afterClose)).toBe(true);
          }),
        (scope) => Scope.close(scope, Exit.void),
      );
    }),
  );

  test.effect("maps open and migration failures to typed errors with their causes", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "deardiary-db-errors-",
      });
      const missingParentFilename = path.join(tempDir, "missing", "deardiary.db");

      const openError = yield* Layer.build(Db.layerFromFilename(missingParentFilename)).pipe(
        Effect.scoped,
        Effect.flip,
      );
      expect(openError).toBeInstanceOf(Db.DatabaseOpenError);
      expect(SqlError.isSqlError(openError.cause)).toBe(true);

      const malformedFilename = path.join(tempDir, "malformed-migrations.db");
      const nativeDatabase = new DatabaseSync(malformedFilename);
      try {
        nativeDatabase.exec(`
          CREATE TABLE effect_sql_migrations (
            migration_id INTEGER PRIMARY KEY
          )
        `);
      } finally {
        nativeDatabase.close();
      }

      const migrationError = yield* Layer.build(Db.layerFromFilename(malformedFilename)).pipe(
        Effect.scoped,
        Effect.flip,
      );
      expect(migrationError).toBeInstanceOf(Db.DatabaseMigrationError);
      expect(SqlError.isSqlError(migrationError.cause)).toBe(true);
    }),
  );
});
