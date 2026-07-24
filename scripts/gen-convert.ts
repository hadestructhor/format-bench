/**
 * convert-bench dataset generator — the REAL matrix.
 *
 *   domains(8) × directions(9) × levels × challenge-tiers(×0..×all)  →  ~2000 test + ~650 train.
 *
 * Directions: text→{json,csv,yaml} + the 6 format pairs among json/csv/yaml.
 *   - nested directions (no CSV): levels L1–L5 (increasing nesting depth).
 *   - CSV-involved directions: levels L1–L3, tabular (arrays of flat rows — CSV can't nest).
 * Challenges (data transformations the model must apply): type · unit · enum · escape · range · count · wrap,
 *   combined ×0/×1/×2/×3/×all per (direction, level) — the actual level×challenge×combination grid.
 *
 * Each case is built from a small schema of "leaves" that carry BOTH a canonical value and a distorted
 * source value, so the INPUT (source format, challenge-distorted) and the EXPECTED (target format, clean)
 * stay in lockstep. Self-check: every generated `output` scores task+strict perfect, every input parses,
 * every challenge tag is applicable, and train∩test inputs = ∅.
 *
 * Run:  bun scripts/gen-convert.ts
 */
import YAML from "yaml";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../providers.js";
import { scoreConvert, parseCsv, type ConvTarget } from "../score.js";

// ── deterministic RNG (no Math.random → reproducible dataset) ──
const hashStr = (s: string) => { let h = 2166136261 >>> 0; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };
const mulberry32 = (a: number) => () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
type RNG = () => number;
const pick = <T>(a: T[], r: RNG): T => a[Math.floor(r() * a.length)];
const sample = <T>(a: T[], k: number, r: RNG): T[] => { const b = a.slice(); for (let i = b.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [b[i], b[j]] = [b[j], b[i]]; } return b.slice(0, Math.min(k, b.length)); };
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

// ── schema nodes: each leaf holds canon + src (distorted) value ──
type Leaf = { kind: string; canon: any; src: any; unit?: string };
type N = { k: "leaf"; leaf: Leaf } | { k: "obj"; entries: [string, N][] } | { k: "arr"; canonItems: N[]; srcItems: N[] };
type Entry = [string, N];
const nd = (leaf: Leaf): N => ({ k: "leaf", leaf });
const objNode = (entries: Entry[]): N => ({ k: "obj", entries });
function valOf(node: N, w: "canon" | "src"): any {
  if (node.k === "leaf") return node.leaf[w];
  if (node.k === "obj") return Object.fromEntries(node.entries.map(([k, c]) => [k, valOf(c, w)]));
  return (w === "canon" ? node.canonItems : node.srcItems).map((c) => valOf(c, w));
}
// keeps `base` items canonically; the `count` challenge leaves the extras in the source only
const arrNode = (full: N[], base: number, ch: Set<string>, word: string) => {
  const canonItems = full.slice(0, base);
  return { node: { k: "arr", canonItems, srcItems: ch.has("count") ? full : canonItems } as N, count: ch.has("count") ? { n: base, word } : null };
};

