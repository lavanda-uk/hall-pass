import { describe, expect, it } from "vitest";
import { classifiers as registry } from "../index.js";
import { parseConfig } from "../../config.js";
import type { PrCommit, PrContext, PrFile } from "../../types.js";
import { modified, prContext, renamed } from "../../testing/pr-context.js";
import { dependabotSafe, dependabotSafeConfigSchema } from "./index.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const cfg = dependabotSafeConfigSchema.parse({
  botLogins: ["dependabot[bot]"],
  allowedCommitters: ["web-flow"],
  branchPrefix: "dependabot/",
  allowedUpdateTypes: ["version-update:semver-patch"],
  allowPreOneZero: false,
  denyPackages: ["@apollo/*", "graphql"],
  allowedFiles: ["**/package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock"],
});

interface Dep {
  name: string;
  version?: string;
  type?: string;
  updateType?: string;
}

const patch = (name: string, version = "4.17.21"): Dep => ({
  name,
  version,
  type: "direct:production",
  updateType: "version-update:semver-patch",
});

function message(deps: Dep[], body = ""): string {
  const entries = deps
    .map((d) =>
      [
        // Dependabot quotes names YAML would misread, such as scoped @org/pkg names.
        `- dependency-name: ${d.name.startsWith("@") ? JSON.stringify(d.name) : d.name}`,
        d.version !== undefined ? `  dependency-version: ${d.version}` : null,
        d.type !== undefined ? `  dependency-type: ${d.type}` : null,
        d.updateType !== undefined ? `  update-type: ${d.updateType}` : null,
      ]
        .filter(Boolean)
        .join("\n"),
    )
    .join("\n");
  return `Bump ${deps.map((d) => d.name).join(", ")}\n\n${body}---\nupdated-dependencies:\n${entries}\n...\n\nSigned-off-by: dependabot[bot] <support@github.com>`;
}

function commit(deps: Dep[], over: Partial<PrCommit> = {}, body = ""): PrCommit {
  return { sha: "abc1234def", authorLogin: "dependabot[bot]", committerLogin: "web-flow", message: message(deps, body), ...over };
}

function dependabotPr(over: Partial<PrContext> = {}): PrContext {
  return prContext({
    author: "dependabot[bot]",
    headRef: "dependabot/npm_and_yarn/lodash-4.17.21",
    commits: [commit([patch("lodash")])],
    files: [modified("package.json"), modified("pnpm-lock.yaml")],
    ...over,
  });
}

const run = (ctx: PrContext) => dependabotSafe.run(ctx, cfg);
const note = async (ctx: PrContext) => {
  const v = await run(ctx);
  expect(v.result).toBe("abstain");
  return v.result === "abstain" ? (v.note ?? "") : "";
};

// ---------------------------------------------------------------------------
// Eligible
// ---------------------------------------------------------------------------

describe("dependabot-safe: eligible", () => {
  it("a patch bump of lodash changing package.json and pnpm-lock.yaml", async () => {
    expect(await run(dependabotPr())).toEqual({
      result: "eligible",
      category: "dependabot-safe",
      evidence: ["lodash → 4.17.21 (semver-patch, direct:production)"],
    });
  });

  it("committer web-flow with author dependabot[bot]", async () => {
    const v = await run(dependabotPr({ commits: [commit([patch("lodash")], { committerLogin: "web-flow" })] }));
    expect(v.result).toBe("eligible");
  });

  it("committer dependabot[bot] itself", async () => {
    const v = await run(dependabotPr({ commits: [commit([patch("lodash")], { committerLogin: "dependabot[bot]" })] }));
    expect(v.result).toBe("eligible");
  });

  it("a grouped update where every dependency is a patch", async () => {
    const v = await run(dependabotPr({ commits: [commit([patch("express", "4.21.2"), patch("uuid", "9.0.1"), patch("body-parser", "1.20.3")])] }));
    expect(v.result).toBe("eligible");
    expect(v.result === "eligible" && v.evidence).toHaveLength(3);
  });

  it("a workspace manifest: packages/api/package.json", async () => {
    const v = await run(dependabotPr({ files: [modified("packages/api/package.json"), modified("pnpm-lock.yaml")] }));
    expect(v.result).toBe("eligible");
  });

  it("logins compare like sameActor: GraphQL-style 'dependabot' matches 'dependabot[bot]'", async () => {
    expect((await run(dependabotPr({ author: "dependabot" }))).result).toBe("eligible");
  });
});

