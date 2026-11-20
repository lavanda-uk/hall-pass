# hall-pass

A GitHub Action that classifies pull requests and gives the low-risk ones a hall pass: approves them and turns on auto-merge, acting as a GitHub App you register for it (called *the App* below; name it whatever you like). Every other PR goes to human review, the same as now.

- [Classifiers](#classifiers)
- [How it decides](#how-it-decides)
- [Markdown that is behaviour, not docs](#markdown-that-is-behaviour-not-docs)
- [Consumer setup](#consumer-setup) (six steps)
- [Config reference](#config-reference)
- [Using with Dependabot](#using-with-dependabot)
- [Backtest](#backtest)
- [Design decisions](#design-decisions)
- [Accepted risks](#accepted-risks)

To work on hall-pass itself, or add a classifier, see [CONTRIBUTING.md](CONTRIBUTING.md).

## Classifiers

Each classifier has its own page describing what it checks and every config option.

| Classifier | Kind | What it does |
|---|---|---|
| [`path-category`](src/classifiers/path-category/README.md) | eligibility | Puts a PR in a named category when every changed file matches that category's allowed paths, for example `docs-only`. |
| [`dependabot-safe`](src/classifiers/dependabot-safe/README.md) | eligibility | Qualifies Dependabot updates that only touch manifests and lockfiles and whose dependencies pass the configured rules, for example patch and minor bumps only. |

There are no veto classifiers yet. [How it decides](#how-it-decides) explains the two kinds.

## How it decides

There are two kinds of classifier:

| Kind | Results | Purpose |
|---|---|---|
| Eligibility | `eligible`, `abstain` | Puts the PR in a safe category |
| Veto | `veto`, `pass` | Blocks the PR whatever its category |

A PR **qualifies** when at least one *active* eligibility classifier returns `eligible` and no *active* classifier vetoes it.

Each classifier has a mode:

- `active`: its verdict counts.
- `shadow`: it runs and is reported, but the decision ignores it.
- `off`: it doesn't run.

The runner fails closed. The classifiers don't have to:

- A classifier that throws, or runs for more than 30 s, counts as a veto. In shadow mode the error is only reported.
- A result outside the classifier's kind counts as a veto. So does a malformed result.
- Invalid config, or an unknown classifier id, means hall-pass grants nothing (no approval, label, auto-merge or comment), takes back any approval or auto-merge it gave earlier, and fails the check run with the problem named.
- With no active eligibility classifier, nothing qualifies.
- Config is read from the PR's **base commit** through the API, so a PR can't change the config that judges it.
- The Action never checks out or runs PR code.

On every `pull_request` event (`opened`, `synchronize`, `reopened`, `ready_for_review`), the runner decides from scratch and makes GitHub match the decision:

1. Skips draft, closed and fork PRs, with a neutral check run.
2. Loads the config from the base commit. If there's no config file, it posts a neutral check run. If the config is invalid, it posts a failed check run. Either way it grants nothing and takes back anything it granted earlier. Draft and fork PRs are treated the same way.
3. Builds the PR context, with every page of files and commits, and runs every classifier that isn't `off`, in parallel.
4. Completes the `hall-pass` check run on the head SHA. The conclusion is `success` whenever the run completed, whether or not the PR qualified. It's `failure` only on a runtime or config error.
5. Creates or updates the sticky comment, found by `<!-- hall-pass -->`. It opens with one line, such as **Hall pass issued:** docs-only or **No hall pass:** touches api-contract, followed by a table of every classifier run. The check run title uses the same line. A vetoing classifier shows as `touches <id>`. One that errored shows as `<id> failed`.
6. Syncs the labels: it adds `hall-pass:<category>` and removes any other `hall-pass:` label.
7. If the PR qualifies, the App approves it (unless it already approved this head SHA) and turns on auto-merge. Auto-merge is pinned to the head SHA it judged, so a commit pushed mid-run can't inherit it. If the PR can already merge, see [`mergeWhenClean`](#config-reference). If it doesn't qualify, the App dismisses its own approvals and turns off auto-merge, but only if the App turned it on. It never touches a human's approval or a human's auto-merge.

`dry-run: true` keeps steps 4 and 5 and skips steps 6 and 7. If a write fails partway, the App dismisses its approval, turns off its auto-merge and fails the check run. Each run logs one JSON line (`{"tool":"hall-pass",...}`) so runs can be searched later.

## Markdown that is behaviour, not docs

Some `.md` files are instructions that a model or GitHub acts on. Changing one changes how the system behaves, even though it looks like prose. Examples:

- `SKILL.md` and anything under `skills/`
- `CLAUDE.md` and `AGENTS.md`
- `.cursor/rules/*.md` and `.claude/commands/*.md`
- `*.prompt.md`
- agent `instructions.md` files
- `.github/copilot-instructions.md` and PR templates

`path-category` and `dependabot-safe` share a built-in deny list for these, `BEHAVIOURAL_DENY` in `src/shared.ts`. It applies to **every** `path-category` category on top of the configured `deny`, it matches **case-insensitively** (so `skill.md`, `Skills.md` and `SKILL.md` all match), and **config can't turn it off**. A consumer's config can only make the classifier stricter. The list also covers `.github/**`, so workflow and template changes always go to a human.

| Covered | Globs |
|---|---|
| GitHub | `.github/**`, `**/.github/**` |
| Instruction files | `**/CLAUDE.md`, `**/CLAUDE.local.md`, `**/AGENTS.md`, `**/AGENT.md`, `**/GEMINI.md`, `**/SOUL.md`, `**/IDENTITY.md`, `**/MEMORY.md`, `**/HEARTBEAT.md`, `**/BOOTSTRAP.md`, `**/*instructions*.md(x)` |
| Skills | `**/SKILL.md`, `**/SKILLS.md`, `**/skills/**` |
| Prompts | `**/prompts/**`, `**/*.prompt.md(x)` |
| Agent definitions and assets | `**/agents/**` |
| Tool config directories | `**/.claude/**`, `**/.cursor/**`, `**/.cursorrules`, `**/.windsurf/**`, `**/.windsurfrules`, `**/.clinerules(/**)`, `**/.roo/**`, `**/.kiro/**`, `**/.continue/**`, `**/.codex/**`, `**/.gemini/**`, `**/.agents/**`, `**/.openclaw/**`, `**/.aider*` |

Renames are judged on both the old and the new path, so moving `.cursor/skills/x/SKILL.md` to `docs/x.md` doesn't qualify.

The list is deliberately broad. For example, `docs/agents/overview.md` is held back because it's under an `agents/` directory. A false "needs review" costs a few minutes. A false "auto-merge" changes how an agent behaves with nobody looking. If a backtest shows the list holding back plain docs in your repo, rename the directory or widen the list in code, through a reviewed PR to this repo.

Backtesting showed why the list is needed. In a real repository, pure-markdown PRs that only added `.agents/skills/*/SKILL.md` files would have been auto-merged under the example deny list alone. The built-in list held them back.

Path matching can't spot a behavioural file kept somewhere ordinary, such as a skill in `docs/foo.md` with skill frontmatter. That needs a content check. See [Adding a classifier](CONTRIBUTING.md#adding-a-classifier) for a veto classifier that would catch it.

## Consumer setup

A consumer repo needs six things, set up in this order.

### 1. Register the App (once per org or account)

Go to **Org settings › Developer settings › GitHub Apps › New GitHub App** and fill it in like this:

- **Name:** anything, for example `hall-pass-bot`. Reviews and comments appear as `<slug>[bot]`. The variable and secret below keep the names `MERGE_BOT_CLIENT_ID` and `MERGE_BOT_KEY` whatever you call the App.
- **Homepage URL:** anything, for example this repo's URL
- **Webhook:** untick **Active**. The App is only used as an identity.
- **Repository permissions:**
  - Pull requests: **Read and write**
  - Contents: **Read and write**
  - Checks: **Read and write**
  - Issues: **Read and write** (labels and comments on PRs go through the issues API)
  - Metadata: **Read** (set automatically)
- **Where can this GitHub App be installed?** Only on this account

Create the App, then:

These steps assume an organisation. On a personal account, register the App under your own Developer settings and add the variable and secret to each consumer repo instead.

1. Note the **Client ID** shown on the App's page (it starts `Iv`). Then go to **Org settings › Secrets and variables › Actions › Variables › New organization variable**. Name it `MERGE_BOT_CLIENT_ID`, give it the Client ID as its value, and grant access to the consumer repos.
2. On the App's page, **Generate a private key**. A `.pem` file downloads. Go to **Org settings › Secrets and variables › Actions › Secrets › New organization secret**. Name it `MERGE_BOT_KEY`, paste the whole `.pem` content, and limit **Repository access** to the consumer repos. Then delete the local `.pem`.
3. Go to **Install App › your-org › Only select repositories**, pick the consumer repos only, and confirm.

### 2. Let consumer repos use the Action (private copies only)

Skip this if you use the public `garfieldmoore/hall-pass`. If you run your own private copy, go to its **Settings › Actions › General › Access** and choose **Accessible from repositories in the organization** (or, on a personal account, **owned by the user**).

### 3. Repo settings

In the consumer repo, go to **Settings › General › Pull Requests** and tick **Allow auto-merge**. Keep at least the merge method you configure (squash by default) enabled.

### 4. Ruleset on the default branch

Go to **Settings › Rules › Rulesets › New branch ruleset**:

- **Target:** the default branch
- **Bypass list:** empty (or admins only)
- **Require a pull request before merging:**
  - Required approvals: **1**
  - **Dismiss stale pull request approvals when new commits are pushed:** on
  - **Require review from Code Owners:** **off**. The App can't satisfy it in v1.
- **Require status checks to pass:** add the CI checks. **This is a hard requirement before you set `mode: active`.** Auto-merge only waits for what the ruleset requires, so without required checks a qualifying PR merges as soon as it's approved, before CI has run. Don't add `hall-pass` itself: its conclusion is `success` whether or not the PR qualifies.
- **Block force pushes:** on
- Merge queue: optional

### 5. Add the workflow

Add this as `.github/workflows/hall-pass.yml`:

```yaml
name: hall-pass
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
permissions:
  contents: read
concurrency:
  group: hall-pass-${{ github.event.pull_request.number }}
  cancel-in-progress: true
jobs:
  classify:
    if: github.event.pull_request.head.repo.full_name == github.repository
    runs-on: ubuntu-latest
    steps:
      - uses: actions/create-github-app-token@v3
        id: app
        with:
          client-id: ${{ vars.MERGE_BOT_CLIENT_ID }}
          private-key: ${{ secrets.MERGE_BOT_KEY }}
      - uses: garfieldmoore/hall-pass@v1
        with:
          github-token: ${{ steps.app.outputs.token }}
```

### 6. Add the config, in shadow mode

Copy [`examples/hall-pass.yml`](examples/hall-pass.yml) to `.github/hall-pass.yml` and merge it to the default branch. The Action reads config from the base commit, so it has no effect until it's merged. Start every classifier in `mode: shadow`. [Run a backtest](#backtest), review the list of PRs that would qualify, then switch to `mode: active` in a separate PR.

## Config reference

```yaml
version: 1                 # required, must be 1

actions:                   # each write can be turned off on its own
  approve: true            # default false: the App approves qualifying PRs
  autoMerge: true          # default false: turn on auto-merge for qualifying PRs
  mergeMethod: squash      # squash | merge | rebase (default squash)
  mergeWhenClean: false    # default false: see below
  labels: true             # default true: hall-pass:<category> labels
  comment: true            # default true: sticky summary comment

classifiers:
  <classifier-id>:         # must be a registered id
    mode: shadow           # active | shadow | off (default shadow)
    ...                    # the classifier's own settings, checked against its schema
```

Unknown keys at any level are a config error.

**`mergeWhenClean`.** GitHub refuses to turn on auto-merge for a PR that can already merge, because there's nothing left to wait for. That happens when a repo requires no checks, or they've all finished by the time hall-pass approves. hall-pass asks GitHub for the PR's merge state first, and falls back on GitHub's error text if the state changes in between.

- `false` (default): the PR stays approved and the comment says a person needs to press merge.
- `true`: hall-pass merges it directly, pinned to the head SHA it judged. Only turn this on once the ruleset requires your CI checks. A PR whose non-required checks are failing (`UNSTABLE`) is never merged directly.

Each classifier's own settings are described on its page: see [Classifiers](#classifiers).

## Using with Dependabot

`dependabot-safe` lets Dependabot updates qualify. Start it in shadow mode, like every classifier. Three things need setting up.

### 1. A release-age delay

Don't merge brand-new releases on day one; let a release age a few days first, so a compromised or broken release is likely to be noticed and pulled. Dependabot's `cooldown` option does this in `.github/dependabot.yml`:

```yaml
version: 2
updates:
  - package-ecosystem: npm
    directory: "/"
    schedule:
      interval: daily
    cooldown:
      default-days: 3
```

Dependabot already applies a 3-day cooldown to version updates when `cooldown` isn't set. Setting it explicitly documents the choice and lets you lengthen it. Cooldown doesn't apply to **security** updates: those still arrive straight away. They follow the same `dependabot-safe` rules, so a security patch can merge without waiting.

### 2. Secrets

Workflows triggered by Dependabot PRs can't read normal Actions secrets, only **Dependabot secrets**. So the hall-pass workflow on a Dependabot PR can't see `MERGE_BOT_KEY` unless it's also stored as a Dependabot secret.

- Add the App's private key as a **Dependabot secret** with the same name, `MERGE_BOT_KEY`: **Settings › Secrets and variables › Dependabot › New repository secret**, or the org-level equivalent.
- Actions **variables** *are* readable in Dependabot-triggered runs, so `vars.MERGE_BOT_CLIENT_ID` needs no copy. (GitHub's docs don't say so; we confirmed it on a real Dependabot PR, where the token step received the Client ID but failed with "'private-key' input must be set" until the Dependabot secret existed.)

### 3. Rebases

When Dependabot rebases its PR, the force-push dismisses the old approval, because the ruleset dismisses stale approvals, and hall-pass re-approves the new head. This needs no extra configuration.

### 4. Docker base-image updates (optional)

Dependabot writes no `update-type` for Docker tag updates, so they abstain with `no update-type` by default. Set `inferDockerUpdateType: true` in the `dependabot-safe` config (and add your Dockerfiles to `allowedFiles`) to infer the type from the old and new tags in Dependabot's commit message, for example `python 3.12-slim → 3.15-slim` is a minor update. It is opt-in, applies only to `<branchPrefix>docker/` branches, and fails closed: tags it can't compare with certainty still abstain. See the [classifier page](src/classifiers/dependabot-safe/README.md#docker-updates-inferdockerupdatetype).

## Backtest

The backtest replays the classifiers over a repo's merged PRs without writing anything to GitHub. Classifiers in `shadow` mode are judged as if they were `active`.

```bash
npm ci && npm run build      # or use the committed dist/
GITHUB_TOKEN=$(gh auth token) node dist/backtest.js \
  --repo your-org/your-repo --last 300 --config ./hall-pass.yml --out report.json

# a single PR
GITHUB_TOKEN=$(gh auth token) node dist/backtest.js --repo your-org/your-repo --pr 1234 --config ./hall-pass.yml

# CSV for a spreadsheet
... --csv report.csv
```

It prints how many PRs would qualify, broken down by category, and how often each veto fired. Then it lists the qualifying PRs (number, category, files, `+/-`, author, title) for people to review by eye. The full per-PR results, including each classifier's evidence and notes, go to `--out` as JSON or `--csv` as CSV.

API responses are cached in `.backtest-cache/`. Merged PRs don't change, so reruns after a config change make no PR API calls. Use `--no-cache` to skip the cache. The CLI waits and retries when it's rate-limited.

To see what the built-in list held back:

```bash
jq -r '.results[] | select(.runs[].verdict.note // "" | contains("behavioural")) | "#\(.number) \(.title)"' report.json
```

## Design decisions

- **Built-in behavioural deny list.** It isn't configurable and applies to every `path-category` category. It also meets the rule that docs-only always denies `.github/**`. See [above](#markdown-that-is-behaviour-not-docs).
- **Case.** `allow` is case-sensitive and `deny` is case-insensitive. Either way, a doubtful path doesn't qualify.
- **Names.** The config file is `.github/hall-pass.yml` and the consumer workflow is `.github/workflows/hall-pass.yml`. The approving review's body is `Hall pass issued: <categories>`.
- **Defaults.** `actions.approve` and `actions.autoMerge` default to `false` and `mode` defaults to `shadow`, so a missing key never grants a write.
- **Check run lifecycle.** The run opens as `in_progress` before the classifiers run and completes afterwards. Creating it is also how the Action learns the App's login (`<app-slug>[bot]`), which it needs to find its own reviews and its own auto-merge. Skip, no-config and config-error runs post one completed check run.
- **Runtime errors after a valid config load**, such as an API failure or a PR with more files than the API returns, roll back the App's approval and auto-merge, then fail the check run.
- **No granting writes without a valid decision.** On config errors, missing config, and draft or fork PRs, hall-pass grants nothing but still takes back any approval or auto-merge the App gave earlier. Taking back is always safe; granting is not. Closed PRs are left alone. Dry-run never takes anything back.
- **Revoking ignores `actions.*`.** When a PR doesn't qualify, the App always takes back its own approval and auto-merge, even if `approve` or `autoMerge` has since been turned off. A flag change must never strand an approval.
- **A PR that is already mergeable.** GitHub refuses to turn on auto-merge for a PR that could merge right now. By default hall-pass leaves it approved for a person. With `mergeWhenClean: true` it merges directly, pinned to the head SHA it judged, and logs that it did. With a required merge queue that direct merge fails, and the run rolls back.
- **Auto-merge is pinned to the head SHA.** `enablePullRequestAutoMerge` gets `expectedHeadOid`, so a push that lands mid-run can't inherit auto-merge. This is a second layer on top of the ruleset's "dismiss stale approvals".
- **Truncated file lists.** The files API stops at 3000 files. If the PR reports more changed files than the API returned, that's a runtime error: no classifier judges part of a PR.
- **Fresh PR data.** The Action re-reads the PR from the API rather than trusting the event payload, which may be stale by the time a queued job starts.
- **"Last N merged" in the backtest.** The list API can't sort by merge time, so the backtest walks closed PRs by last update and keeps merged ones. PRs edited after merging can be slightly out of order.
- **Tests next to code.** Every module's tests sit beside it (`*.test.ts`), and each classifier is a folder holding its code, tests and README. This departs from the brief's separate `test/` tree; it keeps a classifier's rules, tests and docs in one place.
- **Runtime and bundle.** `node24` is the newest runtime GitHub Actions supports. The bundle is ESM built by esbuild. The workflow uses `actions/create-github-app-token@v3`, the current major.

## Accepted risks

- **The classifier is the only judge.** A wrong classifier merges a PR that nobody reviewed. The controls are shadow mode, backtests, fail-closed handling, reading config from the base commit, and the built-in deny list including `.github/**`. None of them is optional.
- **Workflow edits can use the token.** The workflow runs from the PR branch with `MERGE_BOT_KEY` available, so anyone with write access could edit a workflow in their PR to use the token directly. Denying `.github/**` stops the classifier approving such a PR, but it doesn't stop the edited workflow from running.
- **The App key is powerful.** It can approve and turn on auto-merge in any repo where the App is installed. Keep it an org secret limited to the consumer repos, and install the App only on those repos.
