# dependabot-safe

**Kind:** eligibility. **Results:** `eligible` (category `dependabot-safe`) or `abstain`.

Qualifies Dependabot updates that are entirely Dependabot's work, where every updated dependency passes the configured rules, and that touch only manifests and lockfiles.

It decides from three things only:
- the `updated-dependencies` metadata block Dependabot writes into every commit message
- who authored and committed each commit, and who opened the PR
- which files changed

Labels, PR titles and anything else a person can edit are ignored.

## Rules

It returns `eligible` only when **all** of these hold. Otherwise it returns `abstain`, and the note lists every reason that failed (up to 10, then "…and N more").

1. The PR author is in `botLogins`.
2. The head branch starts with `branchPrefix`.
3. Every commit's **author** is in `botLogins`. A commit with no GitHub login fails.
4. Every commit's **committer** is in `botLogins` or `allowedCommitters`. A commit with no GitHub login fails. Dependabot's commits are committed by `web-flow`, GitHub's signing identity.
5. Every commit message has a parseable `updated-dependencies` block, and together they list at least one dependency.
6. Every listed dependency:
   - has an `update-type` in `allowedUpdateTypes` (a missing `update-type` fails, unless `inferDockerUpdateType` infers one: see below)
   - has a name that doesn't match `denyPackages` (globs, so `@apollo/*` works)
   - when `allowPreOneZero` is `false`, has a `dependency-version` that doesn't start with `0.` (a missing version fails)
7. Every changed path, both ends of a rename, matches `allowedFiles` (case-sensitive).
8. No changed path matches the built-in behavioural deny list (case-insensitive, not configurable). So Dependabot's GitHub Actions updates under `.github/` can never qualify.
9. At least one file changed.

Logins are compared the same way as everywhere else in hall-pass: case-insensitively, ignoring a trailing `[bot]`.

Grouped updates list several dependencies in one block, and every one must pass.

### Docker updates: `inferDockerUpdateType`

Dependabot writes no `update-type` for Docker base-image tag updates, so by default they always abstain with `<name>: no update-type`. Setting `inferDockerUpdateType: true` lets the classifier infer one. It is **opt-in** (default `false`; with it off, behaviour is unchanged), **Docker-only**, and **fails closed**:

- It only applies when the head branch starts with `<branchPrefix>docker/`, and only to a dependency whose metadata has no `update-type`. A Dependabot-supplied `update-type` always wins.
- The old and new tags come from Dependabot's own commit message: `Bumps <name> from <A> to <B>` or, for grouped updates, ``Updates `<name>` from <A> to <B>``. There must be exactly one distinct pair for the dependency.
- Both tags must look like `[v]X[.Y[.Z]]<suffix>`, with the same number of numeric parts and the same suffix (`3.12-slim → 3.15-slim` is minor; `3.12-slim → 3.12.1-slim` or `3.12-slim → 3.13-alpine` are not inferred). Digests (`@sha256:…`), names like `bookworm`, downgrades and unchanged tags are not inferred.
- The first numeric part that grows sets the type: major, minor or patch. That type is then checked against `allowedUpdateTypes` like any other.

If inference doesn't succeed, the dependency abstains with `no update-type` as before. Rule 7 still applies, so `allowedFiles` must list the Dockerfiles (for example `**/Dockerfile`). Security updates carry the same metadata and follow the same rules.

## Config

```yaml
dependabot-safe:
  mode: shadow
  botLogins: ["dependabot[bot]"]                  # required, at least one
  allowedCommitters: ["web-flow"]                 # default []
  branchPrefix: "dependabot/"                     # required
  allowedUpdateTypes: ["version-update:semver-patch"]   # required: semver-patch | semver-minor | semver-major
  allowPreOneZero: false                          # default false
  denyPackages: ["@apollo/*", "graphql"]          # default []; globs
  allowedFiles: ["**/package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock"]  # required
  inferDockerUpdateType: false                    # default false; Docker-only, opt-in, fails closed
```

Unknown keys are a config error.

## Evidence

Each dependency appears once, for example `lodash → 4.17.21 (semver-patch, direct:production)`. An inferred update-type is marked, for example `python → 3.15-slim (semver-minor inferred, direct:production)`, so a reviewer can tell it from one Dependabot supplied. Grouped monorepo updates repeat the same entry once per manifest, so duplicates are dropped.

## Parsing the metadata

`parseDependabotMetadata(message)` in [`metadata.ts`](metadata.ts) finds the block between a `---` line followed by `updated-dependencies:`, and the closing `...` line. It parses the block with YAML's failsafe schema, so every value stays a string and a version like `1.10` isn't read as `1.1`, then validates the entries with zod. Unknown extra keys are allowed, because Dependabot adds fields over time. It returns the dependencies or an error, and never throws.

`inferDockerUpdateType(message, name)` in [`infer.ts`](infer.ts) reads the old and new Docker tags out of the commit message and returns the semver update-type, or `undefined` when it can't tell. It never throws.

## Tests

- [`metadata.test.ts`](metadata.test.ts): the parser.
- [`infer.test.ts`](infer.test.ts): Docker update-type inference.
- [`dependabot-safe.test.ts`](dependabot-safe.test.ts): every rule, both eligible and abstain, plus config errors.
- `src/runner.test.ts`: the classifier running alongside `path-category`.
