# npm release automation

`.github/workflows/publish.yml` runs for every push to `main` and can also be started manually.

- Validation runs formatting, linting, typechecking, tests, release-smoke syntax validation, and the
  CLI build on GitHub-hosted ARM64 with `ubuntu-24.04-arm`.
- The minimal publish job runs on GitHub-hosted `ubuntu-24.04-arm` because npm trusted
  publishing does not currently support third-party/self-hosted runners.
- The workflow increments the committed patch version by the workflow run number. With a base
  version of `0.0.2`, run 1 publishes `0.0.3`, run 2 publishes `0.0.4`, and so on.
- The release version is written to the CLI manifest before the release build. The packed manifest
  and the executable's `--version` output must both equal that exact version.
- One build is packed and published under the canonical `@p4cs/deardiary` package and the
  `deardiary-cli` compatibility name, both at the same version and with the `latest` dist-tag.
- pnpm creates the tarballs so `catalog:` and `workspace:` references are converted before npm
  publishes them.
- Dear Diary supports Node.js 24 from `24.15.0` onward and Node.js 26 or newer. The exact engine
  range is `^24.15.0 || >=26.0.0`, and the root and packed package declarations must agree.

## Publication gates

The GitHub-hosted job performs these steps in order:

1. Resolve and write the exact release version.
2. Build the CLI once, then pack `@p4cs/deardiary` and `deardiary-cli` from that build.
3. Run `scripts/release-smoke.mjs` against both tarballs before any registry write.
4. Publish the canonical scoped package first, followed by its compatibility alias. An exact
   version already present on npm is skipped, which makes a workflow rerun idempotent.
5. Poll npm until both exact versions are visible.

The packed-release smoke test requires each alias to contain its manifest, CLI bundle, skill,
README, and license. It rejects unresolved workspace protocols, a wrong package name, a stale
manifest or executable version, an invalid `deardiary` bin, and a Node engine that differs from the
workspace requirement. It then exercises `--help`, isolated setup for Claude Code, Codex, and
OpenCode, the canonical `npx -y @p4cs/deardiary@latest mcp` generated configuration, isolated SQLite
log/read/statistics and integrity checks, and a real cold MCP handshake that must expose three
tools after installing each local tarball with its resolved runtime dependencies. Any failure stops
the job before publication.

## One-time setup

1. In both packages' npm settings, add the same trusted publisher:
   - Provider: GitHub Actions
   - Organization or user: `p4cs-974`
   - Repository: `deardiary`
   - Workflow filename: `publish.yml`
   - Allowed action: `npm publish`
2. Do not add an npm token to GitHub. The publish job requests a short-lived OIDC credential with
   `id-token: write`.

Complete this setup before merging the workflow into `main`.

The repository is private, so npm will not attach public provenance even though authentication uses
trusted publishing.

## Post-release verification

After the workflow is green, verify the registry artifact with fresh npm and data directories:

```bash
smoke_root="$(mktemp -d)"
expected_version="<version>"

test "$(npm view @p4cs/deardiary@latest version)" = "$expected_version"
test "$(npm view deardiary-cli@latest version)" = "$expected_version"

HOME="$smoke_root/home" \
DEARDIARY_HOME="$smoke_root/data" \
npx --yes --cache "$smoke_root/npm-cache" @p4cs/deardiary@latest --version

npm view @p4cs/deardiary@<version> version
npm view deardiary-cli@<version> version
```

The `@latest` launch and both exact-version lookups must print the workflow's release version.
Remove `smoke_root` after inspection.
