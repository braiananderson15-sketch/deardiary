import * as NodeChildProcess from "node:child_process";
import * as NodeFs from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "@effect/vitest";

import {
  benchStartup,
  checkSetup,
  type DetectedHarnesses,
  doctor,
  fullWipeConfirmation,
  type LifecyclePaths,
  resolveLifecyclePaths,
  setup,
  uninstall,
} from "../src/lifecycle.ts";

const skillPath = fileURLToPath(new URL("../skill/SKILL.md", import.meta.url));
const skillSource = NodeFs.readFileSync(skillPath, "utf8");
const temporaryRoots: Array<string> = [];
const allHarnesses: DetectedHarnesses = { claude: true, codex: true, openCode: true };

const temporaryDirectory = (): string => {
  const path = NodeFs.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "deardiary-lifecycle-"));
  temporaryRoots.push(path);
  return path;
};

const makePaths = (): LifecyclePaths => {
  const root = temporaryDirectory();
  const home = NodePath.join(root, "home");
  const config = NodePath.join(root, "config");
  const data = NodePath.join(root, "data");
  NodeFs.mkdirSync(home, { recursive: true });
  return resolveLifecyclePaths({
    homeDir: home,
    env: {
      HOME: home,
      XDG_CONFIG_HOME: config,
      CODEX_HOME: NodePath.join(root, "codex"),
      DEARDIARY_HOME: data,
    },
    platform: "linux",
  });
};

const write = (path: string, content: string): void => {
  NodeFs.mkdirSync(NodePath.dirname(path), { recursive: true });
  NodeFs.writeFileSync(path, content);
};

const gitProject = (): string => {
  const root = temporaryDirectory();
  NodeChildProcess.execFileSync("git", ["init", "--quiet", root]);
  return root;
};

const readJson = (path: string): Record<string, any> =>
  JSON.parse(NodeFs.readFileSync(path, "utf8")) as Record<string, any>;

const install = async (
  paths: LifecyclePaths,
  harnesses: DetectedHarnesses = allHarnesses,
): Promise<void> => {
  const result = await setup({
    paths,
    skillSource,
    yes: true,
    confirm: async () => {
      throw new Error("confirmation should not be requested");
    },
    harnesses,
  });
  expect(result.exitCode, result.output).toBe(0);
};

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    NodeFs.rmSync(root, { recursive: true, force: true });
  }
});

