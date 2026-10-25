import { checkToolUse } from "./safety";

// PreToolUse hook, run by the `claude` CLI (registered via --settings in
// chat.ts) before every Edit/Write/NotebookEdit/Bash call in the Team Pool
// chat, in every permission mode. Reads the hook payload on stdin and
// answers with Claude Code's hook JSON: deny (blocked, Claude sees why) or
// ask (forces the approval card). No output means "no objection" and the
// normal permission flow continues.
let raw = "";
process.stdin.on("data", (chunk) => {
  raw += chunk.toString();
});
process.stdin.on("end", () => {
  let payload: { tool_name?: string; tool_input?: Record<string, unknown>; cwd?: string };
  try {
    payload = JSON.parse(raw);
  } catch {
    return;
  }
  const repoRoot = process.env.CLAUDE_COMMIT_REPO_ROOT || payload.cwd || process.cwd();
  const verdict = checkToolUse(payload.tool_name ?? "", payload.tool_input ?? {}, repoRoot);
  if (verdict.decision === "allow") {
    return;
  }
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: verdict.decision,
        permissionDecisionReason: verdict.reason,
      },
    })
  );
});
