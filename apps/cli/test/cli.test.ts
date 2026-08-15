import * as NodeFs from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "@effect/vitest";

import cliPackage from "../package.json" with { type: "json" };

const cliPath = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const temporaryRoots: Array<string> = [];

interface CliResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

interface CliOptions {
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly home?: string;
  readonly userHome?: string;
}

const temporaryDirectory = (prefix: string): string => {
  const path = NodeFs.mkdtempSync(NodePath.join(NodeOS.tmpdir(), prefix));
  temporaryRoots.push(path);
  return path;
};

const makeHome = (): string => NodePath.join(temporaryDirectory("deardiary-cli-"), "data");

const runCli = (args: ReadonlyArray<string>, options: CliOptions = {}): CliResult => {
  const cwd = options.cwd ?? temporaryDirectory("deardiary-cwd-");
  const home = options.home ?? makeHome();
  const userHome = options.userHome ?? temporaryDirectory("deardiary-user-home-");
  const { FORCE_COLOR: _, ...environment } = process.env;
  const result = spawnSync(process.execPath, ["--experimental-strip-types", cliPath, ...args], {
    cwd,
    encoding: "utf8",
    env: {
      ...environment,
      NO_COLOR: "1",
      DEARDIARY_HOME: home,
      HOME: userHome,
      XDG_CONFIG_HOME: NodePath.join(userHome, ".config"),
      CODEX_HOME: NodePath.join(userHome, ".codex"),
      ...options.env,
    },
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
};

const expectSuccess = (result: CliResult): void => {
  expect(result.status, result.stderr).toBe(0);
  expect(result.stderr).toBe("");
};

const parseJson = <A>(result: CliResult): A => {
  expectSuccess(result);
  return JSON.parse(result.stdout) as A;
};

const runGit = (cwd: string, args: ReadonlyArray<string>): string => {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim();
};

const makeRepository = (name: string): string => {
  const root = NodePath.join(temporaryDirectory("deardiary-repos-"), name);
  NodeFs.mkdirSync(root, { recursive: true });
  runGit(root, ["init", "--quiet"]);
  runGit(root, ["config", "user.name", "Dear Diary Tests"]);
  runGit(root, ["config", "user.email", "tests@example.invalid"]);
  NodeFs.writeFileSync(NodePath.join(root, "README.md"), `# ${name}\n`);
  runGit(root, ["add", "README.md"]);
  runGit(root, ["commit", "--quiet", "-m", "initial"]);
  return root;
};

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    NodeFs.rmSync(root, { recursive: true, force: true });
  }
});

describe("CLI surface", () => {
  it("prints help and version without opening storage, and rejects unknown commands", () => {
    const blockingPath = NodePath.join(temporaryDirectory("deardiary-blocked-help-"), "file");
    NodeFs.writeFileSync(blockingPath, "not a directory");

    const help = runCli(["--help"], { home: blockingPath });
    expectSuccess(help);
    expect(help.stdout).toContain("Usage: deardiary <command>");
    expect(help.stdout).toContain("export");

    const commandHelp = runCli(["log", "--help"], { home: blockingPath });
    expectSuccess(commandHelp);
    expect(commandHelp.stdout).toContain("Mood defaults to 'note'");
    expect(commandHelp.stdout).toContain("Use '--'");

    const version = runCli(["--version"], { home: blockingPath });
    expectSuccess(version);
    expect(version.stdout).toBe(`${cliPackage.version}\n`);

    const unknown = runCli(["wat"], { home: blockingPath });
    expect(unknown.status).toBe(2);
    expect(unknown.stdout).toBe("");
    expect(unknown.stderr).toContain("Unknown command 'wat'");
    expect(unknown.stderr).toContain("deardiary --help");

    const setupHelp = runCli(["setup", "--help"], { home: blockingPath });
    expectSuccess(setupHelp);
    expect(setupHelp.stdout).toContain("Usage: deardiary setup");
    expect(setupHelp.stdout).toContain("--guidance <scope>");
    expect(setupHelp.stdout).toContain("global (default), project, or none");
    expect(setupHelp.stdout).toContain("Restart open agent sessions");
    expect(setupHelp.stdout).toContain("Grok Build");
    expect(setupHelp.stdout).toContain("Custom path");
    expect(setupHelp.stdout).not.toContain("--print-prompt");

    const uninstallHelp = runCli(["uninstall", "--help"], { home: blockingPath });
    expectSuccess(uninstallHelp);
    expect(uninstallHelp.stdout).toContain("--guidance <global|project>");
    expect(uninstallHelp.stdout).toContain("never searches other repositories");

    const checkUserHome = temporaryDirectory("deardiary-check-home-");
    const checkBin = temporaryDirectory("deardiary-check-bin-");
    const fakeClaude = NodePath.join(checkBin, "claude");
    NodeFs.writeFileSync(fakeClaude, "#!/bin/sh\nexit 0\n");
    NodeFs.chmodSync(fakeClaude, 0o755);
    const check = runCli(["setup", "--check"], {
      home: blockingPath,
      userHome: checkUserHome,
      env: { PATH: checkBin },
    });
    expect(check.status).toBe(1);
    expect(check.stderr).toBe("");
    expect(check.stdout).toContain("MISSING Claude Code MCP");

    const mcpHelp = runCli(["mcp", "--help"], { home: blockingPath });
    expectSuccess(mcpHelp);
    expect(mcpHelp.stdout).toContain("Usage: deardiary mcp");

    const mcpFlag = runCli(["mcp", "--global"], { home: blockingPath });
    expect(mcpFlag.status).toBe(2);
    expect(mcpFlag.stderr).toContain("Unknown option '--global'");

    const failedMcp = runCli(["mcp"], { home: blockingPath });
    expect(failedMcp.status).toBe(1);
    expect(failedMcp.stdout).toBe("");
    expect(failedMcp.stderr).toContain("deardiary: Failed to create Dear Diary data directory");
    expect(failedMcp.stderr).not.toContain("at ");
  });
});

