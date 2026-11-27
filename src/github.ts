// Every GitHub write hall-pass makes lives here. Classifiers never write.
import type { getOctokit } from "@actions/github";
import type { MergeMethod } from "./config.js";
import { sameActor } from "./shared.js";

export type Octokit = ReturnType<typeof getOctokit>;

export const CHECK_NAME = "hall-pass";
export const COMMENT_MARKER = "<!-- hall-pass -->";
export const LABEL_PREFIX = "hall-pass:";
const MAX_CHECK_TEXT = 65_000; // GitHub rejects check output over 65535 chars

export type CheckConclusion = "success" | "failure" | "neutral";

interface Repo {
  owner: string;
  name: string;
}

interface AutoMergeState {
  pullRequestId: string;
  mergeStateStatus: string; // CLEAN, BLOCKED, UNSTABLE, ... (GraphQL MergeStateStatus)
  enabledBy: string | null; // null when auto-merge is off
}

/** Merge states in which GitHub refuses to turn on auto-merge: the PR can merge right now. */
const MERGEABLE_NOW = new Set(["CLEAN", "HAS_HOOKS", "UNSTABLE"]);

export type AutoMergeOutcome = "enabled" | "already-on" | "merged" | "left-for-human";

/** How many times to retry completing a just-created check run that answers 404 (4 attempts at most). */
export const MAX_CHECK_RUN_RETRIES = 3;
/** Wait before retry n (0-based): 0.5 s, 1.5 s, 4.5 s, so about 6.5 s in total. */
export const checkRunRetryDelayMs = (retry: number) => 500 * 3 ** retry;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));


function truncate(s: string): string {
  return s.length <= MAX_CHECK_TEXT ? s : s.slice(0, MAX_CHECK_TEXT) + "\n\n…truncated";
}

export class GitHubOps {
  /** The App's own login ("slug[bot]"), learned from the first check run we create. */
  self: string | null = null;

  constructor(
    private readonly octokit: Octokit,
    private readonly repo: Repo,
    /**
     * Set only when the review must come from a user rather than the App. Reviews
     * then read and write through this client and this login, while check runs,
     * labels, the comment and auto-merge stay with the App — so each identity
     * only ever looks for work it did itself.
     */
    private readonly review?: { octokit: Octokit; login: string },
  ) {}

  /** The client reviews are read and written with: the review identity if there is one, else the App. */
  private get reviewOctokit(): Octokit {
    return this.review?.octokit ?? this.octokit;
  }

  /** Who an approval must belong to for hall-pass to call it its own, and to dismiss it. */
  private get reviewLogin(): string | null {
    return this.review ? this.review.login : this.self;
  }

  private get r() {
    return { owner: this.repo.owner, repo: this.repo.name };
  }

  // ---- check run -------------------------------------------------------

  async createCheckRun(headSha: string, conclusion: CheckConclusion, title: string, summary: string): Promise<number> {
    const res = await this.octokit.rest.checks.create({
      ...this.r,
      name: CHECK_NAME,
      head_sha: headSha,
      status: "completed",
      conclusion,
      output: { title: truncate(title).slice(0, 255), summary: truncate(summary) },
    });
    const slug = res.data.app?.slug;
    if (slug) this.self = `${slug}[bot]`;
    return res.data.id;
  }

  /** Open an in-progress check run. Also tells us who we are, before any review or auto-merge write. */
  async startCheckRun(headSha: string): Promise<number> {
    const res = await this.octokit.rest.checks.create({
      ...this.r,
      name: CHECK_NAME,
      head_sha: headSha,
      status: "in_progress",
    });
    const slug = res.data.app?.slug;
    if (slug) this.self = `${slug}[bot]`;
    return res.data.id;
  }

