import { LEAN_ARGS, runClaude, toolsArg } from "./claudeRunner";

// Turns raw sources (Swagger/OpenAPI specs, doc files, links, Figma frames)
// into pool entry bodies. The model only ever *returns text* here; the
// extension decides where it's written (see pool.ts writeEntry).

// ---- OpenAPI / Swagger -----------------------------------------------------

type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any

const HTTP_METHODS = ["get", "post", "put", "patch", "delete", "head", "options"];

// Deterministic (no model call): a spec is already structured, so we
// render it to compact markdown ourselves. That's cheaper, can't
// hallucinate a field, and diffs cleanly in git when the backend team
// re-uploads a new version of the spec.
export function summarizeOpenApi(raw: string): { title: string; summary: string; body: string } {
  let spec: Json;
  try {
    spec = JSON.parse(raw);
  } catch {
    throw new Error("That file isn't valid JSON (YAML specs aren't supported yet - export as JSON).");
  }
  const isV3 = typeof spec.openapi === "string";
  if (!isV3 && spec.swagger === undefined) {
    throw new Error("That JSON doesn't look like an OpenAPI/Swagger spec (no `openapi` or `swagger` field).");
  }

  const title = String(spec.info?.title ?? "API");
  const version = String(spec.info?.version ?? "");
  const lines: string[] = [`# ${title}${version ? ` (v${version})` : ""}`, ""];
  if (spec.info?.description) {
    lines.push(String(spec.info.description).trim(), "");
  }

  const servers: string[] = isV3
    ? (spec.servers ?? []).map((s: Json) => String(s.url))
    : spec.host
      ? [`${(spec.schemes ?? ["https"])[0]}://${spec.host}${spec.basePath ?? ""}`]
      : [];
  if (servers.length) {
    lines.push("**Servers:** " + servers.map((s) => `\`${s}\``).join(", "), "");
  }

  let endpointCount = 0;
  const byTag = new Map<string, string[]>();
  for (const [route, item] of Object.entries<Json>(spec.paths ?? {})) {
    const sharedParams: Json[] = item.parameters ?? [];
    for (const method of HTTP_METHODS) {
      const op = item[method];
      if (!op) {
        continue;
      }
      endpointCount++;
      const tag = String(op.tags?.[0] ?? "default");
      const block: string[] = [];
      block.push(`#### \`${method.toUpperCase()} ${route}\`${op.summary ? ` - ${op.summary}` : ""}`);
      if (op.description && op.description !== op.summary) {
        block.push(String(op.description).trim());
      }
      const params = [...sharedParams, ...(op.parameters ?? [])]
        .map((p: Json) => resolveRef(spec, p))
        .filter((p: Json) => p && p.in !== "body");
      if (params.length) {
        block.push(
          "Params: " +
            params
              .map((p: Json) => `\`${p.name}\` (${p.in}${p.required ? ", required" : ""}${schemaLabel(spec, p.schema ?? p)})`)
              .join(", ")
        );
      }
      const body = isV3
        ? op.requestBody && resolveRef(spec, op.requestBody)?.content
        : (op.parameters ?? []).find((p: Json) => p.in === "body");
      if (body) {
        const schema = isV3 ? firstContentSchema(body) : body.schema;
        if (schema) {
          block.push(`Body: ${schemaLabel(spec, schema).replace(/^, /, "")}`);
        }
      }
      const responses = Object.entries<Json>(op.responses ?? {}).map(([code, res]) => {
        const resolved = resolveRef(spec, res) ?? {};
        const schema = isV3 ? firstContentSchema(resolved.content) : resolved.schema;
        return `\`${code}\`${schema ? schemaLabel(spec, schema).replace(/^, /, " ") : ""}`;
      });
      if (responses.length) {
        block.push(`Responses: ${responses.join(", ")}`);
      }
      if (op.security?.length === 0) {
        block.push("Auth: none");
      }
      const list = byTag.get(tag) ?? [];
      list.push(block.join("  \n"));
      byTag.set(tag, list);
    }
  }

  lines.push("## Endpoints", "");
  for (const [tag, blocks] of byTag) {
    lines.push(`### ${tag}`, "", blocks.join("\n\n"), "");
  }

  const schemas: Record<string, Json> = isV3 ? spec.components?.schemas ?? {} : spec.definitions ?? {};
  const schemaNames = Object.keys(schemas);
  if (schemaNames.length) {
    lines.push("## Schemas", "");
    for (const name of schemaNames) {
      const s = schemas[name];
      const required = new Set<string>(s.required ?? []);
      const props = Object.entries<Json>(s.properties ?? {}).map(
        ([prop, ps]) => `\`${prop}${required.has(prop) ? "" : "?"}\`: ${typeLabel(ps)}`
      );
      const enumNote = s.enum ? ` enum: ${s.enum.map((v: Json) => JSON.stringify(v)).join(" | ")}` : "";
      lines.push(`- **${name}**${props.length ? " { " + props.join(", ") + " }" : ` ${typeLabel(s)}`}${enumNote}`);
    }
    lines.push("");
  }

  return {
    title: `${title} API${version ? ` v${version}` : ""}`,
    summary: `${endpointCount} endpoints, ${schemaNames.length} schemas${servers[0] ? ` @ ${servers[0]}` : ""}`,
    body: lines.join("\n"),
  };
}

