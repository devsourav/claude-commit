import * as vscode from "vscode";
import { getDiffToAnalyze, getDiffStat, getRecentSubjects, truncateDiff } from "./gitDiff";
import { LEAN_ARGS, runClaude, toolsArg } from "./claudeRunner";
import { buildCommitPrompt } from "./promptBuilder";
import { getGitApi, pickRepository } from "./gitApi";
import { GIT_REVISION_SCHEME, GitRevisionContentProvider } from "./gitContentProvider";
import { HubPanel } from "./hubPanel";
import { PoolPanel } from "./poolPanel";
import { PROPOSED_SCHEME, ProposedContentProvider } from "./proposedChanges";

export function activate(context: vscode.ExtensionContext) {
  const proposed = new ProposedContentProvider();
  PoolPanel.init({ proposed });

  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(PROPOSED_SCHEME, proposed),
    vscode.commands.registerCommand("claudeCommit.generate", (arg: unknown) =>
      generateCommitMessage(arg)
    ),
    vscode.commands.registerCommand("claudeCommit.openHub", (arg: unknown) =>
      openHub(context, arg)
    ),
    vscode.commands.registerCommand("claudeCommit.openHubNewTab", (arg: unknown) =>
      openHub(context, arg, true)
    ),
    vscode.commands.registerCommand("claudeCommit.openPool", (arg: unknown) =>
      openPool(context, arg)
    ),
    vscode.commands.registerCommand("claudeCommit.openPoolNewTab", (arg: unknown) =>
      openPool(context, arg, true)
    ),
    vscode.commands.registerCommand("claudeCommit.saveSelectionToPool", () =>
      saveSelectionToPool(context)
    ),
    vscode.commands.registerCommand("claudeCommit.addSelectionToPoolChat", () =>
      addSelectionToPoolChat(context)
    ),
    vscode.commands.registerCommand("claudeCommit.focusPoolChat", async () => {
      const root = await resolvePoolRoot(undefined);
      if (root) {
        PoolPanel.focus(context, root);
      }
    }),
    vscode.workspace.registerTextDocumentContentProvider(
      GIT_REVISION_SCHEME,
      new GitRevisionContentProvider()
    )
  );
}

export function deactivate() {
  // Nothing to clean up: the CLI process is killed on its own timeout,
  // and the command registration is disposed via context.subscriptions.
}