describe("setup lifecycle", () => {
  it("previews before confirmation and declining creates no files or backups", async () => {
    const paths = makePaths();
    let question = "";
    const result = await setup({
      paths,
      skillSource,
      yes: false,
      confirm: async (value) => {
        question = value;
        expect(NodeFs.existsSync(paths.claudeConfig)).toBe(false);
        expect(NodeFs.existsSync(paths.claudeSkill)).toBe(false);
        return "no";
      },
      harnesses: allHarnesses,
    });

    expect(result).toEqual({ exitCode: 0, output: "Setup cancelled; no files changed." });
    expect(question).toContain("Setup preview (global user configuration)");
    expect(question).toContain(`CREATE ${paths.claudeConfig}`);
    expect(question).toContain("MCP command: npx -y @p4cs/deardiary@latest mcp");
    expect(question).toContain("- deardiary entry: absent");
    expect(question).toContain('+ command: "npx"; args: ["-y", "@p4cs/deardiary@latest", "mcp"]');
    expect(question).toContain("- skill copy: absent");
    expect(question).toContain("+ skill copy: canonical apps/cli/skill/SKILL.md");
    expect(NodeFs.existsSync(paths.homeDir)).toBe(true);
    expect(NodeFs.readdirSync(paths.homeDir)).toEqual([]);
  });

  it("preserves unrelated config, copies skills, and creates non-clobbering backups", async () => {
    const paths = makePaths();
    const claudeOriginal = `${JSON.stringify({ theme: "dark", mcpServers: { other: { command: "other" } } }, null, 2)}\n`;
    const codexOriginal = `model = "gpt-test"\n\n[mcp_servers.old]\ncommand = "old"\n`;
    const openCodeOriginal = `${JSON.stringify({ autoupdate: false, mcp: { other: { type: "local", command: ["other"], enabled: true } } }, null, 2)}\n`;
    write(paths.claudeConfig, claudeOriginal);
    write(paths.codexConfig, codexOriginal);
    write(paths.openCodeConfig, openCodeOriginal);
    write(paths.claudeSkill, "old Dear Diary skill");
    write(`${paths.claudeConfig}.bak`, "older backup");

    const result = await setup({
      paths,
      skillSource,
      yes: true,
      confirm: async () => "no",
      harnesses: allHarnesses,
    });

    expect(result.exitCode, result.output).toBe(0);
    expect(result.output).toContain("run 'npx -y @p4cs/deardiary@latest doctor'");
    expect(result.output).toContain(`backup: ${paths.claudeConfig}.bak.1`);
    expect(NodeFs.readFileSync(`${paths.claudeConfig}.bak`, "utf8")).toBe("older backup");
    expect(NodeFs.readFileSync(`${paths.claudeConfig}.bak.1`, "utf8")).toBe(claudeOriginal);
    expect(NodeFs.readFileSync(`${paths.codexConfig}.bak`, "utf8")).toBe(codexOriginal);
    expect(NodeFs.readFileSync(`${paths.openCodeConfig}.bak`, "utf8")).toBe(openCodeOriginal);
    expect(NodeFs.readFileSync(`${paths.claudeSkill}.bak`, "utf8")).toBe("old Dear Diary skill");

    const claude = readJson(paths.claudeConfig);
    expect(claude.theme).toBe("dark");
    expect(claude.mcpServers.other).toEqual({ command: "other" });
    expect(claude.mcpServers.deardiary).toEqual({
      type: "stdio",
      command: "npx",
      args: ["-y", "@p4cs/deardiary@latest", "mcp"],
      env: {},
    });
    const codex = NodeFs.readFileSync(paths.codexConfig, "utf8");
    expect(codex).toContain('model = "gpt-test"');
    expect(codex).toContain("[mcp_servers.old]");
    expect(codex).toContain("[mcp_servers.deardiary]");
    expect(codex).toContain('command = "npx"');
    expect(codex).toContain('args = ["-y", "@p4cs/deardiary@latest", "mcp"]');
    expect(codex).toContain("startup_timeout_sec = 30");
    const openCode = readJson(paths.openCodeConfig);
    expect(openCode.autoupdate).toBe(false);
    expect(openCode.mcp.other.command).toEqual(["other"]);
    expect(openCode.mcp.deardiary).toEqual({
      type: "local",
      command: ["npx", "-y", "@p4cs/deardiary@latest", "mcp"],
      enabled: true,
    });
    expect(NodeFs.readFileSync(paths.claudeSkill, "utf8")).toBe(skillSource);
    expect(NodeFs.readFileSync(paths.agentsSkill, "utf8")).toBe(skillSource);

    expect(checkSetup(paths, skillSource, allHarnesses).exitCode).toBe(0);
    write(paths.agentsSkill, `${skillSource}\nold version`);
    const drift = checkSetup(paths, skillSource, allHarnesses);
    expect(drift.exitCode).toBe(1);
    expect(drift.output).toContain(`DRIFTED shared agents skill: ${paths.agentsSkill}`);
  });

  it("preserves an existing OpenCode v2 shape and blocks all writes on invalid config", async () => {
    const paths = makePaths();
    write(
      paths.openCodeConfig,
      `${JSON.stringify({ mcp: { timeout: { startup: 1000 }, servers: { other: { type: "local", command: ["other"] } } } }, null, 2)}\n`,
    );
    await install(paths);
    const openCode = readJson(paths.openCodeConfig);
    expect(openCode.mcp.timeout).toEqual({ startup: 1000 });
    expect(openCode.mcp.servers.other.command).toEqual(["other"]);
    expect(openCode.mcp.servers.deardiary).toEqual({
      type: "local",
      command: ["npx", "-y", "@p4cs/deardiary@latest", "mcp"],
    });
    expect(openCode.mcp.deardiary).toBeUndefined();

    const invalidPaths = makePaths();
    write(invalidPaths.claudeConfig, "{ invalid json");
    const failed = await setup({
      paths: invalidPaths,
      skillSource,
      yes: true,
      confirm: async () => "yes",
      harnesses: allHarnesses,
    });
    expect(failed.exitCode).toBe(1);
    expect(failed.output).toContain("failed before making changes");
    expect(NodeFs.existsSync(invalidPaths.codexConfig)).toBe(false);
    expect(NodeFs.existsSync(invalidPaths.claudeSkill)).toBe(false);
    expect(NodeFs.existsSync(`${invalidPaths.claudeConfig}.bak`)).toBe(false);
  });

  it("configures only detected harnesses while always installing both skill copies", async () => {
    const paths = makePaths();
    await install(paths, { claude: false, codex: true, openCode: false });

    expect(NodeFs.existsSync(paths.claudeConfig)).toBe(false);
    expect(NodeFs.existsSync(paths.codexConfig)).toBe(true);
    expect(NodeFs.existsSync(paths.openCodeConfig)).toBe(false);
    expect(NodeFs.existsSync(paths.claudeGuidance)).toBe(false);
    expect(NodeFs.existsSync(paths.codexGuidance)).toBe(true);
    expect(NodeFs.readFileSync(paths.claudeSkill, "utf8")).toBe(skillSource);
    expect(NodeFs.readFileSync(paths.agentsSkill, "utf8")).toBe(skillSource);
    const check = checkSetup(paths, skillSource, {
      claude: false,
      codex: true,
      openCode: false,
    });
    expect(check.exitCode).toBe(0);
    expect(check.output).toContain("SKIPPED Claude Code MCP: harness not detected");
    expect(check.output).toContain("CURRENT Codex MCP");
  });

  it("repairs required fields while preserving per-entry options and Codex subtables", async () => {
    const paths = makePaths();
    write(
      paths.claudeConfig,
      `${JSON.stringify({ mcpServers: { deardiary: { type: "stdio", command: "old", args: [], env: { DEARDIARY_HOME: "/custom" }, alwaysLoad: true } } }, null, 2)}\n`,
    );
    write(
      paths.codexConfig,
      `[mcp_servers.deardiary]\ncommand = "old"\nargs = ["serve"]\nenabled = false\nstartup_timeout_sec = 20\n\n[mcp_servers.deardiary.env]\nDEARDIARY_HOME = "/custom"\n\n[other]\nkeep = true\n`,
    );
    write(
      paths.openCodeConfig,
      `${JSON.stringify({ mcp: { servers: { deardiary: { type: "local", command: ["old"], disabled: true, codemode: false, timeout: { startup: 9000 }, environment: { DEARDIARY_HOME: "/custom" } } } } }, null, 2)}\n`,
    );

    await install(paths);

    expect(readJson(paths.claudeConfig).mcpServers.deardiary).toEqual({
      type: "stdio",
      command: "npx",
      args: ["-y", "@p4cs/deardiary@latest", "mcp"],
      env: { DEARDIARY_HOME: "/custom" },
      alwaysLoad: true,
    });
    const codex = NodeFs.readFileSync(paths.codexConfig, "utf8");
    expect(codex).toContain('command = "npx"');
    expect(codex).toContain('args = ["-y", "@p4cs/deardiary@latest", "mcp"]');
    expect(codex).toContain("enabled = true");
    expect(codex).toContain("startup_timeout_sec = 20");
    expect(codex).toContain("[mcp_servers.deardiary.env]");
    expect(codex).toContain('DEARDIARY_HOME = "/custom"');
    expect(codex).toContain("[other]");
    const openCode = readJson(paths.openCodeConfig).mcp.servers.deardiary;
    expect(openCode).toEqual({
      type: "local",
      command: ["npx", "-y", "@p4cs/deardiary@latest", "mcp"],
      disabled: false,
      codemode: false,
      timeout: { startup: 9000 },
      environment: { DEARDIARY_HOME: "/custom" },
    });
  });

  it("repairs legacy unscoped package launchers and a missing Codex startup timeout", async () => {
    const paths = makePaths();
    write(
      paths.claudeConfig,
      `${JSON.stringify({ mcpServers: { deardiary: { type: "stdio", command: "npx", args: ["-y", "deardiary", "mcp"], env: {} } } }, null, 2)}\n`,
    );
    write(
      paths.codexConfig,
      `[mcp_servers.deardiary]\ncommand = "npx"\nargs = ["-y", "deardiary", "mcp"]\n`,
    );
    write(
      paths.openCodeConfig,
      `${JSON.stringify({ mcp: { deardiary: { type: "local", command: ["npx", "-y", "deardiary", "mcp"], enabled: true } } }, null, 2)}\n`,
    );

    const drift = checkSetup(paths, skillSource, allHarnesses);
    expect(drift.exitCode).toBe(1);
    expect(drift.output).toContain("DRIFTED Claude Code MCP");
    expect(drift.output).toContain("DRIFTED Codex MCP");
    expect(drift.output).toContain("DRIFTED OpenCode MCP");
    await install(paths);

    expect(readJson(paths.claudeConfig).mcpServers.deardiary).toMatchObject({
      command: "npx",
      args: ["-y", "@p4cs/deardiary@latest", "mcp"],
    });
    const codex = NodeFs.readFileSync(paths.codexConfig, "utf8");
    expect(codex).toContain('command = "npx"');
    expect(codex).toContain('args = ["-y", "@p4cs/deardiary@latest", "mcp"]');
    expect(codex).toContain("startup_timeout_sec = 30");
    expect(readJson(paths.openCodeConfig).mcp.deardiary.command).toEqual([
      "npx",
      "-y",
      "@p4cs/deardiary@latest",
      "mcp",
    ]);
    expect(checkSetup(paths, skillSource, allHarnesses).exitCode).toBe(0);
  });

  it("repairs untagged scoped package launchers to the latest release", async () => {
    const paths = makePaths();
    write(
      paths.claudeConfig,
      `${JSON.stringify({ mcpServers: { deardiary: { type: "stdio", command: "npx", args: ["-y", "@p4cs/deardiary", "mcp"], env: {} } } }, null, 2)}\n`,
    );
    write(
      paths.codexConfig,
      `[mcp_servers.deardiary]\ncommand = "npx"\nargs = ["-y", "@p4cs/deardiary", "mcp"]\nstartup_timeout_sec = 30\n`,
    );
    write(
      paths.openCodeConfig,
      `${JSON.stringify({ mcp: { deardiary: { type: "local", command: ["npx", "-y", "@p4cs/deardiary", "mcp"], enabled: true } } }, null, 2)}\n`,
    );

    const drift = checkSetup(paths, skillSource, allHarnesses);
    expect(drift.exitCode).toBe(1);
    expect(drift.output).toContain("DRIFTED Claude Code MCP");
    expect(drift.output).toContain("DRIFTED Codex MCP");
    expect(drift.output).toContain("DRIFTED OpenCode MCP");

    await install(paths);

    expect(readJson(paths.claudeConfig).mcpServers.deardiary).toMatchObject({
      command: "npx",
      args: ["-y", "@p4cs/deardiary@latest", "mcp"],
    });
    expect(NodeFs.readFileSync(paths.codexConfig, "utf8")).toContain(
      'args = ["-y", "@p4cs/deardiary@latest", "mcp"]',
    );
    expect(readJson(paths.openCodeConfig).mcp.deardiary.command).toEqual([
      "npx",
      "-y",
      "@p4cs/deardiary@latest",
      "mcp",
    ]);
    expect(checkSetup(paths, skillSource, allHarnesses).exitCode).toBe(0);
  });

  it("accepts direct launchers as a globally installed fast path", async () => {
    const paths = makePaths();
    await install(paths);
    const claude = readJson(paths.claudeConfig);
    claude.mcpServers.deardiary.command = "deardiary";
    claude.mcpServers.deardiary.args = ["mcp"];
    write(paths.claudeConfig, `${JSON.stringify(claude, null, 2)}\n`);
    write(paths.codexConfig, `[mcp_servers.deardiary]\ncommand = "deardiary"\nargs = ["mcp"]\n`);
    const openCode = readJson(paths.openCodeConfig);
    openCode.mcp.deardiary.command = ["deardiary", "mcp"];
    write(paths.openCodeConfig, `${JSON.stringify(openCode, null, 2)}\n`);

    const check = checkSetup(paths, skillSource, allHarnesses);
    expect(check.exitCode, check.output).toBe(0);
    expect(check.output).toContain("CURRENT Claude Code MCP");
    expect(check.output).toContain("CURRENT Codex MCP");
    expect(check.output).toContain("CURRENT OpenCode MCP");
  });
});

