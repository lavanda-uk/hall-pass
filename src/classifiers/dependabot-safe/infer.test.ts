import { describe, expect, it } from "vitest";
import { inferDockerUpdateType } from "./infer.js";

// lavanda-uk/clotho PR #213: a single Docker base-image update, which carries no update-type.
const clotho213 = `Bump python from 3.12-slim to 3.15-slim in /ui

Bumps python from 3.12-slim to 3.15-slim.

---
updated-dependencies:
- dependency-name: python
  dependency-version: 3.15-slim
  dependency-type: direct:production
...

Signed-off-by: dependabot[bot] <support@github.com>`;

const bumps = (name: string, from: string, to: string) => `Bump ${name}\n\nBumps ${name} from ${from} to ${to}.\n`;

describe("inferDockerUpdateType", () => {
  it("the clotho #213 message: 3.12-slim → 3.15-slim is minor", () => {
    expect(inferDockerUpdateType(clotho213, "python")).toBe("version-update:semver-minor");
  });

  it.each([
    ["3.12.1-slim", "3.12.2-slim", "version-update:semver-patch"],
    ["20", "22", "version-update:semver-major"],
    ["1.27", "2.0", "version-update:semver-major"],
    ["v1.2.3", "v1.3.0", "version-update:semver-minor"],
    ["3.12-alpine3.20", "3.13-alpine3.20", "version-update:semver-minor"],
  ])("%s → %s is %s", (from, to, want) => {
    expect(inferDockerUpdateType(bumps("node", from, to), "node")).toBe(want);
  });

  it.each([
    ["component count differs", "3.12-slim", "3.12.1-slim"],
    ["suffix differs", "3.12-slim", "3.13-alpine"],
    ["not a version", "bookworm", "trixie"],
    ["a downgrade", "3.13", "3.12"],
    ["no change", "3.13", "3.13"],
    ["a digest tag", "3.12-slim@sha256:aaaa", "3.13-slim@sha256:bbbb"],
  ])("%s: undefined", (_, from, to) => {
    expect(inferDockerUpdateType(bumps("python", from, to), "python")).toBeUndefined();
  });

  it("two conflicting from … to … lines for the same name: undefined", () => {
    const msg = `${bumps("python", "3.12-slim", "3.13-slim")}Bumps python from 3.12-slim to 3.15-slim.\n`;
    expect(inferDockerUpdateType(msg, "python")).toBeUndefined();
  });

  it("the same pair repeated (title and body) is one pair", () => {
    const msg = `Bumps python from 3.12-slim to 3.13-slim\n\nBumps python from 3.12-slim to 3.13-slim.\n`;
    expect(inferDockerUpdateType(msg, "python")).toBe("version-update:semver-minor");
  });

  it("the grouped `Updates `name` from …` form", () => {
    const msg = `Bump the docker group with 2 updates\n\nUpdates \`python\` from 3.12-slim to 3.13-slim\nUpdates \`node\` from 20 to 22\n`;
    expect(inferDockerUpdateType(msg, "python")).toBe("version-update:semver-minor");
    expect(inferDockerUpdateType(msg, "node")).toBe("version-update:semver-major");
  });

  it("only the named dependency is read", () => {
    expect(inferDockerUpdateType(bumps("python", "3.12", "3.13"), "node")).toBeUndefined();
    expect(inferDockerUpdateType(bumps("python", "3.12", "3.13"), "py")).toBeUndefined();
  });

  it("a name with regex metacharacters is matched literally", () => {
    const name = "ghcr.io/org/img+x";
    expect(inferDockerUpdateType(bumps(name, "1.0.0", "1.0.1"), name)).toBe("version-update:semver-patch");
    expect(inferDockerUpdateType(bumps("ghcrXio/org/img+x", "1.0.0", "1.0.1"), name)).toBeUndefined();
  });

  it("no from … to … line: undefined", () => {
    expect(inferDockerUpdateType("Bump python\n\nNo body.", "python")).toBeUndefined();
    expect(inferDockerUpdateType("", "python")).toBeUndefined();
  });
});
