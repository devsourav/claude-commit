import * as fs from "fs/promises";
import * as path from "path";
import { runGit } from "./gitExec";
import { findSecret } from "./safety";

// The team memory pool lives *inside the repo* under `.claude-pool/`, so
// repo access is the access control, git is the sync/versioning/review
// layer, and there's no server to run. Every entry is a plain markdown file
// with a small frontmatter header, so it's just as readable to a developer
// browsing the tree, a PR reviewer, or any teammate's local Claude Code
// (which picks the pool up through the `@.claude-pool/index.md` import we
// add to CLAUDE.md).
//
// Layout:
//   .claude-pool/index.md                 generated table of contents
//   .claude-pool/modules/<module>/<slug>.md
//   .claude-pool/sources/<module>/<file>  raw uploads (swagger.json, docs, images)

export const POOL_DIR = ".claude-pool";
export const POOL_INDEX = `${POOL_DIR}/index.md`;
const CLAUDE_MD_IMPORT = `@${POOL_INDEX}`;

export type PoolEntryKind = "note" | "api" | "doc" | "design" | "link";

export interface PoolEntryMeta {
  module: string;
  slug: string;
  title: string;
  kind: PoolEntryKind;
  release: string;
  author: string;
  updated: string;
  sources: string[];
  summary: string;
}

export interface PoolEntry extends PoolEntryMeta {
  body: string;
  // Repo-relative path, e.g. ".claude-pool/modules/auth/login-api.md".
  path: string;
}

export function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug || "entry";
}

function moduleDir(root: string, module: string): string {
  return path.join(root, POOL_DIR, "modules", slugify(module));
}

// Frontmatter is a deliberately tiny subset (one `key: value` per line,
// lists as JSON) so we don't need a YAML dependency and hand-edited files
// still round-trip.
function serialize(meta: PoolEntryMeta, body: string): string {
  const lines = [
    "---",
    `title: ${meta.title.replace(/\n/g, " ")}`,
    `module: ${meta.module}`,
    `kind: ${meta.kind}`,
    `release: ${meta.release}`,
    `author: ${meta.author}`,
    `updated: ${meta.updated}`,
    `sources: ${JSON.stringify(meta.sources)}`,
    `summary: ${meta.summary.replace(/\n/g, " ")}`,
    "---",
    "",
  ];
  return lines.join("\n") + body.trim() + "\n";
}

function parse(raw: string, fallback: { module: string; slug: string }): { meta: PoolEntryMeta; body: string } {
  const fields: Record<string, string> = {};
  let body = raw;
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?/);
  if (match) {
    for (const line of match[1].split("\n")) {
      const sep = line.indexOf(":");
      if (sep > 0) {
        fields[line.slice(0, sep).trim()] = line.slice(sep + 1).trim();
      }
    }
    body = raw.slice(match[0].length);
  }
  let sources: string[] = [];
  try {
    const parsed = JSON.parse(fields.sources ?? "[]");
    sources = Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    sources = [];
  }
  const firstHeading = body.match(/^#\s+(.+)$/m)?.[1];
  return {
    meta: {
      module: fields.module || fallback.module,
      slug: fallback.slug,
      title: fields.title || firstHeading || fallback.slug,
      kind: (fields.kind as PoolEntryKind) || "note",
      release: fields.release || "unreleased",
      author: fields.author || "",
      updated: fields.updated || "",
      sources,
      summary: fields.summary || "",
    },
    body,
  };
}

export async function listEntries(root: string): Promise<PoolEntry[]> {
  const modulesRoot = path.join(root, POOL_DIR, "modules");
  let moduleNames: string[];
  try {
    moduleNames = await fs.readdir(modulesRoot);
  } catch {
    return [];
  }
  const entries: PoolEntry[] = [];
  for (const module of moduleNames) {
    const dir = path.join(modulesRoot, module);
    let files: string[];
    try {
      files = (await fs.readdir(dir)).filter((f) => f.endsWith(".md"));
    } catch {
      continue;
    }
    for (const file of files) {
      const slug = file.slice(0, -3);
      const raw = await fs.readFile(path.join(dir, file), "utf8");
      const { meta, body } = parse(raw, { module, slug });
      entries.push({ ...meta, body, path: `${POOL_DIR}/modules/${module}/${file}` });
    }
  }
  entries.sort((a, b) => a.module.localeCompare(b.module) || b.updated.localeCompare(a.updated));
  return entries;
}

export interface WriteEntryParams {
  module: string;
  title: string;
  kind: PoolEntryKind;
  release: string;
  author: string;
  sources?: string[];
  summary?: string;
  body: string;
}

// Writes (or overwrites, if module+title slug already exists) an entry and
// regenerates the index. Only the extension calls this - the chat model
// never gets a Write tool, it only proposes text that the user chooses to
// save.
export async function writeEntry(root: string, params: WriteEntryParams): Promise<PoolEntry> {
  // Pool entries are committed and shared with the whole team, so a leaked
  // credential here spreads further than anywhere else.
  const secret = findSecret(`${params.title}\n${params.summary ?? ""}\n${params.body}`);
  if (secret) {
    throw new Error(`This entry contains ${secret}. Remove it before saving - pool entries are shared with everyone who has the repo.`);
  }
  const dir = moduleDir(root, params.module);
  await fs.mkdir(dir, { recursive: true });
  const slug = slugify(params.title);
  const meta: PoolEntryMeta = {
    module: slugify(params.module),
    slug,
    title: params.title.trim(),
    kind: params.kind,
    release: params.release.trim() || "unreleased",
    author: params.author,
    updated: new Date().toISOString(),
    sources: params.sources ?? [],
    summary: (params.summary ?? deriveSummary(params.body)).slice(0, 200),
  };
  await fs.writeFile(path.join(dir, `${slug}.md`), serialize(meta, params.body), "utf8");
  await rebuildIndex(root);
  return {
    ...meta,
    body: params.body,
    path: `${POOL_DIR}/modules/${meta.module}/${slug}.md`,
  };
}

