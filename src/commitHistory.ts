import { runGit } from "./gitExec";

export interface CommitSummary {
  hash: string;
  shortHash: string;
  author: string;
  date: string;
  subject: string;
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

export async function listCommits(
  cwd: string,
  options: { skip?: number; limit?: number; grep?: string } = {}
): Promise<{ commits: CommitSummary[]; hasMore: boolean }> {
  const { skip = 0, limit = 50, grep } = options;
  const args = [
    "log",
    `--skip=${skip}`,
    `--max-count=${limit + 1}`,
    `--pretty=format:%H${FIELD_SEP}%h${FIELD_SEP}%an${FIELD_SEP}%ad${FIELD_SEP}%s${RECORD_SEP}`,
    "--date=short",
  ];
  if (grep) {
    args.push(`--grep=${grep}`, "-i");
  }

  let out: string;
  try {
    out = await runGit(cwd, args);
  } catch {
    // No commits yet, or not inside a git repo with any history.
    return { commits: [], hasMore: false };
  }

  const records = out
    .split(RECORD_SEP)
    .map((record) => record.trim())
    .filter(Boolean);
  const hasMore = records.length > limit;
  const commits = records.slice(0, limit).map((record) => {
    const [hash, shortHash, author, date, subject] = record.split(FIELD_SEP);
    return { hash, shortHash, author, date, subject };
  });
  return { commits, hasMore };
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
