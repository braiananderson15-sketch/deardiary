# npm release automation

`.github/workflows/publish.yml` runs for every push to `main` and can also be started manually.

- Validation runs on native ARM64 with `blacksmith-4vcpu-ubuntu-2404-arm`.
- The minimal publish job runs on GitHub-hosted `ubuntu-24.04-arm` because npm trusted
  publishing does not currently support third-party/self-hosted runners.
- The workflow increments the committed patch version by the workflow run number. With a base
  version of `0.0.2`, run 1 publishes `0.0.3`, run 2 publishes `0.0.4`, and so on.
- One build is packed and published under the canonical `@p4cs/deardiary` package and the
  `deardiary-cli` compatibility name, both at the same version and with the `latest` dist-tag.
- pnpm creates the tarballs so `catalog:` and `workspace:` references are converted before npm
  publishes them.

## One-time setup

1. Install the Blacksmith GitHub App for `p4cs-974/deardiary`.
2. In both packages' npm settings, add the same trusted publisher:
   - Provider: GitHub Actions
   - Organization or user: `p4cs-974`
   - Repository: `deardiary`
   - Workflow filename: `publish.yml`
   - Allowed action: `npm publish`
3. Do not add an npm token to GitHub. The publish job requests a short-lived OIDC credential with
   `id-token: write`.

Complete this setup before merging the workflow into `main`.

The repository is private, so npm will not attach public provenance even though authentication uses
trusted publishing.
