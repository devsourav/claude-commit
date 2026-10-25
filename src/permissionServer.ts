import * as net from "net";
import * as readline from "readline";

// Standalone stdio MCP server, spawned by the `claude` CLI itself (via
// --mcp-config) - not loaded into the extension host. Claude Code calls its
// one tool through `--permission-prompt-tool` whenever it wants to use a
// tool that isn't pre-allowed (Edit, Write, Bash, ...). We forward each
// request over a token-checked loopback TCP socket to the extension, which
// asks the user in the Team Pool panel and replies allow/deny - the
// headless equivalent of the approval prompt in the Claude Code panel.
//
// Hand-rolled JSON-RPC (newline-delimited, MCP stdio transport) to avoid
// shipping the MCP SDK for three methods.

const PORT = Number(process.env.CLAUDE_COMMIT_PERMISSION_PORT ?? 0);
const TOKEN = process.env.CLAUDE_COMMIT_PERMISSION_TOKEN ?? "";
export const PERMISSION_TOOL_NAME = "approve";

interface RpcRequest {
  jsonrpc: "2.0";
  id?: number | string;
  method: string;
  params?: any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

function send(message: unknown) {
  process.stdout.write(JSON.stringify(message) + "\n");
}

function askExtension(request: unknown): Promise<string> {
  return new Promise((resolve) => {
    const deny = (reason: string) => resolve(JSON.stringify({ behavior: "deny", message: reason }));
    if (!PORT) {
      deny("No approval channel to the editor.");
      return;
    }
    const socket = net.createConnection({ host: "127.0.0.1", port: PORT });
    let buffer = "";
    socket.on("connect", () => socket.write(JSON.stringify({ token: TOKEN, request }) + "\n"));
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      const newline = buffer.indexOf("\n");
      if (newline !== -1) {
        resolve(buffer.slice(0, newline));
        socket.end();
      }
    });
    socket.on("error", () => deny("Lost connection to the editor."));
    socket.on("close", () => deny("The editor closed the approval request."));
  });
}

async function handle(req: RpcRequest) {
  if (req.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: req.id,
      result: {
        protocolVersion: req.params?.protocolVersion ?? "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "claude-commit-permissions", version: "1.0.0" },
      },
    });
  } else if (req.method === "tools/list") {
    send({
      jsonrpc: "2.0",
      id: req.id,
      result: {
        tools: [
          {
            name: PERMISSION_TOOL_NAME,
            description: "Ask the user in the editor to approve a tool use.",
            inputSchema: {
              type: "object",
              properties: {
                tool_name: { type: "string" },
                input: { type: "object" },
                tool_use_id: { type: "string" },
              },
              required: ["tool_name", "input"],
            },
          },
        ],
      },
    });
  } else if (req.method === "tools/call") {
    const decision = await askExtension(req.params?.arguments ?? {});
    send({ jsonrpc: "2.0", id: req.id, result: { content: [{ type: "text", text: decision }] } });
  } else if (req.id !== undefined) {
    send({ jsonrpc: "2.0", id: req.id, error: { code: -32601, message: `Unknown method ${req.method}` } });
  }
}

if (require.main === module) {
  readline.createInterface({ input: process.stdin }).on("line", (line) => {
    let req: RpcRequest;
    try {
      req = JSON.parse(line);
    } catch {
      return;
    }
    handle(req);
  });
}
