import * as NodePath from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "@effect/vitest";
import * as Database from "@deardiary/core/db";
import * as Entries from "@deardiary/core/entries";
import * as Git from "@deardiary/core/git";
import * as Projects from "@deardiary/core/projects";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";

import { makeDiaryMcpServer } from "../src/server.ts";

const startupCwd = NodePath.resolve("/workspace");
const projectA = NodePath.join(startupCwd, "project-a");
const projectB = NodePath.join(startupCwd, "project-b");

const resolver = Git.RepositoryResolver.of({
  resolve: (cwd) => {
    const root = cwd.startsWith(projectA) ? projectA : cwd.startsWith(projectB) ? projectB : null;
    return Effect.succeed(
      root === null
        ? null
        : {
            workingTreeRoot: root,
            canonicalRoot: root,
            isLinkedWorktree: false,
          },
    );
  },
});

const testLayer = Entries.layer.pipe(
  Layer.provideMerge(Projects.layer),
  Layer.provideMerge(Database.layerMemory),
  Layer.provideMerge(Layer.succeed(Git.RepositoryResolver, resolver)),
);

const textOf = (result: unknown): string => {
  if (typeof result !== "object" || result === null) return "";
  const content = (result as { readonly content?: unknown }).content;
  if (!Array.isArray(content)) return "";
  const first = content[0] as { readonly type?: unknown; readonly text?: unknown } | undefined;
  return first?.type === "text" && typeof first.text === "string" ? first.text : "";
};

const structuredOf = (result: unknown): Readonly<Record<string, unknown>> => {
  if (typeof result !== "object" || result === null) return {};
  const structured = (result as { readonly structuredContent?: unknown }).structuredContent;
  return typeof structured === "object" && structured !== null
    ? (structured as Readonly<Record<string, unknown>>)
    : {};
};

const entriesOf = (
  result: unknown,
): ReadonlyArray<{ readonly body: string; readonly projectId: string | null }> => {
  return (structuredOf(result).entries ?? []) as ReadonlyArray<{
    readonly body: string;
    readonly projectId: string | null;
  }>;
};

describe("Dear Diary MCP server", () => {
  it("exposes exactly the settled tools and keeps one repository session alive across calls", async () => {
    const scope = await Effect.runPromise(Scope.make("sequential"));
    const services = await Effect.runPromise(Layer.buildWithScope(testLayer, scope));
    const server = makeDiaryMcpServer({
      entries: Context.get(services, Entries.EntryRepository),
      projects: Context.get(services, Projects.ProjectRepository),
      startupCwd,
    });
    const client = new Client({ name: "deardiary-tests", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name)).toEqual([
        "diary_log",
        "diary_read",
        "diary_context",
      ]);
      for (const tool of listed.tools) {
        expect(tool.title).toBeTypeOf("string");
        expect(tool.description).toBeTypeOf("string");
        expect(tool.inputSchema.additionalProperties).toBe(false);
        expect(tool.outputSchema?.type).toBe("object");
        expect(tool.annotations?.destructiveHint).toBe(false);
        expect(tool.annotations?.openWorldHint).toBe(false);
      }
      expect(listed.tools[0]?.inputSchema.required).toContain("body");
      expect(listed.tools[0]?.annotations).toMatchObject({
        readOnlyHint: false,
        idempotentHint: false,
      });
      expect(listed.tools[1]?.annotations).toMatchObject({
        readOnlyHint: true,
        idempotentHint: true,
      });

      const global = await client.callTool({
        name: "diary_log",
        arguments: {
          body: "global win",
          mood: "win",
          tags: ["shared", "global"],
          model: "gpt-test",
          harness: "vitest",
          global: true,
        },
      });
      expect(global.isError, textOf(global)).not.toBe(true);
      expect(textOf(global)).toMatch(/^Logged win entry /u);
      expect(structuredOf(global).entry).toMatchObject({
        body: "global win",
        mood: "win",
        projectId: null,
      });

      const [loggedA, loggedB] = await Promise.all([
        client.callTool({
          name: "diary_log",
          arguments: { body: "project A note", cwd: "project-a", tags: ["shared"] },
        }),
        client.callTool({
          name: "diary_log",
          arguments: { body: "project B idea", cwd: "project-b", mood: "idea" },
        }),
      ]);
      expect(loggedA.isError).not.toBe(true);
      expect(loggedB.isError).not.toBe(true);

      const current = await client.callTool({
        name: "diary_read",
        arguments: { cwd: "project-a", order: "oldest", tag: "shared" },
      });
      expect(entriesOf(current).map((entry) => entry.body)).toEqual(["project A note"]);
      expect(textOf(current)).toContain("project A note");

      const explicit = await client.callTool({
        name: "diary_read",
        arguments: { scope: "project", project: "project-b" },
      });
      expect(entriesOf(explicit).map((entry) => entry.body)).toEqual(["project B idea"]);

      const context = await client.callTool({
        name: "diary_context",
        arguments: { cwd: "project-a", order: "oldest" },
      });
      expect(entriesOf(context).map((entry) => entry.body)).toEqual([
        "global win",
        "project A note",
      ]);
      expect(textOf(context)).toContain("Dear Diary context:");

      const all = await client.callTool({
        name: "diary_context",
        arguments: { cwd: "project-a", all: true },
      });
      expect(new Set(entriesOf(all).map((entry) => entry.body))).toEqual(
        new Set(["global win", "project A note", "project B idea"]),
      );

      const invalidResults = await Promise.all(
        (
          [
            ["diary_log", {}],
            ["diary_log", { body: "unknown key", surprise: true }],
            ["diary_log", { body: "bad tag", tags: ["not,exact"] }],
            ["diary_log", { body: "bad mood", mood: "happy" }],
            ["diary_read", { since: "yesterday" }],
            ["diary_read", { limit: 0 }],
            ["diary_context", { order: "sideways" }],
          ] as const
        ).map(([name, arguments_]) => client.callTool({ name, arguments: arguments_ })),
      );
      for (const invalid of invalidResults) {
        expect(invalid.isError).toBe(true);
        expect(textOf(invalid)).toContain("Input validation error");
      }
      const contradictory = await client.callTool({
        name: "diary_read",
        arguments: { scope: "global", project: "project-a" },
      });
      expect(contradictory.isError).toBe(true);

      const missingProject = await client.callTool({
        name: "diary_read",
        arguments: { scope: "project", project: "outside-git" },
      });
      expect(missingProject.isError).toBe(true);
      expect(textOf(missingProject)).toContain("not inside a Git working tree");

      const survived = await client.callTool({
        name: "diary_read",
        arguments: { scope: "global", mood: "win", limit: 1 },
      });
      expect(entriesOf(survived).map((entry) => entry.body)).toEqual(["global win"]);
    } finally {
      await client.close().catch(() => undefined);
      await server.close().catch(() => undefined);
      await Effect.runPromise(Scope.close(scope, Exit.void));
    }
  });
});
