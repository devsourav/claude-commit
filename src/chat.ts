import { LEAN_ARGS, runClaude, spawnClaudeSession, ClaudeSessionProcess, toolsArg } from "./claudeRunner";

// Read-only tools only: the chat can dig through history and files itself
// (that's the point - it's the real Claude Code CLI, not just text we hand
// it), but it can never write, edit, or run arbitrary shell, so it's safe
// to let it run unattended in headless mode. Do not widen this to Write,
// Edit, Bash(git commit:*)/Bash(git push:*), or bare Bash(*).
export const ALLOWED_TOOLS = [
  "Bash(git log:*)",
  "Bash(git show:*)",
  "Bash(git diff:*)",
  "Bash(git blame:*)",
  "Bash(git status:*)",
  "Read",
  "Grep",
  "Glob",
];

// Built-in tools each chat mode actually loads (--tools). Everything else
// (Task subagents, Cron, worktrees, notifications...) is left out: unused
// here, and each schema costs tokens on every turn. ToolSearch stays in
// edit modes so deferred MCP tools (e.g. Figma) can still be loaded.
const READ_ONLY_TOOLSET = ["Read", "Grep", "Glob", "Bash"];
export const DEFAULT_EDIT_TOOLSET = [
  ...READ_ONLY_TOOLSET,
  "Edit",
  "Write",
  "NotebookEdit",
  "WebFetch",
  "WebSearch",
  "TodoWrite",
  "ToolSearch",
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
  const args = [
    "-p",
    question,
    "--output-format",
    "json",
    ...toolsArg(READ_ONLY_TOOLSET),
    ...LEAN_ARGS,
    "--allowedTools",
    ...ALLOWED_TOOLS,
  ];
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

// Appended to Claude Code's own system prompt for the Team Pool chat, so
// it treats `.claude-pool/` as the team's shared memory rather than just
// another folder.
const POOL_SYSTEM_PROMPT = `Team memory pool: .claude-pool/ (index: .claude-pool/index.md) holds teammates' API contracts,
Figma specs, docs and module notes. Before working on a module, read only its relevant entries and
cite them by path. Prefer the pool over assumptions; flag any pool/code disagreement.`;

const READ_ONLY_NOTE = `Read-only mode: you cannot modify files. If you produce something worth keeping, suggest saving it to the pool.`;

const EDIT_NOTE = `You may edit files; the user approves changes and a safety check may block some (follow its reason).
Pool entries live in .claude-pool/modules/<module>/<entry>.md - keep their frontmatter; never edit .claude-pool/index.md (generated).`;

// Every request re-sends the whole conversation, so what lands in context
// is paid for again on every later step of the session.
const CONTEXT_NOTE = `Keep the context small: locate code with Grep/Glob first, then Read only the relevant line ranges
(offset/limit) instead of whole files, and don't re-read files already in the conversation.`;

// Mirrors Claude Code's own modes. "readonly" is the original safety
// boundary (only ALLOWED_TOOLS, everything else auto-denied); the others
// route every non-allowed tool through the editor's approval prompt.
export type ChatPermissionMode = "readonly" | "ask" | "acceptEdits" | "auto" | "plan";

export type StreamEvent =
  | { kind: "text"; text: string }
  | { kind: "tool"; id: string; name: string; input: Record<string, unknown>; detail: string; filePath?: string }
  | { kind: "toolResult"; id: string; isError: boolean; output: string }
  | { kind: "init"; model: string; slashCommands: string[] }
  // Size of the conversation context as of the latest model request, for
  // the context meter, the idle/cache notice and auto-compact.
  | { kind: "usage"; contextTokens: number }
  | { kind: "compacted"; preTokens: number; postTokens: number }
  | { kind: "session"; sessionId: string };

export interface ChatProcessOptions {
  cliPath: string;
  cwd: string;
  model?: string;
  effort?: string;
  // Narrows the chat to one pool module, e.g. "auth".
  moduleFocus?: string;
  permissionMode: ChatPermissionMode;
  // Required for every mode except "readonly" (see permissionBroker.ts).
  permission?: { mcpConfig: string; hookSettings: string; promptTool: string; env: NodeJS.ProcessEnv };
  // Built-in tools for edit modes (claudeCommit.pool.chatTools).
  editTools?: string[];
  resumeSessionId?: string;
  onEvent: (event: StreamEvent) => void;
}

export interface TurnResult {
  text: string;
  interrupted: boolean;
}

export type UserContent = string | ({ type: "text"; text: string } | { type: "image"; source: { type: "base64"; media_type: string; data: string } })[];

// Max characters of a tool's output kept for the expandable tool row.
const MAX_TOOL_OUTPUT = 4000;

// CLI spelling of each mode for --permission-mode / set_permission_mode.
function cliMode(mode: ChatPermissionMode): string {
  return mode === "ask" || mode === "readonly" ? "default" : mode;
}

// Settings baked into the process at spawn time. If any of these change,
// the panel restarts the process (resuming the same session); permission
// mode and model change live over the control channel instead.
export function chatProcessKey(opts: ChatProcessOptions): string {
  return JSON.stringify([
    opts.cliPath,
    opts.cwd,
    opts.effort ?? "",
    opts.moduleFocus ?? "",
    opts.permissionMode === "readonly",
    opts.editTools ?? [],
  ]);
}

// One long-lived `claude` process per Team Pool conversation (see
// spawnClaudeSession for why), rendered the way the Claude Code panel
// renders a turn: text as it arrives, each tool call with its result, the
// active model, and context usage.
export class ChatProcess {
  readonly key: string;
  sessionId: string | undefined;
  private proc: ClaudeSessionProcess;
  private exited = false;
  private turn:
    | { resolve: (r: TurnResult) => void; reject: (e: Error) => void; text: string; interrupted: boolean }
    | undefined;
  private requestContext = 0;
  private requestSeq = 0;

  constructor(private readonly opts: ChatProcessOptions) {
    this.key = chatProcessKey(opts);
    this.sessionId = opts.resumeSessionId;
    const canEdit = opts.permissionMode !== "readonly";
    const focus = opts.moduleFocus
      ? `\nThe user is currently working on the "${opts.moduleFocus}" module; start with .claude-pool/modules/${opts.moduleFocus}/.`
      : "";
    const args = [
      "-p",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--append-system-prompt",
      `${POOL_SYSTEM_PROMPT}\n${canEdit ? EDIT_NOTE : READ_ONLY_NOTE}\n${CONTEXT_NOTE}${focus}`,
      "--allowedTools",
      ...ALLOWED_TOOLS,
    ];
    if (canEdit) {
      if (!opts.permission) {
        throw new Error("Editing needs the approval channel, but it isn't available.");
      }
      args.push(
        ...toolsArg(opts.editTools?.length ? opts.editTools : DEFAULT_EDIT_TOOLSET),
        "--mcp-config",
        opts.permission.mcpConfig,
        "--permission-prompt-tool",
        opts.permission.promptTool,
        // Safety hook: runs before every edit/command, even in modes that
        // auto-approve (see safety.ts).
        "--settings",
        opts.permission.hookSettings,
        "--permission-mode",
        cliMode(opts.permissionMode)
      );
    } else {
      // Skills/slash commands stay enabled (the composer's "/" menu), so
      // only the MCP half of LEAN_ARGS applies here.
      args.push(...toolsArg(READ_ONLY_TOOLSET), "--strict-mcp-config");
    }
    if (opts.model) {
      args.push("--model", opts.model);
    }
    if (opts.effort) {
      args.push("--effort", opts.effort);
    }
    if (opts.resumeSessionId) {
      args.push("--resume", opts.resumeSessionId);
    }
    this.proc = spawnClaudeSession({
      cliPath: opts.cliPath,
      args,
      cwd: opts.cwd,
      // CLAUDE_COMMIT_REPO_ROOT pins the safety hook's "inside the repo"
      // check to the repo even if Claude cd's elsewhere in Bash.
      env: canEdit ? { ...opts.permission?.env, CLAUDE_COMMIT_REPO_ROOT: opts.cwd } : undefined,
      onLine: (line) => this.onLine(line),
      onExit: (code, stderr, error) => {
        this.exited = true;
        const turn = this.turn;
        this.turn = undefined;
        if (turn) {
          if (turn.interrupted) {
            turn.resolve({ text: turn.text.trim(), interrupted: true });
          } else {
            const detail = stderr.split("\n").filter(Boolean).slice(-3).join("\n").trim();
            turn.reject(error ?? new Error(`Claude Code CLI exited with code ${code}.${detail ? ` ${detail}` : ""}`));
          }
        }
      },
    });
  }

  get alive(): boolean {
    return !this.exited;
  }

  get busy(): boolean {
    return Boolean(this.turn);
  }

  send(content: UserContent): Promise<TurnResult> {
    if (this.exited) {
      return Promise.reject(new Error("The Claude session has ended."));
    }
    if (this.turn) {
      return Promise.reject(new Error("A turn is already running."));
    }
    return new Promise<TurnResult>((resolve, reject) => {
      this.turn = { resolve, reject, text: "", interrupted: false };
      this.proc.write({ type: "user", message: { role: "user", content } });
    });
  }

  // Stops the current turn but keeps the process (and its warm cache).
  interrupt() {
    if (!this.turn) {
      return;
    }
    this.turn.interrupted = true;
    this.control({ subtype: "interrupt" });
    // If the CLI doesn't honor it promptly, fall back to killing it.
    const turn = this.turn;
    setTimeout(() => {
      if (this.turn === turn) {
        this.proc.kill();
      }
    }, 5000);
  }

  setPermissionMode(mode: ChatPermissionMode) {
    this.control({ subtype: "set_permission_mode", mode: cliMode(mode) });
  }

  setModel(model: string | undefined) {
    this.control({ subtype: "set_model", model: model || "default" });
  }

  dispose() {
    if (this.exited) {
      return;
    }
    this.proc.end();
    const proc = this.proc;
    setTimeout(() => proc.kill(), 2000);
  }

  private control(request: Record<string, unknown>) {
    this.proc.write({ type: "control_request", request_id: `cc-${++this.requestSeq}`, request });
  }

  private onLine(line: string) {
    let msg: any; // eslint-disable-line @typescript-eslint/no-explicit-any
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    const emit = this.opts.onEvent;
    if (msg.session_id && msg.session_id !== this.sessionId) {
      this.sessionId = msg.session_id;
      emit({ kind: "session", sessionId: msg.session_id });
    }
    if (msg.type === "system" && msg.subtype === "init") {
      emit({
        kind: "init",
        model: String(msg.model ?? ""),
        slashCommands: Array.isArray(msg.slash_commands) ? msg.slash_commands.map(String) : [],
      });
    } else if (msg.type === "system" && msg.subtype === "compact_boundary") {
      const meta = msg.compact_metadata ?? {};
      emit({ kind: "compacted", preTokens: Number(meta.pre_tokens ?? 0), postTokens: Number(meta.post_tokens ?? 0) });
      if (meta.post_tokens) {
        emit({ kind: "usage", contextTokens: Number(meta.post_tokens) });
      }
    } else if (msg.type === "stream_event" && !msg.parent_tool_use_id) {
      const event = msg.event;
      if (event?.type === "content_block_delta" && event.delta?.type === "text_delta") {
        if (this.turn) {
          this.turn.text += event.delta.text;
        }
        emit({ kind: "text", text: event.delta.text });
      } else if (event?.type === "message_start") {
        const u = event.message?.usage ?? {};
        this.requestContext = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
      } else if (event?.type === "message_delta" && event.usage?.output_tokens) {
        emit({ kind: "usage", contextTokens: this.requestContext + event.usage.output_tokens });
      }
    } else if (msg.type === "assistant" && !msg.parent_tool_use_id) {
      for (const block of msg.message?.content ?? []) {
        if (block.type === "tool_use") {
          const input = (block.input ?? {}) as Record<string, unknown>;
          const filePath = typeof input.file_path === "string" ? input.file_path : undefined;
          emit({ kind: "tool", id: block.id, name: block.name, input, detail: describeToolInput(input), filePath });
        }
      }
    } else if (msg.type === "user" && !msg.parent_tool_use_id) {
      for (const block of Array.isArray(msg.message?.content) ? msg.message.content : []) {
        if (block.type === "tool_result") {
          emit({
            kind: "toolResult",
            id: block.tool_use_id,
            isError: Boolean(block.is_error),
            output: toolResultText(block.content).slice(0, MAX_TOOL_OUTPUT),
          });
        }
      }
    } else if (msg.type === "result") {
      const turn = this.turn;
      this.turn = undefined;
      if (!turn) {
        return;
      }
      const resultText = typeof msg.result === "string" ? msg.result : "";
      if (turn.interrupted) {
        turn.resolve({ text: turn.text.trim(), interrupted: true });
      } else if (msg.is_error) {
        turn.reject(new Error(resultText || "Claude returned an error."));
      } else {
        // Slash commands like /context answer only in the result, not as
        // streamed text - surface that so the turn isn't blank.
        if (!turn.text.trim() && resultText.trim()) {
          emit({ kind: "text", text: resultText });
        }
        turn.resolve({ text: (turn.text.trim() || resultText).trim(), interrupted: false });
      }
    }
  }
}

function toolResultText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => (part && typeof part === "object" && "text" in part ? String((part as { text: unknown }).text) : ""))
      .join("\n");
  }
  return "";
}

function describeToolInput(input: Record<string, unknown> | undefined): string {
  if (!input) {
    return "";
  }
  const value = input.command ?? input.file_path ?? input.pattern ?? input.url ?? input.query ?? input.path ?? "";
  return String(value).slice(0, 160);
}
