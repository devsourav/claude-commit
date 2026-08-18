import { spawn } from "child_process";

export interface RunClaudeOptions {
  cliPath: string;
  args: string[];
  cwd: string;
  stdin: string;
  timeoutMs: number;
}

export interface RunClaudeResult {
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
}

// Shells out to the Claude Code CLI in headless mode (`claude -p ...`),
// piping the diff over stdin so we never hit argv length limits on large
// diffs the way passing the diff itself as a -p argument would.
export function runClaude({
  cliPath,
  args,
  cwd,
  stdin,
  timeoutMs,
}: RunClaudeOptions): Promise<RunClaudeResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cliPath, args, { cwd, shell: false });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code, timedOut });
    });

    child.stdin.write(stdin);
    child.stdin.end();
  });
}
