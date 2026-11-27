// An in-memory stand-in for the slice of Octokit hall-pass uses. It keeps
// PR state (reviews, comments, labels, auto-merge, check runs) so tests can
// assert on the end state and on idempotency. No network.
import type { Octokit } from "../github.js";

export const BOT = "merge-bot[bot]";

export interface Review {
  id: number;
  user: { login: string };
  state: "APPROVED" | "DISMISSED" | "COMMENTED";
  commit_id: string;
  body: string;
}

export interface FakeState {
  configText: string | null; // null = no file on the base commit
  reviews: Review[];
  comments: { id: number; user: { login: string }; body: string }[];
  labels: string[];
  autoMergeBy: string | null; // GraphQL login, i.e. without [bot]
  checkRuns: { id: number; head_sha: string; status: string; conclusion?: string; title?: string; summary?: string }[];
  merged: boolean;
  calls: string[];
  fail: Partial<Record<string, Error>>; // method name -> error to throw
  autoMergeCleanStatus: boolean; // enablePullRequestAutoMerge fails with GitHub's "clean status" error
  mergeStateStatus: string; // what the GraphQL query reports (CLEAN, BLOCKED, UNSTABLE, ...)
  autoMergeVars: Record<string, unknown> | null; // variables of the last enable mutation
  mergedSha: string | null;
  getContentRefs: string[];
  checkRunNotYetVisible: number; // checks.update answers 404 this many times first
  actor: string; // who this client's writes are attributed to
}

export function fakeOctokit(init: Partial<FakeState> = {}) {
  const s: FakeState = {
    configText: null,
    reviews: [],
    comments: [],
    labels: [],
    autoMergeBy: null,
    checkRuns: [],
    merged: false,
    calls: [],
    fail: {},
    autoMergeCleanStatus: false,
    mergeStateStatus: "BLOCKED",
    autoMergeVars: null,
    mergedSha: null,
    getContentRefs: [],
    checkRunNotYetVisible: 0,
    actor: BOT,
    ...init,
  };
  let nextId = 1000;

  const call = (name: string) => {
    s.calls.push(name);
    const err = s.fail[name];
    if (err) throw err;
  };
  const notFound = () => Object.assign(new Error("Not Found"), { status: 404 });

  const rest = {
    repos: {
      async getContent(p: { ref: string; path: string }) {
        call("repos.getContent");
        s.getContentRefs.push(p.ref);
        if (s.configText === null) throw notFound();
        return { data: { type: "file", content: Buffer.from(s.configText).toString("base64") } };
      },
    },
    checks: {
      async create(p: { head_sha: string; status: string; conclusion?: string; output?: { title: string; summary: string } }) {
        call("checks.create");
        const run = { id: nextId++, head_sha: p.head_sha, status: p.status, conclusion: p.conclusion, title: p.output?.title, summary: p.output?.summary };
        s.checkRuns.push(run);
        return { data: { id: run.id, app: { slug: "merge-bot" } } };
      },
      async update(p: { check_run_id: number; conclusion: string; output: { title: string; summary: string } }) {
        call("checks.update");
        if (s.checkRunNotYetVisible > 0) {
          s.checkRunNotYetVisible--;
          throw notFound();
        }
        const run = s.checkRuns.find((r) => r.id === p.check_run_id);
        if (!run) throw notFound();
        Object.assign(run, { status: "completed", conclusion: p.conclusion, title: p.output.title, summary: p.output.summary });
        return { data: {} };
      },
    },
    issues: {
      async listComments() {
        call("issues.listComments");
        return { data: s.comments };
      },
      async createComment(p: { body: string }) {
        call("issues.createComment");
        s.comments.push({ id: nextId++, user: { login: BOT }, body: p.body });
        return { data: {} };
      },
      async updateComment(p: { comment_id: number; body: string }) {
        call("issues.updateComment");
        const c = s.comments.find((x) => x.id === p.comment_id);
        if (c) c.body = p.body;
        return { data: {} };
      },
      async listLabelsOnIssue() {
        call("issues.listLabelsOnIssue");
        return { data: s.labels.map((name) => ({ name })) };
      },
      async addLabels(p: { labels: string[] }) {
        call("issues.addLabels");
        for (const l of p.labels) if (!s.labels.includes(l)) s.labels.push(l);
        return { data: {} };
      },
      async removeLabel(p: { name: string }) {
        call("issues.removeLabel");
        if (!s.labels.includes(p.name)) throw notFound();
        s.labels = s.labels.filter((l) => l !== p.name);
        return { data: {} };
      },
    },
    pulls: {
      async listReviews() {
        call("pulls.listReviews");
        return { data: s.reviews };
      },
      async createReview(p: { commit_id: string; body: string }) {
        call("pulls.createReview");
        s.reviews.push({ id: nextId++, user: { login: s.actor }, state: "APPROVED", commit_id: p.commit_id, body: p.body });
        return { data: {} };
      },
      async dismissReview(p: { review_id: number }) {
        call("pulls.dismissReview");
        const r = s.reviews.find((x) => x.id === p.review_id);
        if (r) r.state = "DISMISSED";
        return { data: {} };
      },
      async merge(p: { sha: string }) {
        call("pulls.merge");
        s.merged = true;
        s.mergedSha = p.sha;
        return { data: {} };
      },
      async listFiles() {
        call("pulls.listFiles");
        return { data: [] };
      },
      async listCommits() {
        call("pulls.listCommits");
        return { data: [] };
      },
    },
  };

  async function paginate(method: (p: unknown) => Promise<{ data: unknown[] }>, params: unknown) {
    return (await method(params)).data;
  }

  // Mirror @octokit/graphql: these keys are request options, not GraphQL
  // variables. It rejects the first three outright and silently strips the rest.
  const OCTOKIT_RESERVED = ["method", "baseUrl", "url", "headers", "request", "query", "mediaType", "operationName"];

  async function graphql(query: string, vars: Record<string, unknown> = {}) {
    const clash = Object.keys(vars).find((k) => OCTOKIT_RESERVED.includes(k));
    if (clash) throw new Error(`[@octokit/graphql] "${clash}" cannot be used as variable name`);
    if (query.includes("enablePullRequestAutoMerge")) {
      call("graphql.enableAutoMerge");
      s.autoMergeVars = vars;
      if (s.autoMergeCleanStatus) throw new Error("Pull request Pull request is in clean status");
      s.autoMergeBy = "merge-bot";
      return {};
    }
    if (query.includes("disablePullRequestAutoMerge")) {
      call("graphql.disableAutoMerge");
      s.autoMergeBy = null;
      return {};
    }
    call("graphql.autoMergeState");
    return {
      repository: {
        pullRequest: {
          id: "PR_node",
          mergeStateStatus: s.mergeStateStatus,
          autoMergeRequest: s.autoMergeBy ? { enabledBy: { login: s.autoMergeBy } } : null,
        },
      },
    };
  }

  const octokit = { rest, paginate, graphql } as unknown as Octokit;
  return { octokit, state: s };
}
