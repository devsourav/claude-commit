import * as vscode from "vscode";
import * as fs from "fs/promises";
import * as path from "path";
import { randomUUID } from "crypto";
import { ChatPermissionMode, ChatProcess, ChatProcessOptions, StreamEvent, UserContent, chatProcessKey } from "./chat";
import {
  POOL_DIR,
  PoolEntryKind,
  currentAuthor,
  currentRelease,
  deleteEntry,
  isLinkedFromClaudeMd,
  linkFromClaudeMd,
  listEntries,
  rebuildIndex,
  resolveInsidePool,
  storeSource,
  writeEntry,
} from "./pool";
import { splitTitle, summarizeDocuments, summarizeFigma, summarizeLinks, summarizeOpenApi } from "./poolIngest";
import { runGit } from "./gitExec";
import { PERMISSION_PROMPT_TOOL, PermissionBroker, PermissionDecision, PermissionRequest } from "./permissionBroker";
import { ProposedContentProvider, computeProposedContent } from "./proposedChanges";
import { checkToolUse } from "./safety";
import { getPoolHtml } from "./poolWebview";

// Pre-conversations shape (one thread per repo); read once for migration.
const LEGACY_CHAT_STATE_KEY = "claudeCommit.poolChat";
const CONVERSATIONS_STATE_KEY = "claudeCommit.poolConversations";
const PERMISSION_MODE_STATE_KEY = "claudeCommit.poolPermissionMode";
const CHAT_PREFS_STATE_KEY = "claudeCommit.poolChatPrefs";
const MAX_PERSISTED_ITEMS = 400;
const MAX_CONVERSATIONS_PER_REPO = 50;
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const MAX_ATTACHMENTS = 8;
// Picked non-image files outside the repo are inlined up to this size.
const MAX_INLINED_FILE_BYTES = 200 * 1024;
// A conversation's claude process is shut down after this long idle; the
// prompt cache has expired by then anyway, and the next message resumes.
const PROCESS_IDLE_MS = 20 * 60 * 1000;
const IMAGE_TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };
const PERMISSION_MODES: ChatPermissionMode[] = ["ask", "acceptEdits", "auto", "plan", "readonly"];
// Tools whose "Allow for this session" applies to every later call of the
// same tool. For Bash it's remembered per exact command instead.
const FILE_EDIT_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);
// Line-range references larger than this are sent as a path only (Claude
// can Read it) rather than inlined into the prompt.
const MAX_INLINED_REFERENCE_LINES = 400;
const CANCELLED = "The request was cancelled.";
// Raw docs larger than this are summarized but not copied into the repo,
// so the pool doesn't bloat git history with big PDFs.
const MAX_SOURCE_COPY_BYTES = 5 * 1024 * 1024;

interface WebviewMessage {
  type: string;
  [key: string]: unknown;
}

interface TodoItem {
  content: string;
  status: string;
}

// One rendered row of a conversation. The same shape is streamed live and
// persisted, so a restored conversation renders exactly like the live one.
type ChatItem =
  | { kind: "user"; text: string; time: number; attachments?: string[] }
  | { kind: "text"; text: string }
  | {
      kind: "tool";
      id: string;
      name: string;
      detail: string;
      path?: string;
      status: "running" | "ok" | "error";
      summary?: string;
      output?: string;
      todos?: TodoItem[];
    }
  | { kind: "notice"; text: string; tone: "info" | "error" };

interface Conversation {
  id: string;
  title: string;
  updatedAt: number;
  sessionId?: string;
  items: ChatItem[];
  contextTokens?: number;
  lastTurnAt?: number;
}

interface LegacyPersistedChat {
  sessionId?: string;
  messages: { role: string; text: string }[];
}

interface ChatPrefs {
  model?: string;
  effort?: string;
  // Last slash-command list reported by the CLI, so the "/" menu works
  // before the first turn of a session.
  slashCommands?: string[];
}

interface Attachment {
  name: string;
  // Absolute path of a file picked from disk via the "+" menu.
  path: string;
}

type ToolItem = Extract<ChatItem, { kind: "tool" }>;

// Where the persistent process's events for the in-flight turn land.
interface TurnContext {
  convo: Conversation;
  toolItems: Map<string, ToolItem>;
}

interface PendingSend {
  text: string;
  includeSelection: boolean;
  images: { name: string; dataUrl: string }[];
}

interface PickedFile {
  path: string;
  name: string;
}

interface EditorContext {
  // Repo-relative path, and 1-based inclusive lines (undefined = no selection).
  path: string;
  startLine?: number;
  endLine?: number;
}

interface PendingApproval {
  resolve: (decision: PermissionDecision) => void;
  request: PermissionRequest;
  proposedUri?: vscode.Uri;
  // Safety-check reason when the action was flagged as sensitive.
  flagged?: string;
}

export interface PoolPanelDeps {
  proposed: ProposedContentProvider;
}

// "Team Pool" panel: opens beside the editor from the editor title bar
// (next to the Claude Code icon). A streaming, pool-aware chat plus a UI to
// browse and contribute to the repo's shared `.claude-pool/`. Reopening the
// command reveals the most recently used panel for the target repo (or
// switches it to a new repo); "New Tab" (editor-title "+", like Claude
// Code's own icon) always opens an additional, independent panel. Each
// panel owns its own PermissionBroker - a shared one would let two
// concurrently running tabs' approval requests get routed to whichever
// tab's handler happened to be registered last.
export class PoolPanel {
  private static current: PoolPanel | undefined;
  private static readonly allPanels = new Set<PoolPanel>();
  private readonly broker: PermissionBroker;

  private readonly panel: vscode.WebviewPanel;
  private readonly context: vscode.ExtensionContext;
  private cwd: string;
  private conversations: Conversation[] = [];
  // With multiple tabs open on the same repo (see "New Tab"), saves must
  // merge rather than overwrite - this tracks deletions made from this tab
  // so they survive a merge against another tab's newer snapshot.
  private readonly deletedConversationIds = new Set<string>();
  private active: Conversation | undefined;
  // One long-lived claude process per conversation (see ChatProcess);
  // created on the first message, reused for every later turn.
  private proc: ChatProcess | undefined;
  private procConvoId: string | undefined;
  // Set when a setting baked into the process changed mid-turn; the
  // process is restarted (resuming the session) once the turn ends.
  private procStale = false;
  private idleTimer: NodeJS.Timeout | undefined;
  private turnCtx: TurnContext | undefined;
  private turnRunning = false;
  private readonly sendQueue: PendingSend[] = [];
  private moduleFocus: string | undefined;
  private prefs: ChatPrefs;
  private pickedAttachments: Attachment[] = [];
  private permissionMode: ChatPermissionMode;
  private readonly pendingApprovals = new Map<string, PendingApproval>();
  // Reset with each new conversation, like Claude Code's session allows.
  private sessionAllows = new Set<string>();
  // Set when the user denies without feedback, which interrupts the turn;
  // the CLI then reports an empty error that we show as "Stopped" instead.
  private deniedStop: string | undefined;
  private editorContext: EditorContext | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private static deps: PoolPanelDeps | undefined;

