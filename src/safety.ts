import * as fs from "fs";
import * as path from "path";

// Safety rules applied before *every* file change and command, whoever
// makes it: Claude in the Team Pool chat (via the PreToolUse hook in
// safetyHook.ts, which runs in every permission mode - including
// "Edit automatically" and "Auto", where no approval card is shown) and
// the extension itself when it writes pool entries (pool.ts).
//
// "deny" blocks outright and tells Claude why, so it can adjust. "ask"
// forces the approval card even in modes that would otherwise auto-allow.

export type SafetyVerdict = { decision: "allow" } | { decision: "deny" | "ask"; reason: string };

const ALLOW: SafetyVerdict = { decision: "allow" };

// High-confidence credential shapes only - this runs on every edit, so a
// noisy rule would just train people to click through it.
const SECRET_PATTERNS: [RegExp, string][] = [
  [/-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/, "a private key"],
  [/\bAKIA[0-9A-Z]{16}\b/, "an AWS access key"],
  [/\bgh[pousr]_[A-Za-z0-9]{36,}\b/, "a GitHub token"],
  [/\bgithub_pat_[A-Za-z0-9_]{50,}\b/, "a GitHub token"],
  [/\bsk-ant-[A-Za-z0-9_-]{20,}/, "an Anthropic API key"],
  [/\bsk-(?:proj-)?[A-Za-z0-9]{32,}\b/, "an OpenAI API key"],
  [/\bxox[abpr]-[A-Za-z0-9-]{10,}/, "a Slack token"],
  [/\b(?:sk|rk)_live_[A-Za-z0-9]{20,}\b/, "a Stripe live key"],
  [/\bAIza[0-9A-Za-z_-]{35}\b/, "a Google API key"],
];

export function findSecret(text: string): string | undefined {
  for (const [pattern, label] of SECRET_PATTERNS) {
    if (pattern.test(text)) {
      return label;
    }
  }
  return undefined;
}

