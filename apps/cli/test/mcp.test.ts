import * as NodeFs from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, describe, expect, it } from "@effect/vitest";

import cliPackage from "../package.json" with { type: "json" };

const cliPath = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const skillPath = fileURLToPath(new URL("../skill/SKILL.md", import.meta.url));
const skillSource = NodeFs.readFileSync(skillPath, "utf8");
const temporaryRoots: Array<string> = [];

const temporaryDirectory = (prefix: string): string => {
  const path = NodeFs.mkdtempSync(NodePath.join(NodeOS.tmpdir(), prefix));
  temporaryRoots.push(path);
  return path;
};

const structuredOf = (result: unknown): Readonly<Record<string, unknown>> => {
  if (typeof result !== "object" || result === null) return {};
  const structured = (result as { readonly structuredContent?: unknown }).structuredContent;
  return typeof structured === "object" && structured !== null
    ? (structured as Readonly<Record<string, unknown>>)
    : {};
};

const entriesOf = (result: unknown): ReadonlyArray<{ readonly body: string }> => {
  return (structuredOf(result).entries ?? []) as ReadonlyArray<{ readonly body: string }>;
};

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    NodeFs.rmSync(root, { recursive: true, force: true });
  }
});

describe("deardiary mcp stdio", () => {
  it("handshakes, persists calls, emits only protocol stdout, and shuts down cleanly", async () => {
    const root = temporaryDirectory("deardiary-mcp-stdio-");
    const cwd = NodePath.join(root, "cwd");
    const home = NodePath.join(root, "data");
    const userHome = NodePath.join(root, "user");
    const claudeSkill = NodePath.join(userHome, ".claude", "skills", "deardiary", "SKILL.md");
    const agentsSkill = NodePath.join(userHome, ".agents", "skills", "deardiary", "SKILL.md");
    NodeFs.mkdirSync(cwd);
    NodeFs.mkdirSync(NodePath.dirname(claudeSkill), { recursive: true });
    NodeFs.mkdirSync(NodePath.dirname(agentsSkill), { recursive: true });
    NodeFs.writeFileSync(claudeSkill, "outdated Claude skill\n");
    NodeFs.writeFileSync(agentsSkill, "outdated shared skill\n");

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--experimental-strip-types", cliPath, "mcp"],
      cwd,
      env: {
        DEARDIARY_HOME: home,
        HOME: userHome,
        XDG_CONFIG_HOME: NodePath.join(userHome, ".config"),
        CODEX_HOME: NodePath.join(userHome, ".codex"),
        NO_COLOR: "1",
      },
      stderr: "pipe",
    });
    let stderr = "";
    transport.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    const client = new Client({ name: "deardiary-stdio-tests", version: "1.0.0" });

    try {
      await client.connect(transport, { timeout: 5_000 });
      expect(client.getServerVersion()).toMatchObject({
        name: "deardiary",
        version: cliPackage.version,
      });
      expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([
        "diary_log",
        "diary_read",
        "diary_context",
      ]);
      await expect
        .poll(() => NodeFs.readFileSync(claudeSkill, "utf8"), { timeout: 5_000 })
        .toBe(skillSource);
      await expect
        .poll(() => NodeFs.readFileSync(agentsSkill, "utf8"), { timeout: 5_000 })
        .toBe(skillSource);

      const logged = await client.callTool({
        name: "diary_log",
        arguments: { body: "stdio persisted entry", mood: "idea", tags: ["stdio"] },
      });
      expect(logged.isError).not.toBe(true);
      expect(structuredOf(logged).entry).toMatchObject({
        body: "stdio persisted entry",
        mood: "idea",
        projectId: null,
        projectRootPath: null,
      });

      const read = await client.callTool({
        name: "diary_read",
        arguments: { scope: "global", tag: "stdio" },
      });
      expect(entriesOf(read).map((entry) => entry.body)).toEqual(["stdio persisted entry"]);

      const context = await client.callTool({ name: "diary_context", arguments: {} });
      expect(entriesOf(context).map((entry) => entry.body)).toEqual(["stdio persisted entry"]);
      expect(NodeFs.existsSync(NodePath.join(home, "deardiary.db"))).toBe(true);
    } finally {
      await client.close();
    }

    expect(transport.pid).toBeNull();
    expect(stderr).toBe("");
  }, 15_000);
});
