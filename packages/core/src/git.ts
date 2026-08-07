import * as NodePath from "node:path";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

const commandTimeout = "10 seconds";
const maximumOutputBytes = 64 * 1024;
const inspectRepositoryArguments = [
  "rev-parse",
  "--show-toplevel",
  "--git-dir",
  "--git-common-dir",
] as const;
const readRepositoryConfigArguments = [
  "config",
  "--local",
  "--null",
  "--get-regexp",
  "^(core\\.bare|remote\\.origin\\.url)$",
] as const;

const GitOperation = Schema.Literals(["inspectRepository", "readRepositoryConfig"]);
export type GitOperation = typeof GitOperation.Type;

export interface RepositoryDescriptor {
  readonly workingTreeRoot: string;
  readonly canonicalRoot: string;
  readonly isLinkedWorktree: boolean;
  readonly originRemoteUrl?: string;
}

export interface GitCommandRequest {
  readonly operation: GitOperation;
  readonly cwd: string;
  readonly args: ReadonlyArray<string>;
}

export interface GitCommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

const GitCommandContextFields = {
  operation: GitOperation,
  command: Schema.String,
  cwd: Schema.String,
  args: Schema.Array(Schema.String),
};

export class GitCommandExecutionError extends Schema.TaggedErrorClass<GitCommandExecutionError>()(
  "GitCommandExecutionError",
  {
    ...GitCommandContextFields,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to execute Git operation '${this.operation}' in '${this.cwd}'.`;
  }
}

export class GitCommandExitError extends Schema.TaggedErrorClass<GitCommandExitError>()(
  "GitCommandExitError",
  {
    ...GitCommandContextFields,
    exitCode: Schema.Int,
    stdout: Schema.String,
    stderr: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Git operation '${this.operation}' exited with status ${this.exitCode} in '${this.cwd}'.`;
  }
}

