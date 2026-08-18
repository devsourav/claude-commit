import * as vscode from "vscode";
import { listCommits, getCommitDetail, ChangedFile } from "./commitHistory";
import { toGitRevisionUri } from "./gitContentProvider";
import { askChat, ChatSession } from "./chat";

const PAGE_SIZE = 50;

interface WebviewMessage {
  type: string;
  [key: string]: unknown;
}

// Singleton webview panel: History + Chat tabs over the repo at `cwd`.
// Re-showing the command while a panel is already open just reveals and
// resets it, rather than opening a second one.
export class HubPanel {
  private static current: HubPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly cwd: string;
  private readonly chatSession: ChatSession = {};
  private readonly disposables: vscode.Disposable[] = [];
  private historySkip = 0;
  private historyGrep: string | undefined;

  static createOrShow(context: vscode.ExtensionContext, cwd: string) {
    if (HubPanel.current) {
      HubPanel.current.panel.reveal(undefined, true);
      HubPanel.current.reloadHistory();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      "claudeCommitHub",
      "Claude Commit",
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    HubPanel.current = new HubPanel(panel, cwd);
  }

  private constructor(panel: vscode.WebviewPanel, cwd: string) {
    this.panel = panel;
    this.cwd = cwd;
    this.panel.webview.html = getHubHtml(this.panel.webview);
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage(
      (message: WebviewMessage) => this.handleMessage(message),
      null,
      this.disposables
    );
    this.loadCommits(true);
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
    this.loadCommits(true);
  }

  private async handleMessage(message: WebviewMessage) {
    switch (message.type) {
      case "loadCommits":
        this.historyGrep = (message.grep as string) || undefined;
        await this.loadCommits(true);
        break;
      case "loadMoreCommits":
        await this.loadCommits(false);
        break;
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
      });
      this.historySkip += commits.length;
      this.post({ type: "commits", commits, hasMore, reset });
    } catch (err) {
      this.postError(err);
    }
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
  .toolbar { display: flex; gap: 6px; margin-bottom: 10px; }
  input[type="text"] {
    flex: 1;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, transparent);
    padding: 4px 6px;
  }
  button {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border: none;
    padding: 4px 10px;
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
  .commit-subject { font-weight: 600; }
  .commit-meta { font-size: 0.85em; opacity: 0.75; }
  .commit-detail { padding: 8px 8px 8px 20px; white-space: pre-wrap; font-size: 0.9em; }
  .file-row { display: flex; justify-content: space-between; padding: 2px 0; }
  .file-row .status { opacity: 0.7; width: 1.5em; display: inline-block; }
  #loadMoreBtn { margin-top: 10px; }
  #chatLog { display: flex; flex-direction: column; gap: 8px; margin-bottom: 10px; max-height: 70vh; overflow-y: auto; }
  .bubble { padding: 6px 10px; border-radius: 6px; max-width: 85%; white-space: pre-wrap; }
  .bubble.user { align-self: flex-end; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
  .bubble.assistant { align-self: flex-start; background: var(--vscode-editorWidget-background); }
  .bubble.system { align-self: stretch; color: var(--vscode-errorForeground); font-style: italic; }
  .chat-input-row { display: flex; gap: 6px; }
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
    <div class="toolbar">
      <input id="search" type="text" placeholder="Search commit messages...">
      <button id="searchBtn">Search</button>
    </div>
    <div id="historyError" class="error-banner" style="display:none"></div>
    <ul id="commitList"></ul>
    <button id="loadMoreBtn" style="display:none">Load more</button>
  </div>

  <div id="chat" class="tab-panel">
    <div id="chatLog"></div>
    <div class="chat-input-row">
      <input id="chatInput" type="text" placeholder="Ask about this repo's history...">
      <button id="chatSendBtn">Send</button>
    </div>
  </div>

<script nonce="${nonce}">
(function () {
  var vscode = acquireVsCodeApi();
  var commitDetails = {};

  document.querySelectorAll(".tab-btn").forEach(function (btn) {
    btn.addEventListener("click", function () {
      document.querySelectorAll(".tab-btn").forEach(function (b) { b.classList.remove("active"); });
      document.querySelectorAll(".tab-panel").forEach(function (p) { p.classList.remove("active"); });
      btn.classList.add("active");
      document.getElementById(btn.getAttribute("data-tab")).classList.add("active");
    });
  });

  var commitList = document.getElementById("commitList");
  var loadMoreBtn = document.getElementById("loadMoreBtn");
  var historyError = document.getElementById("historyError");
  var searchInput = document.getElementById("search");

  document.getElementById("searchBtn").addEventListener("click", function () {
    vscode.postMessage({ type: "loadCommits", grep: searchInput.value.trim() });
  });
  searchInput.addEventListener("keydown", function (e) {
    if (e.key === "Enter") {
      vscode.postMessage({ type: "loadCommits", grep: searchInput.value.trim() });
    }
  });
  loadMoreBtn.addEventListener("click", function () {
    vscode.postMessage({ type: "loadMoreCommits" });
  });

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
      var subject = document.createElement("div");
      subject.className = "commit-subject";
      subject.textContent = commit.subject;
      var meta = document.createElement("div");
      meta.className = "commit-meta";
      meta.textContent = commit.shortHash + " - " + commit.author + " - " + commit.date;
      li.appendChild(subject);
      li.appendChild(meta);

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
        var label = document.createElement("span");
        label.textContent = "[" + file.status + "] " + file.path;
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

  function appendBubble(role, text) {
    var b = document.createElement("div");
    b.className = "bubble " + role;
    b.textContent = text;
    chatLog.appendChild(b);
    chatLog.scrollTop = chatLog.scrollHeight;
  }

  function sendChat() {
    var text = chatInput.value.trim();
    if (!text) { return; }
    appendBubble("user", text);
    chatInput.value = "";
    vscode.postMessage({ type: "chatSend", text: text });
  }
  chatSendBtn.addEventListener("click", sendChat);
  chatInput.addEventListener("keydown", function (e) {
    if (e.key === "Enter") { sendChat(); }
  });

  window.addEventListener("message", function (event) {
    var msg = event.data;
    switch (msg.type) {
      case "commits":
        renderCommits(msg.commits, msg.reset);
        loadMoreBtn.style.display = msg.hasMore ? "inline-block" : "none";
        break;
      case "commitDetail":
        renderDetail(msg.detail);
        break;
      case "chatMessage":
        appendBubble(msg.role, msg.text);
        break;
      case "chatBusy":
        chatSendBtn.disabled = msg.busy;
        chatInput.disabled = msg.busy;
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