describe("managed passive guidance", () => {
  it("installs global harness guidance, preserves surrounding bytes and modes, and is idempotent", async () => {
    const paths = makePaths();
    const codexOriginal = "# Personal Codex policy\n";
    const overrideOriginal = "# Active override\n";
    const claudeOriginal = "# Personal Claude policy\n";
    write(paths.codexGuidance, codexOriginal);
    write(paths.codexGuidanceOverride, overrideOriginal);
    write(paths.claudeGuidance, claudeOriginal);
    NodeFs.chmodSync(paths.codexGuidance, 0o640);

    const missing = checkSetup(paths, skillSource, allHarnesses);
    expect(missing.output).toContain(`MISSING Codex global guidance: ${paths.codexGuidance}`);

    await install(paths);

    const codex = NodeFs.readFileSync(paths.codexGuidance, "utf8");
    const override = NodeFs.readFileSync(paths.codexGuidanceOverride, "utf8");
    const claude = NodeFs.readFileSync(paths.claudeGuidance, "utf8");
    expect(codex.startsWith(`${codexOriginal}\n<!-- deardiary:start -->\n\n`)).toBe(true);
    expect(override.startsWith(`${overrideOriginal}\n<!-- deardiary:start -->\n\n`)).toBe(true);
    expect(claude.startsWith(`${claudeOriginal}\n<!-- deardiary:start -->\n\n`)).toBe(true);
    expect(codex).toContain("invoke `$deardiary` at the next natural pause");
    expect(override).toContain("invoke `$deardiary` at the next natural pause");
    expect(claude).toContain("invoke `/deardiary` at the next natural pause");
    expect(codex).toContain("blocker that cost meaningful effort");
    expect(codex).toContain("a reusable win");
    expect(codex).toContain("an actionable observation worth carrying forward");
    expect(codex).toContain("when the user asks to recall diary history");
    expect(codex.match(/<!-- deardiary:start -->/gu)).toHaveLength(1);
    expect(NodeFs.statSync(paths.codexGuidance).mode & 0o777).toBe(0o640);
    expect(NodeFs.readFileSync(`${paths.codexGuidance}.bak`, "utf8")).toBe(codexOriginal);
    expect(NodeFs.readFileSync(`${paths.codexGuidanceOverride}.bak`, "utf8")).toBe(
      overrideOriginal,
    );
    expect(NodeFs.readFileSync(`${paths.claudeGuidance}.bak`, "utf8")).toBe(claudeOriginal);

    const check = checkSetup(paths, skillSource, allHarnesses);
    expect(check.exitCode, check.output).toBe(0);
    expect(check.output).toContain(`CURRENT Codex global guidance: ${paths.codexGuidance}`);
    expect(check.output).toContain(
      `CURRENT Codex global override guidance: ${paths.codexGuidanceOverride}`,
    );
    expect(check.output).toContain(`CURRENT Claude Code global guidance: ${paths.claudeGuidance}`);

    const second = await setup({
      paths,
      skillSource,
      yes: true,
      confirm: async () => "no",
      harnesses: allHarnesses,
    });
    expect(second.exitCode, second.output).toBe(0);
    expect(second.output).toContain("Dear Diary setup is already current.");
    expect(NodeFs.existsSync(`${paths.codexGuidance}.bak.1`)).toBe(false);
  });

  it("preserves symlinked guidance files through setup and uninstall", async () => {
    const paths = makePaths();
    const target = NodePath.join(temporaryDirectory(), "dotfiles", "AGENTS.md");
    const original = "# Symlinked policy\n";
    write(target, original);
    NodeFs.mkdirSync(NodePath.dirname(paths.codexGuidance), { recursive: true });
    NodeFs.symlinkSync(target, paths.codexGuidance);

    await install(paths, { claude: false, codex: true, openCode: false });

    expect(NodeFs.lstatSync(paths.codexGuidance).isSymbolicLink()).toBe(true);
    expect(NodeFs.readFileSync(target, "utf8")).toContain("`$deardiary`");

    const removed = await uninstall({
      paths,
      level: "integrations",
      yes: true,
      confirm: async () => "no",
      guidance: "global",
    });
    expect(removed.exitCode, removed.output).toBe(0);
    expect(NodeFs.lstatSync(paths.codexGuidance).isSymbolicLink()).toBe(true);
    expect(NodeFs.readFileSync(target, "utf8")).toBe(original);
  });

  it("rejects a dangling guidance symlink before making any planned write", async () => {
    const paths = makePaths();
    NodeFs.mkdirSync(NodePath.dirname(paths.codexGuidance), { recursive: true });
    NodeFs.symlinkSync(
      NodePath.join(temporaryDirectory(), "missing-AGENTS.md"),
      paths.codexGuidance,
    );

    const result = await setup({
      paths,
      skillSource,
      yes: true,
      confirm: async () => "yes",
      harnesses: allHarnesses,
    });

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("dangling symlink");
    expect(NodeFs.existsSync(paths.claudeConfig)).toBe(false);
    expect(NodeFs.existsSync(paths.claudeSkill)).toBe(false);
  });

  it("aborts without writes when a file changes after the interactive preview", async () => {
    const paths = makePaths();
    write(paths.codexGuidance, "# Original policy\n");

    const result = await setup({
      paths,
      skillSource,
      yes: false,
      confirm: async () => {
        write(paths.codexGuidance, "# Concurrent edit\n");
        return "yes";
      },
      harnesses: allHarnesses,
    });

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("changed after the preview");
    expect(NodeFs.readFileSync(paths.codexGuidance, "utf8")).toBe("# Concurrent edit\n");
    expect(NodeFs.existsSync(paths.claudeConfig)).toBe(false);
    expect(NodeFs.existsSync(paths.claudeSkill)).toBe(false);
    expect(NodeFs.existsSync(`${paths.codexGuidance}.bak`)).toBe(false);
  });

  it("repairs a drifted block in place without duplicating it", async () => {
    const paths = makePaths();
    await install(paths);
    const current = NodeFs.readFileSync(paths.codexGuidance, "utf8");
    const drifted = current.replace("`$deardiary`", "`$old-diary`");
    write(paths.codexGuidance, drifted);

    const check = checkSetup(paths, skillSource, allHarnesses);
    expect(check.exitCode).toBe(1);
    expect(check.output).toContain(`DRIFTED Codex global guidance: ${paths.codexGuidance}`);

    await install(paths);
    const repaired = NodeFs.readFileSync(paths.codexGuidance, "utf8");
    expect(repaired).toContain("`$deardiary`");
    expect(repaired).not.toContain("`$old-diary`");
    expect(repaired.match(/<!-- deardiary:start -->/gu)).toHaveLength(1);
    expect(NodeFs.readFileSync(`${paths.codexGuidance}.bak`, "utf8")).toBe(drifted);
  });

  it("rejects malformed or duplicate markers before making any planned write", async () => {
    await Promise.all(
      [
        "<!-- deardiary:start -->\nbroken",
        "<!-- deardiary:start --><!-- deardiary:end --><!-- deardiary:start --><!-- deardiary:end -->",
      ].map(async (malformed) => {
        const paths = makePaths();
        write(paths.codexGuidance, malformed);
        const result = await setup({
          paths,
          skillSource,
          yes: true,
          confirm: async () => "yes",
          harnesses: allHarnesses,
        });
        expect(result.exitCode).toBe(1);
        expect(result.output).toContain("malformed Dear Diary guidance markers");
        expect(NodeFs.readFileSync(paths.codexGuidance, "utf8")).toBe(malformed);
        expect(NodeFs.existsSync(paths.claudeConfig)).toBe(false);
        expect(NodeFs.existsSync(paths.claudeSkill)).toBe(false);
        expect(NodeFs.existsSync(`${paths.codexGuidance}.bak`)).toBe(false);
      }),
    );
  });

  it("supports project and none scopes and fails project preflight outside Git", async () => {
    const nonePaths = makePaths();
    const malformed = "<!-- deardiary:start --> untouched";
    write(nonePaths.codexGuidance, malformed);
    const none = await setup({
      paths: nonePaths,
      skillSource,
      yes: true,
      confirm: async () => "no",
      harnesses: allHarnesses,
      guidance: "none",
    });
    expect(none.exitCode, none.output).toBe(0);
    expect(NodeFs.readFileSync(nonePaths.codexGuidance, "utf8")).toBe(malformed);
    expect(NodeFs.existsSync(nonePaths.claudeGuidance)).toBe(false);
    expect(checkSetup(nonePaths, skillSource, allHarnesses, "none").exitCode).toBe(0);

    const projectPaths = makePaths();
    const project = gitProject();
    const nested = NodePath.join(project, "packages", "app");
    const projectOverride = NodePath.join(project, "AGENTS.override.md");
    NodeFs.mkdirSync(nested, { recursive: true });
    write(projectOverride, "# Active project override\n");
    const projectSetup = await setup({
      paths: projectPaths,
      skillSource,
      yes: true,
      confirm: async () => "no",
      harnesses: allHarnesses,
      guidance: "project",
      cwd: nested,
    });
    expect(projectSetup.exitCode, projectSetup.output).toBe(0);
    expect(NodeFs.readFileSync(NodePath.join(project, "AGENTS.md"), "utf8")).toContain(
      "`$deardiary`",
    );
    expect(NodeFs.readFileSync(projectOverride, "utf8")).toContain("`$deardiary`");
    expect(NodeFs.readFileSync(NodePath.join(project, "CLAUDE.md"), "utf8")).toContain(
      "`/deardiary`",
    );
    expect(NodeFs.existsSync(projectPaths.codexGuidance)).toBe(false);
    expect(checkSetup(projectPaths, skillSource, allHarnesses, "project", nested).exitCode).toBe(0);

    const outsidePaths = makePaths();
    const outside = temporaryDirectory();
    const failed = await setup({
      paths: outsidePaths,
      skillSource,
      yes: true,
      confirm: async () => "yes",
      harnesses: allHarnesses,
      guidance: "project",
      cwd: outside,
    });
    expect(failed.exitCode).toBe(1);
    expect(failed.output).toContain("Project guidance requires a Git repository");
    expect(NodeFs.existsSync(outsidePaths.claudeConfig)).toBe(false);
    expect(NodeFs.existsSync(outsidePaths.claudeSkill)).toBe(false);
  });

  it("uninstalls only the selected guidance scope and preserves unrelated bytes", async () => {
    const paths = makePaths();
    const project = gitProject();
    write(paths.codexGuidance, "global-before\n");
    write(paths.claudeGuidance, "claude-global-before\n");
    await install(paths);
    const globalCodex = NodeFs.readFileSync(paths.codexGuidance, "utf8");
    const globalClaude = NodeFs.readFileSync(paths.claudeGuidance, "utf8");
    write(NodePath.join(project, "AGENTS.md"), "project-before");
    write(NodePath.join(project, "AGENTS.override.md"), "override-before\n");
    write(NodePath.join(project, "CLAUDE.md"), "claude-project-before\n");
    const projectInstall = await setup({
      paths,
      skillSource,
      yes: true,
      confirm: async () => "no",
      harnesses: allHarnesses,
      guidance: "project",
      cwd: project,
    });
    expect(projectInstall.exitCode, projectInstall.output).toBe(0);
    const installedProjectGuidance = NodeFs.readFileSync(
      NodePath.join(project, "AGENTS.md"),
      "utf8",
    );
    expect(installedProjectGuidance).toContain("project-before\n<!-- deardiary:start -->");
    expect(installedProjectGuidance).toContain("<!-- deardiary:start -->\n\n## Dear Diary");

    const result = await uninstall({
      paths,
      level: "integrations",
      yes: true,
      confirm: async () => "no",
      guidance: "project",
      cwd: project,
    });
    expect(result.exitCode, result.output).toBe(0);
    expect(NodeFs.readFileSync(NodePath.join(project, "AGENTS.md"), "utf8")).toBe("project-before");
    expect(NodeFs.readFileSync(NodePath.join(project, "AGENTS.override.md"), "utf8")).toBe(
      "override-before\n",
    );
    expect(NodeFs.readFileSync(NodePath.join(project, "CLAUDE.md"), "utf8")).toBe(
      "claude-project-before\n",
    );
    expect(NodeFs.readFileSync(paths.codexGuidance, "utf8")).toBe(globalCodex);
    expect(NodeFs.readFileSync(paths.claudeGuidance, "utf8")).toBe(globalClaude);
  });
});