// ---------------------------------------------------------------------------
// Abstain
// ---------------------------------------------------------------------------

describe("dependabot-safe: abstain", () => {
  it("one commit authored by a human", async () => {
    const commits = [commit([patch("lodash")]), commit([patch("lodash")], { sha: "fff0000aaa", authorLogin: "alice" })];
    expect(await note(dependabotPr({ commits }))).toContain("commit fff0000: authored by alice");
  });

  it("human author with committer web-flow (e.g. a web edit)", async () => {
    expect(await note(dependabotPr({ commits: [commit([patch("lodash")], { authorLogin: "alice", committerLogin: "web-flow" })] }))).toContain(
      "authored by alice",
    );
  });

  it("a human committer", async () => {
    expect(await note(dependabotPr({ commits: [commit([patch("lodash")], { committerLogin: "alice" })] }))).toContain("committed by alice");
  });

  it("null commit author", async () => {
    expect(await note(dependabotPr({ commits: [commit([patch("lodash")], { authorLogin: null })] }))).toContain("author has no GitHub login");
  });

  it("null commit committer", async () => {
    expect(await note(dependabotPr({ commits: [commit([patch("lodash")], { committerLogin: null })] }))).toContain(
      "committer has no GitHub login",
    );
  });

  it("a minor update when only patch is allowed", async () => {
    const dep = { ...patch("lodash", "4.18.0"), updateType: "version-update:semver-minor" };
    expect(await note(dependabotPr({ commits: [commit([dep])] }))).toContain("lodash: version-update:semver-minor is not allowed");
  });

  it("a major update when only patch is allowed", async () => {
    const dep = { ...patch("lodash", "5.0.0"), updateType: "version-update:semver-major" };
    expect(await note(dependabotPr({ commits: [commit([dep])] }))).toContain("semver-major is not allowed");
  });

  it("a grouped update with one minor among the patches", async () => {
    const deps = [patch("express", "4.21.2"), { ...patch("uuid", "9.1.0"), updateType: "version-update:semver-minor" }, patch("body-parser", "1.20.3")];
    const n = await note(dependabotPr({ commits: [commit(deps)] }));
    expect(n).toContain("uuid: version-update:semver-minor is not allowed");
    expect(n).not.toContain("express");
  });

  it("an entry with no update-type", async () => {
    expect(await note(dependabotPr({ commits: [commit([{ name: "lodash", version: "4.17.21" }])] }))).toContain("lodash: no update-type");
  });

  it("a dependency matching denyPackages (@apollo/server)", async () => {
    expect(await note(dependabotPr({ commits: [commit([patch("@apollo/server", "4.11.1")])] }))).toContain("@apollo/server: package is denied");
  });

  it("an exact denyPackages name (graphql)", async () => {
    expect(await note(dependabotPr({ commits: [commit([patch("graphql", "16.9.1")])] }))).toContain("graphql: package is denied");
  });

  it("new version 0.4.2 with allowPreOneZero: false", async () => {
    expect(await note(dependabotPr({ commits: [commit([patch("tiny-lib", "0.4.2")])] }))).toContain("tiny-lib: 0.4.2 is pre-1.0");
  });

  it("0.4.2 is fine with allowPreOneZero: true", async () => {
    const v = await dependabotSafe.run(dependabotPr({ commits: [commit([patch("tiny-lib", "0.4.2")])] }), { ...cfg, allowPreOneZero: true });
    expect(v.result).toBe("eligible");
  });

  it("a missing dependency-version fails while allowPreOneZero is false", async () => {
    const dep = { name: "lodash", updateType: "version-update:semver-patch" };
    expect(await note(dependabotPr({ commits: [commit([dep])] }))).toContain("lodash: no dependency-version");
  });

  it("a commit message without a metadata block", async () => {
    expect(await note(dependabotPr({ commits: [commit([], { message: "Bump lodash\n\nNo block." })] }))).toContain(
      "no updated-dependencies block",
    );
  });

  it("a block that lists no dependencies", async () => {
    const msg = "Bump\n\n---\nupdated-dependencies: []\n...\n";
    expect(await note(dependabotPr({ commits: [commit([], { message: msg })] }))).toContain("metadata lists no dependencies");
  });

  it("a branch not starting with dependabot/", async () => {
    expect(await note(dependabotPr({ headRef: "renovate/lodash" }))).toContain("branch renovate/lodash does not start with dependabot/");
  });

  it("a human-authored PR on a dependabot/ branch", async () => {
    expect(await note(dependabotPr({ author: "alice" }))).toContain("PR author alice is not a Dependabot login");
  });

  it("a GitHub Actions update changing .github/workflows/ci.yml (behavioural deny)", async () => {
    const ctx = dependabotPr({
      headRef: "dependabot/github_actions/actions/checkout-7.0.2",
      files: [modified(".github/workflows/ci.yml")],
      commits: [commit([{ ...patch("actions/checkout", "7.0.2"), type: "direct:production" }])],
    });
    expect(await note(ctx)).toContain(".github/workflows/ci.yml: behavioural file (built-in deny)");
  });

  it("behavioural deny can't be allowed away by config", async () => {
    const v = await dependabotSafe.run(dependabotPr({ files: [modified(".github/workflows/ci.yml")] }), { ...cfg, allowedFiles: ["**"] });
    expect(v.result).toBe("abstain");
  });

  it("a source file changed alongside the lockfile", async () => {
    expect(await note(dependabotPr({ files: [modified("pnpm-lock.yaml"), modified("src/index.ts")] }))).toContain(
      "src/index.ts: not in allowedFiles",
    );
  });

  it("allowedFiles is case-sensitive", async () => {
    expect(await note(dependabotPr({ files: [modified("Package.json")] }))).toContain("Package.json: not in allowedFiles");
  });

  it("a rename is judged on both ends", async () => {
    expect(await note(dependabotPr({ files: [renamed("src/x.json", "package.json")] }))).toContain("src/x.json: not in allowedFiles");
  });

  it("no changed files", async () => {
    expect(await note(dependabotPr({ files: [] as PrFile[] }))).toContain("no changed files");
  });

  it("no commits", async () => {
    expect(await note(dependabotPr({ commits: [] }))).toContain("no commits");
  });

  it("multiple failures: the note lists all of them", async () => {
    const n = await note(
      dependabotPr({
        author: "alice",
        headRef: "feature/x",
        commits: [commit([{ ...patch("@apollo/server", "0.1.0"), updateType: "version-update:semver-major" }], { authorLogin: "alice" })],
        files: [modified("src/index.ts")],
      }),
    );
    for (const expected of [
      "PR author alice",
      "branch feature/x",
      "authored by alice",
      "semver-major is not allowed",
      "@apollo/server: package is denied",
      "0.1.0 is pre-1.0",
      "src/index.ts: not in allowedFiles",
    ]) {
      expect(n).toContain(expected);
    }
  });

  it("the note is capped at 10 reasons", async () => {
    const files = Array.from({ length: 15 }, (_, i) => modified(`src/f${i}.ts`));
    expect(await note(dependabotPr({ files }))).toContain("…and 5 more");
  });
});

