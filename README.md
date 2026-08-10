# Dear Diary

A local diary for your coding agents. Agents can record struggles, wins, ideas, and observations in
their own voice, then recall that context in later sessions.

Dear Diary is a CLI and MCP server backed by one SQLite database. It has no account, daemon, sync
service, or network code. The package is open source under the [MIT License](./LICENSE).

## Quick start

Dear Diary requires Node.js 24.15.0 or newer in the Node 24 LTS line, or Node.js 26 or newer.

```bash
npx -y @p4cs/deardiary setup
npx -y @p4cs/deardiary doctor
```

`setup` previews its changes, asks before writing, and configures detected Claude Code, Codex, and
OpenCode installations. Restart open agent sessions after it completes. The configured MCP command
uses `npx`, so a global install is not required.

You can also use the diary directly:

```bash
npx -y @p4cs/deardiary log --mood win --tag release "The packed-package smoke test caught a stale command."
npx -y @p4cs/deardiary context
npx -y @p4cs/deardiary read --mood win --limit 10
```

`@p4cs/deardiary` is the canonical npm package. `deardiary-cli` remains available as a compatibility
alias. Both provide the `deardiary` executable when installed globally.

## Commands

| Command         | Purpose                                                          |
| --------------- | ---------------------------------------------------------------- |
| `log`           | Append an entry                                                  |
| `read`          | Read filtered project or global history                          |
| `context`       | Render current-project and global context                        |
| `stats`         | Summarize entries                                                |
| `random`        | Recall one eligible entry                                        |
| `export`        | Export entries as Markdown                                       |
| `setup`         | Preview and install MCP, skill, and passive-guidance integration |
| `doctor`        | Check the runtime, database, integrations, and MCP startup       |
| `bench-startup` | Measure a cold MCP handshake                                     |
| `uninstall`     | Remove integrations, the CLI, or all local data                  |
| `mcp`           | Run the stdio MCP server                                         |

Run `npx -y @p4cs/deardiary <command> --help` for command-specific options. The MCP server exposes
exactly `diary_log`, `diary_read`, and `diary_context`.

## Scope and storage

Entries written inside a Git working tree belong to that repository, including across linked
worktrees. Entries written outside Git or with `log --global` are global. `read` defaults to the
current project inside Git and global entries outside Git; `context` combines the current project
with global entries. Use `--all` when a command supports it to include every project.

Dear Diary stores entry prose, timestamps, mood, tags, model, harness, working directory, and Git
project identity. The database is `deardiary.db` in:

- Linux: `$XDG_DATA_HOME/deardiary` or `~/.local/share/deardiary`
- macOS: `~/Library/Application Support/deardiary`
- Windows: `%APPDATA%\deardiary`

Set `DEARDIARY_HOME` to an absolute directory to override that location. Dear Diary itself never
sends or syncs diary data; as with any agent tool, content an agent reads may be processed by the
agent provider you chose.

## Setup and passive guidance

Setup copies the Dear Diary skill, registers `npx -y @p4cs/deardiary mcp` for detected harnesses,
and manages a small passive-guidance section. The skill decides how to record or recall an entry;
the guidance only tells an agent when that skill may be useful. Dear Diary is not a background
logger.

```bash
# Global guidance (default)
npx -y @p4cs/deardiary setup

# Guidance in the current Git repository
npx -y @p4cs/deardiary setup --guidance project

# Install MCP and skills without touching guidance
npx -y @p4cs/deardiary setup --guidance none

# Read-only drift check
npx -y @p4cs/deardiary setup --check --guidance global
```

`--yes` applies the preview without prompting and cannot be combined with `--check`. Project
guidance requires a Git working tree because it can become tracked team policy.

Dear Diary owns only the section between `<!-- deardiary:start -->` and `<!-- deardiary:end -->` in
guidance files. It preserves surrounding instructions, backs up changed files, repairs a drifted
managed section, and refuses malformed or duplicate marker pairs.

## Uninstall

```bash
# Remove MCP integrations, skill copies, and managed global guidance
npx -y @p4cs/deardiary uninstall

# Also print the global npm removal command, while keeping diary data
npx -y @p4cs/deardiary uninstall --level cli

# Also delete the local diary database
npx -y @p4cs/deardiary uninstall --level full
```

Use `--guidance project` to remove the managed section in the current repository instead of global
guidance. Uninstall never searches other repositories. Non-interactive `--yes` requires an explicit
`--level`; an interactive full wipe requires the exact confirmation shown by the CLI.

## Repository

| Path             | Package                | Purpose                                                 |
| ---------------- | ---------------------- | ------------------------------------------------------- |
| `apps/cli`       | `deardiary-cli`        | CLI source; released as `@p4cs/deardiary` and its alias |
| `apps/marketing` | `@deardiary/marketing` | Astro one-pager                                         |
| `packages/core`  | `@deardiary/core`      | SQLite, Git identity, queries, and formatting           |
| `packages/mcp`   | `@deardiary/mcp`       | MCP server and tool definitions                         |

The monorepo uses pnpm workspaces and [Vite+](https://viteplus.dev). Local conventions are informed
by the read-only t3code reference in `.repos/t3code`.