// Files where a change is legitimate but high-impact: always shown to the
// user, never auto-applied.
const SENSITIVE_FILES: [RegExp, string][] = [
  [/(^|\/)\.env(\.|$)/, "environment/secrets file"],
  [/\.(pem|key|p12|pfx|keystore|jks)$/, "key/certificate file"],
  [/(^|\/)(id_rsa|id_ed25519|credentials(\.json)?|secrets?\.(json|ya?ml))$/, "credentials file"],
  [/(^|\/)\.claude\/settings(\.local)?\.json$/, "Claude Code permissions/settings"],
  [/(^|\/)\.github\/workflows\//, "CI workflow"],
  [/(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$/, "lockfile"],
  [/(^|\/)\.gitignore$/, ".gitignore"],
];

// JSON files that legitimately allow comments/trailing commas.
const JSONC_FILE = /(^|\/)(tsconfig[^/]*|jsconfig[^/]*|\.vscode\/[^/]+|[^/]*\.jsonc|devcontainer)\.json$|\.jsonc$/;

const BLOCKED_COMMANDS: [RegExp, string][] = [
  [/\brm\s+-[a-z]*r[a-z]*f?\s+(\/|~|\$HOME)(\s|$)/i, "recursive delete of / or home"],
  [/\bsudo\b/, "sudo"],
  [/\bgit\s+push\b[^|;&]*(\s--force\b|\s-f\b|\s--force-with-lease\b)/, "force push"],
  [/\bgit\s+reset\s+--hard\b/, "git reset --hard (discards work)"],
  [/\bgit\s+clean\s+-[a-z]*f/, "git clean -f (deletes untracked files)"],
  [/\b(curl|wget)\b[^|]*\|\s*(ba|z)?sh\b/, "piping a download into a shell"],
  [/\bmkfs\b|\bdd\s+if=|>\s*\/dev\/sd/, "raw disk write"],
  [/\bchmod\s+-R\s+777\b/, "chmod -R 777"],
];

const ASK_COMMANDS: [RegExp, string][] = [
  [/\bgit\s+(push|commit|rebase|merge|checkout\s+--|restore|stash\s+drop|branch\s+-D)\b/, "changes git history or shared state"],
  [/\b(npm|yarn|pnpm)\s+publish\b/, "publishes a package"],
  [/\brm\s+-[a-z]*r/, "recursive delete"],
];

// Fraction of an existing file a single Write may drop before it needs a
// human look (catches "rewrote the whole file from memory and lost half").
const MAX_SILENT_SHRINK = 0.5;
const MIN_LINES_FOR_SHRINK_CHECK = 80;

export function checkToolUse(
  toolName: string,
  input: Record<string, unknown>,
  repoRoot: string
): SafetyVerdict {
  if (toolName === "Bash") {
    return checkCommand(String(input.command ?? ""));
  }
  if (toolName === "Edit" || toolName === "MultiEdit" || toolName === "Write" || toolName === "NotebookEdit") {
    const filePath = String(input.file_path ?? input.notebook_path ?? "");
    const added =
      toolName === "Write"
        ? String(input.content ?? "")
        : toolName === "Edit"
          ? String(input.new_string ?? "")
          : toolName === "MultiEdit"
            ? ((input.edits as { new_string?: string }[] | undefined) ?? []).map((e) => e.new_string ?? "").join("\n")
            : String(input.new_source ?? "");
    return checkFileChange(filePath, added, repoRoot, toolName === "Write");
  }
  return ALLOW;
}

export function checkCommand(command: string): SafetyVerdict {
  for (const [pattern, label] of BLOCKED_COMMANDS) {
    if (pattern.test(command)) {
      return { decision: "deny", reason: `Blocked by Claude Commit safety check: ${label}. Ask the user to run it themselves if it's really needed.` };
    }
  }
  const secret = findSecret(command);
  if (secret) {
    return { decision: "deny", reason: `Blocked by Claude Commit safety check: the command contains ${secret}.` };
  }
  for (const [pattern, label] of ASK_COMMANDS) {
    if (pattern.test(command)) {
      return { decision: "ask", reason: `Safety check: this command ${label}.` };
    }
  }
  return ALLOW;
}

export function checkFileChange(
  filePath: string,
  addedText: string,
  repoRoot: string,
  isFullWrite: boolean
): SafetyVerdict {
  if (!filePath) {
    return { decision: "deny", reason: "Blocked by Claude Commit safety check: no file path given." };
  }
  const root = realpathOrSelf(repoRoot);
  const abs = realpathOrSelf(path.resolve(repoRoot, filePath));
  const rel = path.relative(root, abs).split(path.sep).join("/");
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
    return { decision: "deny", reason: `Blocked by Claude Commit safety check: ${filePath} is outside this repository.` };
  }
  if (rel === ".git" || rel.startsWith(".git/")) {
    return { decision: "deny", reason: "Blocked by Claude Commit safety check: never edit files inside .git/." };
  }
  if (rel === ".claude-pool/index.md") {
    return { decision: "deny", reason: "Blocked by Claude Commit safety check: .claude-pool/index.md is generated - edit the entry under .claude-pool/modules/ instead." };
  }
  const secret = findSecret(addedText);
  if (secret) {
    return { decision: "deny", reason: `Blocked by Claude Commit safety check: the change would write ${secret} into ${rel}. Use an environment variable or secret store instead.` };
  }
  if (isFullWrite && rel.endsWith(".json") && !JSONC_FILE.test(rel)) {
    try {
      JSON.parse(addedText);
    } catch (err) {
      return { decision: "deny", reason: `Blocked by Claude Commit safety check: the new ${rel} isn't valid JSON (${err instanceof Error ? err.message : String(err)}).` };
    }
  }
  for (const [pattern, label] of SENSITIVE_FILES) {
    if (pattern.test(rel)) {
      return { decision: "ask", reason: `Safety check: ${rel} is sensitive (${label}).` };
    }
  }
  if (isFullWrite) {
    const before = readLineCount(abs);
    const after = addedText.split("\n").length;
    if (before >= MIN_LINES_FOR_SHRINK_CHECK && after < before * (1 - MAX_SILENT_SHRINK)) {
      return { decision: "ask", reason: `Safety check: this rewrite shrinks ${rel} from ${before} to ${after} lines.` };
    }
  }
  return ALLOW;
}

// Resolves symlinks so a link inside the repo pointing outside it can't be
// used to escape. For a not-yet-existing file, resolves its nearest
// existing parent.
function realpathOrSelf(p: string): string {
  let current = p;
  const tail: string[] = [];
  while (true) {
    try {
      return path.join(fs.realpathSync(current), ...tail.reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) {
        return p;
      }
      tail.push(path.basename(current));
      current = parent;
    }
  }
}

function readLineCount(abs: string): number {
  try {
    return fs.readFileSync(abs, "utf8").split("\n").length;
  } catch {
    return 0;
  }
}
