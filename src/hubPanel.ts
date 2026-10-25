import * as vscode from "vscode";
import { randomUUID } from "crypto";
import { listCommits, listBranches, listAuthors, getCommitDetail, ChangedFile } from "./commitHistory";
import { toGitRevisionUri } from "./gitContentProvider";
import { askChat, ChatSession } from "./chat";
import { GitApi } from "./gitApi";

const PAGE_SIZE = 50;
const EXTRA_REPOS_STATE_KEY = "claudeCommit.browsedRepositories";
const LEGACY_CHAT_HISTORY_STATE_KEY = "claudeCommit.chatHistory";
const CONVERSATIONS_STATE_KEY = "claudeCommit.chatConversations";
const MAX_PERSISTED_CHAT_MESSAGES = 200;

interface WebviewMessage {
  type: string;
  [key: string]: unknown;
}

interface ChatTurn {
  role: string;
  text: string;
}

interface DesignAttachment {
  name: string;
  mimeType: string;
  size: number;
  dataUrl: string;
}

// Pre-0.2.9 shape: one continuous thread per repo. Read (but never written)
// for one-time migration into the multi-conversation model below.
interface LegacyPersistedChatState {
  sessionId?: string;
  messages: ChatTurn[];
}

interface ChatConversation {
  id: string;
  title: string;
  updatedAt: string;
  sessionId?: string;
  messages: ChatTurn[];
}

function deriveConversationTitle(firstMessage: string): string {
  const oneLine = firstMessage.replace(/\s+/g, " ").trim();
  if (!oneLine) {
    return "New conversation";
  }
  return oneLine.length > 60 ? oneLine.slice(0, 57) + "..." : oneLine;
}

// Webview panel: History + Chat tabs over the repo at `cwd`. Re-showing the
// "Open History & Chat" command while a panel is already open just reveals
// and resets the most recently used one (or switches it to a different
// repository) rather than opening a second one - but "New Tab" (next to the
// close button, like Claude Code's own icon) always opens an additional,
// independent panel, each with its own conversation state.
export class HubPanel {
  private static current: HubPanel | undefined;
  private static readonly allPanels = new Set<HubPanel>();

  private readonly panel: vscode.WebviewPanel;
  private readonly context: vscode.ExtensionContext;
  private readonly gitApi: GitApi;
  private cwd: string;
  private chatSession: ChatSession = {};
  private conversations: ChatConversation[] = [];
  private activeConversationId: string | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  // Repositories opened via "Browse for repository..." rather than being
  // part of the current workspace - gitApi.repositories only ever reflects
  // workspace-open repos, so this is how we support any other repo on
  // disk. Persisted so they're still offered after reopening the panel.
  private extraRepoPaths: string[];
  private historySkip = 0;
  private historyGrep: string | undefined;
  private historyBranch: string | undefined;
  private historyAuthor: string | undefined;
  private historySince: string | undefined;
  private historyUntil: string | undefined;

  // The repo of whichever Hub tab is currently focused/most recently used -
  // lets the title-bar "New Tab" button default to the same repo as the tab
  // it was clicked from, rather than re-prompting or guessing.
  static activeCwd(): string | undefined {
    return HubPanel.current?.cwd;
  }

  static createOrShow(context: vscode.ExtensionContext, gitApi: GitApi, cwd: string) {
    if (HubPanel.current) {
      HubPanel.current.panel.reveal(undefined, true);
      if (HubPanel.current.cwd !== cwd) {
        HubPanel.current.switchRepository(cwd);
      } else {
        HubPanel.current.reloadHistory();
      }
      return;
    }
    HubPanel.createNewTab(context, gitApi, cwd);
  }