describe("uninstall lifecycle", () => {
  it("removes only Dear Diary integrations and skills while preserving config and data", async () => {
    const paths = makePaths();
    write(
      paths.claudeConfig,
      `${JSON.stringify({ keep: 1, mcpServers: { other: { command: "other" } } })}\n`,
    );
    write(paths.codexConfig, `keep = true\n\n[mcp_servers.other]\ncommand = "other"\n`);
    write(
      paths.openCodeConfig,
      `${JSON.stringify({ keep: true, mcp: { other: { type: "local", command: ["other"], enabled: true } } })}\n`,
    );
    await install(paths);
    write(NodePath.join(paths.dataDir, "keep.txt"), "diary data");

    const result = await uninstall({
      paths,
      level: "integrations",
      yes: true,
      confirm: async () => "no",
    });
    expect(result.exitCode, result.output).toBe(0);
    expect(result.output).toContain(`Removed Claude Code MCP: ${paths.claudeConfig}`);
    expect(result.output).not.toContain("npm rm");
    expect(readJson(paths.claudeConfig)).toEqual({
      keep: 1,
      mcpServers: { other: { command: "other" } },
    });
    expect(NodeFs.readFileSync(paths.codexConfig, "utf8")).toContain("[mcp_servers.other]");
    expect(NodeFs.readFileSync(paths.codexConfig, "utf8")).not.toContain("mcp_servers.deardiary");
    expect(readJson(paths.openCodeConfig).mcp.other.command).toEqual(["other"]);
    expect(NodeFs.existsSync(paths.claudeSkill)).toBe(false);
    expect(NodeFs.existsSync(paths.agentsSkill)).toBe(false);
    expect(NodeFs.readFileSync(NodePath.join(paths.dataDir, "keep.txt"), "utf8")).toBe(
      "diary data",
    );
  });

  it("prints the exact CLI instruction and requires the stable typed phrase for full wipe", async () => {
    const paths = makePaths();
    await install(paths);
    write(NodePath.join(paths.dataDir, "deardiary.db"), "not needed for uninstall");

    let question = "";
    const cancelled = await uninstall({
      paths,
      level: "full",
      yes: false,
      confirm: async (value) => {
        question = value;
        return "DELETE DATA";
      },
    });
    expect(cancelled.output).toBe("Uninstall cancelled; no files removed.");
    expect(question).toContain(`DELETE data: ${paths.dataDir}`);
    expect(question).toContain(`Type '${fullWipeConfirmation}'`);
    expect(NodeFs.existsSync(paths.dataDir)).toBe(true);
    expect(NodeFs.existsSync(paths.claudeSkill)).toBe(true);

    const wiped = await uninstall({
      paths,
      level: "full",
      yes: false,
      confirm: async () => fullWipeConfirmation,
    });
    expect(wiped.exitCode, wiped.output).toBe(0);
    expect(wiped.output).toContain(`Deleted data: ${paths.dataDir}`);
    expect(wiped.output).toContain(
      "Remove the CLI after this command exits: npm rm -g @p4cs/deardiary",
    );
    expect(NodeFs.existsSync(paths.dataDir)).toBe(false);

    const cliOnly = await uninstall({
      paths,
      level: "cli",
      yes: true,
      confirm: async () => "no",
    });
    expect(cliOnly.output).toContain(
      "Remove the CLI after this command exits: npm rm -g @p4cs/deardiary",
    );
    expect(cliOnly.output).not.toContain("Deleted data:");
  });

  it("refuses ancestor and workspace-wide full-wipe targets before changing files", async () => {
    const paths = makePaths();
    const ancestor = NodePath.dirname(paths.homeDir);
    const broadHome = await uninstall({
      paths: { ...paths, dataDir: ancestor, databasePath: NodePath.join(ancestor, "deardiary.db") },
      level: "full",
      yes: true,
      confirm: async () => "yes",
    });
    expect(broadHome.exitCode).toBe(1);
    expect(broadHome.output).toContain(`Refusing unsafe data deletion target '${ancestor}'`);
    expect(NodeFs.existsSync(paths.homeDir)).toBe(true);

    const workspace = temporaryDirectory();
    const workspaceChild = NodePath.join(workspace, "project");
    NodeFs.mkdirSync(workspaceChild);
    const broadWorkspace = await uninstall({
      paths: {
        ...paths,
        dataDir: workspace,
        databasePath: NodePath.join(workspace, "deardiary.db"),
      },
      level: "full",
      yes: true,
      confirm: async () => "yes",
      cwd: workspaceChild,
    });
    expect(broadWorkspace.exitCode).toBe(1);
    expect(broadWorkspace.output).toContain(`Refusing unsafe data deletion target '${workspace}'`);
    expect(NodeFs.existsSync(workspaceChild)).toBe(true);

    const filesystemRoot = NodePath.parse(paths.dataDir).root;
    const topLevel = NodePath.join(filesystemRoot, "deardiary-broad-target");
    const broadTopLevel = await uninstall({
      paths: {
        ...paths,
        dataDir: topLevel,
        databasePath: NodePath.join(topLevel, "deardiary.db"),
      },
      level: "full",
      yes: true,
      confirm: async () => "yes",
    });
    expect(broadTopLevel.exitCode).toBe(1);
    expect(broadTopLevel.output).toContain(`Refusing unsafe data deletion target '${topLevel}'`);
  });
});

