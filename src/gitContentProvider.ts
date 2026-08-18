import * as vscode from "vscode";
import { getFileAtRevision } from "./commitHistory";

// Custom scheme backing read-only "file at revision" documents, so commit
// diffs can be opened in VS Code's native diff editor (`vscode.diff`)
// instead of a hand-rolled diff view.
export const GIT_REVISION_SCHEME = "claude-commit-git";

interface GitRevisionUriParams {
  cwd: string;
  hash: string;
  path: string;
}

export function toGitRevisionUri({ cwd, hash, path }: GitRevisionUriParams): vscode.Uri {
  const query = encodeURIComponent(JSON.stringify({ cwd, hash, path }));
  return vscode.Uri.parse(`${GIT_REVISION_SCHEME}:${path}?${query}`);
}

export class GitRevisionContentProvider implements vscode.TextDocumentContentProvider {
  provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const { cwd, hash, path } = JSON.parse(decodeURIComponent(uri.query)) as GitRevisionUriParams;
    return getFileAtRevision(cwd, hash, path);
  }
}
