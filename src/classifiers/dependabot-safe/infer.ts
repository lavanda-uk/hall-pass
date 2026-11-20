// Dependabot writes no `update-type` into the metadata block for Docker tag
// updates. This derives one from the old and new tags in the commit message:
//
//   Bumps python from 3.12-slim to 3.15-slim.
//   Updates `python` from 3.12-slim to 3.13-slim      (grouped updates)
//
// It fails closed: anything it can't read with certainty gives `undefined`.

const TAG = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(.*)$/;
const LEVELS = ["version-update:semver-major", "version-update:semver-minor", "version-update:semver-patch"] as const;

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Every distinct (from, to) tag pair the message gives for `name`. */
function tagPairs(message: string, name: string): [string, string][] {
  const n = escapeRegExp(name);
  const re = new RegExp(`(?:^|\\s)(?:Bumps ${n}|Updates \`${n}\`) from (\\S+) to (\\S+)`, "gm");
  const pairs = new Map<string, [string, string]>();
  for (const m of message.matchAll(re)) {
    const from = (m[1] ?? "").replace(/\.$/, "");
    const to = (m[2] ?? "").replace(/\.$/, "");
    pairs.set(`${from}\n${to}`, [from, to]);
  }
  return [...pairs.values()];
}

/** Numeric components and suffix of a tag, or null if it isn't a version. */
function parseTag(tag: string): { nums: number[]; suffix: string } | null {
  const m = TAG.exec(tag);
  if (!m) return null;
  const nums = [m[1], m[2], m[3]].filter((x): x is string => x !== undefined).map(Number);
  return { nums, suffix: m[4] ?? "" };
}

/**
 * The semver update-type of the Docker update to `name` described in a
 * Dependabot commit message, or undefined when it can't be inferred safely.
 * Never throws.
 */
export function inferDockerUpdateType(message: string, name: string): string | undefined {
  try {
    const pairs = tagPairs(message, name);
    if (pairs.length !== 1) return undefined;
    const [from, to] = pairs[0]!;
    if (from.includes("@") || to.includes("@")) return undefined;

    const a = parseTag(from);
    const b = parseTag(to);
    if (!a || !b || a.nums.length !== b.nums.length || a.suffix !== b.suffix) return undefined;

    for (let i = 0; i < a.nums.length; i++) {
      if (b.nums[i]! > a.nums[i]!) return LEVELS[i];
      if (b.nums[i]! < a.nums[i]!) return undefined;
    }
    return undefined; // equal
  } catch {
    return undefined;
  }
}