function resolveRef(spec: Json, node: Json): Json {
  if (!node || typeof node.$ref !== "string") {
    return node;
  }
  const parts = node.$ref.replace(/^#\//, "").split("/");
  let cur: Json = spec;
  for (const part of parts) {
    cur = cur?.[part.replace(/~1/g, "/").replace(/~0/g, "~")];
  }
  return cur;
}

function refName(ref: string): string {
  return ref.split("/").pop() ?? ref;
}

function typeLabel(schema: Json): string {
  if (!schema) {
    return "any";
  }
  if (schema.$ref) {
    return refName(schema.$ref);
  }
  if (schema.type === "array") {
    return `${typeLabel(schema.items)}[]`;
  }
  if (schema.oneOf || schema.anyOf) {
    return (schema.oneOf ?? schema.anyOf).map(typeLabel).join(" | ");
  }
  if (schema.allOf) {
    return schema.allOf.map(typeLabel).join(" & ");
  }
  const base = String(schema.type ?? "object");
  return schema.format ? `${base}<${schema.format}>` : base;
}

function schemaLabel(_spec: Json, schema: Json): string {
  return `, ${typeLabel(schema)}`;
}

function firstContentSchema(content: Json): Json {
  if (!content) {
    return undefined;
  }
  const json = content["application/json"] ?? Object.values<Json>(content)[0];
  return json?.schema;
}

// ---- Model-assisted ingestion ---------------------------------------------

export interface IngestOptions {
  cliPath: string;
  cwd: string;
  model?: string;
  timeoutMs: number;
}

const ENTRY_FORMAT = `
Write the result as a markdown document for a shared team knowledge base that
other developers' Claude Code sessions will read later to build this feature.
Start with a single "# <title>" line, then a one-sentence summary paragraph.
Be concrete and complete: exact field names, endpoints, states, copy text,
colors/spacing tokens, edge cases. No preamble, no closing remarks, no
mention of these instructions. Output only the markdown.`;

// Doc files (md/txt/pdf/etc.): Claude reads them with its own Read tool
// (which also handles PDFs and images), restricted to Read so this can't
// do anything else.
export async function summarizeDocuments(
  opts: IngestOptions,
  filePaths: string[],
  focus: string
): Promise<string> {
  const prompt = [
    `Read these files and distill what a developer needs to implement or integrate with what they describe:`,
    ...filePaths.map((p) => `- ${p}`),
    focus ? `\nFocus on: ${focus}` : "",
    ENTRY_FORMAT,
  ].join("\n");
  return ingest(opts, prompt, { builtin: ["Read"], allowed: ["Read"] }, filePaths);
}

// Claude share links and other URLs. Note: some pages (claude.ai shares
// included) render client-side and may come back empty to WebFetch - the
// prompt asks Claude to say so rather than invent content.
export async function summarizeLinks(opts: IngestOptions, urls: string[], focus: string): Promise<string> {
  const prompt = [
    `Fetch each of these links and extract the technical details a developer needs (decisions, API contracts, requirements, code snippets):`,
    ...urls.map((u) => `- ${u}`),
    focus ? `\nFocus on: ${focus}` : "",
    `If a page can't be fetched or is empty, include a line "> Could not read <url>" instead of guessing its content.`,
    ENTRY_FORMAT,
  ].join("\n");
  return ingest(opts, prompt, { builtin: ["WebFetch"], allowed: ["WebFetch"] });
}

// Figma frames via the Figma MCP server (claude.ai Figma connector or the
// local Dev Mode server). Only its *read* tools are allowed - newer Figma
// MCP servers also expose write tools, which we never want to trigger
// from an ingestion run.
export async function summarizeFigma(
  opts: IngestOptions,
  figmaUrls: string[],
  focus: string,
  figmaTools: string[]
): Promise<string> {
  const prompt = [
    `Use the Figma MCP tools to inspect these Figma frames:`,
    ...figmaUrls.map((u) => `- ${u}`),
    focus ? `\nFocus on: ${focus}` : "",
    `Produce an implementation spec for frontend developers: layout and component hierarchy,`,
    `every text string, design tokens (colors, typography, spacing, radii) with exact values,`,
    `interactive states and variants, responsive behaviour, and assets. Include the Figma link`,
    `and node id for each frame so teammates can re-open it.`,
    `If the Figma tools are unavailable or need authentication, reply with exactly one line`,
    `starting with "FIGMA_UNAVAILABLE:" followed by the reason.`,
    ENTRY_FORMAT,
  ].join("\n");
  // MCP tools are deferred behind ToolSearch, so that's the one built-in
  // tool kept; MCP servers must stay enabled here (no LEAN_ARGS).
  const text = await ingest(opts, prompt, { builtin: ["ToolSearch"], allowed: figmaTools, needsMcp: true });
  if (text.startsWith("FIGMA_UNAVAILABLE:")) {
    throw new Error(
      `${text.slice("FIGMA_UNAVAILABLE:".length).trim()} - connect Figma in your claude.ai connector settings (or run \`claude mcp\`), then try again.`
    );
  }
  return text;
}

interface IngestTools {
  builtin: string[];
  allowed: string[];
  needsMcp?: boolean;
}

async function ingest(opts: IngestOptions, prompt: string, tools: IngestTools, addDirs: string[] = []): Promise<string> {
  const args = [
    "-p",
    prompt,
    "--output-format",
    "json",
    ...toolsArg(tools.builtin),
    ...(tools.needsMcp ? ["--disable-slash-commands"] : LEAN_ARGS),
    "--allowedTools",
    ...tools.allowed,
  ];
  // Uploaded docs may live outside the repo (e.g. ~/Downloads); --add-dir
  // lets the Read tool reach them without widening anything else.
  const outside = [...new Set(addDirs.map((p) => p.replace(/\/[^/]*$/, "")))].filter(
    (dir) => dir && !dir.startsWith(opts.cwd)
  );
  if (outside.length) {
    args.push("--add-dir", ...outside);
  }
  if (opts.model) {
    args.push("--model", opts.model);
  }
  const result = await runClaude({ cliPath: opts.cliPath, args, cwd: opts.cwd, stdin: "", timeoutMs: opts.timeoutMs });
  if (result.timedOut) {
    throw new Error(`Claude timed out after ${Math.round(opts.timeoutMs / 1000)}s.`);
  }
  if (result.code !== 0) {
    const detail = result.stderr.split("\n").slice(0, 3).join("\n").trim();
    throw new Error(`Claude Code CLI exited with code ${result.code}.${detail ? ` ${detail}` : ""}`);
  }
  let parsed: { result?: string; is_error?: boolean };
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new Error("Couldn't parse Claude's response.");
  }
  if (parsed.is_error || !parsed.result) {
    throw new Error(parsed.result || "Claude returned an error.");
  }
  return parsed.result.trim();
}

// Pulls "# Title" and the first paragraph out of a model-written entry so
// the form fields can be prefilled.
export function splitTitle(markdown: string): { title?: string; summary?: string } {
  const title = markdown.match(/^#\s+(.+)$/m)?.[1]?.trim();
  const afterTitle = markdown.replace(/^#\s+.+$/m, "").trim();
  const summary = afterTitle.split(/\n\s*\n/)[0]?.replace(/\s+/g, " ").trim();
  return { title, summary };
}
