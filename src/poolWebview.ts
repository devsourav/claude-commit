import * as vscode from "vscode";

// HTML/CSS/JS for the Team Pool webview (poolPanel.ts), laid out like the
// Claude Code panel: conversation header, a turn timeline with tool rows,
// and a composer with attachments, "/" commands, the model/effort pill and
// a Shift+Tab permission-mode switcher. Inlined as strings for the same
// reason as hubPanel.ts (src/** isn't packaged). Each block is a String.raw
// literal so regex backslashes survive - none may contain backticks or "${".
// Icons are inline SVG (codicons can't be loaded: node_modules isn't
// packaged either), and deliberately not Anthropic's logo or mascot.

function getNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let nonce = "";
  for (let i = 0; i < 32; i++) {
    nonce += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return nonce;
}

export function getPoolHtml(webview: vscode.Webview): string {
  const nonce = getNonce();
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data: blob:; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Team Pool</title>
<style>${CSS}</style>
</head>
<body>
${BODY}
<script nonce="${nonce}">${SCRIPT}</script>
</body>
</html>`;
}

const CSS = String.raw`
  :root {
    --accent: #d97757;
    --accent-fg: #ffffff;
    --muted: var(--vscode-descriptionForeground);
    --border: var(--vscode-panel-border, rgba(128,128,128,0.35));
    --surface: var(--vscode-input-background);
    --hover: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.15));
    --ok: var(--vscode-testing-iconPassed, #3fb950);
    --err: var(--vscode-errorForeground, #f85149);
    --mono: var(--vscode-editor-font-family);
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body {
    font-family: var(--vscode-font-family);
    font-size: 13px;
    color: var(--vscode-foreground);
    background: var(--vscode-sideBar-background, var(--vscode-editor-background));
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  button { font: inherit; color: inherit; background: none; border: none; cursor: pointer; padding: 0; }
  button:disabled { cursor: default; opacity: 0.45; }
  svg { width: 16px; height: 16px; flex-shrink: 0; }
  .hidden { display: none !important; }
  .muted { color: var(--muted); }
  .mono { font-family: var(--mono); }
  input, select, textarea {
    font: inherit;
    color: var(--vscode-input-foreground);
    background: var(--surface);
    border: 1px solid var(--vscode-input-border, var(--border));
    border-radius: 4px;
    padding: 4px 6px;
  }
  input:focus, select:focus, textarea:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  .icon-btn {
    display: inline-flex; align-items: center; justify-content: center;
    width: 28px; height: 28px; border-radius: 6px; color: var(--muted);
  }
  .icon-btn:hover { background: var(--hover); color: var(--vscode-foreground); }
  .btn {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 4px 10px; border-radius: 4px;
    color: var(--vscode-button-foreground); background: var(--vscode-button-background);
  }
  .btn:hover { background: var(--vscode-button-hoverBackground); }
  .btn.secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
  .btn.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }

  /* Header */
  .top {
    display: flex; align-items: center; gap: 4px;
    height: 40px; padding: 0 8px 0 14px;
    border-bottom: 1px solid var(--border); flex-shrink: 0;
  }
  .top .title { flex: 1; min-width: 0; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .top .back { margin-left: -8px; }

  .view { display: none; flex: 1; min-height: 0; flex-direction: column; }
  .view.active { display: flex; }

  /* Timeline */
  #log { flex: 1; overflow-y: auto; padding: 16px 16px 8px; display: flex; flex-direction: column; gap: 10px; }
  .row.user { display: flex; flex-direction: column; align-items: flex-end; gap: 4px; margin-top: 6px; }
  .row.user .time { font-size: 11px; color: var(--muted); }
  .bubble {
    max-width: 92%;
    background: var(--surface);
    border: 1px solid var(--vscode-input-border, var(--border));
    border-radius: 8px;
    padding: 8px 12px;
    white-space: pre-wrap;
    word-wrap: break-word;
    line-height: 1.5;
    position: relative;
  }
  .bubble.collapsed { max-height: 132px; overflow: hidden; cursor: pointer; }
  .bubble.collapsed::after {
    content: ""; position: absolute; left: 0; right: 0; bottom: 0; height: 48px;
    background: linear-gradient(transparent, var(--surface));
  }
  .bubble .att-row { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 6px; white-space: normal; }

  .row.item { display: flex; gap: 10px; align-items: flex-start; }
  .dot { width: 7px; height: 7px; border-radius: 50%; margin-top: 7px; flex-shrink: 0; background: var(--vscode-foreground); opacity: 0.85; }
  .tool .dot { background: var(--muted); }
  .tool.running .dot { background: var(--muted); animation: pulse 1.1s ease-in-out infinite; }
  .tool.ok .dot { background: var(--ok); opacity: 1; }
  .tool.error .dot { background: var(--err); opacity: 1; }
  @keyframes pulse { 50% { opacity: 0.25; } }
  .item-body { flex: 1; min-width: 0; }
  .tool-head { display: flex; gap: 6px; align-items: baseline; cursor: pointer; line-height: 20px; flex-wrap: wrap; }
  .tool-head b { font-weight: 600; }
  .tool-head .target { font-family: var(--mono); font-size: 12px; color: var(--muted); word-break: break-all; }
  .tool-head .target.link:hover { color: var(--vscode-textLink-foreground); text-decoration: underline; }
  .tool-head .summary { font-size: 12px; color: var(--muted); }
  .tool-head .summary .add { color: var(--ok); }
  .tool-head .summary .del { color: var(--err); }
  .tool-out {
    margin: 4px 0 0; padding: 6px 8px; max-height: 220px; overflow: auto;
    font-family: var(--mono); font-size: 12px; white-space: pre-wrap; word-break: break-word;
    background: var(--vscode-textCodeBlock-background); border-radius: 4px; color: var(--muted);
  }
  .todos { list-style: none; padding: 0; margin: 4px 0 0; }
  .todos li { display: flex; gap: 6px; align-items: baseline; line-height: 1.6; }
  .todos li.completed { color: var(--muted); text-decoration: line-through; }
  .todos li.in_progress { font-weight: 600; }

  .md { line-height: 1.6; word-wrap: break-word; }
  .md p { margin: 0 0 8px; }
  .md > :last-child { margin-bottom: 0; }
  .md h1, .md h2, .md h3, .md h4 { margin: 12px 0 6px; font-size: 1.05em; }
  .md ul, .md ol { margin: 4px 0 8px; padding-left: 20px; }
  .md li { margin: 2px 0; }
  .md code { font-family: var(--mono); font-size: 12px; background: var(--vscode-textCodeBlock-background); padding: 1px 4px; border-radius: 3px; }
  .md pre { background: var(--vscode-textCodeBlock-background); padding: 8px 10px; border-radius: 6px; overflow-x: auto; margin: 6px 0 8px; }
  .md pre code { background: none; padding: 0; }
  .md a { color: var(--vscode-textLink-foreground); }
  .md blockquote { margin: 6px 0; padding-left: 10px; border-left: 3px solid var(--border); color: var(--muted); }
  .md table { border-collapse: collapse; margin: 6px 0 8px; font-size: 12px; }
  .md th, .md td { border: 1px solid var(--border); padding: 3px 8px; text-align: left; }
  .md hr { border: none; border-top: 1px solid var(--border); margin: 10px 0; }
  .turn-actions { display: flex; gap: 2px; margin: -4px 0 0 17px; }
  .turn-actions .icon-btn { width: 24px; height: 24px; }
  .turn-actions svg { width: 14px; height: 14px; }

  .notice { font-size: 12px; color: var(--muted); padding-left: 17px; font-style: italic; }
  .notice.error { color: var(--err); font-style: normal; }

  .empty { margin: auto; text-align: center; color: var(--muted); max-width: 380px; line-height: 1.7; padding: 20px; }
  .empty .brand { display: inline-flex; align-items: center; gap: 8px; font-size: 18px; color: var(--vscode-foreground); margin-bottom: 12px; }
  .empty .brand svg { width: 22px; height: 22px; color: var(--accent); }
  .empty kbd, .hint kbd, .menu kbd {
    font-family: var(--mono); font-size: 11px; padding: 0 4px; border-radius: 3px;
    border: 1px solid var(--border); background: var(--surface);
  }

  /* Permission prompt */
  .approval { border: 1px solid var(--accent); border-radius: 8px; padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; outline: none; }
  .approval.resolved { border-color: var(--border); opacity: 0.75; }
  .approval-title { font-weight: 600; }
  .approval-warning { color: var(--vscode-editorWarning-foreground); font-size: 12px; }
  .approval pre { margin: 0; max-height: 200px; overflow: auto; font-family: var(--mono); font-size: 12px; background: var(--vscode-textCodeBlock-background); padding: 6px 8px; border-radius: 4px; white-space: pre-wrap; }
  .approval .options { display: flex; flex-direction: column; gap: 2px; }
  .approval .opt { display: flex; gap: 8px; align-items: center; text-align: left; padding: 5px 8px; border-radius: 5px; }
  .approval .opt:hover, .approval .opt:focus { background: var(--hover); outline: none; }
  .approval .opt .num { font-family: var(--mono); color: var(--muted); width: 12px; }
  .approval .feedback { display: flex; gap: 6px; }
  .approval .feedback input { flex: 1; }
  .approval .diff-link { align-self: flex-start; color: var(--vscode-textLink-foreground); font-size: 12px; }

  /* Status + idle */
  .status-line { padding: 0 18px 6px; color: var(--accent); font-size: 12px; display: flex; gap: 6px; align-items: center; flex-shrink: 0; }
  .status-line .glyph { width: 12px; text-align: center; }
  .status-line .muted { color: var(--muted); }
  .idle { padding: 0 18px 8px; font-size: 12px; font-style: italic; color: var(--muted); line-height: 1.5; flex-shrink: 0; }

  /* Composer */
  .composer-wrap { padding: 0 12px 12px; flex-shrink: 0; position: relative; }
  .composer {
    border: 1px solid var(--vscode-input-border, var(--border));
    border-radius: 10px;
    background: var(--surface);
    transition: border-color 0.1s;
  }
  .composer.focused { border-color: var(--accent); }
  .composer.dragover { border-style: dashed; border-color: var(--accent); }
  .chips { display: flex; gap: 6px; flex-wrap: wrap; padding: 8px 10px 0; }
  .chips:empty { display: none; }
  .chips.queue { padding: 0 14px 8px; }
  .chip {
    display: inline-flex; align-items: center; gap: 5px; max-width: 100%;
    font-size: 11.5px; padding: 2px 6px 2px 6px; border-radius: 5px;
    border: 1px solid var(--border); background: var(--vscode-editorWidget-background);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .chip svg { width: 13px; height: 13px; color: var(--muted); }
  .chip .dim { color: var(--muted); }
  .chip button { display: inline-flex; color: var(--muted); }
  .chip button:hover { color: var(--vscode-foreground); }
  .chip.toggle { cursor: pointer; }
  .chip.off { opacity: 0.45; text-decoration: line-through; }
  .input-row { position: relative; }
  #input {
    display: block; width: 100%; resize: none; border: none; outline: none !important; background: transparent;
    padding: 10px 40px 4px 12px; min-height: 44px; max-height: 40vh; line-height: 1.5; font-size: 13px;
  }
  #input::placeholder { color: var(--muted); }
  #micBtn { position: absolute; right: 6px; top: 6px; }
  .toolbar { display: flex; align-items: center; gap: 4px; padding: 4px 6px 6px; }
  .toolbar .spacer { flex: 1; }
  .pill {
    display: inline-flex; align-items: center; gap: 5px; height: 26px; padding: 0 9px;
    border-radius: 13px; font-size: 12px; color: var(--vscode-foreground);
    background: var(--hover);
  }
  .pill:hover { background: var(--vscode-list-hoverBackground); }
  .pill.plain { background: none; color: var(--muted); padding: 0 6px; cursor: default; }
  .pill.plain.warn { color: var(--err); }
  .pill.plain svg, .mode-btn svg { width: 14px; height: 14px; }
  .mode-btn { display: inline-flex; align-items: center; gap: 5px; height: 26px; padding: 0 8px; border-radius: 6px; font-size: 12px; color: var(--muted); }
  .mode-btn:hover { background: var(--hover); color: var(--vscode-foreground); }
  .mode-btn.acceptEdits, .mode-btn.auto { color: var(--accent); }
  .mode-btn.plan { color: var(--vscode-charts-blue, #4ea1ff); }
  .send-btn {
    display: inline-flex; align-items: center; justify-content: center;
    width: 28px; height: 28px; border-radius: 7px; background: var(--accent); color: var(--accent-fg);
  }
  .send-btn:disabled { opacity: 0.4; }
  .send-btn svg { width: 15px; height: 15px; }

  /* Popup menus (/, @, +, model, mode) */
  .menu {
    position: absolute; left: 12px; right: 12px; bottom: calc(100% - 6px);
    background: var(--vscode-editorSuggestWidget-background, var(--vscode-editorWidget-background));
    border: 1px solid var(--vscode-editorSuggestWidget-border, var(--border));
    border-radius: 8px; box-shadow: 0 4px 16px rgba(0,0,0,0.25);
    max-height: 300px; overflow-y: auto; padding: 4px; z-index: 20;
  }
  .menu .sect { font-size: 11px; color: var(--muted); padding: 6px 8px 2px; text-transform: uppercase; letter-spacing: 0.04em; }
  .menu .mi { display: flex; align-items: center; gap: 8px; width: 100%; text-align: left; padding: 5px 8px; border-radius: 5px; }
  .menu .mi .lbl { flex-shrink: 0; }
  .menu .mi .desc { color: var(--muted); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .menu .mi .check { margin-left: auto; color: var(--accent); }
  .menu .mi.active, .menu .mi:hover {
    background: var(--vscode-editorSuggestWidget-selectedBackground, var(--vscode-list-activeSelectionBackground));
    color: var(--vscode-editorSuggestWidget-selectedForeground, var(--vscode-list-activeSelectionForeground));
  }
  .menu .mi.active .desc, .menu .mi:hover .desc { color: inherit; opacity: 0.8; }
  .menu .seg { display: flex; gap: 4px; padding: 4px 8px 6px; flex-wrap: wrap; }
  .menu .seg button { padding: 2px 8px; border-radius: 10px; font-size: 12px; background: var(--hover); }
  .menu .seg button.on { background: var(--accent); color: var(--accent-fg); }
  .toast {
    position: absolute; right: 16px; bottom: calc(100% + 2px); max-width: 280px;
    background: var(--vscode-editorWidget-background); border: 1px solid var(--border);
    border-radius: 6px; padding: 8px 10px; font-size: 12px; line-height: 1.5; z-index: 21;
    box-shadow: 0 4px 16px rgba(0,0,0,0.25);
  }

  /* History */
  .subbar { display: flex; gap: 6px; padding: 10px 12px; flex-shrink: 0; }
  .subbar input { flex: 1; }
  .list { flex: 1; overflow-y: auto; padding: 0 8px 10px; }
  .conv { display: flex; align-items: center; gap: 8px; padding: 7px 8px; border-radius: 6px; cursor: pointer; }
  .conv:hover { background: var(--hover); }
  .conv.current { background: var(--vscode-list-inactiveSelectionBackground); }
  .conv .t { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .conv .w { font-size: 11px; color: var(--muted); flex-shrink: 0; }
  .conv .icon-btn { width: 22px; height: 22px; visibility: hidden; }
  .conv:hover .icon-btn { visibility: visible; }

  /* Pool + Add */
  .banner {
    margin: 0 12px 8px; padding: 6px 10px; border-radius: 6px; font-size: 12px;
    display: flex; align-items: center; gap: 8px;
    background: var(--vscode-inputValidation-infoBackground, var(--vscode-editorWidget-background));
    border: 1px solid var(--vscode-inputValidation-infoBorder, var(--border));
  }
  .banner span { flex: 1; }
  .module-head { font-weight: 600; margin: 12px 4px 4px; text-transform: uppercase; font-size: 11px; color: var(--muted); letter-spacing: 0.04em; }
  .entry { padding: 6px 8px; border-radius: 6px; cursor: pointer; display: flex; gap: 8px; align-items: flex-start; }
  .entry:hover { background: var(--hover); }
  .entry-main { flex: 1; min-width: 0; }
  .entry-title { font-weight: 500; }
  .entry-summary { font-size: 12px; color: var(--muted); margin-top: 2px; }
  .entry-meta { font-size: 11px; color: var(--muted); opacity: 0.8; margin-top: 2px; }
  .entry-actions { display: none; gap: 2px; }
  .entry:hover .entry-actions { display: flex; }
  .badge { font-size: 10px; padding: 0 5px; border-radius: 8px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); margin-left: 4px; vertical-align: 1px; }
  #addView { overflow-y: auto; padding: 12px; gap: 10px; }
  .kinds { display: flex; flex-wrap: wrap; gap: 4px; }
  .kind { padding: 3px 10px; border-radius: 12px; background: var(--hover); font-size: 12px; }
  .kind.active { background: var(--accent); color: var(--accent-fg); }
  .field { display: flex; flex-direction: column; gap: 3px; }
  .field label { font-size: 11px; color: var(--muted); font-weight: 600; }
  .frow { display: flex; gap: 8px; align-items: center; }
  .frow .field { flex: 1; }
  .files { font-size: 12px; color: var(--muted); }
  #previewBody { min-height: 220px; font-family: var(--mono); font-size: 12px; resize: vertical; }
  .status { font-size: 12px; color: var(--muted); }
  .status.error { color: var(--err); }
`;

const BODY = String.raw`
<header class="top">
  <button class="icon-btn back hidden" id="backBtn" title="Back to chat" data-icon="back"></button>
  <div class="title" id="topTitle">Untitled</div>
  <button class="icon-btn" id="poolBtn" title="Team Pool" data-icon="library"></button>
  <button class="icon-btn" id="historyBtn" title="Past conversations" data-icon="history"></button>
  <button class="icon-btn" id="newBtn" title="New conversation" data-icon="newChat"></button>
</header>

<section class="view active" id="chatView">
  <div id="log"></div>
  <div class="status-line hidden" id="statusLine"><span class="glyph" id="statusGlyph"></span><span id="statusText"></span></div>
  <div class="idle hidden" id="idleNotice"></div>
  <div class="chips queue hidden" id="queueLine"></div>
  <div class="composer-wrap">
    <div class="menu hidden" id="menu"></div>
    <div class="toast hidden" id="toast"></div>
    <div class="composer" id="composer">
      <div class="chips" id="chips"></div>
      <div class="input-row">
        <textarea id="input" rows="1"></textarea>
        <button class="icon-btn" id="micBtn" title="Dictate (uses your system dictation)" data-icon="mic"></button>
      </div>
      <div class="toolbar">
        <button class="icon-btn" id="plusBtn" title="Attach files, images or context" data-icon="plus"></button>
        <button class="icon-btn" id="slashBtn" title="Commands" data-icon="slash"></button>
        <span class="pill plain hidden" id="timer"></span>
        <button class="pill" id="modelBtn" title="Model and effort"></button>
        <span class="spacer"></span>
        <button class="mode-btn" id="modeBtn" title="Permission mode (Shift+Tab to switch)"></button>
        <button class="send-btn" id="sendBtn" title="Send (Enter)" data-icon="arrowUp" disabled></button>
      </div>
    </div>
  </div>
</section>

<section class="view" id="historyView">
  <div class="subbar"><input id="historySearch" placeholder="Search conversations"></div>
  <div class="list" id="historyList"></div>
</section>

<section class="view" id="poolView">
  <div class="subbar">
    <input id="poolSearch" placeholder="Filter by title, module, release, author...">
    <button class="btn secondary" id="poolAddBtn">Add</button>
  </div>
  <div class="banner hidden" id="linkBanner">
    <span>Link the pool from CLAUDE.md so every teammate's Claude Code loads it automatically.</span>
    <button class="btn" id="linkBtn">Link</button>
  </div>
  <div class="banner hidden" id="commitBanner">
    <span id="commitText"></span>
    <button class="btn secondary" id="scmBtn">Review &amp; commit</button>
  </div>
  <div class="list" id="poolList"></div>
</section>

<section class="view" id="addView">
  <div class="kinds">
    <button class="kind active" data-kind="note">Note</button>
    <button class="kind" data-kind="api">Swagger / OpenAPI</button>
    <button class="kind" data-kind="doc">Documents</button>
    <button class="kind" data-kind="link">Links</button>
    <button class="kind" data-kind="design">Figma</button>
  </div>
  <div class="frow">
    <div class="field">
      <label for="addModule">Module</label>
      <input id="addModule" list="moduleList" placeholder="e.g. auth, checkout, payments">
      <datalist id="moduleList"></datalist>
    </div>
    <div class="field">
      <label for="addRelease">Release</label>
      <input id="addRelease">
    </div>
  </div>
  <div class="field kind-field" data-for="api">
    <label>Spec file</label>
    <div class="frow"><button class="btn secondary" id="pickSwaggerBtn">Choose swagger.json...</button><span class="files" id="swaggerFiles"></span></div>
  </div>
  <div class="field kind-field" data-for="doc">
    <label>Documents</label>
    <div class="frow"><button class="btn secondary" id="pickDocsBtn">Choose files...</button><span class="files" id="docFiles"></span></div>
  </div>
  <div class="field kind-field" data-for="link">
    <label for="linkUrls">Links (one per line): Claude share links, docs pages, tickets...</label>
    <textarea id="linkUrls" rows="3" placeholder="https://claude.ai/share/..."></textarea>
  </div>
  <div class="field kind-field" data-for="design">
    <label for="figmaUrls">Figma frame links (one per line)</label>
    <textarea id="figmaUrls" rows="3" placeholder="https://www.figma.com/design/...?node-id=..."></textarea>
    <span class="status" id="figmaHint">Uses the Figma MCP server through your claude CLI. Connect Figma in claude.ai connector settings first.</span>
  </div>
  <div class="field kind-field" data-for="doc link design">
    <label for="addFocus">What should Claude focus on? (optional)</label>
    <input id="addFocus" placeholder="e.g. only the login + OTP screens, error states">
  </div>
  <div class="frow kind-field" data-for="api doc link design">
    <button class="btn" id="previewBtn">Generate entry</button>
    <span class="status" id="ingestStatus"></span>
  </div>
  <div class="field">
    <label for="addTitle">Title</label>
    <input id="addTitle" placeholder="e.g. Login API contract">
  </div>
  <div class="field">
    <label for="previewBody">Content (markdown, editable before saving)</label>
    <textarea id="previewBody" placeholder="Decisions, contracts, gotchas, handoff notes for this module..."></textarea>
  </div>
  <div class="frow">
    <button class="btn" id="saveEntryBtn">Save to pool</button>
    <span class="status" id="saveStatus"></span>
  </div>
</section>
`;

const SCRIPT = String.raw`
(function () {
  var vscode = acquireVsCodeApi();
  var BT = String.fromCharCode(96);

  // ---- Icons (24px grid, stroke) ----
  function svg(body, filled) {
    return '<svg viewBox="0 0 24 24" fill="' + (filled ? "currentColor" : "none") + '" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">' + body + "</svg>";
  }
  var ICONS = {
    plus: svg('<path d="M12 5v14M5 12h14"/>'),
    slash: svg('<rect x="3.5" y="3.5" width="17" height="17" rx="3.5"/><path d="M14 7.5l-4 9"/>'),
    clock: svg('<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>'),
    mic: svg('<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"/>'),
    arrowUp: svg('<path d="M12 19V5M6 11l6-6 6 6"/>'),
    stop: svg('<rect x="7" y="7" width="10" height="10" rx="1.5"/>', true),
    bolt: svg('<path d="M13 3L5 13.5h6L10 21l8-10.5h-6L13 3z"/>'),
    code: svg('<path d="M8.5 7.5L4 12l4.5 4.5M15.5 7.5L20 12l-4.5 4.5"/>'),
    pause: svg('<path d="M9 6v12M15 6v12"/>'),
    pencil: svg('<path d="M4 20h4L19 9l-4-4L4 16v4z"/>'),
    eye: svg('<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.8"/>'),
    history: svg('<path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1M3.5 4.5v4h4"/><path d="M12 8v4l2.8 1.8"/>'),
    newChat: svg('<circle cx="12" cy="12" r="8.5"/><path d="M12 8.5v7M8.5 12h7"/>'),
    library: svg('<rect x="3.5" y="4" width="4" height="16" rx="1"/><rect x="9.5" y="4" width="4" height="16" rx="1"/><path d="M15.6 5.6l3.4-.9 3.4 14.6-3.4.9z"/>'),
    back: svg('<path d="M15 6l-6 6 6 6"/>'),
    chevron: svg('<path d="M7 10l5 5 5-5"/>'),
    copy: svg('<rect x="8.5" y="8.5" width="11" height="11" rx="2"/><path d="M15.5 8.5V6.5a2 2 0 0 0-2-2h-7a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h2"/>'),
    savePool: svg('<path d="M6 3.5h12v17l-6-4-6 4z"/><path d="M12 7.5v6M9 10.5h6"/>'),
    check: svg('<path d="M5 12.5l4.5 4.5L19 7.5"/>'),
    trash: svg('<path d="M4.5 7h15M10 11v6M14 11v6M6.5 7l1 13h9l1-13M9.5 7V4.5h5V7"/>'),
    image: svg('<rect x="3.5" y="5" width="17" height="14" rx="2"/><circle cx="9" cy="10" r="1.5"/><path d="M20.5 16l-5-5-8.5 8"/>'),
    file: svg('<path d="M14 3.5H6.5v17h11V7z"/><path d="M14 3.5V7h3.5"/>'),
    at: svg('<circle cx="12" cy="12" r="3.5"/><path d="M15.5 12v1.3a2.5 2.5 0 0 0 5 0V12a8.5 8.5 0 1 0-3.4 6.8"/>'),
    x: svg('<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>'),
    selection: svg('<path d="M4 6h16M4 12h10M4 18h7"/>'),
    module: svg('<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/>'),
  };
  document.querySelectorAll("[data-icon]").forEach(function (el) { el.innerHTML = ICONS[el.getAttribute("data-icon")] || ""; });

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  // ---- State ----
  var saved = vscode.getState() || {};
  var state = {
    view: "chat",
    busy: false,
    items: [],
    platform: "darwin",
    mode: "ask",
    model: "",
    activeModel: "",
    effort: "",
    slashCommands: [],
    contextTokens: 0,
    lastTurnAt: 0,
    conversations: [],
    activeId: null,
    images: [],
    attachments: [],
    selection: { ctx: null, include: true },
    moduleFocus: "",
    entries: [],
    history: saved.history || [],
    historyIndex: -1,
    turnStart: 0,
    lastToolName: "",
    // Messages typed while a turn runs; sent in order when it finishes.
    queue: [],
  };
  function persist() { vscode.setState({ history: state.history.slice(-100), draft: input.value }); }

  // ---- Markdown ----
  var inlineCodeRe = new RegExp(BT + "([^" + BT + "]+)" + BT, "g");
  var fenceRe = new RegExp("^\\s*(" + BT + BT + BT + "|~~~)");
  function inline(s) {
    return esc(s)
      .replace(inlineCodeRe, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[^*\w])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>")
      .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2">$1</a>');
  }
  function isBlockStart(line) {
    return /^(#{1,4}\s|\s*([-*+]|\d+\.)\s|>\s?|\|)/.test(line) || fenceRe.test(line) || /^\s*(---|\*\*\*)\s*$/.test(line);
  }
  function renderMarkdown(src) {
    var lines = String(src).split("\n");
    var out = [];
    var i = 0;
    while (i < lines.length) {
      var line = lines[i];
      if (fenceRe.test(line)) {
        var code = [];
        i++;
        while (i < lines.length && !fenceRe.test(lines[i])) { code.push(lines[i]); i++; }
        i++;
        out.push("<pre><code>" + esc(code.join("\n")) + "</code></pre>");
        continue;
      }
      var h = line.match(/^(#{1,4})\s+(.*)$/);
      if (h) { out.push("<h" + h[1].length + ">" + inline(h[2]) + "</h" + h[1].length + ">"); i++; continue; }
      if (/^\s*(---|\*\*\*)\s*$/.test(line)) { out.push("<hr>"); i++; continue; }
      if (/^\|/.test(line) && i + 1 < lines.length && /^\|?\s*:?-{2,}/.test(lines[i + 1])) {
        var cells = function (l) { return l.replace(/^\||\|\s*$/g, "").split("|").map(function (c) { return c.trim(); }); };
        var head = cells(line);
        i += 2;
        var rows = [];
        while (i < lines.length && /^\|/.test(lines[i])) { rows.push(cells(lines[i])); i++; }
        out.push("<table><tr>" + head.map(function (c) { return "<th>" + inline(c) + "</th>"; }).join("") + "</tr>" +
          rows.map(function (r) { return "<tr>" + r.map(function (c) { return "<td>" + inline(c) + "</td>"; }).join("") + "</tr>"; }).join("") + "</table>");
        continue;
      }
      if (/^>\s?/.test(line)) {
        var quote = [];
        while (i < lines.length && /^>\s?/.test(lines[i])) { quote.push(inline(lines[i].replace(/^>\s?/, ""))); i++; }
        out.push("<blockquote>" + quote.join("<br>") + "</blockquote>");
        continue;
      }
      if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
        var ordered = /^\s*\d+\./.test(line);
        var items = [];
        while (i < lines.length && /^\s*([-*+]|\d+\.)\s+/.test(lines[i])) {
          items.push("<li>" + inline(lines[i].replace(/^\s*([-*+]|\d+\.)\s+/, "")) + "</li>");
          i++;
        }
        out.push((ordered ? "<ol>" : "<ul>") + items.join("") + (ordered ? "</ol>" : "</ul>"));
        continue;
      }
      if (!line.trim()) { i++; continue; }
      var para = [];
      while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i])) { para.push(inline(lines[i])); i++; }
      if (!para.length) { para.push(inline(lines[i])); i++; }
      out.push("<p>" + para.join("<br>") + "</p>");
    }
    return out.join("");
  }

  // ---- Formatting helpers ----
  function prettyModel(id) {
    if (!id) { return ""; }
    var m = String(id).match(/(opus|sonnet|haiku|fable)[-_ ]?(\d+)?(?:[-.](\d))?/i);
    if (!m) { return id; }
    var name = m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase();
    if (!m[2]) { return name; }
    return name + " " + m[2] + (m[3] && m[3].length === 1 ? "." + m[3] : "");
  }
  function cap(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : ""; }
  function fmtDuration(ms) {
    var m = Math.floor(ms / 60000);
    if (m < 1) { return "<1m"; }
    if (m < 60) { return m + "m"; }
    var h = Math.floor(m / 60);
    if (h < 24) { return h + "h" + (m % 60 ? " " + (m % 60) + "m" : ""); }
    var d = Math.floor(h / 24);
    return d + "d" + (h % 24 ? " " + (h % 24) + "h" : "");
  }
  function fmtTokens(n) { return n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + "k" : String(n); }
  function fmtTime(t) { return t ? new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : ""; }
  function relTime(t) {
    var d = Date.now() - t;
    if (d < 60000) { return "now"; }
    if (d < 3600000) { return Math.floor(d / 60000) + "m"; }
    if (d < 86400000) { return Math.floor(d / 3600000) + "h"; }
    return Math.floor(d / 86400000) + "d";
  }

  // ---- Views ----
  var VIEW_TITLES = { history: "Past conversations", pool: "Team Pool", add: "Add to Team Pool" };
  function currentTitle() {
    var c = state.conversations.find(function (x) { return x.id === state.activeId; });
    return c ? c.title : "Untitled";
  }
  function showView(name) {
    state.view = name;
    ["chat", "history", "pool", "add"].forEach(function (v) { $(v + "View").classList.toggle("active", v === name); });
    $("backBtn").classList.toggle("hidden", name === "chat");
    $("topTitle").textContent = name === "chat" ? currentTitle() : VIEW_TITLES[name];
    if (name === "pool") { vscode.postMessage({ type: "loadPool" }); }
    if (name === "history") { renderHistory(); $("historySearch").focus(); }
    if (name === "chat") { input.focus(); }
  }
  $("backBtn").addEventListener("click", function () { showView(state.view === "add" ? "pool" : "chat"); });
  $("poolBtn").addEventListener("click", function () { showView(state.view === "pool" ? "chat" : "pool"); });
  $("historyBtn").addEventListener("click", function () { showView(state.view === "history" ? "chat" : "history"); });
  $("newBtn").addEventListener("click", function () { vscode.postMessage({ type: "chatNew" }); showView("chat"); });

  // ---- Timeline rendering ----
  var log = $("log");
  var input = $("input");

  function scrollDown(force) {
    var nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 120;
    if (force || nearBottom) { log.scrollTop = log.scrollHeight; }
  }
  function renderEmpty() {
    log.innerHTML = '<div class="empty"><div class="brand">' + ICONS.library + "Team Pool</div>" +
      "<div>Ask about this repo or ask for a change. Claude reads your code, git history and your team's shared pool in <code>.claude-pool/</code>.</div>" +
      '<div style="margin-top:12px"><kbd>@</kbd> mention files &nbsp;·&nbsp; <kbd>/</kbd> commands &nbsp;·&nbsp; <kbd>Shift+Tab</kbd> switch modes</div></div>';
  }
  function clearEmpty() { var e = log.querySelector(".empty"); if (e) { e.remove(); } }

  function userRow(item) {
    var row = document.createElement("div");
    row.className = "row user";
    var att = (item.attachments || []).map(function (n) {
      return '<span class="chip">' + (/\.(png|jpe?g|gif|webp)$/i.test(n) ? ICONS.image : ICONS.file) + esc(n) + "</span>";
    }).join("");
    row.innerHTML = (item.time ? '<div class="time">' + esc(fmtTime(item.time)) + "</div>" : "") +
      '<div class="bubble">' + (att ? '<div class="att-row">' + att + "</div>" : "") + esc(item.text) + "</div>";
    var bubble = row.querySelector(".bubble");
    requestAnimationFrame(function () {
      if (bubble.scrollHeight > 160) {
        bubble.classList.add("collapsed");
        bubble.title = "Click to expand";
        bubble.addEventListener("click", function () { bubble.classList.remove("collapsed"); bubble.title = ""; }, { once: true });
      }
    });
    return row;
  }
  function textRow(item) {
    var row = document.createElement("div");
    row.className = "row item text";
    row.innerHTML = '<span class="dot"></span><div class="item-body md"></div>';
    row.querySelector(".md").innerHTML = renderMarkdown(item.text);
    return row;
  }
  function summaryHtml(summary) {
    var m = summary && summary.match(/^\+(\d+)(?: -(\d+))?$/);
    if (!m) { return summary ? esc(summary) : ""; }
    return '<span class="add">+' + m[1] + "</span>" + (m[2] !== undefined ? ' <span class="del">-' + m[2] + "</span>" : "");
  }
  function toolRow(item) {
    var row = document.createElement("div");
    row.className = "row item tool " + item.status;
    row.setAttribute("data-tool", item.id);
    var body = "";
    if (item.todos && item.todos.length) {
      body = '<ul class="todos">' + item.todos.map(function (t) {
        return '<li class="' + esc(t.status) + '">' + (t.status === "completed" ? ICONS.check : t.status === "in_progress" ? "▸" : "○") + " " + esc(t.content) + "</li>";
      }).join("") + "</ul>";
    }
    var label = item.name === "TodoWrite" ? "Update Todos" : item.name.replace(/^mcp__[^_]+(?:_[^_]+)*__/, "");
    row.innerHTML = '<span class="dot"></span><div class="item-body">' +
      '<div class="tool-head"><b>' + esc(label) + "</b>" +
      (item.detail ? '<span class="target' + (item.path ? " link" : "") + '">' + esc(item.detail) + "</span>" : "") +
      (item.summary ? '<span class="summary">' + summaryHtml(item.summary) + "</span>" : "") +
      "</div>" + body +
      '<pre class="tool-out hidden"></pre></div>';
    var out = row.querySelector(".tool-out");
    out.textContent = item.output || "";
    row.querySelector(".tool-head").addEventListener("click", function (ev) {
      if (ev.target.classList.contains("link") && item.path) {
        vscode.postMessage({ type: "openFile", path: item.path });
        return;
      }
      if (out.textContent) { out.classList.toggle("hidden"); }
    });
    return row;
  }
  function noticeRow(item) {
    var row = document.createElement("div");
    row.className = "notice" + (item.tone === "error" ? " error" : "");
    row.textContent = item.text;
    return row;
  }
  function rowFor(item) {
    if (item.kind === "user") { return userRow(item); }
    if (item.kind === "text") { return textRow(item); }
    if (item.kind === "tool") { return toolRow(item); }
    return noticeRow(item);
  }
  // Copy / Save-to-pool for the assistant text of the turn ending at index.
  function turnText(endIndex) {
    var parts = [];
    for (var i = endIndex; i >= 0; i--) {
      var it = state.items[i];
      if (it.kind === "user") { break; }
      if (it.kind === "text") { parts.unshift(it.text); }
    }
    return parts.join("\n\n").trim();
  }
  function turnActions(text) {
    var bar = document.createElement("div");
    bar.className = "turn-actions";
    bar.innerHTML = '<button class="icon-btn" data-a="copy" title="Copy">' + ICONS.copy + "</button>" +
      '<button class="icon-btn" data-a="save" title="Save to Team Pool">' + ICONS.savePool + "</button>";
    bar.addEventListener("click", function (ev) {
      var b = ev.target.closest("button");
      if (!b) { return; }
      if (b.getAttribute("data-a") === "copy") {
        navigator.clipboard.writeText(text);
        b.innerHTML = ICONS.check;
        setTimeout(function () { b.innerHTML = ICONS.copy; }, 1200);
      } else {
        vscode.postMessage({ type: "saveToPool", text: text });
      }
    });
    return bar;
  }
  function renderAll() {
    log.innerHTML = "";
    if (!state.items.length) { renderEmpty(); return; }
    state.items.forEach(function (item, i) {
      log.appendChild(rowFor(item));
      var next = state.items[i + 1];
      if ((!next || next.kind === "user") && item.kind !== "user") {
        var text = turnText(i);
        if (text) { log.appendChild(turnActions(text)); }
      }
    });
    scrollDown(true);
  }
  function appendItem(item) {
    clearEmpty();
    state.items.push(item);
    log.appendChild(rowFor(item));
    scrollDown();
  }

  // Streaming text: coalesce re-renders to one per animation frame. Frames
  // don't fire while the panel is hidden, so a timer backs it up.
  function nextFrame(fn) {
    var ran = false;
    function run() { if (!ran) { ran = true; fn(); } }
    requestAnimationFrame(run);
    setTimeout(run, 60);
  }
  var renderQueued = false;
  function onDelta(text) {
    var last = state.items[state.items.length - 1];
    if (!last || last.kind !== "text") {
      last = { kind: "text", text: "" };
      appendItem(last);
    }
    last.text += text;
    if (renderQueued) { return; }
    renderQueued = true;
    nextFrame(function () {
      renderQueued = false;
      var rows = log.querySelectorAll(".row.text");
      var row = rows[rows.length - 1];
      var cur = state.items[state.items.length - 1];
      if (row && cur && cur.kind === "text") { row.querySelector(".md").innerHTML = renderMarkdown(cur.text); }
      scrollDown();
    });
  }
  function onToolResult(msg) {
    var item = state.items.find(function (it) { return it.kind === "tool" && it.id === msg.id; });
    if (item) { item.status = msg.status; item.output = msg.output; }
    var row = log.querySelector('[data-tool="' + CSS.escape(msg.id) + '"]');
    if (row) {
      row.className = "row item tool " + msg.status;
      row.querySelector(".tool-out").textContent = msg.output || "";
    }
  }

  // ---- Status line (spinner while a turn runs) ----
  var GLYPHS = ["·", "✢", "✳", "✶", "✻", "✽", "✻", "✶", "✳", "✢"];
  var VERBS = { Read: "Reading", Edit: "Editing", MultiEdit: "Editing", Write: "Writing", Bash: "Running", Grep: "Searching", Glob: "Searching", WebFetch: "Fetching", WebSearch: "Searching", TodoWrite: "Planning" };
  var statusTimer = null, glyphIndex = 0;
  function updateStatus() {
    var secs = Math.floor((Date.now() - state.turnStart) / 1000);
    $("statusGlyph").textContent = GLYPHS[glyphIndex++ % GLYPHS.length];
    var verb = VERBS[state.lastToolName] || "Thinking";
    $("statusText").innerHTML = esc(verb) + "… <span class=\"muted\">(" + secs + "s" +
      (state.contextTokens ? " · " + fmtTokens(state.contextTokens) + " context" : "") + " · esc to interrupt)</span>";
  }
  function setBusy(busy) {
    state.busy = busy;
    $("statusLine").classList.toggle("hidden", !busy);
    clearInterval(statusTimer);
    if (busy) {
      state.turnStart = Date.now();
      state.lastToolName = "";
      updateStatus();
      statusTimer = setInterval(updateStatus, 120);
      $("idleNotice").classList.add("hidden");
    }
    updateSend();
    renderTimer();
  }

  // ---- Idle / prompt-cache notice + timer pill ----
  // Claude Code's prompt cache lasts about an hour; after that the next
  // message re-sends the whole context uncached.
  var CACHE_TTL_MS = 60 * 60 * 1000;
  function renderTimer() {
    var t = $("timer");
    if (!state.lastTurnAt || state.busy) { t.classList.add("hidden"); return; }
    var idle = Date.now() - state.lastTurnAt;
    t.classList.remove("hidden");
    t.classList.toggle("warn", idle > CACHE_TTL_MS);
    t.innerHTML = ICONS.clock + esc(fmtDuration(idle));
    t.title = "Since last message" + (state.contextTokens ? " · context " + fmtTokens(state.contextTokens) + " tokens" : "") +
      (idle > CACHE_TTL_MS ? " · prompt cache likely expired" : "");
  }
  function renderIdle() {
    var n = $("idleNotice");
    var idle = state.lastTurnAt ? Date.now() - state.lastTurnAt : 0;
    if (state.busy || idle <= CACHE_TTL_MS || !state.items.length) { n.classList.add("hidden"); return; }
    n.classList.remove("hidden");
    n.textContent = "Idle " + fmtDuration(idle) + ". The prompt cache has likely expired, so your next message will re-cache" +
      (state.contextTokens ? " about " + fmtTokens(state.contextTokens) + " tokens." : " the conversation.");
  }
  setInterval(function () { renderTimer(); renderIdle(); }, 30000);

  // ---- Permission modes (Shift+Tab) ----
  var MODES = {
    ask: { label: "Ask before edits", icon: "pencil", desc: "Claude asks before editing files or running commands" },
    acceptEdits: { label: "Edit automatically", icon: "code", desc: "Edits apply automatically; commands still ask" },
    plan: { label: "Plan mode", icon: "pause", desc: "Research and plan without changing anything" },
    auto: { label: "Auto", icon: "bolt", desc: "Claude decides which actions are safe to run" },
    readonly: { label: "Read-only", icon: "eye", desc: "Read code, history and pool only" },
  };
  var MODE_CYCLE = ["ask", "acceptEdits", "plan", "auto"];
  function setMode(mode, announce) {
    if (!MODES[mode]) { return; }
    state.mode = mode;
    var b = $("modeBtn");
    b.className = "mode-btn " + mode;
    b.innerHTML = ICONS[MODES[mode].icon] + esc(MODES[mode].label);
    if (announce) { vscode.postMessage({ type: "setPermissionMode", mode: mode }); }
  }
  function cycleMode() {
    var i = MODE_CYCLE.indexOf(state.mode);
    setMode(MODE_CYCLE[(i + 1) % MODE_CYCLE.length], true);
  }

  // ---- Model / effort pill ----
  var MODELS = [["", "Default"], ["opus", "Opus"], ["sonnet", "Sonnet"], ["haiku", "Haiku"], ["fable", "Fable"]];
  var EFFORTS = [["", "Default"], ["low", "Low"], ["medium", "Medium"], ["high", "High"], ["max", "Max"]];
  function renderModel() {
    var name = state.model ? prettyModel(state.model) : (prettyModel(state.activeModel) || "Default model");
    $("modelBtn").innerHTML = esc(name) + (state.effort ? ' <span class="muted">' + esc(cap(state.effort)) + "</span>" : "");
  }

  // ---- Popup menus ----
  var menu = $("menu");
  var menuState = { kind: null, items: [], active: 0, start: -1 };
  function closeMenu() { menu.classList.add("hidden"); menuState.kind = null; }
  function openMenu(kind, items, extraHtml) {
    menuState.kind = kind;
    menuState.items = items;
    var checkedIndex = items.findIndex(function (it) { return it.checked; });
    menuState.active = checkedIndex >= 0 ? checkedIndex : 0;
    if (!items.length && !extraHtml) { closeMenu(); return; }
    var html = extraHtml || "";
    var lastSect = null;
    items.forEach(function (it, i) {
      if (it.sect && it.sect !== lastSect) { html += '<div class="sect">' + esc(it.sect) + "</div>"; lastSect = it.sect; }
      html += '<button class="mi' + (i === menuState.active ? " active" : "") + '" data-i="' + i + '">' + (it.icon ? ICONS[it.icon] : "") +
        '<span class="lbl">' + esc(it.label) + "</span>" + (it.desc ? '<span class="desc">' + esc(it.desc) + "</span>" : "") +
        (it.checked ? '<span class="check">' + ICONS.check + "</span>" : "") + "</button>";
    });
    menu.innerHTML = html;
    menu.classList.remove("hidden");
  }
  function moveMenu(delta) {
    var n = menuState.items.length;
    if (!n) { return; }
    menuState.active = (menuState.active + delta + n) % n;
    menu.querySelectorAll(".mi").forEach(function (el, i) { el.classList.toggle("active", i === menuState.active); });
    var a = menu.querySelector(".mi.active");
    if (a) { a.scrollIntoView({ block: "nearest" }); }
  }
  menu.addEventListener("mousedown", function (ev) {
    ev.preventDefault();
    var seg = ev.target.closest("[data-effort]");
    if (seg) {
      state.effort = seg.getAttribute("data-effort");
      vscode.postMessage({ type: "setEffort", effort: state.effort });
      renderModel();
      openModelMenu();
      return;
    }
    var mi = ev.target.closest(".mi");
    if (mi) { chooseMenu(Number(mi.getAttribute("data-i"))); }
  });
  function chooseMenu(i) {
    var it = menuState.items[i];
    if (!it) { return; }
    var kind = menuState.kind;
    closeMenu();
    it.run(kind);
  }

  // "/" commands: panel-local ones plus whatever the CLI reported.
  var LOCAL_COMMANDS = [
    { name: "clear", desc: "Start a new conversation", run: function () { vscode.postMessage({ type: "chatNew" }); } },
    { name: "history", desc: "Browse past conversations", run: function () { showView("history"); } },
    { name: "pool", desc: "Open the Team Pool", run: function () { showView("pool"); } },
    { name: "add", desc: "Add a spec, doc, link or Figma frame to the pool", run: function () { showView("add"); } },
    { name: "model", desc: "Choose model and effort", run: function () { openModelMenu(); } },
    { name: "mode", desc: "Choose permission mode", run: function () { openModeMenu(); } },
    { name: "save", desc: "Save the last answer to the pool", run: function () {
      var t = turnText(state.items.length - 1);
      if (t) { vscode.postMessage({ type: "saveToPool", text: t }); }
    } },
  ];
  var CLI_DESCRIPTIONS = { compact: "Summarize the conversation to free up context", context: "Show context usage", init: "Create a CLAUDE.md for this repo", review: "Review code changes", "security-review": "Security review of pending changes", cost: "Show session cost" };
  function slashItems(query) {
    var q = query.toLowerCase();
    var local = LOCAL_COMMANDS.filter(function (c) { return c.name.indexOf(q) === 0; }).map(function (c) {
      return { sect: "Team Pool", label: "/" + c.name, desc: c.desc, run: function () { setInput(""); c.run(); } };
    });
    var localNames = LOCAL_COMMANDS.map(function (c) { return c.name; });
    var cli = state.slashCommands.filter(function (c) {
      return c.toLowerCase().indexOf(q) !== -1 && localNames.indexOf(c) === -1 && c.indexOf("__") !== 0;
    }).sort(function (a, b) { return (a.indexOf(q) === 0 ? 0 : 1) - (b.indexOf(q) === 0 ? 0 : 1); }).slice(0, 40).map(function (c) {
      return { sect: "Claude Code", label: "/" + c, desc: CLI_DESCRIPTIONS[c] || "", run: function () { setInput("/" + c + " "); } };
    });
    return local.concat(cli);
  }
  function openModelMenu() {
    var items = MODELS.map(function (m) {
      return { label: m[1], desc: m[0] ? "" : (state.activeModel ? prettyModel(state.activeModel) : "CLI default"), checked: state.model === m[0],
        run: function () { state.model = m[0]; vscode.postMessage({ type: "setModel", model: m[0] }); renderModel(); } };
    });
    var seg = '<div class="sect">Effort</div><div class="seg">' + EFFORTS.map(function (e) {
      return '<button data-effort="' + e[0] + '" class="' + (state.effort === e[0] ? "on" : "") + '">' + e[1] + "</button>";
    }).join("") + '</div><div class="sect">Model</div>';
    openMenu("model", items, seg);
  }
  function openModeMenu() {
    openMenu("mode", Object.keys(MODES).map(function (k) {
      return { label: MODES[k].label, desc: MODES[k].desc, icon: MODES[k].icon, checked: state.mode === k, run: function () { setMode(k, true); } };
    }), '<div class="sect">Permission mode · <kbd>Shift+Tab</kbd> to switch</div>');
  }
  function openPlusMenu() {
    var items = [
      { label: "Attach file", icon: "file", desc: "Repo files become @mentions", run: function () { vscode.postMessage({ type: "pickAttachment", images: false }); } },
      { label: "Attach image", icon: "image", desc: "Or paste / drop an image", run: function () { vscode.postMessage({ type: "pickAttachment", images: true }); } },
      { label: "Mention a file", icon: "at", desc: "@path, @path#L10-20", run: function () { insertAtCursor("@"); triggerMention(); } },
    ];
    if (state.selection.ctx) {
      items.push({ label: "Add current selection", icon: "selection", desc: refLabel(state.selection.ctx), run: function () { insertAtCursor(formatRef(state.selection.ctx) + " "); } });
    }
    var modules = moduleNames();
    modules.forEach(function (m) {
      items.push({ sect: "Focus on pool module", label: m, icon: "module", checked: state.moduleFocus === m, run: function () { setModuleFocus(state.moduleFocus === m ? "" : m); } });
    });
    openMenu("plus", items);
  }
  $("plusBtn").addEventListener("click", function () { if (menuState.kind === "plus") { closeMenu(); } else { openPlusMenu(); } });
  $("slashBtn").addEventListener("click", function () {
    if (menuState.kind === "slash") { closeMenu(); return; }
    if (!input.value.startsWith("/")) { setInput("/" + input.value); }
    input.focus();
    openMenu("slash", slashItems(input.value.slice(1).split(/\s/)[0]));
  });
  $("modelBtn").addEventListener("click", function () { if (menuState.kind === "model") { closeMenu(); } else { openModelMenu(); } });
  $("modeBtn").addEventListener("click", function () { if (menuState.kind === "mode") { closeMenu(); } else { openModeMenu(); } });

  // "@" file mentions (results come back as fileResults).
  var mentionTimer = null;
  function mentionQuery() {
    var upto = input.value.slice(0, input.selectionStart);
    var m = upto.match(/(^|\s)@([\w.\-\/]*)$/);
    return m ? { start: upto.length - m[2].length - 1, query: m[2] } : null;
  }
  function triggerMention() {
    var q = mentionQuery();
    if (!q) { if (menuState.kind === "mention") { closeMenu(); } return; }
    menuState.start = q.start;
    clearTimeout(mentionTimer);
    mentionTimer = setTimeout(function () { vscode.postMessage({ type: "fileSearch", query: q.query }); }, 100);
  }
  function showMentionResults(msg) {
    var q = mentionQuery();
    if (!q || q.query !== msg.query) { return; }
    var start = q.start;
    openMenu("mention", msg.files.map(function (p) {
      return { label: p.split("/").pop(), desc: p, icon: "file", run: function () {
        var caret = input.selectionStart;
        setInput(input.value.slice(0, start) + "@" + p + " " + input.value.slice(caret), start + p.length + 2);
      } };
    }));
  }

  // ---- Composer ----
  var composer = $("composer");
  input.addEventListener("focus", function () { composer.classList.add("focused"); });
  input.addEventListener("blur", function () { composer.classList.remove("focused"); setTimeout(function () { if (document.activeElement !== input) { closeMenu(); } }, 150); });
  function autosize() { input.style.height = "auto"; input.style.height = Math.min(input.scrollHeight, window.innerHeight * 0.4) + "px"; }
  function setInput(text, caret) {
    input.value = text;
    var pos = caret == null ? text.length : caret;
    input.focus();
    input.setSelectionRange(pos, pos);
    autosize();
    updateSend();
    persist();
  }
  function insertAtCursor(text) {
    var start = input.selectionStart, end = input.selectionEnd;
    var before = input.value.slice(0, start);
    var pad = before && !/\s$/.test(before) ? " " : "";
    setInput(before + pad + text + input.value.slice(end), start + pad.length + text.length);
  }
  function updateSend() {
    var b = $("sendBtn");
    var hasText = Boolean(input.value.trim());
    var stopping = state.busy && !hasText;
    b.innerHTML = stopping ? ICONS.stop : ICONS.arrowUp;
    b.title = stopping ? "Stop (Esc)" : state.busy ? "Queue message (Enter)" : "Send (Enter)";
    b.disabled = !state.busy && !hasText;
  }
  function updatePlaceholder() {
    var focusKey = state.platform === "darwin" ? "⌃Esc" : "Ctrl+Alt+Esc";
    input.placeholder = state.busy ? "Queue another message... (Esc to interrupt)" : focusKey + " to focus or unfocus";
  }

  function refLabel(ctx) {
    var name = ctx.path.split("/").pop();
    if (!ctx.startLine) { return name; }
    return name + ":" + ctx.startLine + (ctx.endLine !== ctx.startLine ? "-" + ctx.endLine : "");
  }
  function formatRef(ctx) {
    if (!ctx.startLine) { return "@" + ctx.path; }
    return "@" + ctx.path + "#L" + ctx.startLine + (ctx.endLine !== ctx.startLine ? "-" + ctx.endLine : "");
  }

  function renderChips() {
    var chips = $("chips");
    var html = "";
    var sel = state.selection.ctx;
    // Like Claude Code: a real selection is attached automatically; click to exclude.
    if (sel && sel.startLine) {
      html += '<span class="chip toggle' + (state.selection.include ? "" : " off") + '" data-chip="sel" title="' + esc(sel.path) +
        ' — click to ' + (state.selection.include ? "exclude" : "include") + '">' + ICONS.selection + esc(refLabel(sel)) + "</span>";
    }
    if (state.moduleFocus) {
      html += '<span class="chip">' + ICONS.module + "Pool: " + esc(state.moduleFocus) + '<button data-chip="module" title="Remove focus">' + ICONS.x + "</button></span>";
    }
    state.images.forEach(function (img, i) {
      html += '<span class="chip" title="' + esc(img.name) + '">' + ICONS.image + esc(img.name) + (img.dims ? ' <span class="dim">' + esc(img.dims) + "</span>" : "") +
        '<button data-chip="img" data-i="' + i + '" title="Remove">' + ICONS.x + "</button></span>";
    });
    state.attachments.forEach(function (a, i) {
      html += '<span class="chip" title="' + esc(a.path) + '">' + ICONS.file + esc(a.name) +
        '<button data-chip="att" data-i="' + i + '" title="Remove">' + ICONS.x + "</button></span>";
    });
    chips.innerHTML = html;
  }
  $("chips").addEventListener("click", function (ev) {
    var el = ev.target.closest("[data-chip]");
    if (!el) { return; }
    var kind = el.getAttribute("data-chip");
    if (kind === "sel") { state.selection.include = !state.selection.include; }
    if (kind === "module") { setModuleFocus(""); }
    if (kind === "img") { state.images.splice(Number(el.getAttribute("data-i")), 1); }
    if (kind === "att") {
      var a = state.attachments.splice(Number(el.getAttribute("data-i")), 1)[0];
      if (a) { vscode.postMessage({ type: "removeAttachment", path: a.path }); }
    }
    renderChips();
  });
  function setModuleFocus(m) {
    state.moduleFocus = m;
    vscode.postMessage({ type: "setModuleFocus", module: m });
    renderChips();
  }

  // Images: paste or drop.
  function addImageFile(file) {
    if (!/^image\/(png|jpe?g|gif|webp)$/.test(file.type) || state.images.length >= 8) { return; }
    var reader = new FileReader();
    reader.onload = function () {
      var entry = { name: file.name || "image.png", dataUrl: String(reader.result), dims: "" };
      var img = new Image();
      img.onload = function () { entry.dims = img.naturalWidth + "×" + img.naturalHeight; renderChips(); };
      img.src = entry.dataUrl;
      state.images.push(entry);
      renderChips();
      updateSend();
    };
    reader.readAsDataURL(file);
  }
  input.addEventListener("paste", function (ev) {
    var files = Array.prototype.filter.call((ev.clipboardData && ev.clipboardData.files) || [], function (f) { return f.type.indexOf("image/") === 0; });
    if (files.length) { ev.preventDefault(); files.forEach(addImageFile); }
  });
  composer.addEventListener("dragover", function (ev) { ev.preventDefault(); composer.classList.add("dragover"); });
  composer.addEventListener("dragleave", function () { composer.classList.remove("dragover"); });
  composer.addEventListener("drop", function (ev) {
    ev.preventDefault();
    composer.classList.remove("dragover");
    Array.prototype.forEach.call((ev.dataTransfer && ev.dataTransfer.files) || [], addImageFile);
  });

  // Mic: system dictation (VS Code webviews can't access the microphone).
  var toastTimer = null;
  function toast(html) {
    var t = $("toast");
    t.innerHTML = html;
    t.classList.remove("hidden");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.add("hidden"); }, 5000);
  }
  $("micBtn").addEventListener("click", function () {
    input.focus();
    var how = state.platform === "darwin" ? "Press <kbd>Fn</kbd> twice (or the <kbd>🌐</kbd>/mic key) to start dictation. Speak, then press it again to stop." :
      state.platform === "win32" ? "Press <kbd>Win</kbd>+<kbd>H</kbd> to start voice typing." :
      "Use your desktop's dictation shortcut to speak into the box.";
    toast("<b>Dictate</b><br>" + how);
  });

  function send() {
    var text = input.value.trim();
    if (state.busy && !text) { vscode.postMessage({ type: "chatStop" }); return; }
    if (!text) { return; }
    // Slash commands handled by the panel itself.
    var lm = text.match(/^\/(\w+)\s*$/);
    var local = lm && LOCAL_COMMANDS.find(function (c) { return c.name === lm[1]; });
    if (local) { setInput(""); local.run(); return; }
    var includeSelection = Boolean(state.selection.ctx && state.selection.ctx.startLine && state.selection.include);
    var payload = {
      text: text,
      includeSelection: includeSelection,
      shown: includeSelection ? text + "\n\n" + formatRef(state.selection.ctx) : text,
      images: state.images.map(function (i) { return { name: i.name, dataUrl: i.dataUrl }; }),
      names: state.attachments.map(function (a) { return a.name; }).concat(state.images.map(function (i) { return i.name; })),
    };
    if (state.history[state.history.length - 1] !== text) { state.history.push(text); }
    state.historyIndex = -1;
    state.images = [];
    state.attachments = [];
    renderChips();
    closeMenu();
    setInput("");
    if (state.busy) {
      state.queue.push(payload);
      renderQueue();
      return;
    }
    dispatch(payload);
  }
  function dispatch(payload) {
    appendItem({ kind: "user", text: payload.shown, time: Date.now(), attachments: payload.names });
    scrollDown(true);
    vscode.postMessage({ type: "chatSend", text: payload.text, includeSelection: payload.includeSelection, images: payload.images });
  }
  function renderQueue() {
    var q = $("queueLine");
    if (!state.queue.length) { q.classList.add("hidden"); return; }
    q.classList.remove("hidden");
    q.innerHTML = state.queue.map(function (p, i) {
      return '<span class="chip" title="' + esc(p.text) + '">Queued: ' + esc(p.text.length > 50 ? p.text.slice(0, 47) + "..." : p.text) +
        '<button data-q="' + i + '" title="Remove">' + ICONS.x + "</button></span>";
    }).join("");
  }
  $("sendBtn").addEventListener("click", send);
  $("queueLine").addEventListener("click", function (ev) {
    var b = ev.target.closest("[data-q]");
    if (b) { state.queue.splice(Number(b.getAttribute("data-q")), 1); renderQueue(); }
  });

  input.addEventListener("input", function () {
    autosize();
    updateSend();
    persist();
    var v = input.value;
    if (/^\/\S*$/.test(v)) { openMenu("slash", slashItems(v.slice(1))); return; }
    if (menuState.kind === "slash") { closeMenu(); }
    triggerMention();
  });

  input.addEventListener("keydown", function (e) {
    if (e.isComposing) { return; }
    if (!menu.classList.contains("hidden") && menuState.items.length) {
      if (e.key === "ArrowDown") { e.preventDefault(); moveMenu(1); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); moveMenu(-1); return; }
      if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); chooseMenu(menuState.active); return; }
    }
    if (e.key === "Escape") {
      e.preventDefault();
      if (!menu.classList.contains("hidden")) { closeMenu(); return; }
      if (state.busy) { state.queue = []; renderQueue(); vscode.postMessage({ type: "chatStop" }); return; }
      vscode.postMessage({ type: "focusEditor" });
      return;
    }
    if (e.key === "Tab" && e.shiftKey) { e.preventDefault(); cycleMode(); return; }
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); return; }
    // Prompt history, like a terminal: only when the caret is at an edge.
    if (e.key === "ArrowUp" && input.selectionStart === 0 && state.history.length) {
      e.preventDefault();
      state.historyIndex = state.historyIndex < 0 ? state.history.length - 1 : Math.max(0, state.historyIndex - 1);
      setInput(state.history[state.historyIndex]);
      return;
    }
    if (e.key === "ArrowDown" && state.historyIndex >= 0 && input.selectionStart === input.value.length) {
      e.preventDefault();
      state.historyIndex++;
      if (state.historyIndex >= state.history.length) { state.historyIndex = -1; setInput(""); } else { setInput(state.history[state.historyIndex]); }
    }
  });
  // Shift+Tab / Esc also work when focus is elsewhere in the panel.
  document.addEventListener("keydown", function (e) {
    if (e.target === input || state.view !== "chat") { return; }
    if (e.key === "Tab" && e.shiftKey) { e.preventDefault(); cycleMode(); }
    if (e.key === "Escape" && state.busy) { vscode.postMessage({ type: "chatStop" }); }
  });

  // ---- Permission prompt ----
  function addApproval(msg) {
    clearEmpty();
    var el = document.createElement("div");
    el.className = "approval";
    el.tabIndex = -1;
    el.setAttribute("data-id", msg.id);
    var opts = [["allow", "Yes"]];
    if (!msg.warning) { opts.push(["allowSession", "Yes, and don't ask again this session"]); }
    opts.push(["deny", "No"]);
    el.innerHTML = '<div class="approval-title">' + esc(msg.title) + "?</div>" +
      (msg.warning ? '<div class="approval-warning">⚠ ' + esc(msg.warning) + "</div>" : "") +
      (msg.detail ? "<pre>" + esc(msg.detail) + "</pre>" : "") +
      (msg.canDiff ? '<button class="diff-link" data-act="diff">Open diff</button>' : "") +
      '<div class="options">' + opts.map(function (o, i) {
        return '<button class="opt" data-act="' + o[0] + '"><span class="num">' + (i + 1) + "</span>" + esc(o[1]) + "</button>";
      }).join("") + "</div>" +
      '<div class="feedback"><input placeholder="Or tell Claude what to do instead, then Enter"></div>';
    function respond(decision, reason) { vscode.postMessage({ type: "approvalResponse", id: msg.id, decision: decision, reason: reason || "" }); }
    el.addEventListener("click", function (ev) {
      var b = ev.target.closest("[data-act]");
      if (!b) { return; }
      var act = b.getAttribute("data-act");
      if (act === "diff") { vscode.postMessage({ type: "viewProposedDiff", id: msg.id }); return; }
      respond(act, el.querySelector("input").value.trim());
    });
    el.addEventListener("keydown", function (ev) {
      if (ev.target.tagName === "INPUT") {
        if (ev.key === "Enter") { ev.preventDefault(); respond("deny", ev.target.value.trim()); }
        return;
      }
      var n = Number(ev.key);
      if (n >= 1 && n <= opts.length) { ev.preventDefault(); respond(opts[n - 1][0]); }
      if (ev.key === "Escape") { ev.preventDefault(); respond("deny"); }
    });
    log.appendChild(el);
    scrollDown(true);
    el.focus();
  }
  function resolveApproval(msg) {
    var el = log.querySelector('.approval[data-id="' + CSS.escape(msg.id) + '"]');
    if (!el) { return; }
    el.classList.add("resolved");
    el.querySelectorAll(".options, .feedback, .diff-link").forEach(function (x) { x.remove(); });
    var r = document.createElement("div");
    r.className = "muted";
    r.textContent = msg.label;
    el.appendChild(r);
    input.focus();
  }

  // ---- History view ----
  function renderHistory() {
    var q = $("historySearch").value.trim().toLowerCase();
    var list = state.conversations.filter(function (c) { return !q || c.title.toLowerCase().indexOf(q) !== -1; });
    $("historyList").innerHTML = list.length ? list.map(function (c) {
      return '<div class="conv' + (c.id === state.activeId ? " current" : "") + '" data-id="' + esc(c.id) + '"><span class="t">' + esc(c.title) +
        '</span><span class="w">' + esc(relTime(c.updatedAt)) + '</span><button class="icon-btn" data-del="1" title="Delete">' + ICONS.trash + "</button></div>";
    }).join("") : '<div class="empty">No conversations yet.</div>';
  }
  $("historySearch").addEventListener("input", renderHistory);
  $("historyList").addEventListener("click", function (ev) {
    var row = ev.target.closest(".conv");
    if (!row) { return; }
    var id = row.getAttribute("data-id");
    if (ev.target.closest("[data-del]")) { vscode.postMessage({ type: "deleteConversation", id: id }); return; }
    vscode.postMessage({ type: "openConversation", id: id });
    showView("chat");
  });

  // ---- Pool view ----
  function moduleNames() {
    var modules = [];
    state.entries.forEach(function (e) { if (modules.indexOf(e.module) === -1) { modules.push(e.module); } });
    return modules.sort();
  }
  function renderPool() {
    var q = $("poolSearch").value.trim().toLowerCase();
    var list = $("poolList");
    if (!state.entries.length) {
      list.innerHTML = '<div class="empty">The pool is empty.<br>Add a Swagger spec, docs, Figma frames or a note with <b>Add</b>.<br>Everything lives in <code>.claude-pool/</code> in this repo, so commit and push to share it.</div>';
      return;
    }
    var html = "";
    var lastModule = null;
    state.entries.filter(function (e) {
      return !q || [e.title, e.module, e.release, e.author, e.summary, e.kind].join(" ").toLowerCase().indexOf(q) !== -1;
    }).forEach(function (e) {
      if (e.module !== lastModule) { html += '<div class="module-head">' + esc(e.module) + "</div>"; lastModule = e.module; }
      var when = e.updated ? new Date(e.updated).toLocaleDateString() : "";
      html += '<div class="entry" data-path="' + esc(e.path) + '"><div class="entry-main">' +
        '<div class="entry-title">' + esc(e.title) + '<span class="badge">' + esc(e.kind) + "</span></div>" +
        (e.summary ? '<div class="entry-summary">' + esc(e.summary) + "</div>" : "") +
        '<div class="entry-meta">' + esc(e.release) + (e.author ? " · " + esc(e.author) : "") + (when ? " · " + esc(when) : "") + "</div></div>" +
        '<div class="entry-actions"><button class="btn secondary" data-act="ask">Ask</button><button class="icon-btn" data-act="delete" title="Delete">' + ICONS.trash + "</button></div></div>";
    });
    list.innerHTML = html || '<div class="empty">No matches.</div>';
  }
  $("poolList").addEventListener("click", function (ev) {
    var el = ev.target.closest(".entry");
    if (!el) { return; }
    var p = el.getAttribute("data-path");
    var actEl = ev.target.closest("[data-act]");
    var act = actEl && actEl.getAttribute("data-act");
    var entry = state.entries.find(function (e) { return e.path === p; });
    if (act === "delete") { vscode.postMessage({ type: "deleteEntry", path: p }); }
    else if (act === "ask" && entry) {
      setModuleFocus(entry.module);
      showView("chat");
      setInput("Using the pool entry " + entry.path + ", ");
    } else { vscode.postMessage({ type: "openEntry", path: p }); }
  });
  $("poolSearch").addEventListener("input", renderPool);
  $("poolAddBtn").addEventListener("click", function () { showView("add"); });
  $("linkBtn").addEventListener("click", function () { vscode.postMessage({ type: "linkClaudeMd" }); });
  $("scmBtn").addEventListener("click", function () { vscode.postMessage({ type: "openScm" }); });

  // ---- Add view ----
  var add = { kind: "note", files: { api: [], doc: [] }, summary: "" };
  function setKind(kind) {
    add.kind = kind;
    document.querySelectorAll(".kind").forEach(function (k) { k.classList.toggle("active", k.getAttribute("data-kind") === kind); });
    document.querySelectorAll(".kind-field").forEach(function (f) { f.classList.toggle("hidden", f.getAttribute("data-for").split(" ").indexOf(kind) === -1); });
    $("ingestStatus").textContent = "";
    $("ingestStatus").className = "status";
  }
  document.querySelectorAll(".kind").forEach(function (k) { k.addEventListener("click", function () { setKind(k.getAttribute("data-kind")); }); });
  setKind("note");
  $("pickSwaggerBtn").addEventListener("click", function () { vscode.postMessage({ type: "pickFiles", purpose: "swagger" }); });
  $("pickDocsBtn").addEventListener("click", function () { vscode.postMessage({ type: "pickFiles", purpose: "docs" }); });
  function urlsFor(kind) {
    var id = kind === "design" ? "figmaUrls" : kind === "link" ? "linkUrls" : null;
    return id ? $(id).value.split("\n").map(function (s) { return s.trim(); }).filter(Boolean) : [];
  }
  function filesFor(kind) { return kind === "api" ? add.files.api : kind === "doc" ? add.files.doc : []; }
  $("previewBtn").addEventListener("click", function () {
    $("ingestStatus").className = "status";
    $("ingestStatus").textContent = add.kind === "api" ? "Parsing spec..." : "Asking Claude... (this can take a minute)";
    vscode.postMessage({ type: "ingestPreview", kind: add.kind, files: filesFor(add.kind), urls: urlsFor(add.kind), focus: $("addFocus").value });
  });
  $("saveEntryBtn").addEventListener("click", function () {
    $("saveStatus").className = "status";
    $("saveStatus").textContent = "Saving...";
    vscode.postMessage({
      type: "saveEntry", kind: add.kind, module: $("addModule").value, release: $("addRelease").value,
      title: $("addTitle").value, summary: add.summary, body: $("previewBody").value,
      files: filesFor(add.kind), urls: urlsFor(add.kind),
    });
  });

  // ---- Messages from the extension ----
  window.addEventListener("message", function (event) {
    var msg = event.data;
    switch (msg.type) {
      case "init":
        state.platform = msg.platform || state.platform;
        state.model = msg.model || "";
        state.effort = msg.effort || "";
        state.slashCommands = msg.slashCommands || [];
        $("addRelease").value = msg.release;
        if (!msg.hasFigmaTools) { $("figmaHint").textContent = 'Set "claudeCommit.pool.figmaTools" to enable Figma import.'; }
        setMode(msg.permissionMode, false);
        renderModel();
        break;
      case "conversations":
        state.conversations = msg.list;
        state.activeId = msg.activeId;
        if (state.view === "chat") { $("topTitle").textContent = currentTitle(); }
        if (state.view === "history") { renderHistory(); }
        break;
      case "chatReset":
        state.items = msg.conversation ? msg.conversation.items.slice() : [];
        state.contextTokens = (msg.conversation && msg.conversation.contextTokens) || 0;
        state.lastTurnAt = (msg.conversation && msg.conversation.lastTurnAt) || 0;
        state.activeId = msg.conversation ? msg.conversation.id : null;
        renderAll();
        renderTimer();
        renderIdle();
        if (state.view === "chat") { $("topTitle").textContent = currentTitle(); }
        break;
      case "chatItem":
        if (msg.item.kind === "tool") { state.lastToolName = msg.item.name; }
        appendItem(msg.item);
        break;
      case "chatDelta": onDelta(msg.text); break;
      case "chatToolResult": onToolResult(msg); break;
      case "chatMeta":
        if (msg.model) { state.activeModel = msg.model; renderModel(); }
        if (msg.slashCommands) { state.slashCommands = msg.slashCommands; }
        if (msg.contextTokens) { state.contextTokens = msg.contextTokens; }
        if (msg.lastTurnAt) { state.lastTurnAt = msg.lastTurnAt; renderTimer(); }
        break;
      case "chatDone": {
        var i = state.items.length - 1;
        var text = turnText(i);
        if (text) { log.appendChild(turnActions(text)); scrollDown(); }
        break;
      }
      case "chatBusy":
        setBusy(msg.busy);
        updatePlaceholder();
        if (!msg.busy && state.queue.length) {
          var nextPayload = state.queue.shift();
          renderQueue();
          setTimeout(function () { dispatch(nextPayload); }, 50);
        }
        break;
      case "approvalRequest": addApproval(msg); break;
      case "approvalResolved": resolveApproval(msg); break;
      case "editorContext": {
        var prev = state.selection.ctx;
        var next = msg.context;
        state.selection.ctx = next;
        if (!prev || !next || prev.path !== next.path || prev.startLine !== next.startLine || prev.endLine !== next.endLine) {
          state.selection.include = true;
        }
        renderChips();
        break;
      }
      case "insertText": showView("chat"); insertAtCursor(msg.text); break;
      case "focusInput": showView("chat"); input.focus(); break;
      case "fileResults": showMentionResults(msg); break;
      case "attachmentAdded": state.attachments.push(msg.attachment); renderChips(); input.focus(); break;
      case "pool":
        state.entries = msg.entries;
        $("linkBanner").classList.toggle("hidden", msg.linked || !msg.entries.length);
        $("commitBanner").classList.toggle("hidden", !msg.uncommitted);
        $("commitText").textContent = msg.uncommitted + " pool change(s) not committed yet - teammates only see them after you commit and push.";
        $("moduleList").innerHTML = moduleNames().map(function (m) { return '<option value="' + esc(m) + '">'; }).join("");
        renderPool();
        break;
      case "pickedFiles":
        if (msg.purpose === "swagger") { add.files.api = msg.files; $("swaggerFiles").textContent = msg.files.map(function (f) { return f.name; }).join(", "); }
        else { add.files.doc = msg.files; $("docFiles").textContent = msg.files.map(function (f) { return f.name; }).join(", "); }
        break;
      case "ingestBusy": $("previewBtn").disabled = msg.busy; break;
      case "ingestPreview":
        $("ingestStatus").textContent = "Review and edit below, then save.";
        if (msg.title && !$("addTitle").value) { $("addTitle").value = msg.title; }
        add.summary = msg.summary || "";
        $("previewBody").value = msg.body;
        break;
      case "ingestError":
        $("ingestStatus").className = "status error";
        $("ingestStatus").textContent = msg.message;
        break;
      case "saved":
        $("saveStatus").textContent = "Saved " + msg.path;
        ["addTitle", "previewBody", "linkUrls", "figmaUrls", "addFocus"].forEach(function (id) { $(id).value = ""; });
        add.summary = "";
        add.files = { api: [], doc: [] };
        $("swaggerFiles").textContent = "";
        $("docFiles").textContent = "";
        break;
      case "error":
        if (state.view === "add") {
          $("saveStatus").className = "status error";
          $("saveStatus").textContent = msg.message;
        } else {
          appendItem({ kind: "notice", text: msg.message, tone: "error" });
        }
        break;
    }
  });

  if (saved.draft) { input.value = saved.draft; }
  autosize();
  updateSend();
  updatePlaceholder();
  renderModel();
  setMode("ask", false);
  renderEmpty();
  vscode.postMessage({ type: "ready" });
})();
`;
