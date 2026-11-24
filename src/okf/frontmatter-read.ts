/**
 * Reader for exactly the frontmatter subset `frontmatter.ts` writes.
 *
 * The plugin has no YAML dependency, so pages are parsed with this deliberately
 * narrow reader: `key: scalar`, `key: "quoted"`, and `key: [a, b]`. Unknown
 * lines are skipped instead of failing the whole page, because an agent may
 * author extra metadata the plugin does not need.
 */

export type ParsedFields = Readonly<Record<string, string | readonly string[]>>;

export interface ParsedFrontmatter {
  readonly fields: ParsedFields;
  readonly body: string;
}

const PLAIN_KEY = /^[A-Za-z_][A-Za-z0-9_-]*$/u;
const NULL_SCALAR = /^(?:null|~)$/iu;

function isDelimiter(line: string): boolean {
  return line.trimEnd() === "---";
}

function findUnquoted(text: string, stop: (source: string, index: number) => boolean): number {
  let quote: '"' | "'" | undefined;
  for (let index = 0; index < text.length; index += 1) {
    const character = text.charAt(index);
    if (quote === '"') {
      if (character === "\\") index += 1;
      else if (character === '"') quote = undefined;
      continue;
    }
    if (quote === "'") {
      if (character !== "'") continue;
      if (text.charAt(index + 1) === "'") index += 1;
      else quote = undefined;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (stop(text, index)) return index;
  }
  return -1;
}

function findKeySeparator(text: string): number {
  return findUnquoted(text, (source, index) => {
    if (source.charAt(index) !== ":") return false;
    const next = source.charAt(index + 1);
    return next === "" || next === " " || next === "\t";
  });
}

/** Drop an unquoted trailing `# comment`, which YAML treats as a comment. */
function stripComment(value: string): string {
  const index = findUnquoted(value, (source, cursor) => {
    if (source.charAt(cursor) !== "#") return false;
    const previous = source.charAt(cursor - 1);
    return cursor === 0 || previous === " " || previous === "\t";
  });
  return index === -1 ? value : value.slice(0, index).trimEnd();
}

function unquote(raw: string): string | undefined {
  if (!raw.startsWith('"')) return undefined;
  let out = "";
  for (let index = 1; index < raw.length; index += 1) {
    const character = raw.charAt(index);
    if (character === '"') return index === raw.length - 1 ? out : undefined;
    if (character !== "\\") {
      out += character;
      continue;
    }
    const escape = raw.charAt(index + 1);
    if (escape === "") return undefined;
    index += 1;
    if (escape === "n") out += "\n";
    else if (escape === "t") out += "\t";
    else if (escape === "r") out += "\r";
    else if (escape === "u") {
      const hex = raw.slice(index + 1, index + 5);
      if (!/^[0-9a-fA-F]{4}$/u.test(hex)) return undefined;
      out += String.fromCharCode(Number.parseInt(hex, 16));
      index += 4;
    } else out += escape;
  }
  return undefined;
}

function parseArray(raw: string): readonly string[] | undefined {
  const inner = raw.slice(1, -1);
  const items: string[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;
  for (let index = 0; index < inner.length; index += 1) {
    const character = inner.charAt(index);
    if (quote === '"') {
      current += character;
      if (character === "\\") {
        current += inner.charAt(index + 1);
        index += 1;
      } else if (character === '"') quote = undefined;
      continue;
    }
    if (quote === "'") {
      current += character;
      if (character !== "'") continue;
      if (inner.charAt(index + 1) === "'") {
        current += "'";
        index += 1;
      } else quote = undefined;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      current += character;
      continue;
    }
    if (character === ",") {
      items.push(current);
      current = "";
      continue;
    }
    current += character;
  }
  if (quote !== undefined) return undefined;
  items.push(current);
  const parsed: string[] = [];
  for (const item of items) {
    const trimmed = item.trim();
    if (trimmed === "") continue;
    const value = parseScalar(trimmed);
    if (typeof value !== "string") return undefined;
    parsed.push(value);
  }
  return parsed;
}

function parseScalar(raw: string): string | readonly string[] | undefined {
  if (raw.startsWith('"')) return unquote(raw);
  if (raw.startsWith("'") && raw.endsWith("'") && raw.length >= 2) {
    return raw.slice(1, -1).replace(/''/gu, "'");
  }
  if (raw.startsWith("[")) return raw.endsWith("]") ? parseArray(raw) : undefined;
  if (NULL_SCALAR.test(raw)) return undefined;
  return raw === "" ? undefined : raw;
}

function parseFieldLine(line: string): { key: string; value: string | readonly string[] } | undefined {
  const trimmed = line.trim();
  if (trimmed === "" || trimmed.startsWith("#") || isDelimiter(trimmed)) return undefined;
  const separator = findKeySeparator(trimmed);
  if (separator <= 0) return undefined;
  const rawKey = trimmed.slice(0, separator).trim();
  const quoted = rawKey.startsWith('"') || rawKey.startsWith("'");
  const key = quoted ? parseScalar(rawKey) : PLAIN_KEY.test(rawKey) ? rawKey : undefined;
  if (typeof key !== "string" || key === "") return undefined;
  const rawValue = stripComment(trimmed.slice(separator + 1)).trim();
  if (rawValue === "") return undefined;
  const value = parseScalar(rawValue);
  return value === undefined ? undefined : { key, value };
}

/**
 * Parse a page into frontmatter fields and body.
 *
 * Without a complete `---` block the whole source is the body, which keeps
 * hand-written pages usable. Line endings are normalised to LF and the single
 * terminating newline is dropped, so `parse(renderDocument(fields, body))`
 * returns the original body.
 */
export function parseFrontmatter(source: string): ParsedFrontmatter {
  const normalized = source.replace(/\r\n/gu, "\n").replace(/\r/gu, "\n");
  const text = normalized.startsWith("\uFEFF") ? normalized.slice(1) : normalized;
  const lines = text.split("\n");
  if (!isDelimiter(lines[0] ?? "")) return { fields: {}, body: source };
  let closing = -1;
  for (let index = 1; index < lines.length; index += 1) {
    if (isDelimiter(lines[index] ?? "")) {
      closing = index;
      break;
    }
  }
  if (closing === -1) return { fields: {}, body: source };
  const entries = new Map<string, string | readonly string[]>();
  for (let index = 1; index < closing; index += 1) {
    const parsed = parseFieldLine(lines[index] ?? "");
    if (parsed !== undefined) entries.set(parsed.key, parsed.value);
  }
  const body = lines.slice(closing + 1).join("\n").replace(/^\n/u, "").replace(/\n$/u, "");
  return { fields: Object.fromEntries(entries), body };
}
