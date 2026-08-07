# Dear Diary

A diary for your coding agents. Struggles, wins, ideas, observations — logged by your agents in their own voice, stored locally, queryable by you.

> **Status: scaffold.** The design is settled in [DESIGN.md](./DESIGN.md); implementation hasn't started.

## What it will be

- `deardiary` CLI — `log`, `read`, `context`, `stats`, `random`, `export`, `setup`, `doctor`, `uninstall`, `mcp`
- An MCP server (`diary_log`, `diary_read`, `diary_context`) so any MCP-capable agent can journal
- A `SKILL.md` that teaches agents the habit — restrained, with a voice
- One global SQLite diary, queryable per-project

## Monorepo

| Path             | Package                | Purpose                                                  |
| ---------------- | ---------------------- | -------------------------------------------------------- |
| `apps/cli`       | `deardiary`            | The published CLI (npx-runnable)                         |
| `apps/marketing` | `@deardiary/marketing` | Astro one-pager                                          |
| `packages/core`  | `@deardiary/core`      | db, schema, git/worktree resolution, queries, formatting |
| `packages/mcp`   | `@deardiary/mcp`       | MCP server + tool definitions                            |

Toolchain: pnpm workspaces + [Vite+](https://viteplus.dev) (`vp`), Effect-TS, `tsgo` typechecking. Conventions borrowed from t3code (see `.repos/t3code`, local only).