  // Always opens a fresh, independent panel instead of reusing/reveal-ing
  // an existing one - the "New Tab" title-bar button's equivalent of
  // clicking Claude Code's own icon to start another chat window.
  static createNewTab(context: vscode.ExtensionContext, gitApi: GitApi, cwd: string) {
    const panel = vscode.window.createWebviewPanel(
      "claudeCommitHub",
      "Claude Commit",
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    HubPanel.current = new HubPanel(panel, context, gitApi, cwd);
  }

  private constructor(panel: vscode.WebviewPanel, context: vscode.ExtensionContext, gitApi: GitApi, cwd: string) {
    this.panel = panel;
    this.context = context;
    this.gitApi = gitApi;
    this.cwd = cwd;
    this.extraRepoPaths = context.globalState.get<string[]>(EXTRA_REPOS_STATE_KEY, []);
    HubPanel.allPanels.add(this);
    this.panel.webview.html = getHubHtml(this.panel.webview);
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.onDidChangeViewState((e) => {
      if (e.webviewPanel.active) {
        HubPanel.current = this;
      }
    }, null, this.disposables);
    this.panel.webview.onDidReceiveMessage(
      (message: WebviewMessage) => this.handleMessage(message),
      null,
      this.disposables
    );
    this.loadRepositories();
    this.loadCommits(true);
    this.loadBranches();
    this.loadAuthors();
    this.restoreChatState(cwd);
  }

  private dispose() {
    HubPanel.allPanels.delete(this);
    if (HubPanel.current === this) {
      HubPanel.current = HubPanel.allPanels.values().next().value;
    }
    while (this.disposables.length) {
      this.disposables.pop()?.dispose();
    }
  }

  private reloadHistory() {
    this.historySkip = 0;
    this.historyGrep = undefined;
    this.historyAuthor = undefined;
    this.historySince = undefined;
    this.historyUntil = undefined;
    this.loadCommits(true);
  }

  private switchRepository(cwd: string) {
    this.cwd = cwd;
    this.historyBranch = undefined;
    this.reloadHistory();
    this.loadRepositories();
    this.loadBranches();
    this.loadAuthors();
    this.post({ type: "chatClear" });
    this.restoreChatState(cwd);
  }

  // Each repository keeps its own list of saved conversations (and each
  // conversation its own Claude Code CLI session id), persisted across
  // panel reopens and VS Code restarts - switching repos, or reopening
  // the panel on the same one, resumes the most recent conversation for
  // that repo instead of starting over every time.
  private restoreChatState(cwd: string) {
    this.conversations = this.loadConversations(cwd);
    if (this.conversations.length > 0) {
      this.activateConversation(this.mostRecentConversationId());
    } else {
      this.startNewConversation();
    }
  }

  private mostRecentConversationId(): string {
    return [...this.conversations].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))[0].id;
  }

  private activateConversation(id: string) {
    const convo = this.conversations.find((c) => c.id === id);
    if (!convo) {
      return;
    }
    this.activeConversationId = id;
    this.chatSession = { sessionId: convo.sessionId };
    this.post({ type: "chatClear" });
    if (convo.messages.length > 0) {
      this.post({ type: "chatHistory", messages: convo.messages });
    } else {
      this.post({
        type: "chatMessage",
        role: "system",
        text: `Starting a new conversation about ${repoName(this.cwd)}.`,
      });
    }
    this.postConversationList();
  }

  // A "new chat" doesn't create a saved conversation until the first
  // message is actually sent, so clicking it repeatedly without typing
  // anything doesn't clutter the sidebar with empty entries.
  private startNewConversation() {
    this.activeConversationId = undefined;
    this.chatSession = {};
    this.post({ type: "chatClear" });
    this.post({
      type: "chatMessage",
      role: "system",
      text: `Starting a new conversation about ${repoName(this.cwd)}.`,
    });
    this.postConversationList();
  }

  private postConversationList() {
    const sorted = [...this.conversations].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
    this.post({
      type: "chatConversations",
      conversations: sorted.map((c) => ({ id: c.id, title: c.title, updatedAt: c.updatedAt })),
      activeId: this.activeConversationId,
    });
  }

  private loadConversations(cwd: string): ChatConversation[] {
    const all = this.context.globalState.get<Record<string, ChatConversation[]>>(CONVERSATIONS_STATE_KEY, {});
    if (all[cwd]) {
      return all[cwd];
    }

    // One-time migration from the pre-0.2.9 single-thread-per-repo model.
    const legacyAll = this.context.globalState.get<Record<string, LegacyPersistedChatState>>(
      LEGACY_CHAT_HISTORY_STATE_KEY,
      {}
    );
    const legacy = legacyAll[cwd];
    if (legacy && legacy.messages.length > 0) {
      const firstUserMessage = legacy.messages.find((m) => m.role === "user")?.text ?? "";
      return [
        {
          id: randomUUID(),
          title: deriveConversationTitle(firstUserMessage),
          updatedAt: new Date().toISOString(),
          sessionId: legacy.sessionId,
          messages: legacy.messages,
        },
      ];
    }
    return [];
  }

  // Merges rather than overwrites: with multiple tabs open on the same repo
  // (see "New Tab"), each holds its own in-memory conversation list, so a
  // blind overwrite here would silently drop conversations another tab
  // created or updated since this one last loaded.
  private async saveConversations() {
    const all = this.context.globalState.get<Record<string, ChatConversation[]>>(CONVERSATIONS_STATE_KEY, {});
    const byId = new Map((all[this.cwd] ?? []).map((c) => [c.id, c]));
    for (const convo of this.conversations) {
      byId.set(convo.id, convo);
    }
    all[this.cwd] = [...byId.values()];
    await this.context.globalState.update(CONVERSATIONS_STATE_KEY, all);
  }

  private loadRepositories() {
    const workspacePaths = new Set(this.gitApi.repositories.map((repo) => repo.rootUri.fsPath));
    const repos = [
      ...this.gitApi.repositories.map((repo) => repo.rootUri.fsPath),
      ...this.extraRepoPaths.filter((path) => !workspacePaths.has(path)),
    ].map((path) => ({ path, name: repoName(path) }));
    this.post({ type: "repositories", repos, current: this.cwd });
  }

  private async browseForRepository() {
    const picked = await vscode.window.showOpenDialog({
      canSelectFolders: true,
      canSelectFiles: false,
      canSelectMany: false,
      openLabel: "Open as Repository",
    });
    if (!picked || picked.length === 0) {
      return;
    }

    const uri = picked[0];
    try {
      await vscode.workspace.fs.stat(vscode.Uri.joinPath(uri, ".git"));
    } catch {
      vscode.window.showErrorMessage(
        `Claude Commit: "${uri.fsPath}" doesn't look like a git repository (no .git found).`
      );
      return;
    }

    const path = uri.fsPath;
    if (!this.extraRepoPaths.includes(path)) {
      this.extraRepoPaths = [...this.extraRepoPaths, path];
      await this.context.globalState.update(EXTRA_REPOS_STATE_KEY, this.extraRepoPaths);
    }
    this.switchRepository(path);
  }

  private async handleMessage(message: WebviewMessage) {
    switch (message.type) {
      case "loadCommits":
        this.historyGrep = (message.grep as string) || undefined;
        this.historyAuthor = (message.author as string) || undefined;
        this.historySince = (message.since as string) || undefined;
        this.historyUntil = (message.until as string) || undefined;
        await this.loadCommits(true);
        break;
      case "loadMoreCommits":
        await this.loadCommits(false);
        break;
      case "selectBranch":
        this.historyBranch = (message.branch as string) || undefined;
        await Promise.all([this.loadCommits(true), this.loadAuthors()]);
        break;
      case "selectRepository": {
        const path = message.path as string;
        if (path && path !== this.cwd) {
          this.switchRepository(path);
        }
        break;
      }
      case "browseRepository":
        await this.browseForRepository();
        break;
      case "getCommitDetail":
        await this.sendCommitDetail(message.hash as string);
        break;
      case "viewDiff":
        await this.viewDiff(message.hash as string, message.file as ChangedFile);
        break;
      case "copyToClipboard":
        await vscode.env.clipboard.writeText(message.text as string);
        break;
      case "chatSend":
        await this.handleChatSend(message.text as string);
        break;
      case "newChat":
        this.startNewConversation();
        break;
      case "switchConversation":
        this.activateConversation(message.id as string);
        break;
      case "designGenerate":
        await this.handleDesignGenerate({
          responsive: Boolean(message.responsive),
          figmaUrl: message.figmaUrl as string | undefined,
          breakpoints: message.breakpoints as Record<string, string> | undefined,
          prompt: message.prompt as string,
          attachments: (message.attachments as DesignAttachment[] | undefined) ?? [],
        });
        break;
    }
  }

  private async loadCommits(reset: boolean) {
    if (reset) {
      this.historySkip = 0;
    }
    try {
      const { commits, hasMore } = await listCommits(this.cwd, {
        skip: this.historySkip,
        limit: PAGE_SIZE,
        grep: this.historyGrep,
        branch: this.historyBranch,
        author: this.historyAuthor,
        since: this.historySince,
        until: this.historyUntil,
      });
      this.historySkip += commits.length;
      this.post({ type: "commits", commits, hasMore, reset });
    } catch (err) {
      this.postError(err);
    }
  }

  private async loadBranches() {
    const { branches, current } = await listBranches(this.cwd);
    if (!this.historyBranch) {
      this.historyBranch = current || undefined;
    }
    this.post({ type: "branches", branches, current: this.historyBranch ?? current });
  }

  private async loadAuthors() {
    const authors = await listAuthors(this.cwd, this.historyBranch);
    this.post({ type: "authors", authors });
  }

  private async sendCommitDetail(hash: string) {
    try {
      const detail = await getCommitDetail(this.cwd, hash);
      this.post({ type: "commitDetail", detail });
    } catch (err) {
      this.postError(err);
    }
  }

  private async viewDiff(hash: string, file: ChangedFile) {
    try {
      const leftPath = file.oldPath ?? file.path;
      const leftUri = toGitRevisionUri({ cwd: this.cwd, hash: `${hash}^`, path: leftPath });
      const rightUri = toGitRevisionUri({ cwd: this.cwd, hash, path: file.path });
      await vscode.commands.executeCommand(
        "vscode.diff",
        leftUri,
        rightUri,
        `${file.path} @ ${hash.slice(0, 7)}`
      );
    } catch (err) {
      this.postError(err);
    }
  }

  private async handleChatSend(text: string) {
    const config = vscode.workspace.getConfiguration("claudeCommit");
    const cliPath = config.get<string>("cliPath", "claude");
    const model = config.get<string>("model", "").trim();
    const timeoutSeconds = config.get<number>("timeoutSeconds", 60);
    // Agentic exploration (git log/show/blame, reading files) takes longer
    // than the single-shot commit-message call, so give it more room.
    const timeoutMs = Math.max(timeoutSeconds * 2, 120) * 1000;

    let convo = this.conversations.find((c) => c.id === this.activeConversationId);
    if (!convo) {
      convo = {
        id: randomUUID(),
        title: deriveConversationTitle(text),
        updatedAt: new Date().toISOString(),
        messages: [],
      };
      this.conversations.unshift(convo);
      this.activeConversationId = convo.id;
    }
    convo.messages.push({ role: "user", text });
    convo.messages = convo.messages.slice(-MAX_PERSISTED_CHAT_MESSAGES);

    this.post({ type: "chatBusy", busy: true });
    try {
      const answer = await askChat({
        cliPath,
        cwd: this.cwd,
        question: text,
        model: model || undefined,
        timeoutMs,
        session: this.chatSession,
      });
      this.post({ type: "chatMessage", role: "assistant", text: answer.text });
      convo.messages.push({ role: "assistant", text: answer.text });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.post({ type: "chatMessage", role: "system", text: message });
      convo.messages.push({ role: "system", text: message });
    } finally {
      convo.sessionId = this.chatSession.sessionId;
      convo.updatedAt = new Date().toISOString();
      convo.messages = convo.messages.slice(-MAX_PERSISTED_CHAT_MESSAGES);
      this.post({ type: "chatBusy", busy: false });
      await this.saveConversations();
      this.postConversationList();
    }
  }

  // Placeholder for the Figma-MCP-driven design-to-code flow: the Design
  // tab's UI (single or per-breakpoint Figma URLs, file attachments, and an
  // optional detail prompt) is wired up end to end, but actually invoking
  // Figma's MCP server and writing pixel-perfect component code from it is
  // a follow-up step.
  private async handleDesignGenerate(params: {
    responsive: boolean;
    figmaUrl?: string;
    breakpoints?: Record<string, string>;
    prompt: string;
    attachments: DesignAttachment[];
  }) {
    this.post({ type: "designBusy", busy: true });
    const received: string[] = [];
    if (params.responsive && params.breakpoints) {
      const parts = ["sm", "md", "lg", "xl", "2xl"]
        .filter((bp) => params.breakpoints![bp])
        .map((bp) => `${bp}: ${params.breakpoints![bp]}`);
      if (parts.length) {
        received.push(`breakpoints - ${parts.join(", ")}`);
      }
    } else if (params.figmaUrl) {
      received.push(`Figma URL - ${params.figmaUrl}`);
    }
    if (params.attachments.length) {
      received.push(`${params.attachments.length} attached file(s) - ${params.attachments.map((a) => a.name).join(", ")}`);
    }
    this.post({
      type: "designMessage",
      role: "system",
      text:
        "Design generation isn't wired up yet - this will use the Figma MCP server to build this design in a follow-up step." +
        (received.length ? ` Received ${received.join("; ")}.` : ""),
    });
    this.post({ type: "designBusy", busy: false });
  }

  private post(message: unknown) {
    this.panel.webview.postMessage(message);
  }

  private postError(err: unknown) {
    this.post({ type: "error", message: err instanceof Error ? err.message : String(err) });
  }
}