  /**
   * Complete a check run we created moments ago. GitHub sometimes answers
   * 404 for a check run created a second or two earlier (seen on real PRs),
   * so retry a 404 a few times before giving up.
   */
  async completeCheckRun(id: number, conclusion: CheckConclusion, title: string, summary: string): Promise<void> {
    const update = () =>
      this.octokit.rest.checks.update({
        ...this.r,
        check_run_id: id,
        status: "completed",
        conclusion,
        output: { title: truncate(title).slice(0, 255), summary: truncate(summary) },
      });
    for (let retry = 0; retry <= MAX_CHECK_RUN_RETRIES; retry++) {
      try {
        await update();
        return;
      } catch (e) {
        const notYetVisible = (e as { status?: number }).status === 404;
        const retriesLeft = retry < MAX_CHECK_RUN_RETRIES;
        if (!notYetVisible || !retriesLeft) throw e;
        await sleep(checkRunRetryDelayMs(retry));
      }
    }
  }

  // ---- sticky comment --------------------------------------------------

  async upsertComment(number: number, body: string): Promise<void> {
    const full = `${COMMENT_MARKER}\n${body}`;
    const comments = await this.octokit.paginate(this.octokit.rest.issues.listComments, {
      ...this.r,
      issue_number: number,
      per_page: 100,
    });
    const mine = comments.find(
      (c) => c.body?.includes(COMMENT_MARKER) && (this.self === null || sameActor(c.user?.login, this.self)),
    );
    if (!mine) {
      await this.octokit.rest.issues.createComment({ ...this.r, issue_number: number, body: full });
    } else if (mine.body !== full) {
      await this.octokit.rest.issues.updateComment({ ...this.r, comment_id: mine.id, body: full });
    }
  }

  // ---- labels ----------------------------------------------------------

  /** Make the PR's hall-pass: labels exactly `wanted`. Leaves every other label alone. */
  async syncLabels(number: number, categories: string[]): Promise<void> {
    const wanted = new Set(categories.map((c) => `${LABEL_PREFIX}${c}`));
    const current = (
      await this.octokit.paginate(this.octokit.rest.issues.listLabelsOnIssue, {
        ...this.r,
        issue_number: number,
        per_page: 100,
      })
    ).map((l) => l.name);

    const toAdd = [...wanted].filter((l) => !current.includes(l));
    const toRemove = current.filter((l) => l.startsWith(LABEL_PREFIX) && !wanted.has(l));

    if (toAdd.length) await this.octokit.rest.issues.addLabels({ ...this.r, issue_number: number, labels: toAdd });
    for (const name of toRemove) {
      try {
        await this.octokit.rest.issues.removeLabel({ ...this.r, issue_number: number, name });
      } catch (e) {
        if ((e as { status?: number }).status !== 404) throw e; // already gone is fine
      }
    }
  }

  // ---- reviews ---------------------------------------------------------

  private async myApprovals(number: number) {
    const login = this.reviewLogin;
    if (!login) throw new Error("Reviewer identity unknown; refusing to touch reviews");
    const reviews = await this.reviewOctokit.paginate(this.reviewOctokit.rest.pulls.listReviews, {
      ...this.r,
      pull_number: number,
      per_page: 100,
    });
    return reviews.filter((r) => r.state === "APPROVED" && sameActor(r.user?.login, login));
  }

  /** Approve, unless we already have an approval on this exact head SHA. Returns true if it approved. */
  async approve(number: number, headSha: string, body: string): Promise<boolean> {
    const mine = await this.myApprovals(number);
    if (mine.some((r) => r.commit_id === headSha)) return false;
    await this.reviewOctokit.rest.pulls.createReview({
      ...this.r,
      pull_number: number,
      commit_id: headSha,
      event: "APPROVE",
      body,
    });
    return true;
  }

  /** Dismiss every active approval hall-pass holds on this PR. Returns how many it dismissed. */
  async dismissApprovals(number: number, message: string): Promise<number> {
    const mine = await this.myApprovals(number);
    for (const r of mine) {
      await this.reviewOctokit.rest.pulls.dismissReview({ ...this.r, pull_number: number, review_id: r.id, message });
    }
    return mine.length;
  }

