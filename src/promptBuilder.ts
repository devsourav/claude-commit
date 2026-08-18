export interface BuildCommitPromptOptions {
  extraInstructions: string;
  truncated: boolean;
  diffStat: string;
  recentSubjects: string[];
}

export function buildCommitPrompt({
  extraInstructions,
  truncated,
  diffStat,
  recentSubjects,
}: BuildCommitPromptOptions): string {
  const blocks = [
    "Write a single git commit message for the diff piped to you via stdin.",
    [
      "Output ONLY the commit message text - no explanation, no markdown code",
      "fences, no surrounding quotes. Subject line under 72 characters. Add a",
      "short bullet-point body only if the change isn't trivial. Reference the",
      "actual files, modules, or functions touched - visible in the diff hunk",
      "headers and the stat summary below - instead of vague phrasing like",
      "'update logic'.",
    ].join(" "),
  ];

  if (diffStat) {
    blocks.push(`Files changed:\n${diffStat}`);
  }

  if (recentSubjects.length > 0) {
    blocks.push(
      [
        "Match the style of this repo's recent commit messages below",
        "(format, tense, use of prefixes/emoji, etc.) unless they're",
        "inconsistent with each other, in which case default to Conventional",
        "Commits style (type(scope): subject):",
      ].join(" ") +
        "\n" +
        recentSubjects.map((subject) => `- ${subject}`).join("\n")
    );
  } else {
    blocks.push(
      "This repo has no prior commit history to match, so default to Conventional Commits style: type(scope): subject."
    );
  }

  if (truncated) {
    blocks.push(
      "Note: the diff was truncated to fit a size limit, so it may be incomplete - do your best with what's shown."
    );
  }

  if (extraInstructions) {
    blocks.push(extraInstructions);
  }

  return blocks.join("\n\n");
}
