import * as vscode from "vscode";

// Minimal slice of the built-in `vscode.git` extension's exported API —
// just enough to enumerate repositories and write the commit message into
// the Source Control input box. The full typings live in microsoft/vscode's
// git extension and aren't worth vendoring for two fields.
export interface GitRepository {
  rootUri: vscode.Uri;
  inputBox: { value: string };
}
export interface GitApi {
  repositories: GitRepository[];
}

export function getGitApi(): GitApi | undefined {
  const gitExtension = vscode.extensions.getExtension("vscode.git");
  if (!gitExtension) {
    return undefined;
  }
  const exports = gitExtension.isActive ? gitExtension.exports : undefined;
  return exports?.getAPI ? exports.getAPI(1) : undefined;
}

export async function pickRepository(
  gitApi: GitApi,
  arg: unknown
): Promise<GitRepository | undefined> {
  const repositories = gitApi.repositories;
  if (repositories.length === 0) {
    vscode.window.showErrorMessage("Claude Commit: no Git repository found.");
    return undefined;
  }

  // Invoked from the scm/title or scm/sourceControl menu: VS Code passes
  // the SourceControl instance, whose rootUri matches the repository's.
  const argRootUri = (arg as { rootUri?: vscode.Uri } | undefined)?.rootUri;
  if (argRootUri) {
    const match = repositories.find(
      (repo) => repo.rootUri.fsPath === argRootUri.fsPath
    );
    if (match) {
      return match;
    }
  }

  if (repositories.length === 1) {
    return repositories[0];
  }

  const pick = await vscode.window.showQuickPick(
    repositories.map((repo) => ({
      label: repo.rootUri.fsPath.split("/").pop() ?? repo.rootUri.fsPath,
      description: repo.rootUri.fsPath,
      repo,
    })),
    { placeHolder: "Select the repository to generate a commit message for" }
  );
  return pick?.repo;
}
