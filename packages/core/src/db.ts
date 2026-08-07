import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";

import * as Migrations from "./internal/migrations.ts";
import * as NodeSqliteClient from "./internal/node-sqlite-client.ts";
import * as Paths from "./paths.ts";

const busyTimeoutMilliseconds = 5_000;

export class DatabaseOpenError extends Schema.TaggedErrorClass<DatabaseOpenError>()(
  "DatabaseOpenError",
  {
    filename: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to open Dear Diary database '${this.filename}'. Check that its parent directory exists and is writable.`;
  }
}

export class DatabaseSetupError extends Schema.TaggedErrorClass<DatabaseSetupError>()(
  "DatabaseSetupError",
  {
    filename: Schema.String,
    setting: Schema.Literals(["foreign_keys", "busy_timeout", "journal_mode"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to configure SQLite setting '${this.setting}' for Dear Diary database '${this.filename}'.`;
  }
}

export class DatabaseMigrationError extends Schema.TaggedErrorClass<DatabaseMigrationError>()(
  "DatabaseMigrationError",
  {
    filename: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to migrate Dear Diary database '${this.filename}'. The database schema could not be initialized.`;
  }
}

export type DatabaseError = DatabaseOpenError | DatabaseSetupError | DatabaseMigrationError;

export interface DatabaseService {
  readonly filename: string;
  readonly sql: SqlClient.SqlClient;
}

export class Database extends Context.Service<Database, DatabaseService>()(
  "@deardiary/core/db/Database",
) {}

const withSetupError = <A, R>(
  effect: Effect.Effect<A, SqlError, R>,
  filename: string,
  setting: DatabaseSetupError["setting"],
): Effect.Effect<A, DatabaseSetupError, R> =>
  effect.pipe(
    Effect.mapError(
      (cause) =>
        new DatabaseSetupError({
          filename,
          setting,
          cause,
        }),
    ),
  );

const failSetup = (filename: string, setting: DatabaseSetupError["setting"], details: string) =>
  Effect.fail(
    new DatabaseSetupError({
      filename,
      setting,
      cause: new Error(details),
    }),
  );

const makeDatabase = Effect.fn("Database.make")(function* (filename: string) {
  const sql = yield* SqlClient.SqlClient;

  yield* withSetupError(sql`PRAGMA foreign_keys = ON`, filename, "foreign_keys");
  const foreignKeys = yield* withSetupError(
    sql<{ readonly foreign_keys: number }>`PRAGMA foreign_keys`,
    filename,
    "foreign_keys",
  );
  if (foreignKeys[0]?.foreign_keys !== 1) {
    return yield* failSetup(
      filename,
      "foreign_keys",
      "SQLite did not enable foreign key enforcement.",
    );
  }

  yield* withSetupError(sql`PRAGMA busy_timeout = 5000`, filename, "busy_timeout");
  const busyTimeout = yield* withSetupError(
    sql<{ readonly timeout: number }>`PRAGMA busy_timeout`,
    filename,
    "busy_timeout",
  );
  if (busyTimeout[0]?.timeout !== busyTimeoutMilliseconds) {
    return yield* failSetup(
      filename,
      "busy_timeout",
      `SQLite reported busy_timeout=${String(busyTimeout[0]?.timeout)} instead of ${busyTimeoutMilliseconds}.`,
    );
  }

  if (filename !== ":memory:") {
    const journalMode = yield* withSetupError(
      sql<{ readonly journal_mode: string }>`PRAGMA journal_mode = WAL`,
      filename,
      "journal_mode",
    );
    if (journalMode[0]?.journal_mode.toLowerCase() !== "wal") {
      return yield* failSetup(
        filename,
        "journal_mode",
        `SQLite reported journal_mode=${String(journalMode[0]?.journal_mode)} instead of WAL.`,
      );
    }
  }

  yield* Migrations.runMigrations.pipe(
    Effect.mapError(
      (cause) =>
        new DatabaseMigrationError({
          filename,
          cause,
        }),
    ),
    Effect.catchDefect((cause) =>
      Effect.fail(
        new DatabaseMigrationError({
          filename,
          cause,
        }),
      ),
    ),
  );

  return Database.of({ filename, sql });
});

export const layerFromFilename = (filename: string) => {
  const clientLayer = NodeSqliteClient.layer({
    filename,
    spanAttributes: {
      "db.name": filename,
    },
  }).pipe(
    Layer.catchTag("SqlError", (cause) =>
      Layer.effect(
        SqlClient.SqlClient,
        Effect.fail(
          new DatabaseOpenError({
            filename,
            cause,
          }),
        ),
      ),
    ),
  );

  return Layer.provideMerge(Layer.effect(Database, makeDatabase(filename)), clientLayer);
};

export const layerMemory = layerFromFilename(":memory:");

export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const paths = yield* Paths.Paths;
    yield* Paths.ensureDataDirectory(paths.dataDir);
    return layerFromFilename(paths.databasePath);
  }),
);
