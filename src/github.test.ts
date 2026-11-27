import { describe, expect, it, vi } from "vitest";
import { GitHubOps, MAX_CHECK_RUN_RETRIES, checkRunRetryDelayMs } from "./github.js";
import { BOT, type Review, fakeOctokit } from "./testing/fake-octokit.js";

const repo = { owner: "example-org", name: "sandbox" };

async function complete(notYetVisible: number) {
  const fake = fakeOctokit({ checkRunNotYetVisible: notYetVisible });
  const ops = new GitHubOps(fake.octokit, repo);
  const id = await ops.startCheckRun("head1");
  vi.useFakeTimers();
  try {
    const p = ops.completeCheckRun(id, "success", "t", "s").then(
      () => "ok",
      (e: { status?: number }) => `threw ${e.status}`,
    );
    await vi.runAllTimersAsync();
    return { result: await p, updates: fake.state.calls.filter((c) => c === "checks.update").length };
  } finally {
    vi.useRealTimers();
  }
}

describe("completeCheckRun retries a 404 on a just-created check run", () => {
  it("retries 3 times, so 4 attempts at most, waiting 0.5 s, 1.5 s and 4.5 s", () => {
    expect(MAX_CHECK_RUN_RETRIES).toBe(3);
    expect([0, 1, 2].map(checkRunRetryDelayMs)).toEqual([500, 1500, 4500]);
  });

  it("succeeds on the last allowed attempt", async () => {
    expect(await complete(MAX_CHECK_RUN_RETRIES)).toEqual({ result: "ok", updates: 4 });
  });

  it("gives up after 4 attempts and rethrows the 404", async () => {
    expect(await complete(99)).toEqual({ result: "threw 404", updates: 4 });
  });

  it("doesn't retry when the first attempt works", async () => {
    expect(await complete(0)).toEqual({ result: "ok", updates: 1 });
  });
});


describe("review-token: the review is a user's, the check run stays the App's", () => {
  const USER = "lavanda-hallpass";

  /** App client for check runs and everything else; a separate client for reviews. */
  function split(reviews: Review[] = []) {
    const app = fakeOctokit();
    const user = fakeOctokit({ actor: USER, reviews });
    const ops = new GitHubOps(app.octokit, repo, { octokit: user.octokit, login: USER });
    return { app, user, ops };
  }

  it("approves as the user, and never writes a review with the App client", async () => {
    const { app, user, ops } = split();
    await ops.startCheckRun("head1");

    expect(await ops.approve(1, "head1", "Hall pass issued")).toBe(true);

    expect(user.state.reviews.map((r) => r.user.login)).toEqual([USER]);
    expect(app.state.calls).not.toContain("pulls.createReview");
    expect(app.state.reviews).toEqual([]);
    // The check run is still the App's work.
    expect(app.state.checkRuns).toHaveLength(1);
  });

  it("withdraws its own approval and leaves the App's alone", async () => {
    const { user, ops } = split([
      { id: 1, user: { login: USER }, state: "APPROVED", commit_id: "head1", body: "mine" },
      { id: 2, user: { login: BOT }, state: "APPROVED", commit_id: "head1", body: "the App's" },
    ]);
    await ops.startCheckRun("head1");

    expect(await ops.dismissApprovals(1, "withdrawn")).toBe(1);

    const byId = Object.fromEntries(user.state.reviews.map((r) => [r.id, r.state]));
    expect(byId).toEqual({ 1: "DISMISSED", 2: "APPROVED" });
  });

  it("does not approve twice on the same head", async () => {
    const { user, ops } = split([
      { id: 1, user: { login: USER }, state: "APPROVED", commit_id: "head1", body: "mine" },
    ]);
    await ops.startCheckRun("head1");

    expect(await ops.approve(1, "head1", "Hall pass issued")).toBe(false);
    expect(user.state.reviews).toHaveLength(1);
  });

  it("without a review token, reviews stay with the App exactly as before", async () => {
    const app = fakeOctokit();
    const ops = new GitHubOps(app.octokit, repo);
    await ops.startCheckRun("head1");

    expect(await ops.approve(1, "head1", "Hall pass issued")).toBe(true);
    expect(app.state.reviews.map((r) => r.user.login)).toEqual([BOT]);
  });

  it("refuses to touch reviews before the reviewer identity is known", async () => {
    const app = fakeOctokit();
    const ops = new GitHubOps(app.octokit, repo); // no check run yet, so self is null
    await expect(ops.approve(1, "head1", "x")).rejects.toThrow(/Reviewer identity unknown/);
  });
});
