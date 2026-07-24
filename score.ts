/**
 * Scoring = parse + normalized deep-equal against the reference value. Object keys are order-insensitive,
 * arrays ordered. Two verdicts per case (task / strict) — see scoreConvert.
 */
import YAML from "yaml";

export type Format = "convert";

export function deepEqual(a: any, b: any): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  const ka = Object.keys(a), kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => k in b && deepEqual(a[k], b[k])); // key-order-insensitive
}

const stripThink = (s: string) => s.replace(/<think>[\s\S]*?<\/think>/gi, "");

/** First balanced JSON value ({…}/[…]) in text, tolerating surrounding prose/fences. null if none. */
export function extractJson(text: string): string | null {
  const s = stripThink(text);
  for (let start = 0; start < s.length; start++) {
    const open = s[start]; if (open !== "{" && open !== "[") continue;
    const close = open === "{" ? "}" : "]";
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < s.length; i++) {
      const c = s[i];
      if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; }
      else if (c === '"') inStr = true;
      else if (c === open) depth++;
      else if (c === close && --depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

export type ConvTarget = "json" | "yaml" | "csv";

const stripFences = (s: string) => s.trim().replace(/^```[a-zA-Z]*\s*\n?/, "").replace(/\n?```\s*$/, "").trim();
const afterLabel = (s: string) => { const m = [...s.matchAll(/output\s*:/gi)]; return m.length ? s.slice(m[m.length - 1].index! + m[m.length - 1][0].length).trim() : s; };
const fencedBlock = (s: string) => { const m = s.match(/```[a-zA-Z]*\s*\n?([\s\S]*?)```/); return m ? m[1].trim() : null; };
const looksJson = (s: string) => /^[\[{]/.test(s.trim()); // a {/[ opener is JSON, not idiomatic YAML

/** Parse a reply as the given target format. Throws on unparseable / empty. csv → string[][]. */
function parseTarget(t: ConvTarget, s: string): any {
  if (t === "json") return JSON.parse(s);
  if (t === "yaml") { const v = YAML.parse(s); if (v == null) throw new Error("empty yaml"); return v; }
  const rows = parseCsv(s); if (!rows.length) throw new Error("empty csv"); return rows;
}
/** expected is the canonical object for json/yaml, the canonical CSV string for csv. */
const eqTarget = (t: ConvTarget, parsed: any, expected: any) => (t === "csv" ? deepEqual(parsed, parseCsv(String(expected))) : deepEqual(parsed, expected));

/**
 * Convert grading — two axes, for any target format (json | yaml | csv):
 *   task   the correct value appears ANYWHERE (prose/fences tolerated) — did the reformatting work.
 *   strict the WHOLE trimmed reply is exactly that value in the target format — "only the <fmt>, nothing else".
 */
export function scoreConvert(raw: string, expected: any, target: ConvTarget = "json"): { task: boolean; strict: boolean; parses: boolean } {
  const s = stripThink(raw).trim();
  let strict = false;
  try { if (!(target === "yaml" && looksJson(s))) strict = eqTarget(target, parseTarget(target, s), expected); } catch { /* not a clean single value */ }
  const cands = target === "json" ? [extractJson(s), fencedBlock(s), s] : [s, stripFences(s), fencedBlock(s), afterLabel(s), stripFences(afterLabel(s))];
  let task = strict, parses = false;
  for (const c of cands) {
    if (!c) continue;
    try { const p = parseTarget(target, c); parses = true; if (eqTarget(target, p, expected)) { task = true; break; } } catch { /* try next candidate */ }
  }
  return { task, strict, parses };
}

/** Small quote-aware CSV → string[][]. */
// ponytail: handles quoted fields, escaped "", and CRLF; if a case needs unquoted embedded newlines, swap in csv-parse.
export function parseCsv(s: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cur = "", q = false;
  s = s.replace(/\r\n?/g, "\n");
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === '"') { if (s[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true;
    else if (c === ",") { row.push(cur); cur = ""; }
    else if (c === "\n") { row.push(cur); rows.push(row); row = []; cur = ""; }
    else cur += c;
  }
  if (cur !== "" || row.length) { row.push(cur); rows.push(row); }
  while (rows.length && rows[rows.length - 1].every((x) => x.trim() === "")) rows.pop();
  return rows.map((r) => r.map((c) => c.trim()));
}

// ── self-check (bun score.ts) ────────────────────────────────────────────────
if (import.meta.main) {
  const assert = (c: boolean, m: string) => { if (!c) { console.error("FAIL:", m); process.exit(1); } };
  assert(deepEqual({ a: 1, b: 2 }, { b: 2, a: 1 }), "json key-order-insensitive");
  assert(!deepEqual({ a: 1 }, { a: "1" }), "type-strict: 1 != \"1\"");
  assert(scoreConvert('{"a":1}', { a: 1 }).strict && scoreConvert('{"a":1}', { a: 1 }).task, "convert exact ⇒ task+strict");
  assert(!scoreConvert('here you go: {"a":1}', { a: 1 }).strict && scoreConvert('here you go: {"a":1}', { a: 1 }).task, "convert prose ⇒ task only");
  assert(!scoreConvert('```json\n{"a":1}\n```', { a: 1 }).strict && scoreConvert('```json\n{"a":1}\n```', { a: 1 }).task, "convert fenced ⇒ task only");
  assert(!scoreConvert('{"a":2}', { a: 1 }).task, "convert wrong value ⇒ fail");
  assert(scoreConvert('<think>hmm</think>{"a":1}', { a: 1 }).strict, "convert strips <think>");
  // yaml target
  assert(scoreConvert("a: 1\nb: two", { a: 1, b: "two" }, "yaml").strict, "convert yaml exact ⇒ strict");
  assert(!scoreConvert("```yaml\na: 1\n```", { a: 1 }, "yaml").strict && scoreConvert("```yaml\na: 1\n```", { a: 1 }, "yaml").task, "convert yaml fenced ⇒ task only");
  assert(!scoreConvert('{"a":1}', { a: 1 }, "yaml").strict, "convert yaml: JSON blob is not strict-yaml");
  assert(!scoreConvert("a: 2", { a: 1 }, "yaml").task, "convert yaml wrong value ⇒ fail");
  // csv target (expected = canonical CSV string)
  assert(scoreConvert("a,b\n1,2", "a,b\n1,2\n", "csv").strict, "convert csv exact ⇒ strict");
  assert(!scoreConvert("here:\na,b\n1,2", "a,b\n1,2\n", "csv").strict && scoreConvert("here:\n```\na,b\n1,2\n```", "a,b\n1,2\n", "csv").task, "convert csv fenced/prose ⇒ task only");
  assert(!scoreConvert("a,b\n1,3", "a,b\n1,2\n", "csv").task, "convert csv wrong value ⇒ fail");
  console.log("score.ts self-check: all passed ✓");
}
