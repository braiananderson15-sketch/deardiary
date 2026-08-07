import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import * as Git from "../src/git.ts";

const gitRepositoryOverrideEnvironmentKeys = new Set([
  "git_ceiling_directories",
  "git_common_dir",
  "git_dir",
  "git_discovery_across_filesystem",
  "git_work_tree",
]);
const testGitEnvironment: NodeJS.ProcessEnv = {
  ...Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !gitRepositoryOverrideEnvironmentKeys.has(key.toLowerCase()),
    ),
  ),
  GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
  LANG: "C",
  LC_ALL: "C",
};

const runGit = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.try({
    try: () =>
      NodeChildProcess.execFileSync("git", ["-C", cwd, ...args], {
        encoding: "utf8",
        env: testGitEnvironment,
        stdio: ["ignore", "pipe", "pipe"],
      }),
    catch: (cause) =>
      new Error(`Git test command failed in ${JSON.stringify(cwd)}: ${args.join(" ")}`, {
        cause,
      }),
  });

const initializeRepository = Effect.fn("initializeRepository")(function* (
  root: string,
  options: { readonly commit?: boolean } = {},
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fileSystem.makeDirectory(root, { recursive: true });
  yield* runGit(root, ["init", "-b", "main"]);
  yield* runGit(root, ["config", "user.email", "deardiary-tests@example.invalid"]);
  yield* runGit(root, ["config", "user.name", "Dear Diary Tests"]);

  if (options.commit) {
    yield* fileSystem.writeFileString(path.join(root, "initial.txt"), "initial\n");
    yield* runGit(root, ["add", "initial.txt"]);
    yield* runGit(root, ["commit", "-m", "Initial commit"]);
  }
});

const resolveLive = (cwd: string) =>
  Git.resolveRepository(cwd).pipe(Effect.provide(Git.commandRunnerLayer()));

const resolveThroughService = (cwd: string) =>
  Effect.gen(function* () {
    const resolver = yield* Git.RepositoryResolver;
    return yield* resolver.resolve(cwd);
  }).pipe(Effect.provide(Git.layer));

const commandResult = (
  stdout: string,
  options: { readonly exitCode?: number; readonly stderr?: string } = {},
): Git.GitCommandResult => ({
  exitCode: options.exitCode ?? 0,
  stdout,
  stderr: options.stderr ?? "",
});

const configOutput = (options: {
  readonly coreBare: boolean;
  readonly originRemoteUrl?: string;
}): string =>
  [
    `core.bare\n${String(options.coreBare)}\0`,
    ...(options.originRemoteUrl === undefined
      ? []
      : [`remote.origin.url\n${options.originRemoteUrl}\0`]),
  ].join("");

const resolveWithRunner = (cwd: string, run: Git.GitCommandRunner["Service"]["run"]) =>
  Git.resolveRepository(cwd).pipe(
    Effect.provideService(Git.GitCommandRunner, Git.GitCommandRunner.of({ run })),
  );

const tests = it.layer(NodeServices.layer);

tests("Git repository resolution", (test) => {
  test.effect(
    "keeps an ordinary repository canonical from a nested cwd, including paths with spaces",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const tempRoot = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "deardiary-git-ordinary-",
        });
        const repositoryRoot = path.join(tempRoot, "ordinary repository with spaces");
        const nestedCwd = path.join(repositoryRoot, "packages", "core", "src");

        yield* initializeRepository(repositoryRoot);
        yield* fileSystem.makeDirectory(nestedCwd, { recursive: true });

        const repository = yield* resolveThroughService(nestedCwd);

        expect(repository).not.toBeNull();
        if (repository === null) return;
        expect(repository).toEqual({
          workingTreeRoot: path.resolve(repositoryRoot),
          canonicalRoot: path.resolve(repositoryRoot),
          isLinkedWorktree: false,
        });
        expect(repository.originRemoteUrl).toBeUndefined();
      }),
  );

  test.effect(
    "maps a real linked worktree nested cwd to the original checkout and reads origin",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const tempRoot = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "deardiary-git-linked-",
        });
        const mainRoot = path.join(tempRoot, "main repository with spaces");
        const linkedRoot = path.join(tempRoot, "linked worktree with spaces");
        const nestedCwd = path.join(linkedRoot, "packages", "core", "nested");
        const originRemoteUrl = "file:///tmp/dear diary remote.git";

        yield* initializeRepository(mainRoot, { commit: true });
        yield* runGit(mainRoot, ["remote", "add", "origin", originRemoteUrl]);
        yield* runGit(mainRoot, ["worktree", "add", "-b", "feature/linked-test", linkedRoot]);
        yield* fileSystem.makeDirectory(nestedCwd, { recursive: true });

        const repository = yield* resolveLive(nestedCwd);

        expect(repository).toEqual({
          workingTreeRoot: path.resolve(linkedRoot),
          canonicalRoot: path.resolve(mainRoot),
          isLinkedWorktree: true,
          originRemoteUrl,
        });
      }),
  );

  test.effect("returns no project for a non-git directory", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempRoot = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "deardiary-git-none-",
      });
      const cwd = path.join(tempRoot, "not a repository", "nested");
      yield* fileSystem.makeDirectory(cwd, { recursive: true });

      expect(yield* resolveLive(cwd)).toBeNull();
    }),
  );

  test.effect("ignores ambient Git repository override variables", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempRoot = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "deardiary-git-environment-",
      });
      const redirectedRoot = path.join(tempRoot, "redirect target");
      const nonGitCwd = path.join(tempRoot, "not a repository");
      yield* initializeRepository(redirectedRoot);
      yield* fileSystem.makeDirectory(nonGitCwd, { recursive: true });

      const repository = yield* Git.resolveRepository(nonGitCwd).pipe(
        Effect.provide(
          Git.commandRunnerLayer({
            environment: {
              ...testGitEnvironment,
              GIT_DIR: path.join(redirectedRoot, ".git"),
              GIT_WORK_TREE: redirectedRoot,
              GIT_COMMON_DIR: path.join(redirectedRoot, ".git"),
            },
          }),
        ),
      );

      expect(repository).toBeNull();
    }),
  );
});