export async function deleteEntry(root: string, entryPath: string): Promise<void> {
  const abs = resolveInsidePool(root, entryPath);
  await fs.rm(abs, { force: true });
  await rebuildIndex(root);
}

// Copies an uploaded file into sources/<module>/ and returns its
// repo-relative path, so entries can link back to the original artifact.
export async function storeSource(root: string, module: string, srcPath: string): Promise<string> {
  // Same check for raw uploads: Swagger examples and docs often carry real
  // tokens. Binary files (PDF, images) can't be scanned meaningfully.
  if (/\.(json|ya?ml|md|txt|csv|html?)$/i.test(srcPath)) {
    const secret = findSecret(await fs.readFile(srcPath, "utf8"));
    if (secret) {
      throw new Error(`${path.basename(srcPath)} contains ${secret}. Redact it before adding it to the pool.`);
    }
  }
  const dir = path.join(root, POOL_DIR, "sources", slugify(module));
  await fs.mkdir(dir, { recursive: true });
  const name = path.basename(srcPath);
  await fs.copyFile(srcPath, path.join(dir, name));
  return `${POOL_DIR}/sources/${slugify(module)}/${name}`;
}

export function resolveInsidePool(root: string, relPath: string): string {
  const poolRoot = path.resolve(root, POOL_DIR);
  const abs = path.resolve(root, relPath);
  if (abs !== poolRoot && !abs.startsWith(poolRoot + path.sep)) {
    throw new Error(`${relPath} is outside ${POOL_DIR}/.`);
  }
  return abs;
}

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max - 3).trimEnd() + "..." : text;
}

function deriveSummary(body: string): string {
  const line = body
    .split("\n")
    .filter((l) => !l.startsWith("#"))
    .map((l) => l.replace(/^[>*\-\s]+/, "").trim())
    .find((l) => l.length > 0);
  return line ?? "";
}

// The index is what every teammate's Claude Code loads (via CLAUDE.md), so
// it stays small: one line per entry with its summary and path. Claude
// reads the full entry on demand with its Read tool, which keeps the pool
// from eating the context window as it grows.
export async function rebuildIndex(root: string): Promise<void> {
  const entries = await listEntries(root);
  const byModule = new Map<string, PoolEntry[]>();
  for (const entry of entries) {
    const list = byModule.get(entry.module) ?? [];
    list.push(entry);
    byModule.set(entry.module, list);
  }
  const lines = [
    "# Team memory pool",
    "",
    "<!-- Generated by the Claude Commit extension. Edit entries under modules/, not this file. -->",
    "",
    "Shared, repo-scoped knowledge contributed by the team: API contracts, design specs,",
    "decisions and handoff notes, grouped by module. Before working on a module, read",
    "its entries below (they are the source of truth over memory from earlier sessions).",
    "When an entry and the code disagree, trust the code and mention the drift.",
    "",
  ];
  if (byModule.size === 0) {
    lines.push("_No entries yet._");
  }
  for (const [module, list] of [...byModule.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`## ${module}`, "");
    for (const entry of list) {
      // Summaries are capped here because index.md is loaded into every
      // teammate's Claude Code context on every turn.
      const summary = entry.summary ? ` - ${truncate(entry.summary, 100)}` : "";
      lines.push(
        `- [${entry.title}](modules/${entry.module}/${entry.slug}.md) \`${entry.kind}\` \`${entry.release}\`${summary}`
      );
    }
    lines.push("");
  }
  await fs.mkdir(path.join(root, POOL_DIR), { recursive: true });
  await fs.writeFile(path.join(root, POOL_INDEX), lines.join("\n"), "utf8");
}

export async function isLinkedFromClaudeMd(root: string): Promise<boolean> {
  try {
    const content = await fs.readFile(path.join(root, "CLAUDE.md"), "utf8");
    return content.includes(CLAUDE_MD_IMPORT);
  } catch {
    return false;
  }
}

// Appends the import line so every teammate's Claude Code session (CLI,
// IDE panel, anything that reads CLAUDE.md) loads the pool index
// automatically - that's what turns this from "a folder of notes" into
// shared memory.
export async function linkFromClaudeMd(root: string): Promise<void> {
  if (await isLinkedFromClaudeMd(root)) {
    return;
  }
  const file = path.join(root, "CLAUDE.md");
  let existing = "";
  try {
    existing = await fs.readFile(file, "utf8");
  } catch {
    existing = "";
  }
  const block = [
    "",
    "## Team memory pool",
    "",
    "Shared module notes, API contracts and design specs contributed by the team:",
    CLAUDE_MD_IMPORT,
    "",
  ].join("\n");
  await fs.writeFile(file, existing.replace(/\s*$/, "\n") + block, "utf8");
}

export async function currentAuthor(root: string): Promise<string> {
  return (await runGit(root, ["config", "user.name"]).catch(() => "")).trim();
}

// Default release tag for new entries: the nearest git tag, so entries are
// naturally grouped by what shipped together. Users can override per entry.
export async function currentRelease(root: string): Promise<string> {
  const tag = (await runGit(root, ["describe", "--tags", "--abbrev=0"]).catch(() => "")).trim();
  return tag || "unreleased";
}
