import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";

import * as Paths from "../src/paths.ts";

const unixInput = (
  env: Readonly<Record<string, string | undefined>> = {},
): Paths.ResolvePathsInput => ({
  env,
  platform: "linux",
  homeDir: "/home/tester",
});

describe("resolvePaths", () => {
  it.effect("gives DEARDIARY_HOME precedence over every platform default", () =>
    Effect.gen(function* () {
      const resolved = yield* Paths.resolvePaths({
        env: {
          DEARDIARY_HOME: "/var/lib/deardiary-custom",
          XDG_DATA_HOME: "relative-xdg-is-ignored",
          APPDATA: "relative-appdata-is-ignored",
        },
        platform: "linux",
        homeDir: "relative-home-is-ignored",
      });

      expect(resolved).toEqual({
        dataDir: "/var/lib/deardiary-custom",
        databasePath: "/var/lib/deardiary-custom/deardiary.db",
      });
    }),
  );

  it.effect("rejects a relative DEARDIARY_HOME with a typed error", () =>
    Effect.gen(function* () {
      const error = yield* Paths.resolvePaths(
        unixInput({ DEARDIARY_HOME: "relative/deardiary" }),
      ).pipe(Effect.flip);

      expect(error).toBeInstanceOf(Paths.PathNotAbsoluteError);
      expect(error).toMatchObject({
        source: "DEARDIARY_HOME",
        value: "relative/deardiary",
        platform: "linux",
      });
    }),
  );

  it.effect("uses XDG_DATA_HOME on Unix when it is set", () =>
    Effect.gen(function* () {
      const resolved = yield* Paths.resolvePaths(unixInput({ XDG_DATA_HOME: "/data/xdg" }));

      expect(resolved).toEqual({
        dataDir: "/data/xdg/deardiary",
        databasePath: "/data/xdg/deardiary/deardiary.db",
      });
    }),
  );

  it.effect("falls back to the home data directory when XDG_DATA_HOME is unset or empty", () =>
    Effect.gen(function* () {
      const unset = yield* Paths.resolvePaths(unixInput());
      const empty = yield* Paths.resolvePaths(unixInput({ XDG_DATA_HOME: "" }));
      const expected = {
        dataDir: "/home/tester/.local/share/deardiary",
        databasePath: "/home/tester/.local/share/deardiary/deardiary.db",
      };

      expect(unset).toEqual(expected);
      expect(empty).toEqual(expected);
    }),
  );

  it.effect("uses Application Support on macOS", () =>
    Effect.gen(function* () {
      const resolved = yield* Paths.resolvePaths({
        env: {},
        platform: "darwin",
        homeDir: "/Users/tester",
      });

      expect(resolved).toEqual({
        dataDir: "/Users/tester/Library/Application Support/deardiary",
        databasePath: "/Users/tester/Library/Application Support/deardiary/deardiary.db",
      });
    }),
  );

  it.effect("uses APPDATA on Windows", () =>
    Effect.gen(function* () {
      const resolved = yield* Paths.resolvePaths({
        env: { APPDATA: String.raw`C:\Users\tester\AppData\Roaming` },
        platform: "win32",
        homeDir: String.raw`C:\Users\tester`,
      });

      expect(resolved).toEqual({
        dataDir: String.raw`C:\Users\tester\AppData\Roaming\deardiary`,
        databasePath: String.raw`C:\Users\tester\AppData\Roaming\deardiary\deardiary.db`,
      });
    }),
  );

  it.effect("falls back to the conventional roaming-data directory when APPDATA is absent", () =>
    Effect.gen(function* () {
      const resolved = yield* Paths.resolvePaths({
        env: {},
        platform: "win32",
        homeDir: String.raw`C:\Users\tester`,
      });

      expect(resolved).toEqual({
        dataDir: String.raw`C:\Users\tester\AppData\Roaming\deardiary`,
        databasePath: String.raw`C:\Users\tester\AppData\Roaming\deardiary\deardiary.db`,
      });
    }),
  );

  it.effect("normalizes the data directory before deriving the database path", () =>
    Effect.gen(function* () {
      const resolved = yield* Paths.resolvePaths(
        unixInput({ DEARDIARY_HOME: "/srv/deardiary/../journal/" }),
      );

      expect(resolved).toEqual({
        dataDir: "/srv/journal/",
        databasePath: "/srv/journal/deardiary.db",
      });
    }),
  );

  it.effect("rejects other relative path bases with the same typed error", () =>
    Effect.gen(function* () {
      const cases: ReadonlyArray<Paths.ResolvePathsInput> = [
        unixInput({ XDG_DATA_HOME: "relative-xdg" }),
        {
          env: { APPDATA: "relative-appdata" },
          platform: "win32",
          homeDir: String.raw`C:\Users\tester`,
        },
        { env: {}, platform: "darwin", homeDir: "relative-home" },
      ];

      for (const input of cases) {
        const error = yield* Paths.resolvePaths(input).pipe(Effect.flip);
        expect(error).toBeInstanceOf(Paths.PathNotAbsoluteError);
      }
    }),
  );
});

it.layer(NodeServices.layer)("ensureDataDirectory", (test) => {
  test.effect("creates nested directories and is idempotent", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "deardiary-paths-",
      });
      const dataDir = path.join(tempDir, "nested", "data");

      yield* Paths.ensureDataDirectory(dataDir);
      yield* Paths.ensureDataDirectory(dataDir);

      const stat = yield* fileSystem.stat(dataDir);
      expect(stat.type).toBe("Directory");
    }),
  );

  test.effect("maps mkdir failures to DataDirectoryCreateError", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "deardiary-paths-failure-",
      });
      const blockingFile = path.join(tempDir, "not-a-directory");
      const dataDir = path.join(blockingFile, "data");
      yield* fileSystem.writeFileString(blockingFile, "block mkdir");

      const error = yield* Paths.ensureDataDirectory(dataDir).pipe(Effect.flip);

      expect(error).toBeInstanceOf(Paths.DataDirectoryCreateError);
      expect(error.dataDir).toBe(dataDir);
      expect(error.cause).toBeInstanceOf(PlatformError.PlatformError);
    }),
  );
});
