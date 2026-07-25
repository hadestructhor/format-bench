/**
 * runs/ + benches/convert/test.jsonl → docs/data/*.json
 *
 * Why a data layer at all: the previous site inlined all 2 025 cases into every per-model page, so 75 models
 * cost 324 MB of near-identical HTML. Emitting the cases ONCE and letting one page fetch what it needs turns
 * that into a few MB, and makes the results reusable by anyone who'd rather not scrape HTML.
 *
 * Emits:
 *   meta.json          dataset sha/counts, axis definitions, exclusions, generation time
 *   board.json         one row per model: scores by direction / domain / level / challenge, both modes
 *   cases.json         the frozen test set (input, expected, reference answer, axes)
 *   models/<slug>.json per-case verdicts for one model, plus replies when the run saved them
 *
 * Run: bun scripts/build-data.ts
 */
import { readFileSync, readdirSync, existsSync, writeFileSync, mkdirSync, statSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ROOT, PROVIDERS } from "../providers.js";
import { datasetSha } from "../run.js";
import { detect, type Casualty } from "./detect-truncated.ts";

const OUT = join(ROOT, "docs", "data");
const HOSTED = new Set(Object.keys(PROVIDERS).filter((id) => id !== "llama" && id !== "tfjs"));

// ── axes (kept in one place so the site and the README can't drift from the generator) ──────────────
export const DIRECTIONS = ["text>json", "text>yaml", "text>csv", "json>yaml", "json>csv", "yaml>json", "yaml>csv", "csv>json", "csv>yaml"];
export const DOMAINS = ["recipe", "product", "basket", "profile", "event", "sensor", "media", "transaction"];
export const LEVELS = [
  { n: 1, label: "flat record", desc: "a single object, every field present" },
  { n: 2, label: "a few fields", desc: "~3 items, still one record" },
  { n: 3, label: "list of tags", desc: "arrays of scalar values (≈6)" },
  { n: 4, label: "list of records", desc: "an array of sub-objects" },
  { n: 5, label: "nested groups", desc: "sub-objects that themselves nest (CSV directions stop at L3)" },
];
export const CHALLENGES = [
  { key: "type", desc: "numbers/booleans written as text → emit a real number/boolean" },
  { key: "unit", desc: 'strip unit suffixes ("30min"→30, "$5"→5, "500g"→500)' },
  { key: "enum", desc: 'normalise category text to its canonical form ("Med"→"medium")' },
  { key: "range", desc: "clamp out-of-range numbers (rating→0–5, score→0–100)" },
  { key: "count", desc: "keep only the first N items; drop the extras" },
  { key: "wrap", desc: "wrap the whole result under one top-level key" },
  { key: "escape", desc: "preserve special characters, escaped correctly for the target" },
];

type Case = { id: string; from: string; to: string; domain: string; level: number; tier: string; challenges: string[]; nChallenges: number; difficulty: string; instructions: string; input: string; expected: any; output: string };

const cases: Case[] = readFileSync(join(ROOT, "benches", "convert", "test.jsonl"), "utf8")
  .split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
// Runs made before results became id-keyed store the case `input` instead. Same cases, older shape — match
// them back by input text rather than throwing away four models (both gpt-oss sizes among them).
const idByInput = new Map(cases.map((c) => [c.input, c.id]));