  static init(deps: PoolPanelDeps) {
    PoolPanel.deps = deps;
  }

  // "Add selection to Team Pool chat" (alt+shift+K): inserts an
  // @path#Lstart-end reference into the composer, like Claude Code's
  // at-mention shortcut.
  static insertReference(context: vscode.ExtensionContext, cwd: string, editor: vscode.TextEditor) {
    const target = PoolPanel.current ?? PoolPanel.createOrShow(context, cwd);
    target.panel.reveal(undefined, false);
    const ctx = toEditorContext(cwd, editor);
    if (ctx) {
      target.post({ type: "insertText", text: formatReference(ctx) + " " });
    }
  }

  // The repo of whichever Pool tab is currently focused/most recently used -
  // lets the title-bar "New Tab" button default to the same repo as the tab
  // it was clicked from, rather than re-prompting or guessing.
  static activeCwd(): string | undefined {
    return PoolPanel.current?.cwd;
  }

  static createOrShow(context: vscode.ExtensionContext, cwd: string) {
    if (PoolPanel.current) {
      PoolPanel.current.panel.reveal(vscode.ViewColumn.Beside);
      if (PoolPanel.current.cwd !== cwd) {
        PoolPanel.current.switchRepository(cwd);
      }
      return PoolPanel.current;
    }
    return PoolPanel.createNewTab(context, cwd);
  }