// ── leaf constructors (challenge-aware) ──
type CH = Set<string>;
const Ls = (k: string, s: string): Entry => [k, nd({ kind: "str", canon: s, src: s })];
const Lesc = (k: string, plain: string, special: string, ch: CH): Entry => { const v = ch.has("escape") ? special : plain; return [k, nd({ kind: "str", canon: v, src: v })]; };
const Li = (k: string, n: number, ch: CH): Entry => [k, nd({ kind: "int", canon: n, src: ch.has("type") ? String(n) : n })];
const Lb = (k: string, b: boolean, ch: CH): Entry => [k, nd({ kind: "bool", canon: b, src: ch.has("type") ? String(b) : b })];
const Lu = (k: string, n: number, unit: string, ch: CH): Entry => [k, nd({ kind: "unit", canon: n, unit, src: ch.has("unit") ? `${n}${unit}` : ch.has("type") ? String(n) : n })];
const Lm = (k: string, amt: number, ch: CH): Entry => [k, nd({ kind: "money", canon: amt, src: ch.has("unit") ? `$${amt}` : ch.has("type") ? String(amt) : amt })];
const Le = (k: string, e: { c: string; m: string[] }, ch: CH, r: RNG): Entry => [k, nd({ kind: "enum", canon: e.c, src: ch.has("enum") ? pick(e.m, r) : e.c })];
// range: in-range value normally; out-of-range value (→ clamped canon) under the `range` challenge
const Lr = (k: string, inV: number, outV: number, lo: number, hi: number, ch: CH): Entry => { const s0 = ch.has("range") ? outV : inV; return [k, nd({ kind: "num", canon: clamp(s0, lo, hi), src: ch.has("type") ? String(s0) : s0 })]; };

// ── shared vocab pools ──
const DIFF = [{ c: "easy", m: ["Easy", "EASY", "easy "] }, { c: "medium", m: ["Med", "MEDIUM", "Medium"] }, { c: "hard", m: ["Hard", "HARD", "hard "] }];
const STOCK = [{ c: "in_stock", m: ["In Stock", "IN STOCK", "InStock"] }, { c: "out_of_stock", m: ["Out of stock", "OOS", "out-of-stock"] }, { c: "preorder", m: ["Pre-order", "PREORDER", "Preorder"] }];
const ORDST = [{ c: "pending", m: ["Pending", "PENDING", "pending "] }, { c: "paid", m: ["Paid", "PAID", "paid "] }, { c: "shipped", m: ["Shipped", "SHIPPED", "shipped "] }];
const ROLE = [{ c: "admin", m: ["Admin", "ADMIN", "administrator"] }, { c: "member", m: ["Member", "MEMBER", "member "] }, { c: "guest", m: ["Guest", "GUEST", "guest "] }];
const VIS = [{ c: "public", m: ["Public", "PUBLIC", "public "] }, { c: "private", m: ["Private", "PRIVATE", "private "] }];
const SSTATE = [{ c: "ok", m: ["OK", "Ok", "ok "] }, { c: "warn", m: ["Warn", "WARNING", "warning"] }, { c: "critical", m: ["Critical", "CRIT", "CRITICAL"] }];
const MTYPE = [{ c: "movie", m: ["Movie", "MOVIE", "film"] }, { c: "series", m: ["Series", "SERIES", "tv series"] }, { c: "podcast", m: ["Podcast", "PODCAST", "podcast "] }];
const TXST = [{ c: "pending", m: ["Pending", "PENDING", "pending "] }, { c: "cleared", m: ["Cleared", "CLEARED", "clear"] }, { c: "failed", m: ["Failed", "FAILED", "fail"] }];
const ESC = ['say "hi", ok', "line1\nline2", 'quote: "x", y', "a,b,c\nd"];
const NAMES = ["Lentil Soup", "Miso Ramen", "Thai Curry", "Aloo Gobi", "Pesto Pasta", "Beef Stew", "Falafel Bowl", "Shakshuka"];
const PEOPLE = ["Ada", "Niko", "Omar", "Lena", "Priya", "Yuki", "Sam", "Ines", "Diego", "Mara"];
const CITIES = ["Berlin", "Osaka", "Cairo", "Lyon", "Quito", "Oslo", "Accra", "Lima"];
const WORDS = ["alpha", "bravo", "cedar", "delta", "ember", "frost", "grove", "harbor", "ivory", "juno"];