// ---------------------------------------------------------------------------
// inferDockerUpdateType
// ---------------------------------------------------------------------------

describe("dependabot-safe: inferDockerUpdateType", () => {
  // lavanda-uk/clotho PR #213: Dependabot gives a Docker tag update no update-type.
  const python = { name: "python", version: "3.15-slim", type: "direct:production" };
  const dockerPr = (over: Partial<PrContext> = {}) =>
    dependabotPr({
      headRef: "dependabot/docker/ui/python-3.15-slim",
      commits: [commit([python], {}, "Bumps python from 3.12-slim to 3.15-slim.\n\n")],
      files: [modified("ui/Dockerfile")],
      ...over,
    });
  const dockerCfg = (infer: boolean, types: string[] = ["version-update:semver-patch", "version-update:semver-minor"]) =>
    dependabotSafeConfigSchema.parse({
      botLogins: ["dependabot[bot]"],
      allowedCommitters: ["web-flow"],
      branchPrefix: "dependabot/",
      allowedUpdateTypes: types,
      allowedFiles: ["**/Dockerfile"],
      ...(infer ? { inferDockerUpdateType: true } : {}),
    });
  const verdict = (ctx: PrContext, c: ReturnType<typeof dockerCfg>) => dependabotSafe.run(ctx, c);

  it("on: the clotho #213 python 3.12-slim → 3.15-slim update is eligible, marked inferred", async () => {
    expect(await verdict(dockerPr(), dockerCfg(true))).toEqual({
      result: "eligible",
      category: "dependabot-safe",
      evidence: ["python → 3.15-slim (semver-minor inferred, direct:production)"],
    });
  });

  it("off (the default): the same PR abstains with no update-type", async () => {
    const v = await verdict(dockerPr(), dockerCfg(false));
    expect(v.result).toBe("abstain");
    expect(v.result === "abstain" && v.note).toContain("python: no update-type");
  });

  it("on, but not a docker/ branch: abstains with no update-type", async () => {
    const v = await verdict(dockerPr({ headRef: "dependabot/npm_and_yarn/ui/python-3.15-slim" }), dockerCfg(true));
    expect(v.result).toBe("abstain");
    expect(v.result === "abstain" && v.note).toContain("python: no update-type");
  });

  it("on, but the tags can't be compared: abstains with no update-type", async () => {
    const ctx = dockerPr({ commits: [commit([python], {}, "Bumps python from bookworm to trixie.\n\n")] });
    const v = await verdict(ctx, dockerCfg(true));
    expect(v.result === "abstain" && v.note).toContain("python: no update-type");
  });

  it("on: an inferred major not in allowedUpdateTypes abstains", async () => {
    const ctx = dockerPr({ commits: [commit([{ ...python, version: "4.0-slim" }], {}, "Bumps python from 3.12-slim to 4.0-slim.\n\n")] });
    const v = await verdict(ctx, dockerCfg(true));
    expect(v.result).toBe("abstain");
    expect(v.result === "abstain" && v.note).toContain("python: version-update:semver-major is not allowed");
  });

  it("on: a Dependabot-supplied update-type wins over the inferred one", async () => {
    const supplied = { ...python, updateType: "version-update:semver-major" };
    const v = await verdict(dockerPr({ commits: [commit([supplied], {}, "Bumps python from 3.12-slim to 3.15-slim.\n\n")] }), dockerCfg(true));
    expect(v.result === "abstain" && v.note).toContain("python: version-update:semver-major is not allowed");
  });
});

