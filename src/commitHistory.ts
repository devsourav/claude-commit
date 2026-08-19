import { runGit } from "./gitExec";

export interface CommitFileStats {
  added: number;
  modified: number;
  deleted: number;
}

export interface CommitSummary {
  hash: string;
  shortHash: string;
  author: string;
  date: string;
  subject: string;
  fileStats: CommitFileStats;
}

export interface ChangedFile {
  status: string;
  path: string;
  oldPath?: string;
}

export interface CommitDetail {
  hash: string;
  body: string;
  statSummary: string;
  files: ChangedFile[];
}

// Record/field separators unlikely to appear in commit metadata, so a
// single `git log` call can be split back into structured rows cheaply.
const RECORD_SEP = "\x1e";
const FIELD_SEP = "\x1f";

export interface BranchList {
  branches: string[];
  current: string;
}

// Local branches plus remote-tracking branches (so a branch someone else
// pushed but you haven't checked out locally still shows up), deduplicated,
// with `origin/HEAD`-style alias entries dropped.
export async function listBranches(cwd: string): Promise<BranchList> {
  try {
    const [localOut, remoteOut, currentOut] = await Promise.all([
      runGit(cwd, ["branch", "--format=%(refname:short)"]),
      runGit(cwd, ["branch", "-r", "--format=%(refname:short)"]).catch(() => ""),
      runGit(cwd, ["branch", "--show-current"]),
    ]);
    const local = localOut.split("\n").map((s) => s.trim()).filter(Boolean);
    const remote = remoteOut
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean)
      .filter((b) => !b.endsWith("/HEAD"));
    const branches = Array.from(new Set([...local, ...remote]));
    return { branches, current: currentOut.trim() };
  } catch {
    return { branches: [], current: "" };
  }
}

// Distinct author names for the given branch (current branch if omitted),
// so the History tab's author filter can offer real suggestions instead of
// being pure free-text.
export async function listAuthors(cwd: string, branch?: string): Promise<string[]> {
  const args = ["log"];
  if (branch) {
    args.push(branch);
  }
  args.push("--pretty=%an");
  try {
    const out = await runGit(cwd, args);
    const names = out
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    return Array.from(new Set(names)).sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

export interface ListCommitsOptions {
  skip?: number;
  limit?: number;
  grep?: string;
  branch?: string;
  author?: string;
  since?: string;
  until?: string;
}

// The filter portion (branch/date/author/message) shared between the main
// listing query and the separate file-stats query below, so both stay in
// sync without duplicating the flag logic.
function buildFilterArgs(options: ListCommitsOptions): string[] {
  const { skip = 0, limit = 50, grep, branch, author, since, until } = options;
  const args = ["log"];
  if (branch) {
    args.push(branch);
  }
  args.push(`--skip=${skip}`, `--max-count=${limit + 1}`);
  if (grep) {
    args.push(`--grep=${grep}`);
  }
  if (author) {
    args.push(`--author=${author}`);
  }
  if (grep || author) {
    args.push("-i");
  }
  if (since) {
    args.push(`--since=${since}`);
  }
  if (until) {
    // A bare date is parsed as that day's midnight, which would exclude the
    // day itself - push to the end of it so "until <date>" reads as
    // inclusive, matching what a date-range picker implies.
    args.push(`--until=${until}T23:59:59`);
  }
  return args;
}

const EMPTY_STATS: CommitFileStats = { added: 0, modified: 0, deleted: 0 };

export async function listCommits(
  cwd: string,
  options: ListCommitsOptions = {}
): Promise<{ commits: CommitSummary[]; hasMore: boolean }> {
  const { skip = 0, limit = 50, grep, branch } = options;
  const filterArgs = buildFilterArgs(options);
  const args = [
    ...filterArgs,
    `--pretty=format:%H${FIELD_SEP}%h${FIELD_SEP}%an${FIELD_SEP}%ad${FIELD_SEP}%s${RECORD_SEP}`,
    "--date=short",
  ];

  let commits: Omit<CommitSummary, "fileStats">[] = [];
  let hasMore = false;
  try {
    const out = await runGit(cwd, args);
    const records = out
      .split(RECORD_SEP)
      .map((record) => record.trim())
      .filter(Boolean);
    hasMore = records.length > limit;
    commits = records.slice(0, limit).map((record) => {
      const [hash, shortHash, author, date, subject] = record.split(FIELD_SEP);
      return { hash, shortHash, author, date, subject };
    });
  } catch {
    // No commits yet, or not inside a git repo with any history.
  }

  // The search box also doubles as a commit-hash lookup: if the term looks
  // like a (possibly abbreviated) hash, resolve it directly and splice it
  // into the first page, since `--grep` only ever matches message text.
  let hashMatch: Omit<CommitSummary, "fileStats"> | undefined;
  const term = grep?.trim();
  if (term && skip === 0 && HASH_LIKE.test(term)) {
    const resolved = await tryResolveCommit(cwd, term);
    if (resolved && !commits.some((c) => c.hash === resolved.hash)) {
      const inScope = branch ? await isAncestorOf(cwd, resolved.hash, branch) : true;
      if (inScope) {
        hashMatch = resolved;
      }
    }
  }

  const statsMap = await fetchFileStats(cwd, filterArgs);
  let withStats: CommitSummary[] = commits.map((c) => ({
    ...c,
    fileStats: statsMap.get(c.hash) ?? EMPTY_STATS,
  }));

  if (hashMatch) {
    const detail = await getCommitDetail(cwd, hashMatch.hash);
    withStats = [{ ...hashMatch, fileStats: tallyChangedFiles(detail.files) }, ...withStats].slice(0, limit);
  }

  return { commits: withStats, hasMore };
}

// Runs the same filters as the main listing query but with `--name-status`
// instead of the multi-field pretty format, since combining a custom
// %-format with --name-status in one call interleaves the two per commit in
// a way that's fragile to parse. A bare `%H` line reliably marks the start
// of each commit's file list (a status line is never a 40/64-char hex
// string), so the two can be told apart line by line.
async function fetchFileStats(cwd: string, filterArgs: string[]): Promise<Map<string, CommitFileStats>> {
  const args = [...filterArgs, "--pretty=format:%H", "--name-status"];
  let out: string;
  try {
    out = await runGit(cwd, args);
  } catch {
    return new Map();
  }

  const rawByHash = new Map<string, string[]>();
  let currentHash: string | undefined;
  out.split("\n").forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }
    if (HASH_LINE.test(trimmed)) {
      currentHash = trimmed;
      rawByHash.set(currentHash, []);
      return;
    }
    if (currentHash) {
      rawByHash.get(currentHash)!.push(trimmed);
    }
  });

  const stats = new Map<string, CommitFileStats>();
  rawByHash.forEach((lines, hash) => {
    stats.set(hash, tallyChangedFiles(parseNameStatus(lines.join("\n"))));
  });
  return stats;
}

