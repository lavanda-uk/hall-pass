// Action entry: read inputs, hand the event to the runner, set outputs.
import * as core from "@actions/core";
import { context, getOctokit } from "@actions/github";
import { classifiers } from "./classifiers/index.js";
import { loadConfig } from "./config.js";
import { buildPrContext, type PullLike } from "./context.js";
import { GitHubOps, type Octokit } from "./github.js";
import { runPullRequest } from "./runner.js";

const EVENTS = new Set(["opened", "synchronize", "reopened", "ready_for_review"]);

/** Who review-token belongs to. Asked of GitHub rather than configured, so it cannot drift. */
async function reviewIdentity(token: string): Promise<{ octokit: Octokit; login: string }> {
  const octokit = getOctokit(token);
  try {
    const { data: me } = await octokit.rest.users.getAuthenticated();
    return { octokit, login: me.login };
  } catch (e) {
    // An installation token authenticates as the App, not as anyone, so GET /user
    // refuses it. Passing github-token here is the likely mistake, and it is not a
    // fallback: an App's review is what review-token exists to avoid.
    if ((e as { status?: number }).status === 403) {
      throw new Error(
        "review-token could not identify itself as a user. A GitHub App installation token cannot be used here — leave review-token unset to let the App review.",
        { cause: e },
      );
    }
    throw e;
  }
}

async function main(): Promise<void> {
  const token = core.getInput("github-token", { required: true });
  const reviewToken = core.getInput("review-token");
  const configPath = core.getInput("config") || ".github/hall-pass.yml";
  const dryRun = core.getBooleanInput("dry-run");

  if (context.eventName !== "pull_request" || !EVENTS.has(String(context.payload.action))) {
    core.info(`Ignoring ${context.eventName}.${context.payload.action ?? ""}: hall-pass runs on pull_request ${[...EVENTS].join("/")}.`);
    core.setOutput("eligible", "false");
    core.setOutput("categories", "[]");
    return;
  }

  const octokit = getOctokit(token);
  // Resolved before any write: an approval hall-pass cannot later recognise is an
  // approval it cannot withdraw, so failing here is better than granting one.
  const review = reviewToken ? await reviewIdentity(reviewToken) : undefined;
  const repo = { owner: context.repo.owner, name: context.repo.repo };
  // Re-read the PR rather than trusting the event payload, which can be stale
  // by the time a queued job starts.
  const number = (context.payload.pull_request as { number: number }).number;
  const { data: pull } = await octokit.rest.pulls.get({ owner: repo.owner, repo: repo.name, pull_number: number });

  const outcome = await runPullRequest({
    pull: pull as PullLike,
    repo,
    dryRun,
    ops: new GitHubOps(octokit, repo, review),
    loadConfig: (baseSha) => loadConfig(octokit, repo, baseSha, configPath, classifiers),
    buildContext: () => buildPrContext(octokit, repo, pull as PullLike),
    log: core,
  });

  const decision = "decision" in outcome ? outcome.decision : undefined;
  core.setOutput("eligible", String(outcome.status === "decided" && outcome.decision.eligible));
  core.setOutput("categories", JSON.stringify(outcome.status === "decided" ? outcome.decision.categories : []));
  if (decision) core.setOutput("decision", JSON.stringify(decision));

  if (outcome.status === "config-error" || outcome.status === "error") core.setFailed(outcome.message);
}

main().catch((e: unknown) => core.setFailed(e instanceof Error ? e.message : String(e)));