// ── 8 domains ──
type Dom = {
  name: string; env: string; word: string; scalarKey: string; itemsKey: string;
  flatLeaves(r: RNG, ch: CH): Entry[];
  nestedGroup(r: RNG, ch: CH): Entry;
  tags(r: RNG): string[];
  subRecord(r: RNG, ch: CH, i: number): Entry[];
  subGroup(r: RNG, ch: CH): Entry;
};
const DOMAINS: Dom[] = [
  { name: "recipe", env: "recipe", word: "ingredients", scalarKey: "tags", itemsKey: "ingredients",
    flatLeaves: (r, ch) => [Ls("name", pick(NAMES, r)), Lu("prepMinutes", pick([15, 20, 30, 45, 60], r), "min", ch), Li("servings", pick([2, 3, 4, 6], r), ch), Le("difficulty", pick(DIFF, r), ch, r), Lr("rating", pick([3, 4, 5], r), 7, 0, 5, ch), Lb("vegetarian", pick([true, false], r), ch), Lesc("note", "house favorite", pick(ESC, r), ch)],
    nestedGroup: (r, ch) => ["chef", objNode([Ls("name", pick(PEOPLE, r)), Li("years", pick([2, 5, 8, 12], r), ch)])],
    tags: (r) => sample(["vegan", "spicy", "quick", "warm", "gluten-free", "sweet"], 5, r),
    subRecord: (r, ch) => [Ls("item", pick(["onion", "garlic", "lentils", "tomato", "basil"], r)), Lu("grams", pick([50, 100, 200], r), "g", ch), Le("state", pick(DIFF, r), ch, r)],
    subGroup: (r) => ["supplier", objNode([Ls("name", pick(CITIES, r) + " Farm")])] },
  { name: "product", env: "product", word: "variants", scalarKey: "labels", itemsKey: "variants",
    flatLeaves: (r, ch) => [Ls("sku", "SKU-" + Math.floor(r() * 9000 + 1000)), Ls("title", pick(WORDS, r) + " " + pick(["mug", "lamp", "chair", "case"], r)), Lm("price", pick([9, 19, 29, 49], r), ch), Lu("weight", pick([200, 500, 800], r), "g", ch), Le("availability", pick(STOCK, r), ch, r), Lr("rating", pick([3, 4, 5], r), 9, 0, 5, ch), Lb("featured", pick([true, false], r), ch)],
    nestedGroup: (r, ch) => ["dimensions", objNode([Li("w", pick([10, 20, 30], r), ch), Li("h", pick([10, 20, 30], r), ch)])],
    tags: (r) => sample(["new", "sale", "eco", "ltd", "boxed", "gift"], 5, r),
    subRecord: (r, ch) => [Ls("color", pick(["red", "blue", "black", "sand"], r)), Li("stock", pick([0, 5, 12, 40], r), ch), Lm("price", pick([9, 19, 29], r), ch)],
    subGroup: (r) => ["warehouse", objNode([Ls("code", pick(CITIES, r).slice(0, 3).toUpperCase())])] },
  { name: "basket", env: "order", word: "items", scalarKey: "coupons", itemsKey: "items",
    flatLeaves: (r, ch) => [Ls("orderId", "ORD-" + Math.floor(r() * 9000 + 1000)), Ls("customer", pick(PEOPLE, r)), Lm("total", pick([24, 58, 91, 140], r), ch), Le("status", pick(ORDST, r), ch, r), Lr("discountPercent", pick([0, 10, 25], r), 150, 0, 100, ch), Li("itemCount", pick([1, 2, 3, 5], r), ch), Lesc("gift", "no message", pick(ESC, r), ch)],
    nestedGroup: (r, ch) => ["address", objNode([Ls("city", pick(CITIES, r)), Li("zip", pick([1010, 2020, 3030], r), ch)])],
    tags: (r) => sample(["SAVE10", "FREESHIP", "VIP", "BOGO", "SUMMER"], 5, r),
    subRecord: (r, ch) => [Ls("product", pick(WORDS, r)), Li("qty", pick([1, 2, 3], r), ch), Lm("price", pick([5, 12, 20], r), ch)],
    subGroup: (r) => ["seller", objNode([Ls("name", pick(WORDS, r) + " Co")])] },
  { name: "profile", env: "user", word: "sessions", scalarKey: "interests", itemsKey: "sessions",
    flatLeaves: (r, ch) => [Ls("username", pick(PEOPLE, r).toLowerCase() + Math.floor(r() * 90 + 10)), Ls("name", pick(PEOPLE, r)), Li("age", pick([21, 28, 35, 42], r), ch), Le("role", pick(ROLE, r), ch, r), Lr("profilePercent", pick([40, 70, 90], r), 130, 0, 100, ch), Lb("verified", pick([true, false], r), ch), Lu("heightCm", pick([160, 172, 185], r), "cm", ch)],
    nestedGroup: (r, ch) => ["contact", objNode([Ls("city", pick(CITIES, r)), Lb("newsletter", pick([true, false], r), ch)])],
    tags: (r) => sample(["music", "travel", "coding", "art", "sports", "food"], 5, r),
    subRecord: (r, ch) => [Ls("device", pick(["ios", "web", "android"], r)), Lu("minutes", pick([5, 30, 120], r), "min", ch), Lb("active", pick([true, false], r), ch)],
    subGroup: (r) => ["geo", objNode([Ls("country", pick(["DE", "JP", "EG", "FR"], r))])] },
  { name: "event", env: "event", word: "attendees", scalarKey: "topics", itemsKey: "attendees",
    flatLeaves: (r, ch) => [Ls("title", pick(WORDS, r) + " summit"), Ls("date", "2026-0" + pick([3, 5, 7, 9], r) + "-1" + pick([1, 2, 4], r)), Lu("durationMin", pick([30, 60, 90], r), "min", ch), Le("visibility", pick(VIS, r), ch, r), Lr("capacityPercent", pick([25, 60, 95], r), 140, 0, 100, ch), Li("seats", pick([20, 50, 100], r), ch), Lb("online", pick([true, false], r), ch)],
    nestedGroup: (r, ch) => ["venue", objNode([Ls("city", pick(CITIES, r)), Li("room", pick([1, 2, 3], r), ch)])],
    tags: (r) => sample(["ai", "design", "ops", "growth", "research", "hiring"], 5, r),
    subRecord: (r, ch) => [Ls("name", pick(PEOPLE, r)), Le("role", pick(ROLE, r), ch, r), Lb("rsvp", pick([true, false], r), ch)],
    subGroup: (r) => ["org", objNode([Ls("name", pick(WORDS, r) + " Labs")])] },
  { name: "sensor", env: "reading", word: "samples", scalarKey: "flags", itemsKey: "samples",
    flatLeaves: (r, ch) => [Ls("sensorId", "S-" + Math.floor(r() * 900 + 100)), Lu("temperature", pick([16, 21, 28], r), "C", ch), Lr("battery", pick([40, 70, 95], r), 120, 0, 100, ch), Le("state", pick(SSTATE, r), ch, r), Li("readings", pick([12, 60, 144], r), ch), Lb("online", pick([true, false], r), ch), Lu("humidity", pick([30, 45, 60], r), "%", ch)],
    nestedGroup: (r, ch) => ["location", objNode([Ls("site", pick(CITIES, r)), Li("floor", pick([1, 2, 3], r), ch)])],
    tags: (r) => sample(["calibrated", "outdoor", "backup", "leak", "spike"], 5, r),
    subRecord: (r, ch) => [Ls("at", "12:0" + pick([1, 3, 5], r)), Lu("value", pick([18, 22, 26], r), "C", ch), Le("state", pick(SSTATE, r), ch, r)],
    subGroup: (r) => ["unitInfo", objNode([Ls("scale", pick(["celsius", "kelvin"], r))])] },
  { name: "media", env: "title", word: "episodes", scalarKey: "genres", itemsKey: "episodes",
    flatLeaves: (r, ch) => [Ls("title", pick(WORDS, r) + " " + pick(["nights", "run", "code", "tide"], r)), Le("type", pick(MTYPE, r), ch, r), Li("year", pick([2019, 2021, 2024], r), ch), Lu("runtimeMin", pick([24, 48, 96], r), "min", ch), Lr("rating", pick([3, 4, 5], r), 8, 0, 5, ch), Lb("subtitled", pick([true, false], r), ch), Lesc("tagline", "a story", pick(ESC, r), ch)],
    nestedGroup: (r, ch) => ["studio", objNode([Ls("name", pick(WORDS, r) + " Pictures"), Li("founded", pick([1998, 2005, 2012], r), ch)])],
    tags: (r) => sample(["drama", "comedy", "scifi", "docu", "thriller"], 5, r),
    subRecord: (r, ch) => [Li("ep", pick([1, 2, 3], r), ch), Ls("name", pick(WORDS, r)), Lu("mins", pick([22, 44], r), "min", ch)],
    subGroup: (r) => ["director", objNode([Ls("name", pick(PEOPLE, r))])] },
  { name: "transaction", env: "transaction", word: "entries", scalarKey: "tags", itemsKey: "entries",
    flatLeaves: (r, ch) => [Ls("txId", "TX-" + Math.floor(r() * 90000 + 10000)), Lm("amount", pick([12, 75, 240, 999], r), ch), Le("status", pick(TXST, r), ch, r), Lr("riskScore", pick([10, 45, 80], r), 160, 0, 100, ch), Ls("currency", pick(["EUR", "USD", "JPY"], r)), Lb("refunded", pick([true, false], r), ch), Li("attempts", pick([1, 2, 3], r), ch)],
    nestedGroup: (r, ch) => ["account", objNode([Ls("holder", pick(PEOPLE, r)), Li("number", pick([4001, 4002, 4003], r), ch)])],
    tags: (r) => sample(["online", "recurring", "flagged", "manual", "fee"], 5, r),
    subRecord: (r, ch) => [Ls("kind", pick(["debit", "credit"], r)), Lm("value", pick([5, 25, 100], r), ch), Le("status", pick(TXST, r), ch, r)],
    subGroup: (r) => ["ledger", objNode([Ls("code", "L" + pick([1, 2, 3], r))])] },
];