describe("global logging and querying", () => {
  it("persists across processes and applies exact filters, limits, order, and JSON", () => {
    const home = makeHome();
    const cwd = temporaryDirectory("deardiary-non-git-");

    const first = runCli(
      [
        "log",
        "--global",
        "--mood",
        "idea",
        "--model",
        "model-a",
        "--harness",
        "harness-a",
        "--tag",
        "tag-a",
        "--tag",
        "tag-shared",
        "first entry",
      ],
      { cwd, home },
    );
    expectSuccess(first);
    expect(first.stdout).toMatch(/^Logged idea entry [0-9a-f-]+\.\n$/u);

    const second = runCli(
      [
        "log",
        "--global",
        "--mood=win",
        "--model=model-b",
        "--harness=harness-b",
        "--tag=tag-b",
        "--json",
        "second entry",
      ],
      { cwd, home },
    );
    const logged = parseJson<{
      readonly body: string;
      readonly mood: string;
      readonly projectId: string | null;
      readonly tags: ReadonlyArray<string>;
    }>(second);
    expect(logged).toMatchObject({
      body: "second entry",
      mood: "win",
      projectId: null,
      tags: ["tag-b"],
    });

    const all = parseJson<ReadonlyArray<{ readonly body: string }>>(
      runCli(["read", "--global", "--oldest", "--json"], { cwd, home }),
    );
    expect(all.map((entry) => entry.body)).toEqual(["first entry", "second entry"]);

    const defaultOutsideGit = parseJson<ReadonlyArray<{ readonly body: string }>>(
      runCli(["read", "--json"], { cwd, home }),
    );
    expect(defaultOutsideGit).toHaveLength(2);

    const limited = parseJson<ReadonlyArray<{ readonly body: string }>>(
      runCli(["read", "--global", "--newest", "--limit", "1", "--json"], { cwd, home }),
    );
    expect(limited.map((entry) => entry.body)).toEqual(["second entry"]);

    for (const [flag, value, expectedBody] of [
      ["--mood", "idea", "first entry"],
      ["--model", "model-b", "second entry"],
      ["--harness", "harness-a", "first entry"],
      ["--tag", "tag-shared", "first entry"],
    ] as const) {
      const filtered = parseJson<ReadonlyArray<{ readonly body: string }>>(
        runCli(["read", "--global", flag, value, "--json"], { cwd, home }),
      );
      expect(filtered.map((entry) => entry.body)).toEqual([expectedBody]);
    }

    const sinceEpoch = parseJson<ReadonlyArray<unknown>>(
      runCli(["read", "--global", "--since", "1970-01-01T00:00:00.000Z", "--json"], {
        cwd,
        home,
      }),
    );
    expect(sinceEpoch).toHaveLength(2);
    const sinceFuture = parseJson<ReadonlyArray<unknown>>(
      runCli(["read", "--global", "--since", "2999-01-01T00:00:00.000Z", "--json"], {
        cwd,
        home,
      }),
    );
    expect(sinceFuture).toEqual([]);
  });

  it("preserves multiline Unicode prose and represents a body beginning with a dash", () => {
    const home = makeHome();
    const cwd = temporaryDirectory("deardiary-prose-");
    const prose = "First line — olá 👋\n\nSecond line";
    expectSuccess(runCli(["log", "--global", prose], { cwd, home }));
    expectSuccess(runCli(["log", "--global", "--", "--starts-with-dash"], { cwd, home }));
    const entries = parseJson<ReadonlyArray<{ readonly body: string }>>(
      runCli(["read", "--global", "--oldest", "--json"], { cwd, home }),
    );
    expect(entries.map((entry) => entry.body)).toEqual([prose, "--starts-with-dash"]);
  });
});