describe("doctor and startup benchmark", () => {
  it("keeps an absent database absent and reports a successful temporary handshake", async () => {
    const paths = makePaths();
    await install(paths);
    const result = await doctor({
      paths,
      skillSource,
      version: "0.0.1",
      probe: async () => ({ milliseconds: 12.4, toolCount: 3 }),
      harnesses: allHarnesses,
    });
    expect(result.exitCode, result.output).toBe(0);
    expect(result.output).toContain("OK Data: database not created yet");
    expect(result.output).toContain("OK MCP startup OK: 12 ms cold handshake, 3 tools, no daemon.");
    expect(NodeFs.existsSync(paths.dataDir)).toBe(false);
  });

  it("returns nonzero for an unhealthy database or failed MCP startup", async () => {
    const paths = makePaths();
    write(paths.databasePath, "not sqlite");
    const result = await doctor({
      paths,
      skillSource,
      version: "0.0.1",
      probe: async () => {
        throw new Error("handshake timed out");
      },
      harnesses: allHarnesses,
    });
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("FAIL Data:");
    expect(result.output).toContain("run 'npx -y @p4cs/deardiary@latest setup'");
    expect(result.output).toContain("FAIL MCP startup failed: handshake timed out");
  });

  it("has a testable benchmark abstraction and validates the tool catalog", async () => {
    const success = await benchStartup(async () => ({ milliseconds: 1.6, toolCount: 3 }));
    expect(success).toEqual({
      exitCode: 0,
      output: "MCP startup OK: 2 ms cold handshake, 3 tools, no daemon.",
    });
    const wrongTools = await benchStartup(async () => ({ milliseconds: 1, toolCount: 2 }));
    expect(wrongTools.exitCode).toBe(1);
    expect(wrongTools.output).toContain("expected 3 tools, received 2");
  });
});