async function generateCommitMessage(arg: unknown) {
  const gitApi = getGitApi();
  if (!gitApi) {
    vscode.window.showErrorMessage(
      "Claude Commit: the built-in Git extension isn't available."
    );
    return;
  }

  const repository = await pickRepository(gitApi, arg);
  if (!repository) {
    return;
  }

  const cwd = repository.rootUri.fsPath;
  const config = vscode.workspace.getConfiguration("claudeCommit");
  const cliPath = config.get<string>("cliPath", "claude");
  const model = config.get<string>("model", "").trim();
  const extraInstructions = config.get<string>("extraInstructions", "").trim();
  const maxDiffChars = config.get<number>("maxDiffChars", 20000);
  const timeoutSeconds = config.get<number>("timeoutSeconds", 60);

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Claude Commit",
      cancellable: false,
    },
    async (progress) => {
      progress.report({ message: "Reading diff..." });

      let diffResult;
      try {
        diffResult = await getDiffToAnalyze(cwd);
      } catch (err) {
        vscode.window.showErrorMessage(
          `Claude Commit: ${err instanceof Error ? err.message : String(err)}`
        );
        return;
      }

      if (diffResult.diff.trim().length === 0) {
        vscode.window.showInformationMessage(
          "Claude Commit: no staged or unstaged changes to analyze."
        );
        return;
      }

      const { text: diffText, truncated } = truncateDiff(
        diffResult.diff,
        maxDiffChars
      );

      const [diffStat, recentSubjects] = await Promise.all([
        getDiffStat(cwd, diffResult.staged).catch(() => ""),
        getRecentSubjects(cwd),
      ]);

      progress.report({ message: "Asking Claude..." });

      const prompt = buildCommitPrompt({
        extraInstructions,
        truncated,
        diffStat,
        recentSubjects,
      });
      // Writing a commit message is a pure text task: no tools, no agent
      // system prompt, low effort. ~1k input tokens instead of ~33k.
      const args = [
        "-p",
        prompt,
        "--output-format",
        "text",
        "--system-prompt",
        "You write accurate, concise git commit messages.",
        "--effort",
        "low",
        ...toolsArg([]),
        ...LEAN_ARGS,
      ];
      if (model) {
        args.push("--model", model);
      }

      try {
        const result = await runClaude({
          cliPath,
          args,
          cwd,
          stdin: diffText,
          timeoutMs: timeoutSeconds * 1000,
        });

        if (result.timedOut) {
          vscode.window.showErrorMessage(
            `Claude Commit: timed out after ${timeoutSeconds}s waiting for the Claude Code CLI.`
          );
          return;
        }

        if (result.code !== 0) {
          vscode.window.showErrorMessage(
            `Claude Commit: Claude Code CLI exited with code ${result.code}. ${firstLines(
              result.stderr,
              3
            )}`
          );
          return;
        }

        const message = cleanMessage(result.stdout);
        if (!message) {
          vscode.window.showErrorMessage(
            "Claude Commit: Claude returned an empty commit message."
          );
          return;
        }

        repository.inputBox.value = message;
        const scopeNote = diffResult.staged ? "staged" : "unstaged";
        vscode.window.setStatusBarMessage(
          `Claude Commit: message generated from ${scopeNote} changes.`,
          4000
        );
      } catch (err) {
        const nodeErr = err as NodeJS.ErrnoException;
        if (nodeErr?.code === "ENOENT") {
          vscode.window.showErrorMessage(
            `Claude Commit: couldn't find "${cliPath}". Install the Claude Code CLI, or set "claudeCommit.cliPath" to its full path.`
          );
        } else {
          vscode.window.showErrorMessage(
            `Claude Commit: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }
    }
  );
}

async function openHub(context: vscode.ExtensionContext, arg: unknown, newTab = false) {
  const gitApi = getGitApi();
  if (!gitApi) {
    vscode.window.showErrorMessage(
      "Claude Commit: the built-in Git extension isn't available."
    );
    return;
  }

  // The "New Tab" title-bar button is invoked from the webview itself (no
  // useful arg), so default to that tab's own repo instead of re-prompting.
  const activeCwd = newTab ? HubPanel.activeCwd() : undefined;
  if (activeCwd) {
    HubPanel.createNewTab(context, gitApi, activeCwd);
    return;
  }

  const repository = await pickRepository(gitApi, arg);
  if (!repository) {
    return;
  }

  if (newTab) {
    HubPanel.createNewTab(context, gitApi, repository.rootUri.fsPath);
  } else {
    HubPanel.createOrShow(context, gitApi, repository.rootUri.fsPath);
  }
}

// The Team Pool is repo-scoped, so resolve which repo first. From the
// editor title bar VS Code passes the active document's Uri; prefer the
// repo that contains it over prompting.
async function resolvePoolRoot(arg: unknown): Promise<string | undefined> {
  const gitApi = getGitApi();
  if (!gitApi) {
    vscode.window.showErrorMessage(
      "Claude Commit: the built-in Git extension isn't available."
    );
    return undefined;
  }
  const fileUri =
    arg instanceof vscode.Uri ? arg : vscode.window.activeTextEditor?.document.uri;
  if (fileUri?.scheme === "file") {
    const containing = gitApi.repositories
      .filter((repo) => fileUri.fsPath.startsWith(repo.rootUri.fsPath))
      .sort((a, b) => b.rootUri.fsPath.length - a.rootUri.fsPath.length)[0];
    if (containing) {
      return containing.rootUri.fsPath;
    }
  }
  const repository = await pickRepository(gitApi, arg);
  return repository?.rootUri.fsPath;
}

async function openPool(context: vscode.ExtensionContext, arg: unknown, newTab = false) {
  // The "New Tab" title-bar button is invoked from the webview itself (no
  // useful arg), so default to that tab's own repo instead of re-prompting.
  const activeCwd = newTab ? PoolPanel.activeCwd() : undefined;
  if (activeCwd) {
    PoolPanel.createNewTab(context, activeCwd);
    return;
  }

  const root = await resolvePoolRoot(arg);
  if (root) {
    if (newTab) {
      PoolPanel.createNewTab(context, root);
    } else {
      PoolPanel.createOrShow(context, root);
    }
  }
}

async function saveSelectionToPool(context: vscode.ExtensionContext) {
  const editor = vscode.window.activeTextEditor;
  const text = editor?.document.getText(editor.selection);
  if (!editor || !text?.trim()) {
    vscode.window.showInformationMessage("Claude Commit: select some text to save to the Team Pool.");
    return;
  }
  const root = await resolvePoolRoot(editor.document.uri);
  if (root) {
    await PoolPanel.saveTextFromEditor(context, root, text);
  }
}

async function addSelectionToPoolChat(context: vscode.ExtensionContext) {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return;
  }
  const root = await resolvePoolRoot(editor.document.uri);
  if (root) {
    PoolPanel.insertReference(context, root, editor);
  }
}

function cleanMessage(raw: string): string {
  let message = raw.trim();
  // Strip a single wrapping ```-fence or matching quote pair, in case the
  // model ignores the "no fences/quotes" instruction.
  const fenceMatch = message.match(/^```[a-zA-Z]*\n([\s\S]*?)\n```$/);
  if (fenceMatch) {
    message = fenceMatch[1].trim();
  } else if (
    (message.startsWith('"') && message.endsWith('"')) ||
    (message.startsWith("'") && message.endsWith("'"))
  ) {
    message = message.slice(1, -1).trim();
  }
  return message;
}

function firstLines(text: string, count: number): string {
  return text.split("\n").slice(0, count).join("\n").trim();
}