  // Always opens a fresh, independent panel instead of reusing/revealing an
  // existing one.
  static createNewTab(context: vscode.ExtensionContext, cwd: string): PoolPanel {
    const panel = vscode.window.createWebviewPanel(
      "claudeCommitPool",
      "Team Pool",
      vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    panel.iconPath = new vscode.ThemeIcon("library");
    PoolPanel.current = new PoolPanel(panel, context, cwd);
    return PoolPanel.current;
  }

  // Used by the "Save Selection to Team Pool" editor command.
  static async saveTextFromEditor(context: vscode.ExtensionContext, cwd: string, text: string) {
    const target = PoolPanel.current ?? PoolPanel.createOrShow(context, cwd);
    await target.saveTextToPool(text);
  }

  private constructor(panel: vscode.WebviewPanel, context: vscode.ExtensionContext, cwd: string) {
    this.panel = panel;
    this.context = context;
    this.cwd = cwd;
    this.broker = new PermissionBroker(context.extensionPath);
    const savedMode = context.globalState.get<ChatPermissionMode>(PERMISSION_MODE_STATE_KEY, "ask");
    this.permissionMode = PERMISSION_MODES.includes(savedMode) ? savedMode : "ask";
    this.prefs = context.globalState.get<ChatPrefs>(CHAT_PREFS_STATE_KEY, {});
    PoolPanel.allPanels.add(this);
    this.panel.webview.html = getPoolHtml(this.panel.webview);
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.onDidChangeViewState((e) => {
      if (e.webviewPanel.active) {
        PoolPanel.current = this;
      }
    }, null, this.disposables);
    this.panel.webview.onDidReceiveMessage(
      (message: WebviewMessage) => this.handleMessage(message),
      null,
      this.disposables
    );
    // Teammates' entries arrive via `git pull`, so refresh whenever
    // anything under the pool changes on disk.
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.file(cwd), `${POOL_DIR}/**`)
    );
    // Debounced: one save touches an entry and index.md (and a pull can
    // touch dozens), and each refresh re-reads every entry.
    let refreshTimer: NodeJS.Timeout | undefined;
    const refresh = () => {
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => this.postPool().catch(() => undefined), 300);
    };
    watcher.onDidCreate(refresh, null, this.disposables);
    watcher.onDidChange(refresh, null, this.disposables);
    watcher.onDidDelete(refresh, null, this.disposables);
    this.disposables.push(watcher);

    // Entries edited directly (by hand, or by Claude in an edit mode) keep
    // the index in sync. Watching modules/ only, so rewriting index.md
    // doesn't retrigger this.
    let rebuildTimer: NodeJS.Timeout | undefined;
    const entryWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.file(cwd), `${POOL_DIR}/modules/**`)
    );
    const scheduleRebuild = () => {
      clearTimeout(rebuildTimer);
      rebuildTimer = setTimeout(() => rebuildIndex(this.cwd).catch(() => undefined), 500);
    };
    entryWatcher.onDidCreate(scheduleRebuild, null, this.disposables);
    entryWatcher.onDidChange(scheduleRebuild, null, this.disposables);
    entryWatcher.onDidDelete(scheduleRebuild, null, this.disposables);
    this.disposables.push(entryWatcher);

    vscode.window.onDidChangeTextEditorSelection(
      (e) => this.updateEditorContext(e.textEditor),
      null,
      this.disposables
    );
    vscode.window.onDidChangeActiveTextEditor(
      (editor) => editor && this.updateEditorContext(editor),
      null,
      this.disposables
    );
  }

  private dispose() {
    PoolPanel.allPanels.delete(this);
    if (PoolPanel.current === this) {
      PoolPanel.current = PoolPanel.allPanels.values().next().value;
    }
    this.disposeProcess();
    this.cancelPendingApprovals();
    this.broker.dispose();
    while (this.disposables.length) {
      this.disposables.pop()?.dispose();
    }
  }

  private switchRepository(cwd: string) {
    this.disposeProcess();
    this.cwd = cwd;
    this.moduleFocus = undefined;
    this.loadConversations();
    this.postInit();
  }

  // Cmd/Ctrl+Escape-style focus toggle target (claudeCommit.focusPoolChat).
  static focus(context: vscode.ExtensionContext, cwd: string) {
    const target = PoolPanel.current ?? PoolPanel.createOrShow(context, cwd);
    target.panel.reveal(undefined, false);
    target.post({ type: "focusInput" });
  }

  private async handleMessage(message: WebviewMessage) {
    try {
      switch (message.type) {
        case "ready":
          this.loadConversations();
          await this.postInit();
          if (vscode.window.activeTextEditor) {
            this.updateEditorContext(vscode.window.activeTextEditor);
          }
          break;
        case "chatSend":
          await this.handleChatSend(
            String(message.text ?? ""),
            Boolean(message.includeSelection),
            (message.images as { name: string; dataUrl: string }[] | undefined) ?? []
          );
          break;
        case "openConversation":
          this.openConversation(String(message.id));
          break;
        case "deleteConversation":
          await this.deleteConversation(String(message.id));
          break;
        case "setEffort":
          this.prefs.effort = (message.effort as string) || undefined;
          await this.context.globalState.update(CHAT_PREFS_STATE_KEY, this.prefs);
          this.invalidateProcess();
          break;
        case "focusEditor":
          await vscode.commands.executeCommand("workbench.action.focusActiveEditorGroup");
          break;
        case "pickAttachment":
          await this.handlePickAttachment(Boolean(message.images));
          break;
        case "removeAttachment":
          this.pickedAttachments = this.pickedAttachments.filter((a) => a.path !== message.path);
          break;
        case "chatStop":
          this.sendQueue.length = 0;
          this.proc?.interrupt();
          this.cancelPendingApprovals();
          break;
        case "setPermissionMode": {
          const mode = message.mode as ChatPermissionMode;
          if (PERMISSION_MODES.includes(mode)) {
            const wasReadonly = this.permissionMode === "readonly";
            this.permissionMode = mode;
            await this.context.globalState.update(PERMISSION_MODE_STATE_KEY, mode);
            if (wasReadonly !== (mode === "readonly")) {
              // Read-only runs with a different tool set: needs a restart.
              this.invalidateProcess();
            } else {
              // Shift+Tab between edit modes switches live, keeping the cache.
              this.proc?.setPermissionMode(mode);
            }
          }
          break;
        }
        case "approvalResponse":
          this.resolveApproval(String(message.id), String(message.decision), String(message.reason ?? ""));
          break;
        case "viewProposedDiff":
          await this.viewProposedDiff(String(message.id));
          break;
        case "openFile":
          await this.openRepoFile(String(message.path), message.line as number | undefined);
          break;
        case "fileSearch":
          await this.handleFileSearch(String(message.query ?? ""));
          break;
        case "chatNew":
          this.startNewConversation();
          break;
        case "setModuleFocus":
          this.moduleFocus = (message.module as string) || undefined;
          this.invalidateProcess();
          break;
        case "setModel":
          this.prefs.model = (message.model as string) || undefined;
          await this.context.globalState.update(CHAT_PREFS_STATE_KEY, this.prefs);
          this.proc?.setModel(this.config().model);
          break;
        case "saveToPool":
          await this.saveTextToPool(String(message.text ?? ""));
          break;
        case "loadPool":
          await this.postPool();
          break;
        case "openEntry":
          await vscode.window.showTextDocument(
            vscode.Uri.file(resolveInsidePool(this.cwd, String(message.path))),
            { viewColumn: vscode.ViewColumn.One, preview: true }
          );
          break;
        case "deleteEntry":
          await this.handleDelete(String(message.path));
          break;
        case "linkClaudeMd":
          await linkFromClaudeMd(this.cwd);
          vscode.window.setStatusBarMessage("Team Pool: linked from CLAUDE.md.", 4000);
          await this.postPool();
          break;
        case "openScm":
          await vscode.commands.executeCommand("workbench.view.scm");
          break;
        case "pickFiles":
          await this.handlePickFiles(String(message.purpose));
          break;
        case "ingestPreview":
          await this.handleIngestPreview(message);
          break;
        case "saveEntry":
          await this.handleSaveEntry(message);
          break;
      }
    } catch (err) {
      this.postError(err);
    }
  }

  private config() {
    const config = vscode.workspace.getConfiguration("claudeCommit");
    const timeoutSeconds = config.get<number>("timeoutSeconds", 60);
    return {
      cliPath: config.get<string>("cliPath", "claude"),
      model: this.prefs.model ?? (config.get<string>("model", "").trim() || undefined),
      // Agentic turns and ingestion (fetching links, reading Figma) need far
      // more room than the single-shot commit-message call.
      timeoutMs: Math.max(timeoutSeconds * 5, 300) * 1000,
      figmaTools: config.get<string[]>("pool.figmaTools", []),
      chatTools: config.get<string[]>("pool.chatTools", []),
      autoCompactTokens: config.get<number>("pool.autoCompactTokens", 100000),
    };
  }

  // ---- Chat ----------------------------------------------------------------

  private async handleChatSend(text: string, includeSelection: boolean, images: { name: string; dataUrl: string }[]) {
    if (!text.trim()) {
      return;
    }
    if (this.turnRunning) {
      // The webview queues while busy too; this covers the gap between
      // "busy: false" and the next turn (e.g. while auto-compacting).
      this.sendQueue.push({ text, includeSelection, images });
      return;
    }
    this.turnRunning = true;
    clearTimeout(this.idleTimer);
    const selection = includeSelection ? this.editorContext : undefined;
    this.deniedStop = undefined;
    const convo = this.active ?? this.startNewConversation(false);
    if (!convo.items.length) {
      convo.title = deriveTitle(text);
      this.postConversations();
    }

    const picked = this.pickedAttachments.splice(0, this.pickedAttachments.length);
    const names = [...picked.map((a) => a.name), ...images.map((i) => i.name)].slice(0, MAX_ATTACHMENTS);
    const shown = selection ? `${text}\n\n${formatReference(selection)}` : text;
    convo.items.push({ kind: "user", text: shown, time: Date.now(), attachments: names });
    this.post({ type: "chatBusy", busy: true });

    this.turnCtx = { convo, toolItems: new Map() };
    try {
      const content = await this.buildContent(await expandReferences(this.cwd, text, selection), images, picked);
      const proc = await this.ensureProcess(convo);
      const result = await proc.send(content);
      if (result.interrupted) {
        this.pushNotice(convo, "Interrupted", "info");
      }
    } catch (err) {
      if (this.deniedStop) {
        this.pushNotice(convo, `Stopped - you denied: ${this.deniedStop}`, "info");
      } else {
        this.pushNotice(convo, this.describeCliError(err), "error");
      }
    }
    this.finishTurn(convo);
    this.post({ type: "chatDone" });
    // Compact while the cache is still warm (cheap to read) and before the
    // next message, so later requests carry a small context.
    await this.maybeAutoCompact(convo);
    this.turnRunning = false;
    this.post({ type: "chatBusy", busy: false });
    await this.saveConversations();
    this.postConversations();
    this.scheduleIdleShutdown();
    const next = this.sendQueue.shift();
    if (next) {
      await this.handleChatSend(next.text, next.includeSelection, next.images);
    }
  }

  private finishTurn(convo: Conversation) {
    // Anything still "running" (stopped mid-tool) shouldn't spin forever.
    for (const item of this.turnCtx?.toolItems.values() ?? []) {
      if (item.status === "running") {
        item.status = "error";
        this.post({ type: "chatToolResult", id: item.id, status: "error", output: item.output ?? "Interrupted" });
      }
    }
    this.turnCtx = undefined;
    this.cancelPendingApprovals();
    convo.sessionId = this.proc?.sessionId ?? convo.sessionId;
    convo.lastTurnAt = Date.now();
    convo.updatedAt = Date.now();
    this.post({ type: "chatMeta", lastTurnAt: convo.lastTurnAt });
    if (this.procStale) {
      this.disposeProcess();
    }
  }

  // The 1M-token context window means Claude Code's own auto-compact almost
  // never triggers, so a long session keeps re-sending a growing context on
  // every step. Past the threshold, /compact summarizes it down.
  private async maybeAutoCompact(convo: Conversation) {
    const threshold = this.config().autoCompactTokens;
    const tokens = convo.contextTokens ?? 0;
    if (!threshold || tokens < threshold || !this.proc?.alive || this.procConvoId !== convo.id) {
      return;
    }
    this.pushNotice(convo, `Context reached ${formatTokens(tokens)} tokens - compacting so each request stays small...`, "info");
    this.turnCtx = { convo, toolItems: new Map() };
    try {
      await this.proc.send("/compact");
    } catch (err) {
      this.pushNotice(convo, `Couldn't compact: ${this.describeCliError(err)}`, "error");
    }
    this.turnCtx = undefined;
  }

  private onChatEvent(event: StreamEvent) {
    const ctx = this.turnCtx;
    switch (event.kind) {
      case "text": {
        if (!ctx) {
          return;
        }
        const last = ctx.convo.items[ctx.convo.items.length - 1];
        if (last?.kind === "text") {
          last.text += event.text;
        } else {
          ctx.convo.items.push({ kind: "text", text: event.text });
        }
        this.post({ type: "chatDelta", text: event.text });
        break;
      }
      case "tool": {
        if (!ctx) {
          return;
        }
        const rel = event.filePath ? toRepoRelative(this.cwd, event.filePath) : undefined;
        const item: ToolItem = {
          kind: "tool",
          id: event.id,
          name: event.name,
          detail: rel ?? event.detail,
          path: rel,
          status: "running",
          summary: toolSummary(event.name, event.input),
          todos: event.name === "TodoWrite" ? (event.input.todos as TodoItem[] | undefined) : undefined,
        };
        ctx.toolItems.set(event.id, item);
        ctx.convo.items.push(item);
        this.post({ type: "chatItem", item });
        break;
      }
      case "toolResult": {
        const item = ctx?.toolItems.get(event.id);
        if (item) {
          item.status = event.isError ? "error" : "ok";
          item.output = event.output;
          this.post({ type: "chatToolResult", id: event.id, status: item.status, output: item.output });
        }
        break;
      }
      case "init":
        this.prefs.slashCommands = event.slashCommands;
        void this.context.globalState.update(CHAT_PREFS_STATE_KEY, this.prefs);
        this.post({ type: "chatMeta", model: event.model, slashCommands: event.slashCommands });
        break;
      case "usage":
        if (ctx) {
          ctx.convo.contextTokens = event.contextTokens;
        }
        this.post({ type: "chatMeta", contextTokens: event.contextTokens });
        break;
      case "compacted":
        if (ctx) {
          ctx.convo.contextTokens = event.postTokens;
          this.pushNotice(ctx.convo, `Compacted conversation: ${formatTokens(event.preTokens)} -> ${formatTokens(event.postTokens)} tokens`, "info");
        }
        break;
      case "session":
        if (ctx) {
          ctx.convo.sessionId = event.sessionId;
        }
        break;
    }
  }

  // Reuses the conversation's running process when nothing baked into it
  // changed; otherwise starts one that resumes the same session.
  private async ensureProcess(convo: Conversation): Promise<ChatProcess> {
    const { cliPath, model, chatTools } = this.config();
    const canEdit = this.permissionMode !== "readonly";
    const channel = canEdit ? await this.broker.channel() : undefined;
    const opts: ChatProcessOptions = {
      cliPath,
      cwd: this.cwd,
      model,
      effort: this.prefs.effort,
      moduleFocus: this.moduleFocus,
      permissionMode: this.permissionMode,
      permission: channel && { ...channel, promptTool: PERMISSION_PROMPT_TOOL },
      editTools: chatTools,
      resumeSessionId: convo.sessionId,
      onEvent: (event) => this.onChatEvent(event),
    };
    if (this.proc?.alive && this.procConvoId === convo.id && this.proc.key === chatProcessKey(opts)) {
      return this.proc;
    }
    this.disposeProcess();
    this.broker.setHandler(canEdit ? (request, signal) => this.requestApproval(request, signal) : undefined);
    this.proc = new ChatProcess(opts);
    this.procConvoId = convo.id;
    return this.proc;
  }

  private invalidateProcess() {
    if (this.proc?.busy) {
      this.procStale = true;
    } else {
      this.disposeProcess();
    }
  }

  private disposeProcess() {
    clearTimeout(this.idleTimer);
    this.proc?.dispose();
    this.proc = undefined;
    this.procConvoId = undefined;
    this.procStale = false;
    this.broker.setHandler(undefined);
  }

  private scheduleIdleShutdown() {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (!this.turnRunning) {
        this.disposeProcess();
      }
    }, PROCESS_IDLE_MS);
  }

  // Images go to Claude as image blocks in the message itself (no extra
  // Read round-trip per image); picked text files outside the repo are
  // inlined, since Claude can't read outside the repo.
  private async buildContent(
    question: string,
    images: { name: string; dataUrl: string }[],
    picked: Attachment[]
  ): Promise<UserContent> {
    const blocks: Exclude<UserContent, string> = [];
    let text = question;
    for (const image of images.slice(0, MAX_ATTACHMENTS)) {
      const match = image.dataUrl.match(/^data:(image\/(?:png|jpeg|gif|webp));base64,(.+)$/);
      if (match && match[2].length * 0.75 <= MAX_ATTACHMENT_BYTES) {
        blocks.push({ type: "image", source: { type: "base64", media_type: match[1], data: match[2] } });
      }
    }
    for (const file of picked.slice(0, MAX_ATTACHMENTS)) {
      const ext = path.extname(file.path).slice(1).toLowerCase();
      const stat = await fs.stat(file.path).catch(() => undefined);
      if (!stat) {
        continue;
      }
      if (IMAGE_TYPES[ext] && stat.size <= MAX_ATTACHMENT_BYTES) {
        const data = (await fs.readFile(file.path)).toString("base64");
        blocks.push({ type: "image", source: { type: "base64", media_type: IMAGE_TYPES[ext], data } });
      } else if (stat.size <= MAX_INLINED_FILE_BYTES) {
        text += `\n\n<attached_file name="${file.name}">\n${await fs.readFile(file.path, "utf8")}\n</attached_file>`;
      } else {
        text += `\n\n(Attached file ${file.name} was too large to include: ${Math.round(stat.size / 1024)}KB.)`;
      }
    }
    return blocks.length ? [{ type: "text", text }, ...blocks] : text;
  }

  private pushNotice(convo: Conversation, text: string, tone: "info" | "error") {
    const item: ChatItem = { kind: "notice", text, tone };
    convo.items.push(item);
    this.post({ type: "chatItem", item });
  }

  // "+" menu: files inside the repo become @-references (Claude reads them
  // in place); anything outside is attached by path.
  private async handlePickAttachment(images: boolean) {
    const uris = await vscode.window.showOpenDialog({
      canSelectMany: true,
      openLabel: "Attach",
      defaultUri: vscode.Uri.file(this.cwd),
      filters: images ? { Images: ["png", "jpg", "jpeg", "gif", "webp"] } : undefined,
    });
    for (const uri of uris ?? []) {
      const rel = toRepoRelative(this.cwd, uri.fsPath);
      if (rel && !images) {
        this.post({ type: "insertText", text: `@${rel} ` });
      } else {
        const attachment = { name: path.basename(uri.fsPath), path: uri.fsPath };
        this.pickedAttachments.push(attachment);
        this.post({ type: "attachmentAdded", attachment });
      }
    }
  }

  // ---- Conversations ---------------------------------------------------------

  private loadConversations() {
    const all = this.context.workspaceState.get<Record<string, Conversation[]>>(CONVERSATIONS_STATE_KEY, {});
    let list = all[this.cwd];
    if (!list) {
      const legacy = this.context.workspaceState.get<Record<string, LegacyPersistedChat>>(LEGACY_CHAT_STATE_KEY, {})[this.cwd];
      list = legacy?.messages.length ? [migrateLegacy(legacy)] : [];
    }
    this.conversations = list;
    this.openConversation(list[0]?.id);
  }

  private openConversation(id: string | undefined) {
    if (this.turnRunning) {
      return;
    }
    const convo = this.conversations.find((c) => c.id === id);
    if (convo?.id !== this.procConvoId) {
      this.disposeProcess();
    }
    this.active = convo;
    this.sessionAllows = new Set();
    this.post({ type: "chatReset", conversation: convo ?? null });
    this.postConversations();
  }

  private startNewConversation(announce = true): Conversation {
    if (announce) {
      // A real "New chat" click; the implicit call from the first send
      // must not tear down the process that send is about to create.
      this.sendQueue.length = 0;
      this.proc?.interrupt();
      this.disposeProcess();
    }
    this.cancelPendingApprovals();
    const convo: Conversation = { id: randomUUID(), title: "Untitled", updatedAt: Date.now(), items: [] };
    this.conversations.unshift(convo);
    this.conversations = this.conversations.slice(0, MAX_CONVERSATIONS_PER_REPO);
    this.active = convo;
    this.sessionAllows = new Set();
    if (announce) {
      this.post({ type: "chatReset", conversation: convo });
      this.postConversations();
    }
    return convo;
  }

  private async deleteConversation(id: string) {
    this.conversations = this.conversations.filter((c) => c.id !== id);
    this.deletedConversationIds.add(id);
    if (this.active?.id === id) {
      this.openConversation(this.conversations[0]?.id);
    }
    await this.saveConversations();
    this.postConversations();
  }

  // Merges rather than overwrites: a blind overwrite here would silently
  // drop conversations another tab on the same repo created, updated, or
  // deleted since this tab last loaded.
  private async saveConversations() {
    const all = this.context.workspaceState.get<Record<string, Conversation[]>>(CONVERSATIONS_STATE_KEY, {});
    const byId = new Map((all[this.cwd] ?? []).map((c) => [c.id, c]));
    for (const id of this.deletedConversationIds) {
      byId.delete(id);
    }
    // Empty "Untitled" conversations aren't worth keeping.
    for (const convo of this.conversations) {
      if (convo.items.length) {
        byId.set(convo.id, { ...convo, items: convo.items.slice(-MAX_PERSISTED_ITEMS) });
      } else {
        byId.delete(convo.id);
      }
    }
    all[this.cwd] = [...byId.values()]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, MAX_CONVERSATIONS_PER_REPO);
    await this.context.workspaceState.update(CONVERSATIONS_STATE_KEY, all);
  }

  private postConversations() {
    this.post({
      type: "conversations",
      list: this.conversations
        .filter((c) => c.items.length || c.id === this.active?.id)
        .map((c) => ({ id: c.id, title: c.title, updatedAt: c.updatedAt })),
      activeId: this.active?.id ?? null,
    });
  }

  // ---- Approvals -------------------------------------------------------------

  private approvalKey(request: PermissionRequest): string {
    if (FILE_EDIT_TOOLS.has(request.tool_name)) {
      return request.tool_name;
    }
    if (request.tool_name === "Bash") {
      return `Bash:${String(request.input.command ?? "")}`;
    }
    return request.tool_name;
  }

  private async requestApproval(request: PermissionRequest, signal: AbortSignal): Promise<PermissionDecision> {
    // Same rules the PreToolUse hook applies. Hard blocks never get here
    // (the hook denies them first); flagged-but-allowed actions show their
    // reason on the card and are never covered by "Allow for this session".
    const verdict = checkToolUse(request.tool_name, request.input, this.cwd);
    if (verdict.decision === "deny") {
      return { behavior: "deny", message: verdict.reason };
    }
    const flagged = verdict.decision === "ask" ? verdict.reason : undefined;
    if (!flagged && this.sessionAllows.has(this.approvalKey(request))) {
      return { behavior: "allow", updatedInput: request.input };
    }
    const id = randomUUID();
    let proposedUri: vscode.Uri | undefined;
    const proposal = await computeProposedContent(request.tool_name, request.input).catch(() => undefined);
    if (proposal && PoolPanel.deps) {
      proposedUri = PoolPanel.deps.proposed.set(id, proposal.filePath, proposal.after);
    }
    const { title, detail } = describeApproval(this.cwd, request);
    return new Promise<PermissionDecision>((resolve) => {
      this.pendingApprovals.set(id, { resolve, request, proposedUri, flagged });
      signal.addEventListener("abort", () => this.resolveApproval(id, "deny", CANCELLED));
      this.post({ type: "approvalRequest", id, title, detail, canDiff: Boolean(proposedUri), warning: flagged });
      this.panel.reveal(undefined, true);
    });
  }

  private resolveApproval(id: string, decision: string, reason: string) {
    const pending = this.pendingApprovals.get(id);
    if (!pending) {
      return;
    }
    this.pendingApprovals.delete(id);
    if (pending.proposedUri) {
      PoolPanel.deps?.proposed.delete(pending.proposedUri);
    }
    const allowed = decision === "allow" || decision === "allowSession";
    if (decision === "allowSession" && !pending.flagged) {
      this.sessionAllows.add(this.approvalKey(pending.request));
    }
    const title = describeApproval(this.cwd, pending.request).title;
    const label = allowed
      ? decision === "allowSession" ? "Allowed for this session" : "Allowed"
      : reason ? `Denied: "${reason}"` : "Denied";
    if (this.active) {
      this.active.items.push({ kind: "notice", text: `${label}: ${title}`, tone: "info" });
    }
    this.post({ type: "approvalResolved", id, label });
    if (allowed) {
      pending.resolve({ behavior: "allow", updatedInput: pending.request.input });
    } else if (reason) {
      pending.resolve({ behavior: "deny", message: `The user denied this and said: ${reason}` });
    } else {
      this.deniedStop = title;
      pending.resolve({ behavior: "deny", message: "The user denied this action.", interrupt: true });
    }
  }

  private cancelPendingApprovals() {
    for (const id of [...this.pendingApprovals.keys()]) {
      this.resolveApproval(id, "deny", CANCELLED);
    }
  }

  private async viewProposedDiff(id: string) {
    const pending = this.pendingApprovals.get(id);
    if (!pending?.proposedUri) {
      return;
    }
    const filePath = pending.proposedUri.path;
    const exists = await fs.stat(filePath).then(() => true, () => false);
    const left = exists
      ? vscode.Uri.file(filePath)
      : PoolPanel.deps!.proposed.set(`${id}-empty`, filePath, "");
    await vscode.commands.executeCommand(
      "vscode.diff",
      left,
      pending.proposedUri,
      `${path.basename(filePath)} (proposed by Claude)`,
      { viewColumn: vscode.ViewColumn.One, preview: true }
    );
  }

  // ---- Editor context & file references -------------------------------------

  private updateEditorContext(editor: vscode.TextEditor) {
    const ctx = toEditorContext(this.cwd, editor);
    // Ignore our own diff/virtual docs and files outside this repo.
    if (!ctx && editor.document.uri.scheme !== "file") {
      return;
    }
    this.editorContext = ctx;
    this.post({ type: "editorContext", context: ctx ?? null });
  }

  private async openRepoFile(relPath: string, line?: number) {
    const abs = path.resolve(this.cwd, relPath);
    if (!abs.startsWith(this.cwd + path.sep)) {
      return;
    }
    const editor = await vscode.window.showTextDocument(vscode.Uri.file(abs), {
      viewColumn: vscode.ViewColumn.One,
      preview: true,
    });
    if (line) {
      const pos = new vscode.Position(Math.max(0, line - 1), 0);
      editor.selection = new vscode.Selection(pos, pos);
      editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
    }
  }

  // Backs the "@" autocomplete in the composer.
  private async handleFileSearch(query: string) {
    const safe = query.replace(/[{}[\]*?!]/g, "");
    const pattern = new vscode.RelativePattern(vscode.Uri.file(this.cwd), safe ? `**/*${safe}*` : "**/*");
    const uris = await vscode.workspace.findFiles(pattern, "**/{node_modules,.git,out,dist,build}/**", 200);
    const files = uris
      .map((u) => toRepoRelative(this.cwd, u.fsPath))
      .filter((p): p is string => Boolean(p))
      .sort((a, b) => scorePath(a, safe) - scorePath(b, safe) || a.length - b.length)
      .slice(0, 12);
    this.post({ type: "fileResults", query, files });
  }

  // ---- Pool ----------------------------------------------------------------

  private async postInit() {
    const [release, author] = await Promise.all([currentRelease(this.cwd), currentAuthor(this.cwd)]);
    this.post({
      type: "init",
      repo: path.basename(this.cwd),
      release,
      author,
      hasFigmaTools: this.config().figmaTools.length > 0,
      permissionMode: this.permissionMode,
      model: this.prefs.model ?? "",
      effort: this.prefs.effort ?? "",
      slashCommands: this.prefs.slashCommands ?? [],
      platform: process.platform,
    });
    await this.postPool();
  }

  private async postPool() {
    const [entries, linked, status] = await Promise.all([
      listEntries(this.cwd),
      isLinkedFromClaudeMd(this.cwd),
      runGit(this.cwd, ["status", "--porcelain", "--", POOL_DIR, "CLAUDE.md"]).catch(() => ""),
    ]);
    this.post({
      type: "pool",
      entries: entries.map(({ body: _body, ...meta }) => meta),
      linked,
      uncommitted: status.split("\n").filter((l) => l.trim()).length,
    });
  }

  private async moduleNames(): Promise<string[]> {
    return [...new Set((await listEntries(this.cwd)).map((e) => e.module))].sort();
  }

  // "Save to pool" from a chat answer or an editor selection: ask for the
  // module and title natively, then write a note entry.
  private async saveTextToPool(text: string) {
    if (!text.trim()) {
      return;
    }
    const modules = await this.moduleNames();
    const NEW = "$(add) New module...";
    let module: string | undefined = this.moduleFocus;
    if (!module) {
      const pick = await vscode.window.showQuickPick([...modules, NEW], {
        placeHolder: "Which module does this belong to?",
      });
      if (!pick) {
        return;
      }
      module = pick === NEW ? await vscode.window.showInputBox({ prompt: "Module name (e.g. auth, checkout)" }) : pick;
    }
    if (!module?.trim()) {
      return;
    }
    const guess = splitTitle(text);
    const title = await vscode.window.showInputBox({
      prompt: "Entry title",
      value: guess.title ?? text.replace(/\s+/g, " ").slice(0, 60),
    });
    if (!title?.trim()) {
      return;
    }
    const [release, author] = await Promise.all([currentRelease(this.cwd), currentAuthor(this.cwd)]);
    const entry = await writeEntry(this.cwd, {
      module,
      title,
      kind: "note",
      release,
      author,
      body: text.startsWith("# ") ? text : `# ${title}\n\n${text}`,
    });
    await this.afterSave(entry.path);
  }

  private async handleDelete(entryPath: string) {
    const answer = await vscode.window.showWarningMessage(
      `Delete ${entryPath} from the team pool? (You can still restore it from git.)`,
      { modal: true },
      "Delete"
    );
    if (answer === "Delete") {
      await deleteEntry(this.cwd, entryPath);
      await this.postPool();
    }
  }

  private async handlePickFiles(purpose: string) {
    const isSwagger = purpose === "swagger";
    const uris = await vscode.window.showOpenDialog({
      canSelectMany: !isSwagger,
      openLabel: isSwagger ? "Use this spec" : "Add to pool",
      filters: isSwagger
        ? { "OpenAPI / Swagger JSON": ["json"] }
        : { Documents: ["md", "txt", "pdf", "json", "yaml", "yml", "html", "csv", "png", "jpg", "jpeg"], All: ["*"] },
    });
    if (!uris?.length) {
      return;
    }
    const files: PickedFile[] = uris.map((u) => ({ path: u.fsPath, name: path.basename(u.fsPath) }));
    this.post({ type: "pickedFiles", purpose, files });
  }

  private async handleIngestPreview(message: WebviewMessage) {
    const kind = String(message.kind);
    const files = ((message.files as PickedFile[] | undefined) ?? []).map((f) => f.path);
    const urls = ((message.urls as string[] | undefined) ?? []).map((u) => u.trim()).filter(Boolean);
    const focus = String(message.focus ?? "").trim();
    const { cliPath, model, timeoutMs, figmaTools } = this.config();
    const opts = { cliPath, cwd: this.cwd, model, timeoutMs };

    this.post({ type: "ingestBusy", busy: true });
    try {
      let body: string;
      let title: string | undefined;
      let summary: string | undefined;
      if (kind === "api") {
        if (!files[0]) {
          throw new Error("Choose a swagger.json file first.");
        }
        const result = summarizeOpenApi(await fs.readFile(files[0], "utf8"));
        ({ body, title, summary } = result);
      } else if (kind === "doc") {
        if (!files.length) {
          throw new Error("Choose at least one document.");
        }
        body = await summarizeDocuments(opts, files, focus);
      } else if (kind === "link") {
        if (!urls.length) {
          throw new Error("Paste at least one link.");
        }
        body = await summarizeLinks(opts, urls, focus);
      } else if (kind === "design") {
        if (!urls.length) {
          throw new Error("Paste at least one Figma link.");
        }
        if (!figmaTools.length) {
          throw new Error('No Figma tools configured - set "claudeCommit.pool.figmaTools".');
        }
        body = await summarizeFigma(opts, urls, focus, figmaTools);
      } else {
        throw new Error(`Unknown source type: ${kind}`);
      }
      if (!title) {
        ({ title, summary } = splitTitle(body));
      }
      this.post({ type: "ingestPreview", body, title: title ?? "", summary: summary ?? "" });
    } catch (err) {
      this.post({ type: "ingestError", message: this.describeCliError(err) });
    } finally {
      this.post({ type: "ingestBusy", busy: false });
    }
  }

  private async handleSaveEntry(message: WebviewMessage) {
    const module = String(message.module ?? "").trim();
    const title = String(message.title ?? "").trim();
    const body = String(message.body ?? "").trim();
    if (!module || !title || !body) {
      throw new Error("Module, title and content are all required.");
    }
    const kind = (String(message.kind) || "note") as PoolEntryKind;
    const files = (message.files as PickedFile[] | undefined) ?? [];
    const urls = ((message.urls as string[] | undefined) ?? []).map((u) => u.trim()).filter(Boolean);

    // Keep the original artifacts next to the distilled entry (spec, docs)
    // so teammates can always go back to the source of truth.
    const sources: string[] = [...urls];
    for (const file of files) {
      const stat = await fs.stat(file.path);
      if (stat.size <= MAX_SOURCE_COPY_BYTES) {
        sources.push(await storeSource(this.cwd, module, file.path));
      } else {
        sources.push(`(not copied, ${Math.round(stat.size / 1024 / 1024)}MB) ${file.name}`);
      }
    }

    const entry = await writeEntry(this.cwd, {
      module,
      title,
      kind,
      release: String(message.release ?? ""),
      author: await currentAuthor(this.cwd),
      sources,
      summary: String(message.summary ?? "") || undefined,
      body,
    });
    this.post({ type: "saved", path: entry.path });
    await this.afterSave(entry.path);
  }

  private async afterSave(entryPath: string) {
    await this.postPool();
    const linked = await isLinkedFromClaudeMd(this.cwd);
    const actions = linked ? ["Open", "Review & commit"] : ["Link from CLAUDE.md", "Open"];
    const choice = await vscode.window.showInformationMessage(
      `Saved ${entryPath}. Commit and push it to share it with your team.`,
      ...actions
    );
    if (choice === "Open") {
      await vscode.window.showTextDocument(vscode.Uri.file(path.join(this.cwd, entryPath)), {
        viewColumn: vscode.ViewColumn.One,
      });
    } else if (choice === "Review & commit") {
      await vscode.commands.executeCommand("workbench.view.scm");
    } else if (choice === "Link from CLAUDE.md") {
      await linkFromClaudeMd(this.cwd);
      await this.postPool();
    }
  }

  private describeCliError(err: unknown): string {
    const nodeErr = err as NodeJS.ErrnoException;
    if (nodeErr?.code === "ENOENT") {
      return `Couldn't find the Claude Code CLI. Install it, or set "claudeCommit.cliPath" to its full path.`;
    }
    return err instanceof Error ? err.message : String(err);
  }

  private post(message: unknown) {
    this.panel.webview.postMessage(message);
  }

  private postError(err: unknown) {
    this.post({ type: "error", message: this.describeCliError(err) });
  }
}