// ── structure builders ──
function buildNested(d: Dom, level: number, ch: CH, r: RNG) {
  const e: Entry[] = [...d.flatLeaves(r, ch)];
  if (level >= 2) e.push(d.nestedGroup(r, ch));
  let count: { n: number; word: string } | null = null;
  if (level === 3) { const full = d.tags(r).map((t) => nd({ kind: "str", canon: t, src: t })); const a = arrNode(full, 3, ch, d.word); e.push([d.scalarKey, a.node]); count = a.count; }
  if (level >= 4) { const mk = (i: number) => { const ent = d.subRecord(r, ch, i); if (level >= 5) ent.push(d.subGroup(r, ch)); return objNode(ent); }; const full = [0, 1, 2, 3].map(mk); const a = arrNode(full, 2, ch, d.word); e.push([d.itemsKey, a.node]); count = a.count; }
  return { node: objNode(e), count };
}
function buildTabular(d: Dom, level: number, ch: CH, r: RNG) {
  const base = level === 1 ? 1 : level === 2 ? 3 : 6;
  const full = Array.from({ length: base + 2 }, () => objNode(d.flatLeaves(r, ch)));
  return arrNode(full, base, ch, "rows");
}

// ── challenge applicability + tier selection ──
function applicable(from: string, to: string, mode: string, level: number): string[] {
  const a = ["type", "unit", "enum", "range"];
  if (from !== "text") a.push("escape"); // can't unambiguously carry escaped strings through prose
  if (mode === "tabular" ? level >= 2 : level >= 3) a.push("count");
  if (to !== "csv") a.push("wrap"); // CSV has no place for an envelope key
  return a;
}
const TIERS = ["x0", "x1", "x2", "x3", "xall"] as const;
function chooseCh(tier: string, applic: string[], r: RNG): string[] {
  if (tier === "x0") return [];
  if (tier === "xall") return applic.slice();
  return sample(applic, { x1: 1, x2: 2, x3: 3 }[tier as "x1" | "x2" | "x3"], r);
}