function repoName(fsPath: string): string {
  return fsPath.split("/").pop() ?? fsPath;
}

function getHubHtml(webview: vscode.Webview): string {
  const nonce = getNonce();
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<title>Claude Commit</title>
<style>
  body {
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    padding: 0;
    margin: 0;
  }
  .tabs {
    display: flex;
    border-bottom: 1px solid var(--vscode-panel-border);
    position: sticky;
    top: 0;
    z-index: 20;
    background: var(--vscode-editor-background);
  }
  .tab-btn {
    background: none;
    border: none;
    color: var(--vscode-foreground);
    padding: 8px 16px;
    cursor: pointer;
    border-bottom: 2px solid transparent;
  }
  .tab-btn.active {
    border-bottom: 2px solid var(--vscode-focusBorder);
    font-weight: 600;
  }
  .tab-panel { display: none; padding: 12px; }
  .tab-panel.active { display: block; }
  #chat.tab-panel.active, #design.tab-panel.active {
    display: flex;
    flex-direction: column;
    height: calc(100vh - var(--tabs-height, 41px));
    box-sizing: border-box;
  }
  .history-filters {
    position: sticky;
    top: 0;
    z-index: 5;
    margin: -12px -12px 10px;
    padding: 12px 12px 0;
    background: var(--vscode-editor-background);
    border-bottom: 1px solid var(--vscode-panel-border);
  }
  .toolbar, .search-row {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 10px;
    flex-wrap: wrap;
  }
  input[type="text"], input[type="date"], .combo input[type="text"], button {
    box-sizing: border-box;
    height: 28px;
  }
  input[type="text"], input[type="date"] {
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, transparent);
    padding: 0 6px;
  }
  .search-row #search { flex: 1; }
  .toolbar input[type="date"] { flex: 0 1 140px; }
  .toolbar .repo-combo { flex: 0 0 200px; }
  .toolbar .author-combo { flex: 1 1 200px; }
  .combo { position: relative; }
  .combo input[type="text"] {
    width: 100%;
    background: var(--vscode-dropdown-background);
    color: var(--vscode-dropdown-foreground);
    border: 1px solid var(--vscode-dropdown-border, transparent);
  }
  .branch-combo { flex: 0 0 220px; }
  .combo-dropdown {
    position: absolute;
    top: calc(100% + 2px);
    left: 0;
    right: 0;
    max-height: 220px;
    overflow-y: auto;
    background: var(--vscode-dropdown-background);
    border: 1px solid var(--vscode-dropdown-border, var(--vscode-panel-border));
    z-index: 10;
  }
  .combo-option {
    padding: 5px 8px;
    cursor: pointer;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .combo-option:hover, .combo-option.active {
    background: var(--vscode-list-hoverBackground);
  }
  .combo-option.current { font-weight: 600; }
  .combo-option.empty { opacity: 0.6; cursor: default; }
  .combo-option.empty:hover { background: none; }
  .combo-option.combo-action {
    font-style: italic;
    color: var(--vscode-descriptionForeground, inherit);
    border-top: 1px solid var(--vscode-panel-border);
  }
  button {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border: none;
    padding: 0 12px;
    cursor: pointer;
  }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button:disabled { opacity: 0.6; cursor: default; }
  #commitList { list-style: none; margin: 0; padding: 0; }
  .commit-row {
    padding: 6px 8px;
    border-bottom: 1px solid var(--vscode-panel-border);
    cursor: pointer;
  }
  .commit-row:hover { background: var(--vscode-list-hoverBackground); }
  .commit-row-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
  .commit-row-lead { display: flex; align-items: flex-start; gap: 8px; min-width: 0; }
  .commit-dot {
    flex-shrink: 0;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    margin-top: 5px;
    box-sizing: border-box;
    background: var(--dot-color, var(--vscode-focusBorder, #007acc));
  }
  .commit-dot.merge {
    background: none;
    border: 2px solid var(--dot-color, var(--vscode-focusBorder, #007acc));
  }
  /* One color per branch lane (cycling), matching VS Code's own git-graph
     bullet colors via its chart-color theme tokens. */
  .commit-dot.lane-0 { --dot-color: var(--vscode-charts-blue, #3794ff); }
  .commit-dot.lane-1 { --dot-color: var(--vscode-charts-purple, #b180d7); }
  .commit-dot.lane-2 { --dot-color: var(--vscode-charts-orange, #d18616); }
  .commit-dot.lane-3 { --dot-color: var(--vscode-charts-green, #89d185); }
  .commit-dot.lane-4 { --dot-color: var(--vscode-charts-red, #f14c4c); }
  .commit-dot.lane-5 { --dot-color: var(--vscode-charts-yellow, #cca700); }
  .commit-row-main { min-width: 0; }
  .commit-subject { font-weight: 600; overflow: hidden; text-overflow: ellipsis; }
  .commit-meta { font-size: 0.85em; display: flex; align-items: center; gap: 2px; }
  .commit-meta-text { opacity: 0.75; }
  .commit-author { font-weight: 600; color: var(--vscode-textLink-foreground, #3794ff); }
  .commit-hash-pill {
    font-family: var(--vscode-editor-font-family, monospace);
    background: var(--vscode-textCodeBlock-background, rgba(127, 127, 127, 0.2));
    color: var(--vscode-textPreformat-foreground, inherit);
    padding: 1px 5px;
    border-radius: 3px;
  }
  .commit-badges { display: flex; gap: 6px; flex-shrink: 0; margin-top: 1px; }
  .commit-badge {
    font-size: 0.8em;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    padding: 1px 7px;
    border-radius: 10px;
    background: rgba(0, 0, 0, 0.35);
  }
  .commit-badge.added { color: var(--vscode-gitDecoration-addedResourceForeground, #4caf50); }
  .commit-badge.modified { color: var(--vscode-gitDecoration-modifiedResourceForeground, #e2c08d); }
  .commit-badge.deleted { color: var(--vscode-gitDecoration-deletedResourceForeground, #f14c4c); }
  .commit-detail { padding: 8px 8px 8px 20px; white-space: pre-wrap; font-size: 0.9em; }
  .copy-hash-btn {
    height: 20px;
    width: 20px;
    padding: 0;
    line-height: 1;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: transparent;
    color: var(--vscode-button-background);
    border-radius: 4px;
  }
  .copy-hash-btn:hover { background: var(--vscode-toolbar-hoverBackground, rgba(127, 127, 127, 0.2)); }
  .commit-stat-line { margin-bottom: 6px; opacity: 0.9; }
  .stat-insertions { color: var(--vscode-gitDecoration-addedResourceForeground, #4caf50); }
  .stat-deletions { color: var(--vscode-gitDecoration-deletedResourceForeground, #f14c4c); }
  .file-row { display: flex; justify-content: space-between; padding: 2px 0; }
  .status-letter {
    display: inline-block;
    width: 1.4em;
    text-align: center;
    font-weight: 700;
    font-family: var(--vscode-editor-font-family, monospace);
    margin-right: 6px;
  }
  .status-letter.added { color: var(--vscode-gitDecoration-addedResourceForeground, #4caf50); }
  .status-letter.modified { color: var(--vscode-gitDecoration-modifiedResourceForeground, #e2c08d); }
  .status-letter.deleted { color: var(--vscode-gitDecoration-deletedResourceForeground, #f14c4c); }
  #loadMoreIndicator { margin-top: 10px; opacity: 0.75; text-align: center; display: none; }
  .chat-body { display: flex; flex-direction: row; flex: 1; min-height: 0; gap: 10px; }
  .chat-main { display: flex; flex-direction: column; flex: 1; min-width: 0; }
  .sidebar-toggle {
    flex-shrink: 0;
    align-self: stretch;
    width: 18px;
    padding: 0;
  }
  .chat-sidebar {
    width: 240px;
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    min-height: 0;
    border-left: 1px solid var(--vscode-panel-border);
    padding-left: 10px;
  }
  .chat-sidebar-header {
    margin-bottom: 8px;
    font-weight: 600;
  }
  #newChatBtn { margin-bottom: 8px; }
  #conversationSearch { margin-bottom: 8px; }
  #conversationList {
    list-style: none;
    margin: 0;
    padding: 0;
    overflow-y: auto;
    flex: 1;
    min-height: 0;
  }
  .conversation-item {
    padding: 6px 8px;
    border-radius: 4px;
    cursor: pointer;
    margin-bottom: 2px;
  }
  .conversation-item:hover { background: var(--vscode-list-hoverBackground); }
  .conversation-item.active {
    background: var(--vscode-list-activeSelectionBackground);
    color: var(--vscode-list-activeSelectionForeground);
  }
  .conversation-title {
    font-size: 0.9em;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .conversation-date { font-size: 0.75em; opacity: 0.7; margin-top: 2px; }
  #chatLog {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin-bottom: 10px;
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding-right: 14px;
  }
  .bubble { padding: 6px 10px; border-radius: 6px; max-width: 85%; white-space: pre-wrap; }
  .bubble .inline-code {
    font-family: var(--vscode-editor-font-family, monospace);
    background: var(--vscode-textCodeBlock-background, rgba(127, 127, 127, 0.2));
    color: var(--vscode-textPreformat-foreground, inherit);
    padding: 1px 4px;
    border-radius: 3px;
    font-size: 0.9em;
  }
  .bubble .code-block {
    font-family: var(--vscode-editor-font-family, monospace);
    background: var(--vscode-textCodeBlock-background, rgba(127, 127, 127, 0.2));
    color: var(--vscode-textPreformat-foreground, inherit);
    padding: 6px 8px;
    border-radius: 4px;
    font-size: 0.9em;
    overflow-x: auto;
    margin: 4px 0;
  }
  .bubble ul, .bubble ol { margin: 4px 0; padding-left: 22px; }
  .bubble li { margin: 2px 0; }
  .bubble.user { align-self: flex-end; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
  .bubble.assistant { align-self: flex-start; background: var(--vscode-editorWidget-background); }
  .bubble.system { align-self: stretch; color: var(--vscode-errorForeground); font-style: italic; }
  .bubble.thinking-bubble { display: flex; align-items: baseline; gap: 6px; opacity: 0.85; }
  .thinking-spinner {
    color: #d97757;
    font-weight: bold;
    display: inline-block;
    width: 1em;
    text-align: center;
  }
  .thinking-label { color: var(--vscode-descriptionForeground); }
  .chat-input-row { display: flex; gap: 6px; align-items: flex-end; flex-shrink: 0; }
  #chatSendBtn { height: 32px; }
  #chatInput {
    flex: 1;
    resize: none;
    min-height: 32px;
    max-height: 160px;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, transparent);
    padding: 6px;
    font-family: inherit;
    font-size: inherit;
  }
  .empty, .error-banner { opacity: 0.75; padding: 6px 0; }
  .error-banner { color: var(--vscode-errorForeground); }
  .design-body { display: flex; flex-direction: column; flex: 1; min-height: 0; gap: 10px; }
  #designLog {
    display: flex;
    flex-direction: column;
    gap: 8px;
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding-right: 14px;
  }
  .design-form { display: flex; flex-direction: column; gap: 6px; flex-shrink: 0; }
  #figmaUrlInput { width: 100%; }
  .design-toggle-row {
    display: flex;
    align-items: center;
    gap: 6px;
    cursor: pointer;
    user-select: none;
  }
  .design-toggle-row input[type="checkbox"] { margin: 0; cursor: pointer; }
  .design-breakpoints {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .design-breakpoint-row {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .design-breakpoint-row label {
    flex: 0 0 34px;
    font-size: 11px;
    font-weight: 600;
    opacity: 0.75;
    text-transform: uppercase;
  }
  .design-breakpoint-row input[type="text"] { flex: 1; }
  .design-dropzone {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 4px;
    border: 1px dashed var(--vscode-input-border, var(--vscode-panel-border));
    border-radius: 4px;
    padding: 10px;
    text-align: center;
    opacity: 0.85;
    font-size: 12px;
  }
  .design-dropzone.dragover {
    border-color: var(--vscode-focusBorder);
    opacity: 1;
    background: var(--vscode-list-hoverBackground);
  }
  .link-btn {
    background: none;
    border: none;
    height: auto;
    padding: 0;
    color: var(--vscode-textLink-foreground);
    text-decoration: underline;
    cursor: pointer;
  }
  .link-btn:hover { background: none; color: var(--vscode-textLink-activeForeground); }
  .design-attachments {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .design-attachment-chip {
    display: flex;
    align-items: center;
    gap: 6px;
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
    border-radius: 10px;
    padding: 2px 4px 2px 10px;
    font-size: 12px;
    max-width: 220px;
  }
  .design-attachment-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .design-attachment-remove {
    background: none;
    border: none;
    color: inherit;
    height: auto;
    padding: 0 4px;
    cursor: pointer;
    opacity: 0.8;
    line-height: 1;
  }
  .design-attachment-remove:hover { opacity: 1; background: none; }
  #designPromptInput {
    resize: vertical;
    min-height: 60px;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, transparent);
    padding: 6px;
    font-family: inherit;
    font-size: inherit;
  }
  #designGenerateBtn { align-self: flex-start; }
</style>
</head>
<body>
  <div class="tabs">
    <button class="tab-btn active" data-tab="history">History</button>
    <button class="tab-btn" data-tab="chat">Chat</button>
    <button class="tab-btn" data-tab="design">Design</button>
  </div>

  <div id="history" class="tab-panel active">
    <div class="history-filters">
      <div class="toolbar">
        <div class="combo repo-combo">
          <input id="repoInput" type="text" placeholder="Repository..." autocomplete="off">
          <div id="repoDropdown" class="combo-dropdown" style="display:none"></div>
        </div>
        <div class="combo branch-combo">
          <input id="branchInput" type="text" placeholder="Branch..." autocomplete="off">
          <div id="branchDropdown" class="combo-dropdown" style="display:none"></div>
        </div>
        <div class="combo author-combo">
          <input id="authorFilter" type="text" placeholder="Author..." autocomplete="off">
          <div id="authorDropdown" class="combo-dropdown" style="display:none"></div>
        </div>
        <input id="sinceFilter" type="date" title="Since">
        <input id="untilFilter" type="date" title="Until">
        <button id="applyBtn">Apply</button>
      </div>
      <div class="search-row">
        <input id="search" type="text" placeholder="Search commit messages or paste a commit hash...">
        <button id="searchBtn">Search</button>
      </div>
      <div id="historyError" class="error-banner" style="display:none"></div>
    </div>
    <ul id="commitList"></ul>
    <div id="loadMoreIndicator">Loading more...</div>
  </div>

  <div id="chat" class="tab-panel">
    <div class="chat-body">
      <div class="chat-main">
        <div id="chatLog"></div>
        <div class="chat-input-row">
          <textarea id="chatInput" rows="1" placeholder="Ask about this repo's history... (Enter to send, Shift+Enter for a new line)"></textarea>
          <button id="chatSendBtn">Send</button>
        </div>
      </div>
      <button id="sidebarToggleBtn" class="sidebar-toggle" title="Toggle conversation history">&raquo;</button>
      <div class="chat-sidebar" id="chatSidebar">
        <div class="chat-sidebar-header">
          <span>Conversations</span>
        </div>
        <button id="newChatBtn">+ New chat</button>
        <input id="conversationSearch" type="text" placeholder="Search conversations...">
        <ul id="conversationList"></ul>
      </div>
    </div>
  </div>

  <div id="design" class="tab-panel">
    <div class="design-body">
      <div id="designLog"></div>
      <div class="design-form">
        <label class="design-toggle-row">
          <input id="responsiveToggle" type="checkbox">
          <span>Responsive design (separate Figma URL per breakpoint)</span>
        </label>
        <div id="figmaUrlSingle">
          <input id="figmaUrlInput" type="text" placeholder="Figma file or frame URL...">
        </div>
        <div id="figmaUrlResponsive" class="design-breakpoints" style="display:none">
          <div class="design-breakpoint-row">
            <label for="figmaUrlSm">sm</label>
            <input id="figmaUrlSm" type="text" placeholder="Figma URL for sm (≥640px)">
          </div>
          <div class="design-breakpoint-row">
            <label for="figmaUrlMd">md</label>
            <input id="figmaUrlMd" type="text" placeholder="Figma URL for md (≥768px)">
          </div>
          <div class="design-breakpoint-row">
            <label for="figmaUrlLg">lg</label>
            <input id="figmaUrlLg" type="text" placeholder="Figma URL for lg (≥1024px)">
          </div>
          <div class="design-breakpoint-row">
            <label for="figmaUrlXl">xl</label>
            <input id="figmaUrlXl" type="text" placeholder="Figma URL for xl (≥1280px)">
          </div>
          <div class="design-breakpoint-row">
            <label for="figmaUrl2xl">2xl</label>
            <input id="figmaUrl2xl" type="text" placeholder="Figma URL for 2xl (≥1536px)">
          </div>
        </div>
        <div id="designDropzone" class="design-dropzone">
          <span>Drag &amp; drop files here, or <button type="button" id="designAttachBtn" class="link-btn">browse</button></span>
          <input id="designFileInput" type="file" multiple style="display:none">
        </div>
        <div id="designAttachments" class="design-attachments"></div>
        <textarea id="designPromptInput" rows="3" placeholder="Optional: describe the design in more detail (spacing, states, breakpoints, etc.)"></textarea>
        <button id="designGenerateBtn">Generate</button>
      </div>
    </div>
  </div>

<script nonce="${nonce}">
(function () {
  var vscode = acquireVsCodeApi();
  var commitDetails = {};

  // Surface unexpected JS errors in the chat log itself rather than only
  // the (harder to reach, in a webview) devtools console, so a bug here
  // shows up as a visible message instead of a silent blank response.
  window.addEventListener("error", function (event) {
    if (typeof chatLog !== "undefined" && chatLog && typeof appendBubble === "function") {
      appendBubble("system", "Internal UI error: " + (event.message || "unknown error") + ".");
    }
  });

  // The history filters bar sticks right below the tab strip rather than
  // at the very top of the viewport - measure the strip's actual rendered
  // height (font size/zoom-dependent) instead of hardcoding a pixel value.
  var tabsEl = document.querySelector(".tabs");
  var historyFiltersEl = document.querySelector(".history-filters");
  if (tabsEl && historyFiltersEl) {
    historyFiltersEl.style.top = tabsEl.offsetHeight + "px";
    document.documentElement.style.setProperty("--tabs-height", tabsEl.offsetHeight + "px");
  }

  document.querySelectorAll(".tab-btn").forEach(function (btn) {
    btn.addEventListener("click", function () {
      document.querySelectorAll(".tab-btn").forEach(function (b) { b.classList.remove("active"); });
      document.querySelectorAll(".tab-panel").forEach(function (p) { p.classList.remove("active"); });
      btn.classList.add("active");
      document.getElementById(btn.getAttribute("data-tab")).classList.add("active");
    });
  });

  var commitList = document.getElementById("commitList");
  var loadMoreIndicator = document.getElementById("loadMoreIndicator");
  var historyPanel = document.getElementById("history");
  var historyError = document.getElementById("historyError");
  var searchInput = document.getElementById("search");
  var authorInput = document.getElementById("authorFilter");
  var authorDropdown = document.getElementById("authorDropdown");
  var sinceInput = document.getElementById("sinceFilter");
  var untilInput = document.getElementById("untilFilter");
  var branchInput = document.getElementById("branchInput");
  var branchDropdown = document.getElementById("branchDropdown");
  var repoInput = document.getElementById("repoInput");
  var repoDropdown = document.getElementById("repoDropdown");

  function applyFilters() {
    vscode.postMessage({
      type: "loadCommits",
      grep: searchInput.value.trim(),
      author: authorInput.value.trim(),
      since: sinceInput.value,
      until: untilInput.value,
    });
  }

  document.getElementById("searchBtn").addEventListener("click", applyFilters);
  document.getElementById("applyBtn").addEventListener("click", applyFilters);
  [searchInput, sinceInput, untilInput].forEach(function (el) {
    el.addEventListener("keydown", function (e) {
      if (e.key === "Enter") { applyFilters(); }
    });
  });
  // Infinite scroll: fetch the next page once the user nears the bottom of
  // the (webview's own, page-level) scroll area, instead of a manual
  // "Load more" button.
  var hasMoreCommits = false;
  var isLoadingMore = false;

  function maybeLoadMore() {
    if (!hasMoreCommits || isLoadingMore || !historyPanel.classList.contains("active")) {
      return;
    }
    var nearBottom = window.innerHeight + window.scrollY >= document.body.offsetHeight - 150;
    if (nearBottom) {
      isLoadingMore = true;
      loadMoreIndicator.style.display = "block";
      vscode.postMessage({ type: "loadMoreCommits" });
    }
  }
  window.addEventListener("scroll", maybeLoadMore);

  // Clearing the message-search or author box (typing/deleting down to
  // empty, or a browser/OS "clear" action) drops that filter and refetches
  // immediately, rather than waiting for Apply/Enter.
  [searchInput, authorInput].forEach(function (el) {
    el.addEventListener("input", function () {
      if (el.value.trim() === "") { applyFilters(); }
    });
  });

  // Generic type-to-filter combobox, shared by the branch and author
  // fields: an <input> plus an absolutely-positioned dropdown of matches,
  // with mouse click, arrow-key navigation, and Enter-to-commit.
  function createCombobox(input, dropdown, getOptions, opts) {
    opts = opts || {};
    var activeIndex = -1;

    function options() {
      return typeof getOptions === "function" ? getOptions() : getOptions;
    }

    function filtered() {
      var term = input.value.trim().toLowerCase();
      var all = options();
      if (!term) { return all; }
      return all.filter(function (v) { return v.toLowerCase().indexOf(term) !== -1; });
    }

    function render() {
      var matches = filtered();
      activeIndex = -1;
      dropdown.innerHTML = "";
      if (matches.length === 0 && !opts.extraAction) {
        var empty = document.createElement("div");
        empty.className = "combo-option empty";
        empty.textContent = opts.emptyText || "No matches";
        dropdown.appendChild(empty);
      } else {
        matches.forEach(function (value) {
          var el = document.createElement("div");
          el.className = "combo-option" + (opts.isCurrent && opts.isCurrent(value) ? " current" : "");
          el.textContent = value;
          el.addEventListener("mousedown", function (e) {
            e.preventDefault();
            commit(value);
          });
          dropdown.appendChild(el);
        });
      }
      // An always-shown action row (e.g. "Browse for repository...") -
      // present regardless of the typed filter, since it's an action, not
      // a value to filter against.
      if (opts.extraAction) {
        var actionEl = document.createElement("div");
        actionEl.className = "combo-option combo-action";
        actionEl.textContent = opts.extraAction.label;
        actionEl.addEventListener("mousedown", function (e) {
          e.preventDefault();
          hide();
          opts.extraAction.onSelect();
        });
        dropdown.appendChild(actionEl);
      }
      dropdown.style.display = "block";
    }

    function hide() { dropdown.style.display = "none"; }

    function commit(value) {
      input.value = value;
      hide();
      if (opts.onCommit) { opts.onCommit(value); }
    }

    function moveActive(delta) {
      var els = dropdown.querySelectorAll(".combo-option:not(.empty)");
      if (els.length === 0) { return; }
      activeIndex = (activeIndex + delta + els.length) % els.length;
      els.forEach(function (el, i) { el.classList.toggle("active", i === activeIndex); });
      els[activeIndex].scrollIntoView({ block: "nearest" });
    }

    input.addEventListener("focus", render);
    input.addEventListener("input", render);
    input.addEventListener("blur", function () { setTimeout(hide, 100); });
    input.addEventListener("keydown", function (e) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        if (dropdown.style.display === "none") { render(); }
        moveActive(1);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        moveActive(-1);
      } else if (e.key === "Enter") {
        var els = dropdown.querySelectorAll(".combo-option:not(.empty)");
        var matches = filtered();
        if (activeIndex >= 0 && els[activeIndex]) {
          e.preventDefault();
          if (opts.extraAction && activeIndex === matches.length) {
            hide();
            opts.extraAction.onSelect();
          } else {
            commit(matches[activeIndex]);
          }
        } else if (opts.selectTopMatchOnEnter && matches.length > 0) {
          e.preventDefault();
          commit(matches[0]);
        } else if (opts.onPlainEnter) {
          opts.onPlainEnter();
        }
      } else if (e.key === "Escape") {
        hide();
        if (opts.onEscape) { opts.onEscape(); }
      }
    });

    return {
      setValue: function (value) { input.value = value; },
    };
  }

  var allBranches = [];
  var currentBranch = "";
  var branchCombo = createCombobox(branchInput, branchDropdown, function () { return allBranches; }, {
    emptyText: "No matching branches",
    isCurrent: function (b) { return b === currentBranch; },
    selectTopMatchOnEnter: true,
    onCommit: function (branch) {
      currentBranch = branch;
      vscode.postMessage({ type: "selectBranch", branch: branch });
    },
    onEscape: function () { branchInput.value = currentBranch; },
  });

  function renderBranches(branches, current) {
    allBranches = branches;
    currentBranch = current;
    branchCombo.setValue(current);
  }

  var allAuthors = [];
  createCombobox(authorInput, authorDropdown, function () { return allAuthors; }, {
    emptyText: "No matching authors",
    // Unlike branch, picking an author (or pressing Enter with none
    // highlighted) applies the filter immediately alongside whatever else
    // is already in the other filter fields.
    onCommit: applyFilters,
    onPlainEnter: applyFilters,
  });

  function renderAuthors(authors) {
    allAuthors = authors;
  }

  var allRepoNames = [];
  var repoPathByName = {};
  var currentRepoName = "";
  var repoCombo = createCombobox(repoInput, repoDropdown, function () { return allRepoNames; }, {
    emptyText: "No matching repositories",
    isCurrent: function (name) { return name === currentRepoName; },
    selectTopMatchOnEnter: true,
    onCommit: function (name) {
      var path = repoPathByName[name];
      if (path) {
        currentRepoName = name;
        vscode.postMessage({ type: "selectRepository", path: path });
      }
    },
    onEscape: function () { repoInput.value = currentRepoName; },
    extraAction: {
      label: "Browse for repository...",
      onSelect: function () { vscode.postMessage({ type: "browseRepository" }); },
    },
  });

  function renderRepositories(repos, currentPath) {
    repoPathByName = {};
    allRepoNames = repos.map(function (repo) {
      repoPathByName[repo.name] = repo.path;
      return repo.name;
    });
    var current = repos.filter(function (repo) { return repo.path === currentPath; })[0];
    currentRepoName = current ? current.name : "";
    repoCombo.setValue(currentRepoName);
  }

  function renderCommits(commits, reset) {
    if (reset) {
      commitList.innerHTML = "";
      commitDetails = {};
    }
    if (reset && commits.length === 0) {
      var empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = "No commits found.";
      commitList.appendChild(empty);
      return;
    }
    commits.forEach(function (commit) {
      var li = document.createElement("li");
      li.className = "commit-row";

      var header = document.createElement("div");
      header.className = "commit-row-header";

      var lead = document.createElement("div");
      lead.className = "commit-row-lead";

      var dot = document.createElement("span");
      var lane = (commit.lane || 0) % 6;
      dot.className = "commit-dot lane-" + lane + (commit.isMerge ? " merge" : "");
      lead.appendChild(dot);

      var main = document.createElement("div");
      main.className = "commit-row-main";
      var subject = document.createElement("div");
      subject.className = "commit-subject";
      subject.textContent = commit.subject;
      var meta = document.createElement("div");
      meta.className = "commit-meta";
      var hashPill = document.createElement("code");
      hashPill.className = "commit-hash-pill";
      hashPill.textContent = commit.shortHash;
      var sep1 = document.createElement("span");
      sep1.className = "commit-meta-text";
      sep1.textContent = " · ";
      var authorSpan = document.createElement("span");
      authorSpan.className = "commit-author";
      authorSpan.textContent = commit.author;
      var metaText = document.createElement("span");
      metaText.className = "commit-meta-text";
      metaText.textContent = " · " + formatCommitDate(commit.date);
      var copyBtn = document.createElement("button");
      copyBtn.type = "button";
      copyBtn.className = "copy-hash-btn";
      copyBtn.title = "Copy hash";
      copyBtn.textContent = "⧉";
      copyBtn.addEventListener("click", function (e) {
        e.stopPropagation();
        vscode.postMessage({ type: "copyToClipboard", text: commit.hash });
        copyBtn.textContent = "✓";
        setTimeout(function () { copyBtn.textContent = "⧉"; }, 1200);
      });
      meta.appendChild(hashPill);
      meta.appendChild(copyBtn);
      meta.appendChild(sep1);
      meta.appendChild(authorSpan);
      meta.appendChild(metaText);
      main.appendChild(subject);
      main.appendChild(meta);
      lead.appendChild(main);
      header.appendChild(lead);

      var stats = commit.fileStats || { added: 0, modified: 0, deleted: 0 };
      if (stats.added || stats.modified || stats.deleted) {
        var badges = document.createElement("div");
        badges.className = "commit-badges";
        badges.title = stats.added + " added, " + stats.modified + " modified, " + stats.deleted + " deleted";
        if (stats.added) {
          var addedBadge = document.createElement("span");
          addedBadge.className = "commit-badge added";
          addedBadge.textContent = "+" + stats.added + "A";
          badges.appendChild(addedBadge);
        }
        if (stats.modified) {
          var modifiedBadge = document.createElement("span");
          modifiedBadge.className = "commit-badge modified";
          modifiedBadge.textContent = "~" + stats.modified + "M";
          badges.appendChild(modifiedBadge);
        }
        if (stats.deleted) {
          var deletedBadge = document.createElement("span");
          deletedBadge.className = "commit-badge deleted";
          deletedBadge.textContent = "-" + stats.deleted + "D";
          badges.appendChild(deletedBadge);
        }
        header.appendChild(badges);
      }

      li.appendChild(header);

      var detailEl = document.createElement("div");
      detailEl.className = "commit-detail";
      detailEl.style.display = "none";
      li.appendChild(detailEl);

      li.addEventListener("click", function (e) {
        if (e.target.tagName === "A") { return; }
        var isOpen = detailEl.style.display !== "none";
        if (isOpen) {
          detailEl.style.display = "none";
          return;
        }
        detailEl.style.display = "block";
        if (commitDetails[commit.hash]) {
          return;
        }
        detailEl.textContent = "Loading...";
        vscode.postMessage({ type: "getCommitDetail", hash: commit.hash });
      });

      commitList.appendChild(li);
    });
  }

  var MONTH_NAMES = ["January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"];

  function formatCommitDate(raw) {
    var d = new Date(raw);
    if (isNaN(d.getTime())) { return raw; }
    var now = new Date();
    var isToday = d.getFullYear() === now.getFullYear()
      && d.getMonth() === now.getMonth()
      && d.getDate() === now.getDate();
    if (isToday) {
      return "Today, " + d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    }
    return d.getDate() + " " + MONTH_NAMES[d.getMonth()] + " " + d.getFullYear();
  }

  function parseStatSummary(raw) {
    var filesMatch = raw.match(/(\d+) files? changed/);
    var insMatch = raw.match(/(\d+) insertion/);
    var delMatch = raw.match(/(\d+) deletion/);
    return {
      files: filesMatch ? filesMatch[1] : null,
      insertions: insMatch ? insMatch[1] : null,
      deletions: delMatch ? delMatch[1] : null,
    };
  }

  function renderDetail(detail) {
    commitDetails[detail.hash] = detail;
    var rows = commitList.querySelectorAll(".commit-row");
    rows.forEach(function (row) {
      var meta = row.querySelector(".commit-meta");
      if (!meta || meta.textContent.indexOf(detail.hash.slice(0, 7)) !== 0) { return; }
      var detailEl = row.querySelector(".commit-detail");
      detailEl.innerHTML = "";

      if (detail.body && detail.body.trim()) {
        var body = document.createElement("div");
        body.textContent = detail.body;
        detailEl.appendChild(body);
      }

      var stat = parseStatSummary(detail.statSummary || "");
      if (stat.files || stat.insertions || stat.deletions) {
        var statLine = document.createElement("div");
        statLine.className = "commit-stat-line";
        if (stat.files) {
          var filesSpan = document.createElement("span");
          filesSpan.textContent = stat.files + (stat.files === "1" ? " file changed" : " files changed");
          statLine.appendChild(filesSpan);
        }
        if (stat.insertions) {
          var insSpan = document.createElement("span");
          insSpan.className = "stat-insertions";
          insSpan.textContent = (stat.files ? ", " : "") + stat.insertions + " insertions(+)";
          statLine.appendChild(insSpan);
        }
        if (stat.deletions) {
          var delSpan = document.createElement("span");
          delSpan.className = "stat-deletions";
          delSpan.textContent = (stat.files || stat.insertions ? ", " : "") + stat.deletions + " deletions(-)";
          statLine.appendChild(delSpan);
        }
        detailEl.appendChild(statLine);
      }

      detail.files.forEach(function (file) {
        var fr = document.createElement("div");
        fr.className = "file-row";

        var statusChar = file.status.charAt(0);
        var category = statusChar === "A" || statusChar === "U" ? "added"
          : statusChar === "D" ? "deleted"
          : "modified";

        var label = document.createElement("span");
        var statusEl = document.createElement("span");
        statusEl.className = "status-letter " + category;
        statusEl.textContent = statusChar;
        var pathEl = document.createElement("span");
        pathEl.textContent = file.path;
        label.appendChild(statusEl);
        label.appendChild(pathEl);

        var link = document.createElement("a");
        link.href = "#";
        link.textContent = "View diff";
        link.addEventListener("click", function (e) {
          e.preventDefault();
          vscode.postMessage({ type: "viewDiff", hash: detail.hash, file: file });
        });
        fr.appendChild(label);
        fr.appendChild(link);
        detailEl.appendChild(fr);
      });
    });
  }

  var chatLog = document.getElementById("chatLog");
  var chatInput = document.getElementById("chatInput");
  var chatSendBtn = document.getElementById("chatSendBtn");
  var chatSidebar = document.getElementById("chatSidebar");
  var conversationList = document.getElementById("conversationList");
  var conversationSearch = document.getElementById("conversationSearch");
  var designLog = document.getElementById("designLog");
  var responsiveToggle = document.getElementById("responsiveToggle");
  var figmaUrlSingle = document.getElementById("figmaUrlSingle");
  var figmaUrlResponsive = document.getElementById("figmaUrlResponsive");
  var figmaUrlInput = document.getElementById("figmaUrlInput");
  var figmaUrlSm = document.getElementById("figmaUrlSm");
  var figmaUrlMd = document.getElementById("figmaUrlMd");
  var figmaUrlLg = document.getElementById("figmaUrlLg");
  var figmaUrlXl = document.getElementById("figmaUrlXl");
  var figmaUrl2xl = document.getElementById("figmaUrl2xl");
  var designDropzone = document.getElementById("designDropzone");
  var designAttachBtn = document.getElementById("designAttachBtn");
  var designFileInput = document.getElementById("designFileInput");
  var designAttachmentsEl = document.getElementById("designAttachments");
  var designAttachments = [];
  var designPromptInput = document.getElementById("designPromptInput");
  var designGenerateBtn = document.getElementById("designGenerateBtn");
  var newChatBtn = document.getElementById("newChatBtn");
  var sidebarToggleBtn = document.getElementById("sidebarToggleBtn");
  var allConversations = [];
  var activeConversationId = null;
  var sidebarCollapsed = false;

  newChatBtn.addEventListener("click", function () {
    vscode.postMessage({ type: "newChat" });
  });
  sidebarToggleBtn.addEventListener("click", function () {
    sidebarCollapsed = !sidebarCollapsed;
    chatSidebar.style.display = sidebarCollapsed ? "none" : "flex";
    sidebarToggleBtn.textContent = sidebarCollapsed ? "«" : "»";
    sidebarToggleBtn.title = sidebarCollapsed ? "Show conversation history" : "Collapse";
  });
  conversationSearch.addEventListener("input", renderConversationList);

  function renderConversationList() {
    var term = conversationSearch.value.trim().toLowerCase();
    var filtered = term
      ? allConversations.filter(function (c) { return c.title.toLowerCase().indexOf(term) !== -1; })
      : allConversations;

    conversationList.innerHTML = "";
    if (filtered.length === 0) {
      var empty = document.createElement("li");
      empty.className = "empty";
      empty.textContent = term ? "No matching conversations." : "No conversations yet.";
      conversationList.appendChild(empty);
      return;
    }
    filtered.forEach(function (convo) {
      var li = document.createElement("li");
      li.className = "conversation-item" + (convo.id === activeConversationId ? " active" : "");
      var title = document.createElement("div");
      title.className = "conversation-title";
      title.textContent = convo.title;
      var date = document.createElement("div");
      date.className = "conversation-date";
      date.textContent = new Date(convo.updatedAt).toLocaleString();
      li.appendChild(title);
      li.appendChild(date);
      li.addEventListener("click", function () {
        vscode.postMessage({ type: "switchConversation", id: convo.id });
      });
      conversationList.appendChild(li);
    });
  }

  function renderConversations(conversations, activeId) {
    allConversations = conversations;
    activeConversationId = activeId;
    renderConversationList();
  }

  // Auto-scroll to the newest message, but back off the moment the user
  // scrolls on their own (they're reading history), and only resume once
  // they've stopped scrolling for a bit - matching how most chat UIs behave.
  var chatAutoScroll = true;
  var suppressNextScrollEvent = false;
  var scrollIdleTimer = null;

  function scrollChatToBottom() {
    suppressNextScrollEvent = true;
    chatLog.scrollTop = chatLog.scrollHeight;
  }

  chatLog.addEventListener("scroll", function () {
    if (suppressNextScrollEvent) {
      suppressNextScrollEvent = false;
      return;
    }
    chatAutoScroll = false;
    if (scrollIdleTimer) { clearTimeout(scrollIdleTimer); }
    scrollIdleTimer = setTimeout(function () {
      chatAutoScroll = true;
    }, 600);
  });

  function escapeHtml(text) {
    return text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  // Minimal markdown for chat replies: fenced code blocks, bullet/numbered
  // lists, inline code spans (which is how commit hashes, branch names,
  // dates, and file paths show up in Claude's answers), and bold text. This
  // is a line-based parser (not a single global regex pass) because fenced
  // code blocks and lists are multi-line constructs - a plain regex over
  // the whole string can't tell a triple-backtick fence from a one-off
  // inline backtick, and leaves list markers as literal dash/number text
  // instead of real list markup.
  //
  // This whole file is itself one giant untagged template literal (the
  // HTML this function builds), so any backslash escape sequence typed
  // below - even inside what looks like a nested JS string or regex
  // literal - is resolved by that outer literal before this code ever
  // reaches the browser: unrecognized letter escapes silently lose their
  // backslash (changing what a regex like a whitespace/digit shorthand
  // matches), and recognized ones (newline, tab) are turned into real
  // newline/tab bytes, which breaks out of whatever quotes they were
  // written in - exactly the bug that made the chat panel fail to load
  // entirely the first time this function used a raw newline escape in a
  // string. Do not add backslash escapes (in strings or regex literals)
  // below - build any special character from String.fromCharCode instead,
  // the same way BACKTICK avoids embedding a literal backtick that would
  // terminate the outer template early.
  var BACKTICK = String.fromCharCode(96);
  var NEWLINE = String.fromCharCode(10);
  var inlineCodePattern = new RegExp(BACKTICK + "([^" + BACKTICK + "]+)" + BACKTICK, "g");
  var FENCE = BACKTICK + BACKTICK + BACKTICK;
  var BOLD = "*" + "*";

  function isSpaceOrTab(ch) {
    return ch === " " || ch === String.fromCharCode(9);
  }

  function isDigit(ch) {
    return ch >= "0" && ch <= "9";
  }

  function trimLeft(line) {
    var i = 0;
    while (i < line.length && isSpaceOrTab(line.charAt(i))) { i++; }
    return line.slice(i);
  }

  function isFenceLine(line) {
    return trimLeft(line).slice(0, 3) === FENCE;
  }

  function matchBullet(line) {
    var trimmed = trimLeft(line);
    if ((trimmed.charAt(0) === "-" || trimmed.charAt(0) === "*") && isSpaceOrTab(trimmed.charAt(1))) {
      return trimLeft(trimmed.slice(1));
    }
    return null;
  }

  function matchNumbered(line) {
    var trimmed = trimLeft(line);
    var i = 0;
    while (i < trimmed.length && isDigit(trimmed.charAt(i))) { i++; }
    if (i === 0) { return null; }
    var marker = trimmed.charAt(i);
    if ((marker === "." || marker === ")") && isSpaceOrTab(trimmed.charAt(i + 1))) {
      return trimLeft(trimmed.slice(i + 1));
    }
    return null;
  }

  function renderInlineMarkdown(line) {
    var html = escapeHtml(line);
    html = html.replace(inlineCodePattern, function (_, code) {
      return '<code class="inline-code">' + code + "</code>";
    });
    var parts = html.split(BOLD);
    if (parts.length > 2) {
      var out = "";
      for (var p = 0; p < parts.length; p++) {
        out += p % 2 === 1 ? "<strong>" + parts[p] + "</strong>" : parts[p];
      }
      html = out;
    }
    return html;
  }

  function renderMarkdownLite(text) {
    var lines = String(text).split(NEWLINE);
    var html = "";
    var listType = null;

    function closeList() {
      if (listType) {
        html += "</" + listType + ">";
        listType = null;
      }
    }

    var i = 0;
    while (i < lines.length) {
      var line = lines[i];

      if (isFenceLine(line)) {
        closeList();
        var codeLines = [];
        i++;
        while (i < lines.length && !isFenceLine(lines[i])) {
          codeLines.push(lines[i]);
          i++;
        }
        i++; // skip closing fence (or end of text if it was never closed)
        html += '<pre class="code-block"><code>' + escapeHtml(codeLines.join(NEWLINE)) + "</code></pre>";
        continue;
      }

      var bulletContent = matchBullet(line);
      var numberedContent = matchNumbered(line);

      if (bulletContent !== null) {
        if (listType !== "ul") { closeList(); html += "<ul>"; listType = "ul"; }
        html += "<li>" + renderInlineMarkdown(bulletContent) + "</li>";
        i++;
        continue;
      }
      if (numberedContent !== null) {
        if (listType !== "ol") { closeList(); html += "<ol>"; listType = "ol"; }
        html += "<li>" + renderInlineMarkdown(numberedContent) + "</li>";
        i++;
        continue;
      }

      closeList();
      if (line.trim() === "") {
        html += "<br>";
      } else {
        html += renderInlineMarkdown(line) + "<br>";
      }
      i++;
    }
    closeList();
    return html;
  }

  function appendBubble(role, text, skipScroll) {
    var safeText = text == null ? "" : String(text);
    var b = document.createElement("div");
    b.className = "bubble " + role;
    if (role === "user") {
      b.textContent = safeText;
    } else {
      // Never let a markdown-rendering edge case swallow a response -
      // fall back to plain text if anything about it goes wrong.
      try {
        b.innerHTML = renderMarkdownLite(safeText);
      } catch (e) {
        b.textContent = safeText;
      }
    }
    chatLog.appendChild(b);
    if (!skipScroll && chatAutoScroll) { scrollChatToBottom(); }
  }

  function renderChatHistory(messages) {
    messages.forEach(function (m) { appendBubble(m.role, m.text, true); });
    scrollChatToBottom();
  }

  var THINKING_VERBS = [
    "Pondering", "Noodling", "Percolating", "Mulling", "Ruminating", "Cogitating",
    "Puzzling", "Synthesizing", "Simmering", "Churning", "Brewing", "Tinkering",
    "Musing", "Deliberating", "Combobulating", "Herding tokens", "Reticulating",
    "Marinating", "Stewing", "Crunching", "Divining", "Wrangling", "Unfurling",
  ];
  var SPINNER_FRAMES = ["·", "✢", "✳", "✶", "✻", "✽", "✻", "✶", "✳", "✢"];
  var thinkingTimer = null;

  function showThinking() {
    if (document.getElementById("thinkingBubble")) { return; }
    var b = document.createElement("div");
    b.className = "bubble assistant thinking-bubble";
    b.id = "thinkingBubble";
    var spinner = document.createElement("span");
    spinner.className = "thinking-spinner";
    var label = document.createElement("span");
    label.className = "thinking-label";
    b.appendChild(spinner);
    b.appendChild(label);
    chatLog.appendChild(b);
    if (chatAutoScroll) { scrollChatToBottom(); }

    var verb = THINKING_VERBS[Math.floor(Math.random() * THINKING_VERBS.length)];
    var start = Date.now();
    var frame = 0;
    var tick = function () {
      spinner.textContent = SPINNER_FRAMES[frame % SPINNER_FRAMES.length];
      frame++;
      var elapsed = Math.floor((Date.now() - start) / 1000);
      label.textContent = " " + verb + "… (" + elapsed + "s)";
    };
    tick();
    thinkingTimer = setInterval(tick, 100);
  }

  function hideThinking() {
    var el = document.getElementById("thinkingBubble");
    if (el) { el.remove(); }
    if (thinkingTimer) { clearInterval(thinkingTimer); thinkingTimer = null; }
  }

  function autoGrow() {
    chatInput.style.height = "auto";
    chatInput.style.height = Math.min(chatInput.scrollHeight, 160) + "px";
  }

  function sendChat() {
    var text = chatInput.value.trim();
    if (!text) { return; }
    appendBubble("user", text);
    chatInput.value = "";
    autoGrow();
    vscode.postMessage({ type: "chatSend", text: text });
  }
  chatSendBtn.addEventListener("click", sendChat);
  chatInput.addEventListener("input", autoGrow);
  chatInput.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendChat();
    }
  });

  function appendDesignMessage(role, text) {
    var b = document.createElement("div");
    b.className = "bubble " + role;
    b.textContent = text == null ? "" : String(text);
    designLog.appendChild(b);
    designLog.scrollTop = designLog.scrollHeight;
  }

  responsiveToggle.addEventListener("change", function () {
    var on = responsiveToggle.checked;
    figmaUrlSingle.style.display = on ? "none" : "block";
    figmaUrlResponsive.style.display = on ? "flex" : "none";
  });

  function renderDesignAttachments() {
    designAttachmentsEl.innerHTML = "";
    designAttachments.forEach(function (att, idx) {
      var chip = document.createElement("span");
      chip.className = "design-attachment-chip";
      var name = document.createElement("span");
      name.className = "design-attachment-name";
      name.textContent = att.name;
      name.title = att.name;
      var remove = document.createElement("button");
      remove.type = "button";
      remove.className = "design-attachment-remove";
      remove.title = "Remove";
      remove.textContent = "×";
      remove.addEventListener("click", function () {
        designAttachments.splice(idx, 1);
        renderDesignAttachments();
      });
      chip.appendChild(name);
      chip.appendChild(remove);
      designAttachmentsEl.appendChild(chip);
    });
  }

  function readFileAsDataUrl(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () { resolve(reader.result); };
      reader.onerror = function () { reject(reader.error); };
      reader.readAsDataURL(file);
    });
  }

  function addDesignFiles(fileList) {
    Array.prototype.slice.call(fileList).forEach(function (file) {
      readFileAsDataUrl(file).then(function (dataUrl) {
        designAttachments.push({ name: file.name, mimeType: file.type, size: file.size, dataUrl: dataUrl });
        renderDesignAttachments();
      });
    });
  }

  designAttachBtn.addEventListener("click", function () {
    designFileInput.click();
  });
  designFileInput.addEventListener("change", function () {
    addDesignFiles(designFileInput.files);
    designFileInput.value = "";
  });
  designDropzone.addEventListener("dragover", function (e) {
    e.preventDefault();
    designDropzone.classList.add("dragover");
  });
  designDropzone.addEventListener("dragleave", function () {
    designDropzone.classList.remove("dragover");
  });
  designDropzone.addEventListener("drop", function (e) {
    e.preventDefault();
    designDropzone.classList.remove("dragover");
    if (e.dataTransfer && e.dataTransfer.files) {
      addDesignFiles(e.dataTransfer.files);
    }
  });

  function sendDesignGenerate() {
    var responsive = responsiveToggle.checked;
    var figmaUrl = "";
    var breakpoints = null;
    if (responsive) {
      breakpoints = {
        sm: figmaUrlSm.value.trim(),
        md: figmaUrlMd.value.trim(),
        lg: figmaUrlLg.value.trim(),
        xl: figmaUrlXl.value.trim(),
        "2xl": figmaUrl2xl.value.trim()
      };
      var hasAny = Object.keys(breakpoints).some(function (k) { return breakpoints[k]; });
      if (!hasAny) {
        figmaUrlSm.focus();
        return;
      }
    } else {
      figmaUrl = figmaUrlInput.value.trim();
      if (!figmaUrl) {
        figmaUrlInput.focus();
        return;
      }
    }
    var prompt = designPromptInput.value.trim();
    var summaryLines = [];
    if (responsive) {
      ["sm", "md", "lg", "xl", "2xl"].forEach(function (bp) {
        if (breakpoints[bp]) { summaryLines.push(bp + ": " + breakpoints[bp]); }
      });
    } else {
      summaryLines.push(figmaUrl);
    }
    if (prompt) { summaryLines.push(prompt); }
    if (designAttachments.length) {
      summaryLines.push("Attached: " + designAttachments.map(function (a) { return a.name; }).join(", "));
    }
    appendDesignMessage("user", summaryLines.join(NEWLINE + NEWLINE));
    vscode.postMessage({
      type: "designGenerate",
      responsive: responsive,
      figmaUrl: figmaUrl,
      breakpoints: breakpoints,
      prompt: prompt,
      attachments: designAttachments.map(function (a) {
        return { name: a.name, mimeType: a.mimeType, size: a.size, dataUrl: a.dataUrl };
      })
    });
    designAttachments = [];
    renderDesignAttachments();
  }
  designGenerateBtn.addEventListener("click", sendDesignGenerate);

  window.addEventListener("message", function (event) {
    var msg = event.data;
    switch (msg.type) {
      case "commits":
        renderCommits(msg.commits, msg.reset);
        hasMoreCommits = msg.hasMore;
        isLoadingMore = false;
        loadMoreIndicator.style.display = "none";
        // In case the page just rendered still doesn't fill the viewport
        // (e.g. a tall window, or a small result set), check again so
        // scrolling isn't required just to discover there's more to load.
        setTimeout(maybeLoadMore, 0);
        break;
      case "commitDetail":
        renderDetail(msg.detail);
        break;
      case "repositories":
        renderRepositories(msg.repos, msg.current);
        break;
      case "branches":
        renderBranches(msg.branches, msg.current);
        break;
      case "authors":
        renderAuthors(msg.authors);
        break;
      case "chatClear":
        chatLog.innerHTML = "";
        break;
      case "chatHistory":
        renderChatHistory(msg.messages);
        break;
      case "chatConversations":
        renderConversations(msg.conversations, msg.activeId);
        break;
      case "chatMessage":
        hideThinking();
        appendBubble(msg.role, msg.text);
        break;
      case "chatBusy":
        chatSendBtn.disabled = msg.busy;
        chatInput.disabled = msg.busy;
        if (msg.busy) { showThinking(); } else { hideThinking(); }
        break;
      case "error":
        historyError.style.display = "block";
        historyError.textContent = msg.message;
        break;
      case "designMessage":
        appendDesignMessage(msg.role, msg.text);
        break;
      case "designBusy":
        designGenerateBtn.disabled = msg.busy;
        break;
    }
  });
})();
</script>
</body>
</html>`;
}

function getNonce(): string {
  let text = "";
  const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
