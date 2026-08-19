import * as vscode from "vscode";
import { listCommits, listBranches, listAuthors, getCommitDetail, ChangedFile } from "./commitHistory";
import { toGitRevisionUri } from "./gitContentProvider";
import { askChat, ChatSession } from "./chat";
import { GitApi } from "./gitApi";

const PAGE_SIZE = 50;

interface WebviewMessage {
  type: string;
  [key: string]: unknown;
}

// Singleton webview panel: History + Chat tabs over the repo at `cwd`.
// Re-showing the command while a panel is already open just reveals and
// resets it (or switches to a different repository), rather than opening a
// second one.
export class HubPanel {
  private static current: HubPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly gitApi: GitApi;
  private cwd: string;
  private chatSession: ChatSession = {};
  private readonly disposables: vscode.Disposable[] = [];
  private historySkip = 0;
  private historyGrep: string | undefined;
  private historyBranch: string | undefined;
  private historyAuthor: string | undefined;
  private historySince: string | undefined;
  private historyUntil: string | undefined;

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
    const panel = vscode.window.createWebviewPanel(
      "claudeCommitHub",
      "Claude Commit",
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    HubPanel.current = new HubPanel(panel, gitApi, cwd);
  }

  private constructor(panel: vscode.WebviewPanel, gitApi: GitApi, cwd: string) {
    this.panel = panel;
    this.gitApi = gitApi;
    this.cwd = cwd;
    this.panel.webview.html = getHubHtml(this.panel.webview);
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage(
      (message: WebviewMessage) => this.handleMessage(message),
      null,
      this.disposables
    );
    this.loadRepositories();
    this.loadCommits(true);
    this.loadBranches();
    this.loadAuthors();
  }

  private dispose() {
    HubPanel.current = undefined;
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
    this.chatSession = {};
    this.reloadHistory();
    this.loadRepositories();
    this.loadBranches();
    this.loadAuthors();
    this.post({ type: "chatClear" });
    this.post({
      type: "chatMessage",
      role: "system",
      text: `Switched to ${repoName(cwd)} - starting a new conversation.`,
    });
  }

  private loadRepositories() {
    const repos = this.gitApi.repositories.map((repo) => ({
      path: repo.rootUri.fsPath,
      name: repoName(repo.rootUri.fsPath),
    }));
    this.post({ type: "repositories", repos, current: this.cwd });
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
      case "getCommitDetail":
        await this.sendCommitDetail(message.hash as string);
        break;
      case "viewDiff":
        await this.viewDiff(message.hash as string, message.file as ChangedFile);
        break;
      case "chatSend":
        await this.handleChatSend(message.text as string);
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
    } catch (err) {
      this.post({
        type: "chatMessage",
        role: "system",
        text: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this.post({ type: "chatBusy", busy: false });
    }
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
  #chat.tab-panel.active {
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
  .commit-row-main { min-width: 0; }
  .commit-subject { font-weight: 600; overflow: hidden; text-overflow: ellipsis; }
  .commit-meta { font-size: 0.85em; opacity: 0.75; }
  .commit-badges { display: flex; gap: 6px; flex-shrink: 0; margin-top: 1px; }
  .commit-badge {
    font-size: 0.8em;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    padding: 1px 7px;
    border-radius: 10px;
    background: var(--vscode-badge-background);
  }
  .commit-badge.added { color: var(--vscode-gitDecoration-addedResourceForeground, #4caf50); }
  .commit-badge.modified { color: var(--vscode-gitDecoration-modifiedResourceForeground, #e2c08d); }
  .commit-badge.deleted { color: var(--vscode-gitDecoration-deletedResourceForeground, #f14c4c); }
  .commit-detail { padding: 8px 8px 8px 20px; white-space: pre-wrap; font-size: 0.9em; }
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
  .bubble.user { align-self: flex-end; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
  .bubble.assistant { align-self: flex-start; background: var(--vscode-editorWidget-background); }
  .bubble.system { align-self: stretch; color: var(--vscode-errorForeground); font-style: italic; }
  .bubble.thinking-bubble { display: flex; align-items: center; gap: 6px; opacity: 0.85; }
  .thinking-dots { display: flex; gap: 3px; }
  .thinking-dots span {
    width: 5px; height: 5px; border-radius: 50%;
    background: var(--vscode-foreground);
    opacity: 0.3;
    animation: thinking-blink 1.4s infinite both;
  }
  .thinking-dots span:nth-child(2) { animation-delay: 0.2s; }
  .thinking-dots span:nth-child(3) { animation-delay: 0.4s; }
  @keyframes thinking-blink { 0%, 80%, 100% { opacity: 0.2; } 40% { opacity: 1; } }
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
</style>
</head>
<body>
  <div class="tabs">
    <button class="tab-btn active" data-tab="history">History</button>
    <button class="tab-btn" data-tab="chat">Chat</button>
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
    <div id="chatLog"></div>
    <div class="chat-input-row">
      <textarea id="chatInput" rows="1" placeholder="Ask about this repo's history... (Enter to send, Shift+Enter for a new line)"></textarea>
      <button id="chatSendBtn">Send</button>
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
      if (matches.length === 0) {
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
          commit(matches[activeIndex]);
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

      var main = document.createElement("div");
      main.className = "commit-row-main";
      var subject = document.createElement("div");
      subject.className = "commit-subject";
      subject.textContent = commit.subject;
      var meta = document.createElement("div");
      meta.className = "commit-meta";
      meta.textContent = commit.shortHash + " - " + commit.author + " - " + commit.date;
      main.appendChild(subject);
      main.appendChild(meta);
      header.appendChild(main);

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

  function renderDetail(detail) {
    commitDetails[detail.hash] = detail;
    var rows = commitList.querySelectorAll(".commit-row");
    rows.forEach(function (row) {
      var meta = row.querySelector(".commit-meta");
      if (!meta || meta.textContent.indexOf(detail.hash.slice(0, 7)) !== 0) { return; }
      var detailEl = row.querySelector(".commit-detail");
      detailEl.innerHTML = "";

      var body = document.createElement("div");
      body.textContent = detail.body;
      detailEl.appendChild(body);

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

  // Minimal markdown for chat replies: inline code spans (which is how
  // commit hashes, branch names, dates, and file paths show up in Claude's
  // answers) and **bold**. Escapes HTML first since this is model output,
  // then relies on the bubble's existing pre-wrap white-space to keep
  // plain newlines working without needing <br> conversion.
  var BACKTICK = String.fromCharCode(96);
  var inlineCodePattern = new RegExp(BACKTICK + "([^" + BACKTICK + "]+)" + BACKTICK, "g");

  function renderMarkdownLite(text) {
    var html = escapeHtml(text);
    html = html.replace(inlineCodePattern, function (_, code) {
      return '<code class="inline-code">' + code + "</code>";
    });
    html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    return html;
  }

  function appendBubble(role, text) {
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
    if (chatAutoScroll) { scrollChatToBottom(); }
  }

  function showThinking() {
    if (document.getElementById("thinkingBubble")) { return; }
    var b = document.createElement("div");
    b.className = "bubble assistant thinking-bubble";
    b.id = "thinkingBubble";
    var label = document.createElement("span");
    label.textContent = "Claude is thinking";
    var dots = document.createElement("span");
    dots.className = "thinking-dots";
    dots.innerHTML = "<span></span><span></span><span></span>";
    b.appendChild(label);
    b.appendChild(dots);
    chatLog.appendChild(b);
    if (chatAutoScroll) { scrollChatToBottom(); }
  }

  function hideThinking() {
    var el = document.getElementById("thinkingBubble");
    if (el) { el.remove(); }
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