function tallyChangedFiles(files: ChangedFile[]): CommitFileStats {
  const stats: CommitFileStats = { added: 0, modified: 0, deleted: 0 };
  files.forEach((file) => {
    if (file.status.startsWith("A")) {
      stats.added++;
    } else if (file.status.startsWith("D")) {
      stats.deleted++;
    } else {
      // M, R* (rename), C* (copy), T (type-change) all count as "modified".
      stats.modified++;
    }
  });
  return stats;
}

const HASH_LINE = /^[0-9a-f]{40,64}$/;

const HASH_LIKE = /^[0-9a-fA-F]{4,64}$/;

async function tryResolveCommit(
  cwd: string,
  ref: string
): Promise<Omit<CommitSummary, "fileStats"> | undefined> {
  try {
    const out = await runGit(cwd, [
      "log",
      "-1",
      ref,
      `--pretty=format:%H${FIELD_SEP}%h${FIELD_SEP}%an${FIELD_SEP}%ad${FIELD_SEP}%s`,
      "--date=short",
    ]);
    const trimmed = out.trim();
    if (!trimmed) {
      return undefined;
    }
    const [hash, shortHash, author, date, subject] = trimmed.split(FIELD_SEP);
    return { hash, shortHash, author, date, subject };
  } catch {
    return undefined;
  }
}

async function isAncestorOf(cwd: string, hash: string, branch: string): Promise<boolean> {
  try {
    await runGit(cwd, ["merge-base", "--is-ancestor", hash, branch]);
    return true;
  } catch {
    return false;
  }
}

export async function getCommitDetail(cwd: string, hash: string): Promise<CommitDetail> {
  const [body, statSummary, nameStatus] = await Promise.all([
    runGit(cwd, ["show", "--format=%B", "--no-patch", hash]),
    runGit(cwd, ["show", "--format=", "--stat", hash]),
    runGit(cwd, ["show", "--format=", "--name-status", hash]),
  ]);

  return {
    hash,
    body: body.trim(),
    statSummary: statSummary.trim(),
    files: parseNameStatus(nameStatus),
  };
}

// Returns "" when the file didn't exist at that revision (e.g. it was added
// or deleted by the commit) - the diff viewer treats that as an empty side.
export async function getFileAtRevision(
  cwd: string,
  hash: string,
  path: string
): Promise<string> {
  try {
    return await runGit(cwd, ["show", `${hash}:${path}`]);
  } catch {
    return "";
  }
}

function parseNameStatus(raw: string): ChangedFile[] {
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split("\t");
      if (parts.length >= 3) {
        return { status: parts[0], oldPath: parts[1], path: parts[2] };
      }
      return { status: parts[0], path: parts[1] };
    });
}