describe("Git resolver command protocol", () => {
  it.effect("resolves relative metadata paths and uses at most two Git processes", () =>
    Effect.gen(function* () {
      const fixtureRoot = NodePath.resolve(NodePath.parse(process.cwd()).root, "workspace");
      const mainRoot = NodePath.join(fixtureRoot, "main repository");
      const linkedRoot = NodePath.join(fixtureRoot, "linked worktree");
      const cwd = NodePath.join(linkedRoot, "packages", "core");
      const commonDir = NodePath.join(mainRoot, ".git");
      const gitDir = NodePath.join(commonDir, "worktrees", "linked-worktree");
      const relativeCommonDir = NodePath.relative(cwd, commonDir);
      const calls: Array<Git.GitCommandRequest> = [];
      const originRemoteUrl = "file:///tmp/remote repository.git";

      const repository = yield* resolveWithRunner(cwd, (request) =>
        Effect.sync(() => {
          calls.push(request);
          return request.operation === "inspectRepository"
            ? commandResult(`${linkedRoot}\n${gitDir}\n${relativeCommonDir}\n`)
            : commandResult(configOutput({ coreBare: false, originRemoteUrl }));
        }),
      );

      expect(repository).toEqual({
        workingTreeRoot: linkedRoot,
        canonicalRoot: mainRoot,
        isLinkedWorktree: true,
        originRemoteUrl,
      });
      expect(calls).toHaveLength(2);
      expect(calls.map((call) => call.operation)).toEqual([
        "inspectRepository",
        "readRepositoryConfig",
      ]);
      expect(calls[0]?.cwd).toBe(cwd);
      expect(calls[1]?.cwd).toBe(linkedRoot);

      const nonGitCalls: Array<Git.GitCommandRequest> = [];
      const noRepository = yield* resolveWithRunner(cwd, (request) =>
        Effect.sync(() => {
          nonGitCalls.push(request);
          return commandResult("", {
            exitCode: 128,
            stderr: "fatal: not a git repository (or any parent): .git\n",
          });
        }),
      );
      expect(noRepository).toBeNull();
      expect(nonGitCalls).toHaveLength(1);
    }),
  );

  it.effect("does not infer linked worktrees from an unrelated worktrees path", () =>
    Effect.gen(function* () {
      const fixtureRoot = NodePath.resolve(NodePath.parse(process.cwd()).root, "fixture");
      const workingTreeRoot = NodePath.join(fixtureRoot, "working");
      const gitDir = NodePath.join(fixtureRoot, "cache", "worktrees", "candidate");
      const commonDir = NodePath.join(fixtureRoot, "different", "repository.git");

      const repository = yield* resolveWithRunner(workingTreeRoot, (request) =>
        Effect.succeed(
          request.operation === "inspectRepository"
            ? commandResult(`${workingTreeRoot}\n${gitDir}\n${commonDir}\n`)
            : commandResult(configOutput({ coreBare: false })),
        ),
      );

      expect(repository).toEqual({
        workingTreeRoot,
        canonicalRoot: workingTreeRoot,
        isLinkedWorktree: false,
      });
    }),
  );

  it.effect("uses the current worktree as the conservative fallback for bare layouts", () =>
    Effect.gen(function* () {
      const fixtureRoot = NodePath.resolve(NodePath.parse(process.cwd()).root, "fixture");
      const workingTreeRoot = NodePath.join(fixtureRoot, "linked");
      const commonDir = NodePath.join(fixtureRoot, ".git");
      const gitDir = NodePath.join(commonDir, "worktrees", "linked");

      const repository = yield* resolveWithRunner(workingTreeRoot, (request) =>
        Effect.succeed(
          request.operation === "inspectRepository"
            ? commandResult(`${workingTreeRoot}\n${gitDir}\n${commonDir}\n`)
            : commandResult(configOutput({ coreBare: true })),
        ),
      );

      expect(repository).toEqual({
        workingTreeRoot,
        canonicalRoot: workingTreeRoot,
        isLinkedWorktree: true,
      });
    }),
  );

  it.effect("maps malformed repository metadata to a typed protocol error", () =>
    Effect.gen(function* () {
      const cwd = NodePath.resolve("malformed-metadata");
      const error = yield* resolveWithRunner(cwd, () =>
        Effect.succeed(commandResult(`${cwd}\n${NodePath.join(cwd, ".git")}\n`)),
      ).pipe(Effect.flip);

      expect(error).toBeInstanceOf(Git.GitProtocolError);
      if (!(error instanceof Git.GitProtocolError)) return;
      expect(error).toMatchObject({
        operation: "inspectRepository",
        command: "git",
        cwd,
      });
      expect(error.args).toEqual(["rev-parse", "--show-toplevel", "--git-dir", "--git-common-dir"]);
      expect(error.cause).toBeInstanceOf(Error);
    }),
  );

  it.effect("preserves repository inspection launch failures as typed errors", () =>
    Effect.gen(function* () {
      const cwd = NodePath.resolve("inspect-launch-failure");
      const launchCause = new Error("spawn git ENOENT");
      const error = yield* resolveWithRunner(cwd, () => Effect.fail(launchCause)).pipe(Effect.flip);

      expect(error).toBeInstanceOf(Git.GitCommandExecutionError);
      if (!(error instanceof Git.GitCommandExecutionError)) return;
      expect(error).toMatchObject({
        operation: "inspectRepository",
        command: "git",
        cwd,
      });
      expect(error.cause).toBe(launchCause);
      expect(error.args).toEqual(["rev-parse", "--show-toplevel", "--git-dir", "--git-common-dir"]);
    }),
  );

  it.effect("maps genuine repository inspection exits to typed errors", () =>
    Effect.gen(function* () {
      const cwd = NodePath.resolve("inspect-exit-failure");
      const error = yield* resolveWithRunner(cwd, () =>
        Effect.succeed(
          commandResult("", {
            exitCode: 2,
            stderr: "fatal: invalid gitfile format\n",
          }),
        ),
      ).pipe(Effect.flip);

      expect(error).toBeInstanceOf(Git.GitCommandExitError);
      if (!(error instanceof Git.GitCommandExitError)) return;
      expect(error).toMatchObject({
        operation: "inspectRepository",
        command: "git",
        cwd,
        exitCode: 2,
      });
      expect(error.cause).toBeInstanceOf(Error);
    }),
  );

  it.effect("falls back when repository config output is malformed", () =>
    Effect.gen(function* () {
      const mainRoot = NodePath.resolve("malformed-config-main");
      const workingTreeRoot = NodePath.resolve("malformed-config-linked");
      const commonDir = NodePath.join(mainRoot, ".git");
      const gitDir = NodePath.join(commonDir, "worktrees", "linked");
      const repository = yield* resolveWithRunner(workingTreeRoot, (request) =>
        Effect.succeed(
          request.operation === "inspectRepository"
            ? commandResult(`${workingTreeRoot}\n${gitDir}\n${commonDir}\n`)
            : commandResult("core.bare=false\0"),
        ),
      );

      expect(repository).toEqual({
        workingTreeRoot,
        canonicalRoot: mainRoot,
        isLinkedWorktree: true,
      });
      expect(repository?.originRemoteUrl).toBeUndefined();
    }),
  );

  it.effect("falls back when repository config cannot be launched", () =>
    Effect.gen(function* () {
      const mainRoot = NodePath.resolve("config-launch-main");
      const workingTreeRoot = NodePath.resolve("config-launch-linked");
      const commonDir = NodePath.join(mainRoot, ".git");
      const gitDir = NodePath.join(commonDir, "worktrees", "linked");
      const launchCause = new Error("spawn git ENOENT");
      const repository = yield* resolveWithRunner(workingTreeRoot, (request) =>
        request.operation === "inspectRepository"
          ? Effect.succeed(commandResult(`${workingTreeRoot}\n${gitDir}\n${commonDir}\n`))
          : Effect.fail(launchCause),
      );

      expect(repository).toEqual({
        workingTreeRoot,
        canonicalRoot: mainRoot,
        isLinkedWorktree: true,
      });
      expect(repository?.originRemoteUrl).toBeUndefined();
    }),
  );

  it.effect("falls back when repository config exits non-zero", () =>
    Effect.gen(function* () {
      const mainRoot = NodePath.resolve("config-exit-main");
      const workingTreeRoot = NodePath.resolve("config-exit-linked");
      const commonDir = NodePath.join(mainRoot, ".git");
      const gitDir = NodePath.join(commonDir, "worktrees", "linked");
      const repository = yield* resolveWithRunner(workingTreeRoot, (request) =>
        Effect.succeed(
          request.operation === "inspectRepository"
            ? commandResult(`${workingTreeRoot}\n${gitDir}\n${commonDir}\n`)
            : commandResult("", {
                exitCode: 2,
                stderr: "fatal: bad config line 1 in file .git/config\n",
              }),
        ),
      );

      expect(repository).toEqual({
        workingTreeRoot,
        canonicalRoot: mainRoot,
        isLinkedWorktree: true,
      });
      expect(repository?.originRemoteUrl).toBeUndefined();
    }),
  );
});
