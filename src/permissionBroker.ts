import * as net from "net";
import * as path from "path";
import { randomBytes } from "crypto";

export const PERMISSION_SERVER_NAME = "claude_commit";
export const PERMISSION_PROMPT_TOOL = `mcp__${PERMISSION_SERVER_NAME}__approve`;

export interface PermissionRequest {
  tool_name: string;
  input: Record<string, unknown>;
  tool_use_id?: string;
}

export type PermissionDecision =
  | { behavior: "allow"; updatedInput: Record<string, unknown> }
  // interrupt: true ends the turn (a plain "Deny"); without it Claude gets
  // the message as feedback and carries on ("Deny" with instructions).
  | { behavior: "deny"; message: string; interrupt?: boolean };

export type PermissionHandler = (request: PermissionRequest, signal: AbortSignal) => Promise<PermissionDecision>;

export interface PermissionChannel {
  // Inline --mcp-config JSON for the CLI (holds the port, never the token).
  mcpConfig: string;
  // Inline --settings JSON registering safetyHook.js as a PreToolUse hook,
  // so the safety rules run before every edit/command in every mode.
  hookSettings: string;
  // Env for the `claude` process; stdio MCP servers inherit it, which is
  // how the token reaches permissionServer.js without appearing in argv.
  env: NodeJS.ProcessEnv;
}

// Extension-side end of the approval channel (see permissionServer.ts): a
// loopback-only TCP server that accepts requests carrying the per-window
// random token and hands them to whichever chat turn is running.
export class PermissionBroker {
  private server: net.Server | undefined;
  private port = 0;
  private readonly token = randomBytes(24).toString("hex");
  private handler: PermissionHandler | undefined;

  constructor(private readonly extensionPath: string) {}

  setHandler(handler: PermissionHandler | undefined) {
    this.handler = handler;
  }

  async channel(): Promise<PermissionChannel> {
    await this.ensureListening();
    const config = {
      mcpServers: {
        [PERMISSION_SERVER_NAME]: {
          type: "stdio",
          command: process.execPath,
          args: [path.join(this.extensionPath, "out", "permissionServer.js")],
          // process.execPath is VS Code's Electron binary; this makes it
          // run the script as plain Node. Scoped to this server's env so
          // commands Claude runs don't inherit it.
          env: { CLAUDE_COMMIT_PERMISSION_PORT: String(this.port), ELECTRON_RUN_AS_NODE: "1" },
        },
      },
    };
    const hookScript = path.join(this.extensionPath, "out", "safetyHook.js");
    const hookSettings = {
      hooks: {
        PreToolUse: [
          {
            matcher: "Edit|MultiEdit|Write|NotebookEdit|Bash",
            // Hooks run through a POSIX shell (Git Bash on Windows).
            hooks: [{ type: "command", command: `ELECTRON_RUN_AS_NODE=1 ${shellQuote(process.execPath)} ${shellQuote(hookScript)}` }],
          },
        ],
      },
    };
    return {
      mcpConfig: JSON.stringify(config),
      hookSettings: JSON.stringify(hookSettings),
      env: { ...process.env, CLAUDE_COMMIT_PERMISSION_TOKEN: this.token },
    };
  }

  dispose() {
    this.server?.close();
    this.server = undefined;
  }

  private ensureListening(): Promise<void> {
    if (this.server) {
      return Promise.resolve();
    }
    const server = net.createServer((socket) => this.onConnection(socket));
    this.server = server;
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        this.port = (server.address() as net.AddressInfo).port;
        resolve();
      });
    });
  }

  private onConnection(socket: net.Socket) {
    let buffer = "";
    const abort = new AbortController();
    // The CLI dropping the connection (Stop, timeout) cancels the pending
    // approval card instead of leaving it dangling.
    socket.on("close", () => abort.abort());
    socket.on("error", () => abort.abort());
    socket.on("data", async (chunk) => {
      buffer += chunk.toString();
      const newline = buffer.indexOf("\n");
      if (newline === -1) {
        return;
      }
      const line = buffer.slice(0, newline);
      buffer = "";
      let decision: PermissionDecision;
      try {
        const { token, request } = JSON.parse(line) as { token: string; request: PermissionRequest };
        if (token !== this.token) {
          decision = { behavior: "deny", message: "Invalid approval token." };
        } else if (!this.handler) {
          decision = { behavior: "deny", message: "No chat is waiting for approvals." };
        } else {
          decision = await this.handler(request, abort.signal);
        }
      } catch (err) {
        decision = { behavior: "deny", message: err instanceof Error ? err.message : String(err) };
      }
      if (!socket.destroyed) {
        socket.end(JSON.stringify(decision) + "\n");
      }
    });
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
