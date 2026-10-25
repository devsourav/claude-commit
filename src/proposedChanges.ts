import * as vscode from "vscode";
import * as fs from "fs/promises";

export const PROPOSED_SCHEME = "claude-commit-proposed";

// Holds the would-be content of a file for a pending Edit/Write approval,
// so "View diff" can open VS Code's native diff editor (current file vs.
// proposed) before the user allows the change - same idea as
// gitContentProvider, but backed by memory instead of `git show`.
export class ProposedContentProvider implements vscode.TextDocumentContentProvider {
  private readonly contents = new Map<string, string>();

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.contents.get(uri.toString()) ?? "";
  }

  set(id: string, filePath: string, content: string): vscode.Uri {
    const uri = vscode.Uri.from({ scheme: PROPOSED_SCHEME, path: filePath, query: id });
    this.contents.set(uri.toString(), content);
    return uri;
  }

  delete(uri: vscode.Uri) {
    this.contents.delete(uri.toString());
  }
}

interface EditSpec {
  old_string?: unknown;
  new_string?: unknown;
  replace_all?: unknown;
}

// Applies an Edit/MultiEdit/Write tool input to the file's current content.
// Returns undefined for tools that don't change a file's text.
export async function computeProposedContent(
  toolName: string,
  input: Record<string, unknown>
): Promise<{ filePath: string; before: string; after: string } | undefined> {
  const filePath = typeof input.file_path === "string" ? input.file_path : undefined;
  if (!filePath) {
    return undefined;
  }
  const before = await fs.readFile(filePath, "utf8").catch(() => "");
  if (toolName === "Write") {
    return { filePath, before, after: String(input.content ?? "") };
  }
  const edits: EditSpec[] =
    toolName === "Edit" ? [input as EditSpec] : toolName === "MultiEdit" ? ((input.edits as EditSpec[]) ?? []) : [];
  if (!edits.length) {
    return undefined;
  }
  let after = before;
  for (const edit of edits) {
    const oldString = String(edit.old_string ?? "");
    const newString = String(edit.new_string ?? "");
    after = edit.replace_all ? after.split(oldString).join(newString) : after.replace(oldString, () => newString);
  }
  return { filePath, before, after };
}
