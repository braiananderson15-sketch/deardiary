import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

export interface ResolvePathsInput {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly platform: NodeJS.Platform;
  readonly homeDir: string;
}

export interface ResolvedPaths {
  readonly dataDir: string;
  readonly databasePath: string;
}

export class PathNotAbsoluteError extends Schema.TaggedErrorClass<PathNotAbsoluteError>()(
  "PathNotAbsoluteError",
  {
    source: Schema.Literals(["DEARDIARY_HOME", "XDG_DATA_HOME", "APPDATA", "homeDir"]),
    value: Schema.String,
    platform: Schema.String,
  },
) {
  override get message(): string {
    return `${this.source} must be an absolute path for ${this.platform} (received ${JSON.stringify(this.value)}).`;
  }
}

export class DataDirectoryCreateError extends Schema.TaggedErrorClass<DataDirectoryCreateError>()(
  "DataDirectoryCreateError",
  {
    dataDir: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to create Dear Diary data directory '${this.dataDir}'.`;
  }
}

export const resolvePaths = Effect.fn("Paths.resolvePaths")(function* (input: ResolvePathsInput) {
  const path = input.platform === "win32" ? NodePath.win32 : NodePath.posix;
  const normalizeAbsolute = (
    source: PathNotAbsoluteError["source"],
    value: string,
  ): Effect.Effect<string, PathNotAbsoluteError> =>
    path.isAbsolute(value)
      ? Effect.succeed(path.normalize(value))
      : Effect.fail(
          new PathNotAbsoluteError({
            source,
            value,
            platform: input.platform,
          }),
        );

  const override = input.env.DEARDIARY_HOME;
  let dataDir: string;

  if (override !== undefined) {
    dataDir = yield* normalizeAbsolute("DEARDIARY_HOME", override);
  } else if (input.platform === "darwin") {
    const homeDir = yield* normalizeAbsolute("homeDir", input.homeDir);
    dataDir = path.join(homeDir, "Library", "Application Support", "deardiary");
  } else if (input.platform === "win32") {
    const appData = input.env.APPDATA;
    if (appData !== undefined && appData.length > 0) {
      const appDataDir = yield* normalizeAbsolute("APPDATA", appData);
      dataDir = path.join(appDataDir, "deardiary");
    } else {
      const homeDir = yield* normalizeAbsolute("homeDir", input.homeDir);
      // APPDATA normally points here; use the conventional roaming-data path when it is absent.
      dataDir = path.join(homeDir, "AppData", "Roaming", "deardiary");
    }
  } else {
    const xdgDataHome = input.env.XDG_DATA_HOME;
    if (xdgDataHome !== undefined && xdgDataHome.length > 0) {
      const xdgDataDir = yield* normalizeAbsolute("XDG_DATA_HOME", xdgDataHome);
      dataDir = path.join(xdgDataDir, "deardiary");
    } else {
      const homeDir = yield* normalizeAbsolute("homeDir", input.homeDir);
      dataDir = path.join(homeDir, ".local", "share", "deardiary");
    }
  }

  return {
    dataDir,
    databasePath: path.join(dataDir, "deardiary.db"),
  } satisfies ResolvedPaths;
});

export class Paths extends Context.Service<Paths, ResolvedPaths>()("@deardiary/core/paths/Paths") {}

export const make = Effect.suspend(() =>
  resolvePaths({
    env: process.env,
    platform: process.platform,
    homeDir: NodeOS.homedir(),
  }),
).pipe(Effect.map((paths) => Paths.of(paths)));

export const layer = Layer.effect(Paths, make);

export const ensureDataDirectory = Effect.fn("Paths.ensureDataDirectory")(function* (
  dataDir: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  yield* fileSystem.makeDirectory(dataDir, { recursive: true }).pipe(
    Effect.mapError(
      (cause) =>
        new DataDirectoryCreateError({
          dataDir,
          cause,
        }),
    ),
  );
});