// ── serialization ──
const csvCell = (v: any) => { const s = v == null ? "" : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
function toCsv(rows: any[]): string { if (!rows.length) return ""; const keys = Object.keys(rows[0]); return [keys.map(csvCell).join(","), ...rows.map((r) => keys.map((k) => csvCell(r[k])).join(","))].join("\n"); }
const yamlStr = (v: any) => YAML.stringify(v).replace(/\n$/, "");
function describe(value: any, d: Dom): string {
  const lines: string[] = [];
  const walk = (v: any, ind: string) => {
    if (Array.isArray(v)) v.forEach((it, i) => { if (it && typeof it === "object") { lines.push(`${ind}- entry ${i + 1}:`); walk(it, ind + "    "); } else lines.push(`${ind}- ${String(it)}`); });
    else if (v && typeof v === "object") for (const [k, val] of Object.entries(v)) { if (val && typeof val === "object") { lines.push(`${ind}${k}:`); walk(val, ind + "  "); } else lines.push(`${ind}${k}: ${String(val)}`); }
    else lines.push(`${ind}${String(v)}`);
  };
  walk(value, "");
  return (Array.isArray(value) ? `Field notes on ${value.length} ${d.name} records:` : `Field notes on a ${d.name}:`) + "\n" + lines.join("\n");
}
function serializeSource(from: string, src: any, d: Dom): string {
  if (from === "text") return describe(src, d);
  if (from === "json") return JSON.stringify(src, null, 2);
  if (from === "yaml") return yamlStr(src);
  return toCsv(src);
}
function serializeTarget(to: string, wrapped: any): { expected: any; output: string } {
  if (to === "json") return { expected: wrapped, output: JSON.stringify(wrapped) };
  if (to === "yaml") return { expected: wrapped, output: yamlStr(wrapped) };
  const c = toCsv(wrapped); return { expected: c, output: c };
}
function buildInstr(from: string, to: string, ch: CH, d: Dom, count: { n: number; word: string } | null): string {
  const T = to.toUpperCase();
  const l = [`Convert the following ${from === "text" ? "field notes" : from.toUpperCase()} into ${T}.`, `- Keep every field and the nesting structure; only change the representation into ${T}.`];
  if (ch.has("type")) l.push("- Where a number or boolean is written as text, output it as a real number/boolean.");
  if (ch.has("unit")) l.push('- Strip unit suffixes from measurements (e.g. "30min"→30, "16C"→16, "$5"→5, "500g"→500); output the bare number.');
  if (ch.has("enum")) l.push('- Normalise status/category text to its canonical lowercase form (e.g. "Med"→"medium", "IN STOCK"→"in_stock", "OOS"→"out_of_stock").');
  if (ch.has("escape")) l.push(`- Preserve special characters in text values exactly, escaped correctly for ${T}.`);
  if (ch.has("range")) l.push("- Clamp numbers to their valid range: any rating to 0–5, any percentage/score to 0–100.");
  if (ch.has("count") && count) l.push(`- Include only the first ${count.n} ${count.word}.`);
  if (ch.has("wrap")) l.push(`- Wrap the whole result under a single top-level key "${d.env}".`);
  return l.join("\n");
}
const diffOf = (level: number, nc: number) => { const s = level - 1 + nc; return s <= 1 ? "easy" : s <= 3 ? "moderate" : s <= 5 ? "hard" : "extreme"; };

const DIRS: [string, string][] = [["text", "json"], ["text", "csv"], ["text", "yaml"], ["json", "yaml"], ["yaml", "json"], ["json", "csv"], ["csv", "json"], ["yaml", "csv"], ["csv", "yaml"]];

const testInputs = new Set<string>();
let domRot = 0;
function genSplit(split: "test" | "train", perN: number, perC: number) {
  const out: any[] = [];
  for (const [from, to] of DIRS) {
    const csvInv = from === "csv" || to === "csv";
    const mode = csvInv ? "tabular" : "nested";
    const levels = csvInv ? [1, 2, 3] : [1, 2, 3, 4, 5];
    const per = csvInv ? perC : perN;
    for (const level of levels)
      for (const tier of TIERS) {
        const applic = applicable(from, to, mode, level);
        for (let i = 0; i < per; i++) {
          const r = mulberry32(hashStr(`${split}|${from}|${to}|${level}|${tier}|${i}`));
          const d = DOMAINS[domRot++ % DOMAINS.length];
          const ch = new Set(chooseCh(tier, applic, r));
          const { node, count } = mode === "nested" ? buildNested(d, level, ch, r) : buildTabular(d, level, ch, r);
          const canon = valOf(node, "canon");
          const src = valOf(node, "src");
          const wrapped = ch.has("wrap") ? { [d.env]: canon } : canon;
          const input = serializeSource(from, src, d);
          if (split === "train" && testInputs.has(input)) continue; // keep train ⊥ test
          if (split === "test") testInputs.add(input);
          const { expected, output } = serializeTarget(to, wrapped);
          out.push({ id: `${split}-${String(out.length + 1).padStart(5, "0")}`, split, domain: d.name, from, to, target: to, level, challenges: [...ch], tier, nChallenges: ch.size, difficulty: diffOf(level, ch.size), instructions: buildInstr(from, to, ch, d, count), input, expected, output });
        }
      }
  }
  return out;
}

const test = genSplit("test", 12, 11);
const train = genSplit("train", 4, 3);

// ── self-check ──
{
  const bad: string[] = [];
  for (const c of [...test, ...train]) {
    const v = scoreConvert(c.output, c.expected, c.to as ConvTarget);
    if (!(v.task && v.strict)) bad.push(`${c.id} ${c.from}→${c.to} L${c.level} ${c.tier}: reference scores task=${v.task} strict=${v.strict}`);
    try {
      if (c.from === "json") JSON.parse(c.input);
      else if (c.from === "yaml") YAML.parse(c.input);
      else if (c.from === "csv") { if (parseCsv(c.input).length < 1) bad.push(`${c.id}: csv input empty`); }
      else if (c.input.length < 10) bad.push(`${c.id}: text input too short`);
    } catch (e) { bad.push(`${c.id}: input unparsable as ${c.from}: ${String(e).slice(0, 50)}`); }
    const applic = applicable(c.from, c.to, c.from === "csv" || c.to === "csv" ? "tabular" : "nested", c.level);
    for (const ch of c.challenges) if (!applic.includes(ch)) bad.push(`${c.id}: challenge '${ch}' not applicable`);
  }
  const overlap = train.filter((t) => testInputs.has(t.input)).length;
  if (overlap) bad.push(`train∩test overlap: ${overlap}`);
  if (bad.length) { console.error(`SELF-CHECK FAILED (${bad.length}):`); bad.slice(0, 25).forEach((b) => console.error("  " + b)); process.exit(1); }
  console.log(`self-check ✓  (test ${test.length}, train ${train.length}, train⊥test)`);
}

writeFileSync(join(ROOT, "benches", "convert", "test.jsonl"), test.map((c) => JSON.stringify(c)).join("\n") + "\n");
writeFileSync(join(ROOT, "benches", "convert", "train.jsonl"), train.map((c) => JSON.stringify(c)).join("\n") + "\n");
console.log(`wrote test.jsonl (${test.length}) + train.jsonl (${train.length})`);