function toRepoRelative(cwd: string, absPath: string): string | undefined {
  const rel = path.relative(cwd, absPath);
  return rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel.split(path.sep).join("/") : undefined;
}

function toEditorContext(cwd: string, editor: vscode.TextEditor): EditorContext | undefined {
  if (editor.document.uri.scheme !== "file") {
    return undefined;
  }
  const rel = toRepoRelative(cwd, editor.document.uri.fsPath);
  if (!rel) {
    return undefined;
  }
  const sel = editor.selection;
  if (sel.isEmpty) {
    return { path: rel };
  }
  // A selection ending at column 0 of the next line shouldn't count that line.
  const endLine = sel.end.character === 0 && sel.end.line > sel.start.line ? sel.end.line : sel.end.line + 1;
  return { path: rel, startLine: sel.start.line + 1, endLine };
}

function formatReference(ctx: EditorContext): string {
  if (!ctx.startLine) {
    return `@${ctx.path}`;
  }
  return ctx.startLine === ctx.endLine ? `@${ctx.path}#L${ctx.startLine}` : `@${ctx.path}#L${ctx.startLine}-${ctx.endLine}`;
}

const REFERENCE_PATTERN = /@([\w.\-/]+[\w\-])(?:#L(\d+)(?:-(\d+))?)?/g;

// Expands @path and @path#L10-20 references (typed, autocompleted, or from
// the editor selection) the way Claude Code does: line ranges are inlined
// so Claude sees exactly the code being pointed at; whole-file references
// are listed so Claude reads them itself. Anything outside the repo or not
// a file is left as plain text.
async function expandReferences(cwd: string, text: string, selection?: EditorContext): Promise<string> {
  const refs: EditorContext[] = [];
  for (const match of text.matchAll(REFERENCE_PATTERN)) {
    const start = match[2] ? Number(match[2]) : undefined;
    refs.push({ path: match[1], startLine: start, endLine: match[3] ? Number(match[3]) : start });
  }
  if (selection) {
    refs.push(selection);
  }
  const blocks: string[] = [];
  const seen = new Set<string>();
  for (const ref of refs) {
    const key = formatReference(ref);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    const abs = path.resolve(cwd, ref.path);
    if (!abs.startsWith(cwd + path.sep)) {
      continue;
    }
    const content = await fs.readFile(abs, "utf8").catch(() => undefined);
    if (content === undefined) {
      continue;
    }
    if (!ref.startLine) {
      blocks.push(`<file path="${ref.path}" />`);
      continue;
    }
    const lines = content.split("\n");
    const end = Math.min(ref.endLine ?? ref.startLine, lines.length);
    if (end - ref.startLine + 1 > MAX_INLINED_REFERENCE_LINES) {
      blocks.push(`<file path="${ref.path}" lines="${ref.startLine}-${end}" />`);
      continue;
    }
    const snippet = lines.slice(ref.startLine - 1, end).join("\n");
    blocks.push(`<file path="${ref.path}" lines="${ref.startLine}-${end}">\n${snippet}\n</file>`);
  }
  if (!blocks.length) {
    return text;
  }
  return `${text}\n\n<referenced_code>\nThe user referenced this code from their editor:\n${blocks.join("\n")}\n</referenced_code>`;
}

function scorePath(relPath: string, query: string): number {
  if (!query) {
    return 0;
  }
  const base = relPath.split("/").pop() ?? relPath;
  if (base.toLowerCase().startsWith(query.toLowerCase())) {
    return 0;
  }
  return base.toLowerCase().includes(query.toLowerCase()) ? 1 : 2;
}

// Human-readable summary for the approval card.
function describeApproval(cwd: string, request: PermissionRequest): { title: string; detail: string } {
  const input = request.input;
  const file = typeof input.file_path === "string" ? toRepoRelative(cwd, input.file_path) ?? input.file_path : "";
  switch (request.tool_name) {
    case "Bash":
      return { title: "Run command", detail: String(input.command ?? "") };
    case "Write":
      return { title: `Write ${file}`, detail: String(input.content ?? "").split("\n").slice(0, 12).join("\n") };
    case "Edit":
      return { title: `Edit ${file}`, detail: `- ${String(input.old_string ?? "").split("\n").join("\n- ")}\n+ ${String(input.new_string ?? "").split("\n").join("\n+ ")}` };
    case "MultiEdit":
      return { title: `Edit ${file}`, detail: `${(input.edits as unknown[] | undefined)?.length ?? 0} edits` };
    case "WebFetch":
      return { title: "Fetch URL", detail: String(input.url ?? "") };
    default:
      return { title: `Use ${request.tool_name}`, detail: JSON.stringify(input, null, 2).slice(0, 600) };
  }
}

function deriveTitle(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > 60 ? oneLine.slice(0, 57) + "..." : oneLine || "Untitled";
}

function migrateLegacy(legacy: LegacyPersistedChat): Conversation {
  const items: ChatItem[] = legacy.messages.map((m) => {
    if (m.role === "user") {
      return { kind: "user", text: m.text, time: 0 };
    }
    if (m.role === "assistant") {
      return { kind: "text", text: m.text };
    }
    return { kind: "notice", text: m.text, tone: m.role === "system" ? "error" : "info" };
  });
  const firstUser = legacy.messages.find((m) => m.role === "user");
  return {
    id: randomUUID(),
    title: deriveTitle(firstUser?.text ?? ""),
    updatedAt: Date.now(),
    sessionId: legacy.sessionId,
    items,
  };
}

// The "+3 -1" style badge Claude Code shows next to an edit.
function toolSummary(name: string, input: Record<string, unknown>): string | undefined {
  const lines = (value: unknown) => (typeof value === "string" && value.length ? value.split("\n").length : 0);
  switch (name) {
    case "Edit":
      return `+${lines(input.new_string)} -${lines(input.old_string)}`;
    case "MultiEdit": {
      const edits = (input.edits as { old_string?: string; new_string?: string }[] | undefined) ?? [];
      const added = edits.reduce((n, e) => n + lines(e.new_string), 0);
      const removed = edits.reduce((n, e) => n + lines(e.old_string), 0);
      return `+${added} -${removed}`;
    }
    case "Write":
      return `+${lines(input.content)}`;
    case "Bash":
      return typeof input.description === "string" ? input.description : undefined;
    default:
      return undefined;
  }
}

function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n);
}
