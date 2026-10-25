import { runGit } from "./gitExec";

export interface DiffResult {
  diff: string;
  staged: boolean;
}

// Generated/vendored files whose diff text costs a lot of tokens and says
// nothing about intent. They're left out of the diff body but still listed
// in the --stat summary, so the message can still mention e.g. a
// dependency bump.
const NOISY_PATHSPECS = [
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "Cargo.lock",
  "poetry.lock",
  "Gemfile.lock",
  "composer.lock",
  "go.sum",
  "*.min.js",
  "*.min.css",
  "*.map",
  "*.snap",
].map((p) => `:(exclude,glob)**/${p}`);

// One line of context per hunk instead of git's default three: plenty for
// summarizing a change, and it shrinks the prompt substantially.
const DIFF_ARGS = ["diff", "--unified=1", "--no-color"];

// Prefers the staged diff (what will actually be committed). Falls back to
// the full working-tree diff when nothing is staged, so the command is
// still useful for someone who hasn't run `git add` yet.
export async function getDiffToAnalyze(cwd: string): Promise<DiffResult> {
  const hasStaged = (await runGit(cwd, ["diff", "--cached", "--name-only"])).trim().length > 0;
  const scope = hasStaged ? ["--cached"] : [];
  const diff = await runGit(cwd, [...DIFF_ARGS, ...scope, "--", ".", ...NOISY_PATHSPECS]);
  if (diff.trim().length > 0) {
    return { diff, staged: hasStaged };
  }
  // Only noisy files changed (e.g. a lockfile-only commit): use them after all.
  return { diff: await runGit(cwd, [...DIFF_ARGS, ...scope]), staged: hasStaged };
}

// Diffstat summary (files touched, +/- counts) for the same scope as
// getDiffToAnalyze, used to give the commit-message prompt a cheap overview
// of blast radius alongside the raw diff text.
export async function getDiffStat(cwd: string, staged: boolean): Promise<string> {
  const args = staged ? ["diff", "--cached", "--stat"] : ["diff", "--stat"];
  return (await runGit(cwd, args)).trim();
}

// Samples the repo's actual commit style so the prompt can match it instead
// of always forcing Conventional Commits. Empty on a brand-new repo with no
// commits yet - that's an expected condition, not an error.
export async function getRecentSubjects(cwd: string, count = 8): Promise<string[]> {
  try {
    const out = await runGit(cwd, ["log", `-n`, String(count), "--pretty=%s"]);
    return out
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

export function truncateDiff(
  diff: string,
  maxChars: number
): { text: string; truncated: boolean } {
  if (diff.length <= maxChars) {
    return { text: diff, truncated: false };
  }
  return { text: diff.slice(0, maxChars), truncated: true };
}
