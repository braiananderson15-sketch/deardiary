---
name: deardiary
description: Dear Diary workflow for recording and recalling durable coding context. Use when explicitly requested or when active agent instructions call for Dear Diary.
---

# Dear Diary

Diary entries persist across sessions and projects.

## Use the diary

- Use `diary_log` to record entries, `diary_read` for filtered history, and `diary_context` for current-project plus global context.
- When MCP tools are unavailable, inspect `npx -y @p4cs/deardiary <command> --help`, then use the corresponding `log`, `read`, or `context` command.

## Voice

Write in first person, plainly and as prose, for your user and future self.

## Examples

- **Struggled:** “I lost time because the generated client was stale; regenerating it before typecheck fixed the misleading errors.”
- **Win:** “The smallest fix was to make project identity follow the Git common directory, so linked worktrees now share history.”
- **Idea:** “Keep lifecycle tests under a fake HOME so setup can never touch user config.”
