# The settled design tree — "Dear Diary"

**Concept.** A global diary for coding agents. Agents log struggles, wins, ideas, and observations about the user; entries are prose with a voice, lightly structured for queryability. Stored locally, global by default, queryable per-project. Open source after v1 works; sync service + self-hosting is a later, separate project.

**Storage.**

- One SQLite DB (WAL) at `~/.local/share/deardiary/` (XDG, `DEARDIARY_HOME` override)
- Schema: `projects(id, root_path, name, remote_url, first_seen, last_seen)` + `entries(id, project_id NULL, ts, model, harness, mood, tags, cwd, body)`; `project_id NULL` = global entry
- Mood enum: `struggled | win | note | idea | rant`; tags as comma-text
- Sync seam only: UUIDs, `updated_at`, tombstones — zero network code in v1
- Worktree resolution: parse `git rev-parse --git-dir`; only activates when actually inside a linked worktree (`*/.git/worktrees/*`), mapping to the main repo root; zero interference otherwise; non-git cwd → global entry

**Architecture.**

- Stateless: CLI is the engine; `packages/mcp` wraps `packages/core`; each harness spawns `deardiary mcp` per session
- Cold-start strategy: wizard registers `npx -y deardiary mcp` with bumped timeouts, offers global install (direct binary path) for speed; `deardiary bench-startup` + `doctor` verify; a service is only reconsidered if measurements hurt
- **Effect-TS throughout** the TS codebase, with `.repos/t3code` as the in-repo style reference

**Interfaces.**

- CLI: `log`, `read`, `context`, `stats`, `random`, `export --markdown`, `setup`, `setup --check`, `doctor`, `bench-startup`, `uninstall`, `mcp`
- MCP: thin stdio server exposing log/read/context tools over `packages/core`
- Skill: one `SKILL.md`, copied (not symlinked) to `~/.claude/skills/deardiary/` and `~/.agents/skills/deardiary/`; MCP-first with CLI fallback; `setup --check` reports drift with one-command refresh
- Skill personality: **restrained** — log genuine blockers and notable wins; explicit permission to have a voice; 2–3 example entries set the register; no mandated persona, no read-at-start ritual
- Harness support: MCP + skill only — "all proper harnesses support MCP and skills"; Claude Code, Codex, OpenCode natively; others via generic MCP/skill docs
- Read scope: `context` returns current-project + global by default, `--all` for everything; no auto-redaction; README states plainly what's stored and where
- No hooks, anywhere, ever — too invasive, cost/quality risk

**Monorepo** (pnpm 11 + vite+ `vp`, t3code conventions: catalog deps, one strict `tsconfig.base.json`, raw-TS internal package exports, `vp pack` for publishables):

- `apps/cli` — all commands, wizard, prompts (published as `deardiary`)
- `apps/marketing` — Astro one-pager: hero, beautifully rendered sample entries as the demo, the copy-paste agent setup prompt (the self-propagating install loop), install instructions, GitHub link. A web journal reader is your later project, not v1
- `packages/core` — db, schema, git/worktree resolution, queries, formatting
- `packages/mcp` — MCP server, tool schemas, harness quirks

**Setup wizard.** Interactive, detects harnesses, registers MCP + installs skill with backup + diff preview; global by default. The agent-driven setup path lives on the **website** as a copy-paste prompt, not a CLI flag.

**Uninstall.** `deardiary uninstall` → three levels: (1) integrations only, (2) integrations + CLI, (3) full wipe incl. data dir (typed confirmation). `--yes` non-interactive per level; prints exactly what it removed; if globally installed, prints the final `npm rm -g` for the user.

**Name & brand.** npm: **`deardiary`** (available — publish a placeholder or v0.0.1 to claim); brand: "Dear Diary"; entries read as "dear diary…"

---

**Implicit defaults** (flagged, not silently baked in): license MIT (matches the vp/VoidZero ecosystem); entries are immutable (append-only; no edit command — it's a diary, edits happen by adding new entries).