describe("Git project scopes", () => {
  it("selects project, global, all, explicit project, and converges linked worktrees", () => {
    const home = makeHome();
    const outside = temporaryDirectory("deardiary-outside-");
    const projectA = makeRepository("project-a");
    const projectB = makeRepository("project-b");

    expectSuccess(runCli(["log", "--global", "global entry"], { cwd: outside, home }));
    expectSuccess(runCli(["log", "project A entry"], { cwd: projectA, home }));
    expectSuccess(runCli(["log", "project B entry"], { cwd: projectB, home }));

    const projectOnly = parseJson<ReadonlyArray<{ readonly body: string }>>(
      runCli(["read", "--json"], { cwd: projectA, home }),
    );
    expect(projectOnly.map((entry) => entry.body)).toEqual(["project A entry"]);

    const globalOnly = parseJson<ReadonlyArray<{ readonly body: string }>>(
      runCli(["read", "--global", "--json"], { cwd: projectA, home }),
    );
    expect(globalOnly.map((entry) => entry.body)).toEqual(["global entry"]);

    const all = parseJson<ReadonlyArray<{ readonly body: string }>>(
      runCli(["read", "--all", "--json"], { cwd: projectA, home }),
    );
    expect(new Set(all.map((entry) => entry.body))).toEqual(
      new Set(["global entry", "project A entry", "project B entry"]),
    );

    const explicit = parseJson<ReadonlyArray<{ readonly body: string }>>(
      runCli(["read", "--project", projectB, "--json"], { cwd: outside, home }),
    );
    expect(explicit.map((entry) => entry.body)).toEqual(["project B entry"]);

    const linked = NodePath.join(temporaryDirectory("deardiary-worktree-"), "linked-a");
    runGit(projectA, ["worktree", "add", "--quiet", "-b", "linked-test", linked]);
    expectSuccess(runCli(["log", "linked A entry"], { cwd: linked, home }));
    const converged = parseJson<
      ReadonlyArray<{
        readonly body: string;
        readonly cwd: string;
        readonly projectRootPath: string | null;
      }>
    >(runCli(["read", "--oldest", "--json"], { cwd: projectA, home }));
    expect(converged.map((entry) => entry.body)).toEqual(["project A entry", "linked A entry"]);
    expect(converged).toMatchObject([
      { cwd: projectA, projectRootPath: projectA },
      { cwd: linked, projectRootPath: projectA },
    ]);
    expect(runCli(["read"], { cwd: projectA, home }).stdout).toContain(`repo: ${projectA}`);
  });
});

describe("context, stats, random, and export", () => {
  it("uses project+global context by default and broadens only with --all", () => {
    const home = makeHome();
    const outside = temporaryDirectory("deardiary-context-outside-");
    const projectA = makeRepository("context-a");
    const projectB = makeRepository("context-b");
    expectSuccess(runCli(["log", "--global", "context global"], { cwd: outside, home }));
    expectSuccess(runCli(["log", "context A"], { cwd: projectA, home }));
    expectSuccess(runCli(["log", "context B"], { cwd: projectB, home }));

    const settled = parseJson<ReadonlyArray<{ readonly body: string }>>(
      runCli(["context", "--cwd", projectA, "--oldest", "--json"], { cwd: outside, home }),
    );
    expect(settled.map((entry) => entry.body)).toEqual(["context global", "context A"]);

    const broadened = parseJson<ReadonlyArray<{ readonly body: string }>>(
      runCli(["context", "--cwd", projectA, "--all", "--json"], { cwd: outside, home }),
    );
    expect(new Set(broadened.map((entry) => entry.body))).toEqual(
      new Set(["context global", "context A", "context B"]),
    );

    const text = runCli(["context", "--cwd", projectA, "--limit", "1"], {
      cwd: outside,
      home,
    });
    expectSuccess(text);
    expect(text.stdout).toContain("Dear Diary context:");
  });

  it("renders stats, handles empty and singleton random queries, and exports Markdown", () => {
    const home = makeHome();
    const cwd = temporaryDirectory("deardiary-derived-");
    const multiline = "Export first line\n\nExport second line";
    expectSuccess(
      runCli(
        ["log", "--global", "--mood", "win", "--model", "solo", "--tag", "export", multiline],
        { cwd, home },
      ),
    );

    const stats = parseJson<{
      readonly total: number;
      readonly byMood: ReadonlyArray<{ readonly mood: string; readonly count: number }>;
    }>(runCli(["stats", "--global", "--json"], { cwd, home }));
    expect(stats.total).toBe(1);
    expect(stats.byMood).toEqual([{ mood: "win", count: 1 }]);

    const statsText = runCli(["stats", "--global"], { cwd, home });
    expectSuccess(statsText);
    expect(statsText.stdout).toContain("Total entries: 1");
    expect(statsText.stdout).toContain("WIN: 1");

    const emptyRandom = runCli(["random", "--global", "--mood", "rant", "--json"], {
      cwd,
      home,
    });
    expect(parseJson<null>(emptyRandom)).toBeNull();
    const emptyRandomText = runCli(["random", "--global", "--mood", "rant"], { cwd, home });
    expectSuccess(emptyRandomText);
    expect(emptyRandomText.stdout).toBe("No diary entries found.\n");

    const singleton = parseJson<{ readonly body: string }>(
      runCli(["random", "--global", "--model", "solo", "--json"], { cwd, home }),
    );
    expect(singleton.body).toBe(multiline);

    expectSuccess(
      runCli(["log", "--global", "--tag", "export", "later export entry"], { cwd, home }),
    );

    const markdown = runCli(["export", "--markdown", "--global", "--tag", "export"], {
      cwd,
      home,
    });
    expectSuccess(markdown);
    expect(markdown.stdout).toContain("# Dear Diary");
    expect(markdown.stdout).toContain("**Mood:** win");
    expect(markdown.stdout).toContain(multiline);
    expect(markdown.stdout.indexOf(multiline)).toBeLessThan(
      markdown.stdout.indexOf("later export entry"),
    );
  });
});

