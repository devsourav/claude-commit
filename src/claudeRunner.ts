import { spawn } from "child_process";

// Token budget: by default every `claude -p` call carries Claude Code's full
// agent scaffolding (~33k input tokens: every built-in tool's schema,
// skills, MCP connectors). Each caller instead names exactly the built-in
// tools it needs via --tools, which on its own cuts a chat turn to ~13k.
// LEAN_ARGS additionally skips MCP servers (faster startup - no connecting
// to every claude.ai connector) and skills, for calls that use neither.
// Measured with `claude` 2.1 - re-measure if you change these.
export const LEAN_ARGS = ["--strict-mcp-config", "--disable-slash-commands"];

export function toolsArg(tools: string[]): string[] {
  // An empty string is the CLI's spelling of "no tools at all".
  return ["--tools", tools.join(",")];
}

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

export interface StreamClaudeOptions {
  cliPath: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
  onLine: (line: string) => void;
}

export interface StreamClaudeHandle {
  done: Promise<RunClaudeResult>;
  kill: () => void;
}

// Same spawn as runClaude, but hands stdout to the caller one line at a
// time (for `--output-format stream-json`) and exposes kill() so a Stop
// button can cancel a long agentic turn.
export function streamClaude({
  cliPath,
  args,
  cwd,
  timeoutMs,
  env,
  onLine,
}: StreamClaudeOptions): StreamClaudeHandle {
  const child = spawn(cliPath, args, { cwd, shell: false, env });
  const done = new Promise<RunClaudeResult>((resolve, reject) => {
    // stdout is consumed line by line and not accumulated: a long agentic
    // turn emits megabytes of partial-message events nobody needs again.
    const stdout = "";
    let stderr = "";
    let pending = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      pending += chunk.toString();
      let newline = pending.indexOf("\n");
      while (newline !== -1) {
        const line = pending.slice(0, newline).trim();
        pending = pending.slice(newline + 1);
        if (line) {
          onLine(line);
        }
        newline = pending.indexOf("\n");
      }
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
      if (pending.trim()) {
        onLine(pending.trim());
      }
      resolve({ stdout, stderr, code, timedOut });
    });

    child.stdin.end();
  });
  return { done, kill: () => child.kill() };
}

export interface ClaudeSessionProcess {
  write: (message: unknown) => void;
  end: () => void;
  kill: () => void;
}

// Long-lived `claude -p --input-format stream-json` process: messages go in
// over stdin, events come out line by line. Keeping one process per
// conversation (instead of a fresh `--resume` process per message) keeps
// the prompt cache warm between turns - a resumed process re-sends history
// that doesn't byte-match the cached prefix, so its first request re-writes
// the whole conversation at cache-write price.
export function spawnClaudeSession({
  cliPath,
  args,
  cwd,
  env,
  onLine,
  onExit,
}: {
  cliPath: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  onLine: (line: string) => void;
  onExit: (code: number | null, stderr: string, error?: Error) => void;
}): ClaudeSessionProcess {
  const child = spawn(cliPath, args, { cwd, shell: false, env });
  let pending = "";
  let stderr = "";
  let exited = false;
  child.stdout.on("data", (chunk) => {
    pending += chunk.toString();
    let newline = pending.indexOf("\n");
    while (newline !== -1) {
      const line = pending.slice(0, newline).trim();
      pending = pending.slice(newline + 1);
      if (line) {
        onLine(line);
      }
      newline = pending.indexOf("\n");
    }
  });
  child.stderr.on("data", (chunk) => {
    // Keep only the tail; it's just for error messages.
    stderr = (stderr + chunk.toString()).slice(-4000);
  });
  child.on("error", (err) => {
    if (!exited) {
      exited = true;
      onExit(null, stderr, err);
    }
  });
  child.on("close", (code) => {
    if (!exited) {
      exited = true;
      onExit(code, stderr);
    }
  });
  // Writing after the process died would throw EPIPE asynchronously.
  child.stdin.on("error", () => undefined);
  return {
    write: (message) => {
      if (!exited && child.stdin.writable) {
        child.stdin.write(JSON.stringify(message) + "\n");
      }
    },
    end: () => child.stdin.end(),
    kill: () => child.kill(),
  };
}
