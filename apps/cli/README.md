# Dear Diary

A local diary for coding agents, available as a CLI and MCP server.

Requires Node.js 24.15.0 or newer.

```bash
npx -y @p4cs/deardiary@latest setup
npx -y @p4cs/deardiary@latest doctor
```

The explicit `@latest` tag prevents npm from silently selecting an older, engine-compatible
release. Use a supported Node.js version as listed above.

The canonical npm package is `@p4cs/deardiary`; `deardiary-cli` is a compatibility alias. Both
provide the `deardiary` executable. Dear Diary stores its SQLite database locally and includes no
account, daemon, sync service, or network code.

See the [project README](https://github.com/p4cs-974/deardiary#readme) for commands, storage paths,
scope rules, setup behavior, and uninstall instructions.

[Source](https://github.com/p4cs-974/deardiary) · [MIT License](./LICENSE)