describe("argument and operational failures", () => {
  it("rejects invalid and contradictory arguments without stack traces or query broadening", () => {
    const home = makeHome();
    const cwd = temporaryDirectory("deardiary-invalid-");
    const cases: ReadonlyArray<ReadonlyArray<string>> = [
      ["log"],
      ["log", "--mood", "meh", "body"],
      ["log", "--tag", "two,tags", "body"],
      ["read", "--global", "--all"],
      ["read", "--oldest", "--newest"],
      ["read", "--limit"],
      ["read", "--limit", "0"],
      ["read", "--limit", "1.5"],
      ["read", "--since", "yesterday"],
      ["read", "unexpected"],
      ["read", "--wat"],
      ["export"],
      ["export", "--json"],
      ["setup", "--check", "--yes"],
      ["setup", "--guidance", "local"],
      ["setup", "--print-prompt"],
      ["doctor", "--wat"],
      ["bench-startup", "later"],
      ["uninstall", "--yes"],
      ["uninstall", "--level", "everything"],
      ["uninstall", "--guidance", "none"],
    ];
    for (const args of cases) {
      const result = runCli(args, { cwd, home });
      expect(result.status, `${args.join(" ")}\n${result.stderr}`).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("Try 'deardiary");
      expect(result.stderr).not.toMatch(/\n\s+at /u);
    }

    const noEntries = parseJson<ReadonlyArray<unknown>>(
      runCli(["read", "--global", "--json"], { cwd, home }),
    );
    expect(noEntries).toEqual([]);
  }, 15_000);

  it("reports non-Git project, Git execution, and storage failures actionably", () => {
    const home = makeHome();
    const outside = temporaryDirectory("deardiary-errors-");

    const nonGit = runCli(["read", "--project", outside], { cwd: outside, home });
    expect(nonGit.status).toBe(1);
    expect(nonGit.stdout).toBe("");
    expect(nonGit.stderr).toContain("is not inside a Git working tree");
    expect(nonGit.stderr).not.toMatch(/\n\s+at /u);

    const noGitExecutable = runCli(["read"], { cwd: outside, home, env: { PATH: "" } });
    expect(noGitExecutable.status).toBe(1);
    expect(noGitExecutable.stderr).toContain("Failed to execute Git operation");
    expect(noGitExecutable.stderr).not.toMatch(/\n\s+at /u);

    const projectGuidance = runCli(["setup", "--check", "--guidance", "project"], {
      cwd: outside,
      home,
    });
    expect(projectGuidance.status).toBe(1);
    expect(projectGuidance.stderr).toBe("");
    expect(projectGuidance.stdout).toContain("Project guidance requires a Git repository");
    expect(projectGuidance.stdout).not.toMatch(/\n\s+at /u);

    const blockingPath = NodePath.join(temporaryDirectory("deardiary-storage-"), "file");
    NodeFs.writeFileSync(blockingPath, "not a directory");
    const storage = runCli(["read", "--global"], {
      cwd: outside,
      home: NodePath.join(blockingPath, "data"),
    });
    expect(storage.status).toBe(1);
    expect(storage.stderr).toContain("Failed to create Dear Diary data directory");
    expect(storage.stderr).not.toMatch(/\n\s+at /u);
  });
});
