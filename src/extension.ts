import * as vscode from "vscode";
import { getDiffToAnalyze, getDiffStat, getRecentSubjects, truncateDiff } from "./gitDiff";
import { runClaude } from "./claudeRunner";
import { buildCommitPrompt } from "./promptBuilder";
import { getGitApi, pickRepository } from "./gitApi";
import { GIT_REVISION_SCHEME, GitRevisionContentProvider } from "./gitContentProvider";
import { HubPanel } from "./hubPanel";

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand("claudeCommit.generate", (arg: unknown) =>
      generateCommitMessage(arg)
    ),
    vscode.commands.registerCommand("claudeCommit.openHub", (arg: unknown) =>
      openHub(context, arg)
    ),
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
      const args = ["-p", prompt, "--output-format", "text"];
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

async function openHub(context: vscode.ExtensionContext, arg: unknown) {
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

  HubPanel.createOrShow(context, gitApi, repository.rootUri.fsPath);
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
