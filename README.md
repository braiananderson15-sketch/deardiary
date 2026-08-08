# Dear Diary

A diary for your coding agents. Struggles, wins, ideas, observations — logged by your agents in their own voice, stored locally, queryable by you.

Dear Diary stores entry prose, timestamps, mood, tags, model, harness, working directory,
and Git project identity in one local SQLite database. Set `DEARDIARY_HOME` to choose its
directory. Otherwise it follows the platform data directory: `$XDG_DATA_HOME/deardiary`
(or `~/.local/share/deardiary`) on Linux, `~/Library/Application Support/deardiary` on
macOS, and `%APPDATA%\deardiary` on Windows. The database file is `deardiary.db`. Diary
data is never sent over the network or synced.

Entries logged inside a Git working tree belong to that project (including linked
worktrees); entries outside Git or logged with `--global` are global. Reads default to the
current project inside Git and to global entries outside Git. Context combines the current
project with global entries unless `--all` is explicit.

## Commands

- `deardiary` CLI — `log`, `read`, `context`, `stats`, `random`, `export`, `setup`, `doctor`, `uninstall`, `mcp`
- MCP server — exactly `diary_log`, `diary_read`, and `diary_context`
- `SKILL.md` — MCP-first instructions with a package-runner CLI fallback

## Setup and passive guidance

Run `npx -y deardiary setup` to preview and install detected harness integrations, shared
skill copies, and global passive guidance. The guidance gives Codex and Claude a concise,
always-available policy for recognizing a diary-worthy blocker, reusable win, or actionable
observation and invoking the Dear Diary skill at a natural pause. The skill owns the active
record-or-recall workflow; it is not a background logger.

Guidance scope is explicit and predictable:

- `deardiary setup` or `deardiary setup --guidance global` manages user-level guidance
  (the default).
- `deardiary setup --guidance project` manages guidance in the Git repository containing
  the current directory. It fails outside a Git working tree because project guidance can
  become tracked team policy.
- `deardiary setup --guidance none` installs integrations and skills without creating,
  changing, or removing existing guidance.
- `deardiary setup --check --guidance <scope>` performs a read-only drift check for exactly
  that scope. `--yes` applies the preview without prompting and cannot be combined with
  `--check`.

Dear Diary owns the section between `<!-- deardiary:start -->` and
`<!-- deardiary:end -->`, plus the single separator newline it inserts immediately before the
start marker in a non-empty file. Setup preserves surrounding instructions, backs up files before
changes, repairs a drifted managed section, and refuses unsafe malformed or duplicate marker
pairs. After setup changes guidance, restart open Codex or Claude sessions so they reload their
instruction files.

Setup registers `npx -y deardiary mcp`, so it remains usable without a global install. If
`deardiary` is installed globally, you can manually use the direct `deardiary mcp` command in
harness config for faster startup.

## Uninstall

`deardiary uninstall` removes integrations, skill copies, and the managed global guidance
section by default. Use `--guidance project` to select the managed section in the Git repository
containing the current directory instead of the global section; integration and skill removal still
follow the selected uninstall level. Uninstall never searches other repositories and restores the
instruction file content outside Dear Diary's managed insertion exactly.

The `integrations` level is the default. `--level cli` also prints the final global CLI removal
command while retaining diary data; `--level full` additionally deletes the local diary data.
Non-interactive `--yes` requires an explicit `--level`.

## Monorepo

| Path             | Package                | Purpose                                                  |
| ---------------- | ---------------------- | -------------------------------------------------------- |
| `apps/cli`       | `deardiary`            | The published CLI (npx-runnable)                         |
| `apps/marketing` | `@deardiary/marketing` | Astro one-pager                                          |
| `packages/core`  | `@deardiary/core`      | db, schema, git/worktree resolution, queries, formatting |
| `packages/mcp`   | `@deardiary/mcp`       | MCP server + tool definitions                            |

Toolchain: pnpm workspaces + [Vite+](https://viteplus.dev) (`vp`), Effect-TS, `tsgo` typechecking. Conventions borrowed from t3code (see `.repos/t3code`, local only).
