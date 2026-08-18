import { runGit } from "./gitExec";

export interface DiffResult {
  diff: string;
  staged: boolean;
}

// Prefers the staged diff (what will actually be committed). Falls back to
// the full working-tree diff when nothing is staged, so the command is
// still useful for someone who hasn't run `git add` yet.
export async function getDiffToAnalyze(cwd: string): Promise<DiffResult> {
  const staged = await runGit(cwd, ["diff", "--cached"]);
  if (staged.trim().length > 0) {
    return { diff: staged, staged: true };
  }

  const unstaged = await runGit(cwd, ["diff"]);
  return { diff: unstaged, staged: false };
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