// ---------------------------------------------------------------------------
// Config, through parseConfig
// ---------------------------------------------------------------------------

describe("dependabot-safe config", () => {
  const block = (body: string) => `version: 1\nclassifiers:\n  dependabot-safe:\n    mode: shadow\n${body}`;
  const valid = `    botLogins: ["dependabot[bot]"]
    branchPrefix: "dependabot/"
    allowedUpdateTypes: ["version-update:semver-patch"]
    allowedFiles: ["**/package.json"]
`;

  it("a valid block parses, with defaults filled in", () => {
    const r = parseConfig(block(valid), registry);
    expect(r.kind).toBe("ok");
    const c = r.kind === "ok" ? r.config.classifiers.find((x) => x.classifier.id === "dependabot-safe") : undefined;
    expect(c?.cfg).toMatchObject({ allowedCommitters: [], allowPreOneZero: false, denyPackages: [], inferDockerUpdateType: false });
  });

  it("inferDockerUpdateType: true parses", () => {
    const r = parseConfig(block(valid + "    inferDockerUpdateType: true\n"), registry);
    const c = r.kind === "ok" ? r.config.classifiers.find((x) => x.classifier.id === "dependabot-safe") : undefined;
    expect(c?.cfg).toMatchObject({ inferDockerUpdateType: true });
  });

  it.each([
    ["missing botLogins", valid.replace(`    botLogins: ["dependabot[bot]"]\n`, "")],
    ["empty allowedUpdateTypes", valid.replace(`["version-update:semver-patch"]`, "[]")],
    ["an invalid update type", valid.replace("version-update:semver-patch", "version-update:any")],
    ["an unknown key", valid + "    surprise: true\n"],
    ["empty allowedFiles", valid.replace(`["**/package.json"]`, "[]")],
    ["a non-boolean inferDockerUpdateType", valid + "    inferDockerUpdateType: yes please\n"],
  ])("%s is a config error", (_, body) => {
    expect(parseConfig(block(body), registry).kind).toBe("error");
  });
});