  // ---- auto-merge ------------------------------------------------------

  async autoMergeState(number: number): Promise<AutoMergeState> {
    const res = await this.octokit.graphql<{
      repository: {
        pullRequest: {
          id: string;
          mergeStateStatus: string;
          autoMergeRequest: { enabledBy: { login: string } | null } | null;
        };
      };
    }>(
      `query($owner: String!, $name: String!, $number: Int!) {
        repository(owner: $owner, name: $name) {
          pullRequest(number: $number) {
            id
            mergeStateStatus
            autoMergeRequest { enabledBy { login } }
          }
        }
      }`,
      { owner: this.repo.owner, name: this.repo.name, number },
    );
    const pr = res.repository.pullRequest;
    return {
      pullRequestId: pr.id,
      mergeStateStatus: pr.mergeStateStatus,
      enabledBy: pr.autoMergeRequest ? (pr.autoMergeRequest.enabledBy?.login ?? "(unknown)") : null,
    };
  }

  /**
   * Turn on auto-merge, pinned to headSha so a commit pushed mid-run can't
   * inherit it. Leaves it alone if anyone already turned it on.
   *
   * GitHub refuses auto-merge on a PR that can merge right now (nothing left
   * to wait for). Then: with mergeWhenClean, merge directly, pinned to
   * headSha; without it, leave the approved PR for a person to merge.
   */
  async enableAutoMerge(
    number: number,
    headSha: string,
    method: MergeMethod,
    mergeWhenClean: boolean,
  ): Promise<AutoMergeOutcome> {
    const state = await this.autoMergeState(number);
    if (state.enabledBy !== null) return "already-on";

    const mergeableNow = async (status: string): Promise<AutoMergeOutcome> => {
      if (mergeWhenClean && (status === "CLEAN" || status === "HAS_HOOKS")) {
        await this.octokit.rest.pulls.merge({ ...this.r, pull_number: number, sha: headSha, merge_method: method });
        return "merged";
      }
      return "left-for-human";
    };

    // Ask first rather than relying on GitHub's error text.
    if (MERGEABLE_NOW.has(state.mergeStateStatus)) return mergeableNow(state.mergeStateStatus);

    try {
      await this.octokit.graphql(
        // Variable names must not collide with Octokit's request options
        // (method, url, query, headers, ...): Octokit rejects or swallows them.
        `mutation($id: ID!, $mergeMethod: PullRequestMergeMethod!, $head: GitObjectID!) {
          enablePullRequestAutoMerge(input: { pullRequestId: $id, mergeMethod: $mergeMethod, expectedHeadOid: $head }) {
            pullRequest { number }
          }
        }`,
        { id: state.pullRequestId, mergeMethod: method.toUpperCase(), head: headSha },
      );
      return "enabled";
    } catch (e) {
      // The state can change between the query and the mutation (our own
      // approval may be what made it mergeable). Fall back to the error text.
      const m = /\b(clean|unstable|has_hooks) status\b/i.exec(String((e as Error).message));
      if (m?.[1]) return mergeableNow(m[1].toUpperCase());
      throw e;
    }
  }

  /** Turn off auto-merge, but only if hall-pass's App turned it on. Never touches a human's. */
  async disableOwnAutoMerge(number: number): Promise<boolean> {
    if (!this.self) throw new Error("App identity unknown; refusing to touch auto-merge");
    const state = await this.autoMergeState(number);
    if (state.enabledBy === null || !sameActor(state.enabledBy, this.self)) return false;
    await this.octokit.graphql(
      `mutation($id: ID!) {
        disablePullRequestAutoMerge(input: { pullRequestId: $id }) { pullRequest { number } }
      }`,
      { id: state.pullRequestId },
    );
    return true;
  }
}
