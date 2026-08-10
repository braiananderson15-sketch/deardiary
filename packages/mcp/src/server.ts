import type { Readable, Writable } from "node:stream";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Database from "@deardiary/core/db";
import * as Entries from "@deardiary/core/entries";
import * as Git from "@deardiary/core/git";
import * as Paths from "@deardiary/core/paths";
import * as Projects from "@deardiary/core/projects";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";

import { type DiaryToolServices, registerDiaryTools } from "./tools.ts";

export interface DiaryMcpServerOptions extends DiaryToolServices {
  readonly version: string;
}

export const makeDiaryMcpServer = (options: DiaryMcpServerOptions): McpServer => {
  const server = new McpServer({ name: "deardiary", version: options.version });
  registerDiaryTools(server, options);
  return server;
};

const liveLayer = Entries.layer.pipe(
  Layer.provideMerge(Projects.layer),
  Layer.provideMerge(Database.layer),
  Layer.provideMerge(Paths.layer),
  Layer.provideMerge(Git.layer),
  Layer.provideMerge(NodeServices.layer),
);

interface AcquiredDiaryServer {
  readonly server: McpServer;
  readonly close: () => Promise<void>;
}

const acquireLiveDiaryServer = async (
  startupCwd: string,
  version: string,
): Promise<AcquiredDiaryServer> => {
  const scope = await Effect.runPromise(Scope.make("sequential"));
  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await Effect.runPromise(Scope.close(scope, Exit.void));
  };

  try {
    const services = await Effect.runPromise(Layer.buildWithScope(liveLayer, scope));
    return {
      server: makeDiaryMcpServer({
        entries: Context.get(services, Entries.EntryRepository),
        projects: Context.get(services, Projects.ProjectRepository),
        startupCwd,
        version,
      }),
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
};

export interface StdioRunnerOptions {
  readonly version: string;
  readonly startupCwd?: string;
  readonly stdin?: Readable;
  readonly stdout?: Writable;
}

/** Run one long-lived stdio MCP connection and release SQLite when its input closes. */
export const runStdioServer = async (options: StdioRunnerOptions): Promise<void> => {
  const startupCwd = options.startupCwd ?? process.cwd();
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  const acquired = await acquireLiveDiaryServer(startupCwd, options.version);
  const transport = new StdioServerTransport(stdin, stdout);

  let settled = false;
  let resolveDone: (() => void) | undefined;
  let rejectDone: ((error: Error) => void) | undefined;
  const done = new Promise<void>((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });
  const finish = (error?: Error): void => {
    if (settled) return;
    settled = true;
    if (error === undefined) resolveDone?.();
    else rejectDone?.(error);
  };
  const onInputEnd = (): void => finish();
  stdin.once("end", onInputEnd);
  stdin.once("close", onInputEnd);

  try {
    // The SDK's Protocol API intentionally exposes single lifecycle callbacks.
    // oxlint-disable-next-line unicorn/prefer-add-event-listener
    acquired.server.server.onclose = () => finish();
    // oxlint-disable-next-line unicorn/prefer-add-event-listener
    acquired.server.server.onerror = (error) => finish(error);
    await acquired.server.connect(transport);
    if (stdin.readableEnded || stdin.destroyed) finish();
    await done;
  } finally {
    stdin.off("end", onInputEnd);
    stdin.off("close", onInputEnd);
    await acquired.server.close().catch(() => undefined);
    await acquired.close();
  }
};