export class GitProtocolError extends Schema.TaggedErrorClass<GitProtocolError>()(
  "GitProtocolError",
  {
    ...GitCommandContextFields,
    detail: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Git operation '${this.operation}' returned malformed output in '${this.cwd}': ${this.detail}`;
  }
}

export type GitResolutionError = GitCommandExecutionError | GitCommandExitError | GitProtocolError;

export class GitCommandRunner extends Context.Service<
  GitCommandRunner,
  {
    readonly run: (request: GitCommandRequest) => Effect.Effect<GitCommandResult, unknown>;
  }
>()("@deardiary/core/git/GitCommandRunner") {}

const repositoryOverrideEnvironmentKeys = [
  "GIT_CEILING_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_DIR",
  "GIT_DISCOVERY_ACROSS_FILESYSTEM",
  "GIT_WORK_TREE",
] as const;

export interface GitCommandRunnerOptions {
  readonly environment?: Readonly<NodeJS.ProcessEnv>;
}

const makeGitEnvironment = (environment: Readonly<NodeJS.ProcessEnv>): NodeJS.ProcessEnv => {
  const overrideKeys = new Set(repositoryOverrideEnvironmentKeys.map((key) => key.toLowerCase()));
  const sanitized = Object.fromEntries(
    Object.entries(environment).filter(([key]) => !overrideKeys.has(key.toLowerCase())),
  );
  return {
    ...sanitized,
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
    LANG: "C",
    LC_ALL: "C",
  };
};

interface CollectedOutput {
  readonly chunks: Array<Uint8Array<ArrayBufferLike>>;
  readonly bytes: number;
}

const collectOutput = (
  stream: Stream.Stream<Uint8Array, unknown>,
  streamName: "stdout" | "stderr",
): Effect.Effect<string, unknown> =>
  stream.pipe(
    Stream.runFoldEffect<CollectedOutput, Uint8Array<ArrayBufferLike>, unknown, never>(
      () => ({ chunks: [], bytes: 0 }),
      (state, chunk) => {
        const bytes = state.bytes + chunk.byteLength;
        if (bytes > maximumOutputBytes) {
          return Effect.fail(
            new Error(`Git ${streamName} exceeded the ${maximumOutputBytes} byte output limit.`),
          );
        }
        state.chunks.push(chunk);
        return Effect.succeed({ chunks: state.chunks, bytes });
      },
    ),
    Effect.map(({ chunks, bytes }) => Buffer.concat(chunks, bytes).toString("utf8")),
  );

const runLiveCommand = (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  environment: NodeJS.ProcessEnv,
  request: GitCommandRequest,
): Effect.Effect<GitCommandResult, unknown> =>
  Effect.gen(function* () {
    const child = yield* spawner.spawn(
      ChildProcess.make("git", request.args, {
        cwd: request.cwd,
        detached: false,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        env: environment,
      }),
    );

    const [stdout, stderr, exitCode] = yield* Effect.all(
      [
        collectOutput(child.stdout, "stdout"),
        collectOutput(child.stderr, "stderr"),
        child.exitCode,
      ],
      { concurrency: "unbounded" },
    );

    return {
      exitCode: Number(exitCode),
      stdout,
      stderr,
    } satisfies GitCommandResult;
  }).pipe(Effect.scoped, Effect.timeout(commandTimeout));

export const makeCommandRunner = (options: GitCommandRunnerOptions = {}) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const environment = makeGitEnvironment(options.environment ?? process.env);
    return GitCommandRunner.of({
      run: (request) => runLiveCommand(spawner, environment, request),
    });
  });

export const commandRunnerLayer = (options: GitCommandRunnerOptions = {}) =>
  Layer.effect(GitCommandRunner, makeCommandRunner(options));

const commandContext = (request: GitCommandRequest) => ({
  operation: request.operation,
  command: "git",
  cwd: request.cwd,
  args: [...request.args],
});

const execute = (
  runner: GitCommandRunner["Service"],
  request: GitCommandRequest,
): Effect.Effect<GitCommandResult, GitCommandExecutionError> =>
  runner.run(request).pipe(
    Effect.mapError(
      (cause) =>
        new GitCommandExecutionError({
          ...commandContext(request),
          cause,
        }),
    ),
  );

const commandExitError = (request: GitCommandRequest, result: GitCommandResult, detail: string) =>
  new GitCommandExitError({
    ...commandContext(request),
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    cause: new Error(detail),
  });

const protocolError = (
  request: GitCommandRequest,
  detail: string,
  cause: unknown = new Error(detail),
) =>
  new GitProtocolError({
    ...commandContext(request),
    detail,
    cause,
  });

interface RepositoryMetadata {
  readonly workingTreeRoot: string;
  readonly gitDir: string;
  readonly commonDir: string;
}

const splitLines = (stdout: string): ReadonlyArray<string> => {
  const lines = stdout.split("\n");
  if (lines.at(-1) === "") {
    lines.pop();
  }
  return lines.map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
};

const parseRepositoryMetadata = (
  request: GitCommandRequest,
  stdout: string,
): Effect.Effect<RepositoryMetadata, GitProtocolError> =>
  Effect.try({
    try: () => {
      const lines = splitLines(stdout);
      if (lines.length !== 3) {
        throw new Error(`expected 3 output lines, received ${lines.length}`);
      }

      const [workingTreeRootOutput, gitDirOutput, commonDirOutput] = lines;
      if (
        workingTreeRootOutput === undefined ||
        gitDirOutput === undefined ||
        commonDirOutput === undefined ||
        workingTreeRootOutput.length === 0 ||
        gitDirOutput.length === 0 ||
        commonDirOutput.length === 0
      ) {
        throw new Error("repository metadata contained an empty path");
      }
      if (
        workingTreeRootOutput.includes("\0") ||
        gitDirOutput.includes("\0") ||
        commonDirOutput.includes("\0")
      ) {
        throw new Error("repository metadata contained a NUL byte");
      }

      // rev-parse reports relative --git-dir/--git-common-dir values relative to
      // the command cwd. resolve() is lexical: it normalizes without realpath.
      return {
        workingTreeRoot: NodePath.resolve(request.cwd, workingTreeRootOutput),
        gitDir: NodePath.resolve(request.cwd, gitDirOutput),
        commonDir: NodePath.resolve(request.cwd, commonDirOutput),
      } satisfies RepositoryMetadata;
    },
    catch: (cause) =>
      protocolError(
        request,
        cause instanceof Error ? cause.message : "could not parse repository metadata",
        cause,
      ),
  });

interface RepositoryConfig {
  readonly coreBare: boolean;
  readonly originRemoteUrl?: string;
}

const parseGitBoolean = (value: string): boolean => {
  switch (value.trim().toLowerCase()) {
    case "":
    case "0":
    case "false":
    case "no":
    case "off":
      return false;
    case "1":
    case "true":
    case "yes":
    case "on":
      return true;
    default:
      throw new Error(`invalid core.bare boolean ${JSON.stringify(value)}`);
  }
};

const parseRepositoryConfig = (
  request: GitCommandRequest,
  stdout: string,
): Effect.Effect<RepositoryConfig, GitProtocolError> =>
  Effect.try({
    try: () => {
      if (!stdout.endsWith("\0")) {
        throw new Error("expected NUL-terminated config records");
      }

      const records = stdout.slice(0, -1).split("\0");
      if (records.length === 0 || records.some((record) => record.length === 0)) {
        throw new Error("config output contained an empty record");
      }

      let coreBare = false;
      let originRemoteUrl: string | undefined;
      for (const record of records) {
        const separator = record.indexOf("\n");
        if (separator <= 0) {
          throw new Error("config record did not contain a key/value separator");
        }

        const key = record.slice(0, separator);
        const value = record.slice(separator + 1);
        switch (key) {
          case "core.bare":
            coreBare = parseGitBoolean(value);
            break;
          case "remote.origin.url":
            originRemoteUrl = value.length === 0 ? undefined : value;
            break;
          default:
            throw new Error(`unexpected config key ${JSON.stringify(key)}`);
        }
      }

      return {
        coreBare,
        ...(originRemoteUrl === undefined ? {} : { originRemoteUrl }),
      } satisfies RepositoryConfig;
    },
    catch: (cause) =>
      protocolError(
        request,
        cause instanceof Error ? cause.message : "could not parse repository config",
        cause,
      ),
  });

const normalizePathForComparison = (value: string): string =>
  process.platform === "win32" ? value.toLowerCase() : value;

const samePath = (left: string, right: string): boolean =>
  normalizePathForComparison(left) === normalizePathForComparison(right);

const isLinkedWorktreeMetadata = (metadata: RepositoryMetadata): boolean =>
  !samePath(metadata.gitDir, metadata.commonDir) &&
  samePath(NodePath.dirname(metadata.gitDir), NodePath.join(metadata.commonDir, "worktrees"));

const isDotGitDirectory = (value: string): boolean =>
  process.platform === "win32"
    ? NodePath.basename(value).toLowerCase() === ".git"
    : NodePath.basename(value) === ".git";

const inferCanonicalRoot = (
  metadata: RepositoryMetadata,
  config: RepositoryConfig,
  isLinkedWorktree: boolean,
): string => {
  if (!isLinkedWorktree) {
    return metadata.workingTreeRoot;
  }

  // Standard linked worktrees keep their common directory at <main-root>/.git.
  // Bare repositories and separate/unusual common-dir layouts do not safely
  // reveal an original checkout, so conservatively retain the current worktree.
  if (!config.coreBare && isDotGitDirectory(metadata.commonDir)) {
    return NodePath.dirname(metadata.commonDir);
  }
  return metadata.workingTreeRoot;
};

const isNoWorkingTreeResult = (result: GitCommandResult): boolean => {
  const stderr = result.stderr.toLowerCase();
  return (
    stderr.includes("not a git repository") ||
    stderr.includes("this operation must be run in a work tree")
  );
};

export const resolveRepository = Effect.fn("Git.resolveRepository")(function* (
  cwd: string,
): Effect.fn.Return<RepositoryDescriptor | null, GitResolutionError, GitCommandRunner> {
  const runner = yield* GitCommandRunner;
  const normalizedCwd = NodePath.resolve(cwd);
  const inspectRequest = {
    operation: "inspectRepository",
    cwd: normalizedCwd,
    args: inspectRepositoryArguments,
  } satisfies GitCommandRequest;
  const inspectResult = yield* execute(runner, inspectRequest);

  if (inspectResult.exitCode !== 0) {
    if (isNoWorkingTreeResult(inspectResult)) {
      return null;
    }
    return yield* commandExitError(
      inspectRequest,
      inspectResult,
      "Git could not inspect repository metadata.",
    );
  }

  const metadata = yield* parseRepositoryMetadata(inspectRequest, inspectResult.stdout);
  const configRequest = {
    operation: "readRepositoryConfig",
    cwd: metadata.workingTreeRoot,
    args: readRepositoryConfigArguments,
  } satisfies GitCommandRequest;
  const fallbackConfig: RepositoryConfig = { coreBare: false };
  const config = yield* execute(runner, configRequest).pipe(
    Effect.flatMap((result) =>
      result.exitCode === 0
        ? parseRepositoryConfig(configRequest, result.stdout)
        : Effect.succeed(fallbackConfig),
    ),
    Effect.catch(() => Effect.succeed(fallbackConfig)),
  );

  const isLinkedWorktree = isLinkedWorktreeMetadata(metadata);
  return {
    workingTreeRoot: metadata.workingTreeRoot,
    canonicalRoot: inferCanonicalRoot(metadata, config, isLinkedWorktree),
    isLinkedWorktree,
    ...(config.originRemoteUrl === undefined ? {} : { originRemoteUrl: config.originRemoteUrl }),
  } satisfies RepositoryDescriptor;
});

export class RepositoryResolver extends Context.Service<
  RepositoryResolver,
  {
    readonly resolve: (
      cwd: string,
    ) => Effect.Effect<RepositoryDescriptor | null, GitResolutionError>;
  }
>()("@deardiary/core/git/RepositoryResolver") {}

export const make = Effect.gen(function* () {
  const runner = yield* GitCommandRunner;
  return RepositoryResolver.of({
    resolve: (cwd) => resolveRepository(cwd).pipe(Effect.provideService(GitCommandRunner, runner)),
  });
});

export const layer = Layer.effect(RepositoryResolver, make).pipe(
  Layer.provide(commandRunnerLayer()),
);
