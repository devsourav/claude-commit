import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

// Shared low-level `git` runner. No shell involved (execFile with an argv
// array), so there's no command-injection surface even with user-influenced
// arguments like a search term passed to `--grep`.
export async function runGit(
  cwd: string,
  args: string[],
  maxBuffer = 1024 * 1024 * 20
): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd, maxBuffer });
    return stdout;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`git ${args.join(" ")} failed: ${message}`);
  }
}
