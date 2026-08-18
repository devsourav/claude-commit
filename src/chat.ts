import { runClaude } from "./claudeRunner";

// Read-only tools only: the chat can dig through history and files itself
// (that's the point - it's the real Claude Code CLI, not just text we hand
// it), but it can never write, edit, or run arbitrary shell, so it's safe
// to let it run unattended in headless mode. Do not widen this to Write,
// Edit, Bash(git commit:*)/Bash(git push:*), or bare Bash(*).
const ALLOWED_TOOLS = [
  "Bash(git log:*)",
  "Bash(git show:*)",
  "Bash(git diff:*)",
  "Bash(git blame:*)",
  "Bash(git status:*)",
  "Read",
  "Grep",
  "Glob",
];

export interface ChatSession {
  sessionId?: string;
}

export interface AskChatOptions {
  cliPath: string;
  cwd: string;
  question: string;
  model?: string;
  timeoutMs: number;
  session: ChatSession;
}

export interface ChatAnswer {
  text: string;
}

interface ClaudeJsonResult {
  result?: string;
  session_id?: string;
  is_error?: boolean;
}

export async function askChat({
  cliPath,
  cwd,
  question,
  model,
  timeoutMs,
  session,
}: AskChatOptions): Promise<ChatAnswer> {
  const args = ["-p", question, "--output-format", "json", "--allowedTools", ...ALLOWED_TOOLS];
  if (model) {
    args.push("--model", model);
  }
  if (session.sessionId) {
    args.push("--resume", session.sessionId);
  }

  const result = await runClaude({ cliPath, args, cwd, stdin: "", timeoutMs });

  if (result.timedOut) {
    throw new Error(`Claude timed out after ${Math.round(timeoutMs / 1000)}s.`);
  }
  if (result.code !== 0) {
    const detail = result.stderr.split("\n").slice(0, 3).join("\n").trim();
    throw new Error(`Claude Code CLI exited with code ${result.code}.${detail ? ` ${detail}` : ""}`);
  }

  let parsed: ClaudeJsonResult;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new Error("Couldn't parse Claude's response.");
  }

  if (parsed.is_error || !parsed.result) {
    throw new Error(parsed.result || "Claude returned an error.");
  }

  session.sessionId = parsed.session_id ?? session.sessionId;
  return { text: parsed.result };
}