// ── model discovery ────────────────────────────────────────────────────────────────────────────────
const dirsOf = (p: string) => (existsSync(p) ? readdirSync(p).filter((e) => !e.startsWith(".") && statSync(join(p, e)).isDirectory()) : []);
export const slugOf = (prov: string, model: string) => `${prov}__${model}`.replace(/\//g, "_");

/** Curated parameter counts. One underlying model ships under many provider ids, so aliases collapse them. */
const SZ: { models: Record<string, { total?: string | null; active?: string | null }>; aliases: Record<string, string> } = (() => {
  try { const j = JSON.parse(readFileSync(join(ROOT, "scripts", "model-sizes.json"), "utf8")); return { models: j.models ?? {}, aliases: j.aliases ?? {} }; }
  catch { return { models: {}, aliases: {} }; }
})();
const toM = (s?: string | null): number | null => {
  const m = s == null ? null : String(s).match(/(\d+(?:\.\d+)?)\s*([mbt])/i);
  if (!m) return null;
  const v = parseFloat(m[1]), u = m[2].toLowerCase();
  return u === "t" ? v * 1e6 : u === "b" ? v * 1000 : v;
};
function sizeInfo(prov: string, model: string) {
  const key = `${prov}/${model}`;
  const canon = SZ.aliases[key] ?? SZ.aliases[model] ?? key;
  const e = SZ.models[canon] ?? SZ.models[key] ?? SZ.models[model];
  if (!e) return { params: null as number | null, sizeLabel: "undisclosed", active: null as string | null };
  return { params: toM(e.total), sizeLabel: e.total ? String(e.total) : "undisclosed", active: e.active && e.active !== e.total ? String(e.active) : null };
}

type Verdict = { t: 0 | 1; s: 0 | 1 };
type ModeData = { score: number; strictScore: number; verdicts: Map<string, Verdict>; replies: Map<string, string>; run: any } | null;

function loadMode(dir: string, mode: "plain" | "ex"): ModeData {
  const f = join(dir, `convert-${mode}.json`);
  if (!existsSync(f)) return null;
  let j: any;
  try { j = JSON.parse(readFileSync(f, "utf8")); } catch { return null; }
  const verdicts = new Map<string, Verdict>();
  const replies = new Map<string, string>();
  for (const r of j.results ?? []) {
    const id = r.id != null ? String(r.id) : (r.input != null ? idByInput.get(r.input) : undefined);
    if (id == null) continue;
    verdicts.set(id, { t: r.correctRuns > 0 ? 1 : 0, s: (r.strictRuns ?? 0) > 0 ? 1 : 0 });
    if (typeof r.sample === "string" && r.sample) replies.set(id, r.sample); // legacy rich runs carried the reply inline
  }
  return { score: j.score ?? 0, strictScore: j.strictScore ?? 0, verdicts, replies, run: j.run ?? null };
}

/** Full replies, when the run was made with --save-responses. */
function loadResponses(dir: string, mode: "plain" | "ex"): Map<string, string> {
  const f = join(dir, `convert-${mode}.responses.jsonl`);
  const out = new Map<string, string>();
  if (!existsSync(f)) return out;
  for (const l of readFileSync(f, "utf8").split("\n")) {
    if (!l.trim()) continue;
    try { const r = JSON.parse(l); if (r.id != null) out.set(String(r.id), String(r.response ?? "")); } catch { /* torn line */ }
  }
  return out;
}

/** Pass rate over a subset of cases, as a 0-100 int. null when the subset is empty. */
function rate(v: Map<string, Verdict>, ids: string[], axis: "t" | "s"): number | null {
  let n = 0, hit = 0;
  for (const id of ids) { const x = v.get(id); if (!x) continue; n++; hit += x[axis]; }
  return n ? Math.round((100 * hit) / n) : null;
}

// Precompute the id sets each slice needs once, rather than re-filtering 2 025 cases per model per slice.
const idsAll = cases.map((c) => c.id);
const idsByDir: Record<string, string[]> = {};
for (const d of DIRECTIONS) { const [f, t] = d.split(">"); idsByDir[d] = cases.filter((c) => c.from === f && c.to === t).map((c) => c.id); }
const idsByDomain = Object.fromEntries(DOMAINS.map((d) => [d, cases.filter((c) => c.domain === d).map((c) => c.id)]));
const idsByLevel = Object.fromEntries(LEVELS.map((l) => [l.n, cases.filter((c) => c.level === l.n).map((c) => c.id)]));
const idsByChallenge = Object.fromEntries(CHALLENGES.map((c) => [c.key, cases.filter((x) => x.challenges.includes(c.key)).map((x) => x.id)]));
const idsNoChallenge = cases.filter((c) => c.challenges.length === 0).map((c) => c.id);
// The enum constraint has unguessable targets in v1.0 (see README Limitations), so we also publish a score
// with those cases removed — it isolates "follows instructions" from "guessed our vocabulary".
const idsNoEnum = cases.filter((c) => !c.challenges.includes("enum")).map((c) => c.id);

/**
 * The one worked example the "explained" prompt prepends, per direction. run.ts picks the first easy train
 * case of the same from→to (else the first of that direction), so this mirrors that choice exactly — the site
 * can then reconstruct the prompt a model actually saw instead of approximating it.
 */
function demosByDirection(): Record<string, { input: string; output: string }> {
  const f = join(ROOT, "benches", "convert", "train.jsonl");
  if (!existsSync(f)) return {};
  const train = readFileSync(f, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
  const out: Record<string, { input: string; output: string }> = {};
  for (const d of DIRECTIONS) {
    const [from, to] = d.split(">");
    const pick = train.find((c: any) => c.from === from && c.to === to && c.difficulty === "easy")
      ?? train.find((c: any) => c.from === from && c.to === to);
    if (pick) out[d] = { input: pick.input, output: pick.output };
  }
  return out;
}

const casualties: Casualty[] = detect();
const isExcluded = (prov: string, model: string, mode: string) =>
  casualties.some((c) => c.provider === prov && c.model === model && c.mode === mode);

function build() {
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(join(OUT, "models"), { recursive: true });

  const board: any[] = [];
  const runsRoot = join(ROOT, "runs");

  for (const prov of dirsOf(runsRoot)) {
    for (const model of dirsOf(join(runsRoot, prov))) {
      const dir = join(runsRoot, prov, model);
      let plain = loadMode(dir, "plain"), ex = loadMode(dir, "ex");
      const excl: string[] = [];
      if (plain && isExcluded(prov, model, "plain")) { excl.push("plain"); plain = null; }
      if (ex && isExcluded(prov, model, "ex")) { excl.push("ex"); ex = null; }
      // A model needs BOTH modes over the full set to be comparable. Partial coverage would silently make
      // an easy subset look like a whole-benchmark score.
      const complete = !!plain && !!ex && plain.verdicts.size === cases.length && ex.verdicts.size === cases.length;
      if (!complete) continue;

      const si = sizeInfo(prov, model);
      const slug = slugOf(prov, model);
      const sliceAll = (v: Map<string, Verdict>) => ({
        task: rate(v, idsAll, "t"), strict: rate(v, idsAll, "s"),
        noEnum: rate(v, idsNoEnum, "t"), noChallenge: rate(v, idsNoChallenge, "t"),
        dir: Object.fromEntries(DIRECTIONS.map((d) => [d, rate(v, idsByDir[d], "t")])),
        domain: Object.fromEntries(DOMAINS.map((d) => [d, rate(v, idsByDomain[d], "t")])),
        level: Object.fromEntries(LEVELS.map((l) => [l.n, rate(v, idsByLevel[l.n], "t")])),
        challenge: Object.fromEntries(CHALLENGES.map((c) => [c.key, rate(v, idsByChallenge[c.key], "t")])),
      });

      board.push({
        slug, provider: prov, model, name: `${prov}/${model}`,
        local: !HOSTED.has(prov), params: si.params, sizeLabel: si.sizeLabel, active: si.active,
        plain: sliceAll(plain!.verdicts), ex: sliceAll(ex!.verdicts),
        delta: ex!.score - plain!.score,
        excluded: excl.length ? excl : undefined,
        run: { plain: plain!.run, ex: ex!.run },
      });

      // Per-model per-case detail. Replies come from --save-responses, or inline for legacy rich runs.
      const rp = loadResponses(dir, "plain"), re = loadResponses(dir, "ex");
      for (const [k, v] of plain!.replies) if (!rp.has(k)) rp.set(k, v);
      for (const [k, v] of ex!.replies) if (!re.has(k)) re.set(k, v);
      const rows = cases.map((c) => {
        const p = plain!.verdicts.get(c.id), e = ex!.verdicts.get(c.id);
        const row: any = { id: c.id, p: p ? p.t * 2 + p.s : 0, e: e ? e.t * 2 + e.s : 0 };  // bitfield: 2=task, 1=strict
        const a = rp.get(c.id), b = re.get(c.id);
        if (a != null) row.pr = a;
        if (b != null) row.er = b;
        return row;
      });
      writeFileSync(join(OUT, "models", `${slug}.json`), JSON.stringify({
        slug, provider: prov, model, name: `${prov}/${model}`,
        hasResponses: rp.size > 0 || re.size > 0, rows,
      }));
    }
  }

  board.sort((a, b) => Math.max(b.ex.task, b.plain.task) - Math.max(a.ex.task, a.plain.task));

  writeFileSync(join(OUT, "board.json"), JSON.stringify(board));
  writeFileSync(join(OUT, "cases.json"), JSON.stringify(cases.map((c) => ({
    id: c.id, from: c.from, to: c.to, domain: c.domain, level: c.level, tier: c.tier,
    challenges: c.challenges, difficulty: c.difficulty,
    instructions: c.instructions, input: c.input, expected: c.expected, output: c.output,
  }))));
  writeFileSync(join(OUT, "meta.json"), JSON.stringify({
    generated: new Date().toISOString(),
    datasetSha: datasetSha(),
    cases: cases.length,
    models: board.length,
    directions: DIRECTIONS, domains: DOMAINS, levels: LEVELS, challenges: CHALLENGES,
    demos: demosByDirection(),
    excluded: casualties,
  }, null, 2));

  const mb = (n: number) => (n / 1e6).toFixed(2) + " MB";
  const size = (f: string) => statSync(join(OUT, f)).size;
  console.log(`docs/data written:`);
  console.log(`  board.json  ${mb(size("board.json"))}  (${board.length} models)`);
  console.log(`  cases.json  ${mb(size("cases.json"))}  (${cases.length} cases)`);
  console.log(`  models/     ${readdirSync(join(OUT, "models")).length} files`);
  if (casualties.length) console.log(`  excluded ${casualties.length} truncated run(s): ${casualties.map((c) => `${c.provider}/${c.model}[${c.mode}]`).join(", ")}`);
}

if (import.meta.main) build();
