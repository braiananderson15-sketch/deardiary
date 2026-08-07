import * as Effect from "effect/Effect";
import * as Migrator from "effect/unstable/sql/Migrator";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const schemaV1 = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY NOT NULL,
      root_path TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      remote_url TEXT,
      first_seen TEXT NOT NULL,
      last_seen TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS entries (
      id TEXT PRIMARY KEY NOT NULL,
      project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
      ts TEXT NOT NULL,
      model TEXT,
      harness TEXT,
      mood TEXT NOT NULL CHECK (mood IN ('struggled', 'win', 'note', 'idea', 'rant')),
      tags TEXT NOT NULL DEFAULT '',
      cwd TEXT NOT NULL,
      body TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_entries_project_ts
    ON entries(project_id, ts)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_entries_mood_ts
    ON entries(mood, ts)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_entries_ts
    ON entries(ts)
  `;
});

const migrate = Migrator.make({});

export const runMigrations = migrate({
  loader: Migrator.fromRecord({
    "1_InitialSchema": schemaV1,
  }),
});
