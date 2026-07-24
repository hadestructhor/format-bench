/**
 * Orchestration: load the convert bench, build the per-case prompt, call the model, score, and write
 * runs/<provider>/<model>/convert-<mode>.json.
 *
 * Two prompt modes per model:
 *   plain — instructions only
 *   ex    — instructions + one worked demo from the train split, same direction (train ⊥ test)
 *
 * Resumable: every scored case is appended to convert-<mode>.partial.jsonl as {id,t,s}. Errored cases are
 * deliberately NOT checkpointed, so re-running the identical command retries exactly what failed.
 */
import { readFileSync, existsSync, mkdirSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { ROOT } from "./providers.js";
import { httpRunner, type Runner } from "./call.js";
import { scoreConvert, type Format } from "./score.js";

type Case = { id?: string; input: string; expected: any; from?: string; to?: string; instructions?: string; difficulty?: string; output?: string; level?: number; challenges?: string[]; domain?: string };
type Bench = { name: string; format: Format; cases: Case[] };

const readJsonl = (f: string): any[] =>
  readFileSync(f, "utf8").split("\n").map((l) => l.trim()).filter(Boolean).map((l) => JSON.parse(l));

const testPath = () => join(ROOT, "benches", "convert", "test.jsonl");

/** sha256 of the frozen test set — recorded in every run file so a score is always traceable to a dataset version. */
let _sha: string | null = null;
export function datasetSha(): string {
  if (_sha == null) _sha = existsSync(testPath()) ? createHash("sha256").update(readFileSync(testPath())).digest("hex") : "";
  return _sha;
}

/** "explained" demo: one easy train case of the same DIRECTION (from→to). train ⊥ test. */
let _demos: Case[] | null = null;
function demoFor(from: string, to: string): Case | null {
  if (!_demos) { const f = join(ROOT, "benches", "convert", "train.jsonl"); _demos = existsSync(f) ? readJsonl(f) : []; }
  return _demos.find((c) => c.from === from && c.to === to && c.difficulty === "easy") ?? _demos.find((c) => c.from === from && c.to === to) ?? null;
}

export function loadBench(): Bench {
  const f = testPath();
  if (!existsSync(f)) throw new Error(`dataset missing: ${f} — run "bun scripts/gen-convert.ts"`);
  return { name: "convert", format: "convert", cases: readJsonl(f) };
}

export function systemFor(c: Case, explain = false): string {
  const F = (c.from ?? "data").toUpperCase(), T = (c.to ?? "json").toUpperCase();
  let p = `You reformat data. The input below is ${F === "TEXT" ? "field notes (text)" : F}; produce ${T}.\n${c.instructions ?? ""}\nReply with ONLY the ${T} value — nothing else: no prose, no explanation, no markdown code fences, no "Output:" label.`;
  if (explain) { const d = demoFor(c.from ?? "", c.to ?? "json"); if (d) p += `\n\nWorked example — for this input:\n${d.input}\nthe correct reply is exactly:\n${d.output}\n\nNow do the same for the input below — reply with ONLY the ${T}.`; }
  return p;
}

async function mapPool<T, R>(items: T[], n: number, f: (x: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await f(items[k], k); }
  }));
  return out;
}

/** Per-case aggregate: id + verdict counts. Inputs/expected are recoverable from test.jsonl by id. */
export type CaseAgg = { id?: string; correctRuns: number; totalRuns: number; strictRuns?: number; note?: string };

async function runSingle(
  runner: Runner, bench: Bench, cases: Case[], concurrency: number, repeat: number,
  explain: boolean, checkpoint: string, responsesFile?: string,
): Promise<CaseAgg[]> {
  // Resume: replay the append-only checkpoint → skip already-scored ids.
  const useCkpt = repeat === 1;
  const done = new Map<string, { t: number; s: number }>();
  if (useCkpt && existsSync(checkpoint)) {
    for (const line of readFileSync(checkpoint, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try { const r = JSON.parse(line); if (r.id != null) done.set(String(r.id), { t: r.t ? 1 : 0, s: r.s ? 1 : 0 }); } catch { /* torn last line */ }
    }
    if (done.size) console.log(`    ↻ resume: ${done.size} already scored, ${cases.length - done.size} to go`);
  }
  const todo = cases.filter((c) => !(useCkpt && c.id != null && done.has(String(c.id))));
  const todoIdx = new Map<Case, number>(); todo.forEach((c, ti) => todoIdx.set(c, ti));
  const trials = todo.flatMap((_, ti) => Array.from({ length: repeat }, () => ti));
  const total = trials.length;
  let doneN = 0, ok = 0;
  const tick = Math.max(1, Math.floor(total / 20));
  const outcomes = await mapPool(trials, concurrency, async (ti) => {
    const c = todo[ti];
    let res: any;
    const t0 = Date.now();
    try {
      const { text, finishReason } = await runner([{ role: "system", content: systemFor(c, explain) }, { role: "user", content: c.input }]);
      // A reply cut off by the token ceiling is an INFRASTRUCTURE failure, not a wrong answer. Scoring it 0
      // silently turns "we didn't let it finish" into "the model can't do this" — which is exactly how
      // reasoning models were mis-measured at the old fixed 2048 cap. Throw so it isn't checkpointed and retries.
      if (finishReason === "length") throw new Error("TRUNCATED (finish_reason=length) — raise --max-tokens");
      const v = scoreConvert(text, c.expected, (c.to ?? "json") as any);
      res = { ti, output: text, correct: v.task, strict: v.strict, ms: Date.now() - t0, finishReason };
    } catch (e) {
      res = { ti, output: "", correct: false, strict: false, note: `ERROR ${String(e).slice(0, 60)}` };
    }
    // Checkpoint each completed case as it finishes (repeat=1 ⇒ trial ≡ case). Skip exceptions so a
    // transient failure retries on resume. O_APPEND makes a single-line write atomic across workers.
    if (useCkpt && c.id != null && !res.note) {
      appendFileSync(checkpoint, JSON.stringify({ id: c.id, t: res.correct ? 1 : 0, s: res.strict ? 1 : 0 }) + "\n");
      if (responsesFile) appendFileSync(responsesFile, JSON.stringify({ id: c.id, response: res.output, finish_reason: res.finishReason ?? null, latency_ms: res.ms ?? null }) + "\n");
    }
    doneN++; if (res.correct) ok++;
    if (doneN % tick === 0 || doneN === total) console.log(`    … ${doneN}/${total} trials (${Math.round((ok / doneN) * 100)}% task-ok)`);
    return res;
  });
  // Assemble aggs in original case order: checkpoint hits + freshly-run.
  return cases.map((c) => {
    if (useCkpt && c.id != null && done.has(String(c.id))) {
      const d = done.get(String(c.id))!;
      return { id: c.id, correctRuns: d.t, strictRuns: d.s, totalRuns: 1 };
    }
    const ti = todoIdx.get(c)!;
    const g = outcomes.filter((o) => o.ti === ti);
    return { id: c.id, correctRuns: g.filter((o) => o.correct).length, strictRuns: g.filter((o) => o.strict).length, totalRuns: g.length };
  });
}

const slug = (s: string) => s.replace(/[^a-zA-Z0-9._-]+/g, "_");
const pct = (a: number, b: number) => (b ? Math.round((a / b) * 100) : 0);

export type RunOpts = {
  provider: string; model: string; providerLabel?: string; limit?: number; concurrency: number;
  repeat: number; temperature: number; thinking?: string; explain?: boolean;
  saveResponses?: boolean; maxTokens: number;
};

/** Run the convert bench for one model in one mode; returns the score /100. */
export async function runOne(opts: RunOpts): Promise<number> {
  const runner = opts.provider === "grok"
    ? (await import("./grok.js")).grokRunner(opts.model)          // Grok CLI subprocess (free X-account tier), not HTTP
    : httpRunner(opts.provider, opts.model, opts.temperature, opts.thinking, opts.maxTokens);
  const providerLabel = opts.providerLabel ?? opts.provider;       // dir bucket (e.g. "LiquidAI" for a local GGUF)
  const label = opts.thinking ? `${opts.model} think=${opts.thinking}` : opts.model;
  const bench = loadBench();
  const explain = !!opts.explain;
  const cases = opts.limit ? bench.cases.slice(0, opts.limit) : bench.cases;
  const variant = explain ? "ex" : "plain";
  const dir = join(ROOT, "runs", slug(providerLabel), slug(label));
  mkdirSync(dir, { recursive: true });                            // up-front so the checkpoint can be appended during the run
  // --limit is a smoke test, so it gets its own scratch files and never finalizes. Sharing the real
  // checkpoint would let a 6-case probe consume a 2000-case resume and write a 6-case "result".
  const smoke = !!opts.limit;
  const sfx = smoke ? `.limit${opts.limit}` : "";
  const checkpoint = join(dir, `convert-${variant}${sfx}.partial.jsonl`);
  const responsesFile = opts.saveResponses ? join(dir, `convert-${variant}${sfx}.responses.jsonl`) : undefined;
  const startedAt = new Date().toISOString();
  if (smoke) rmSync(checkpoint, { force: true });                 // a smoke test always starts clean

  console.log(`\n▶ convert [${providerLabel}/${label}] ${variant} — ${cases.length} case(s) ×${opts.repeat}${responsesFile ? " · saving responses" : ""}`);
  const aggs = await runSingle(runner, bench, cases, opts.concurrency, opts.repeat, explain, checkpoint, responsesFile);

  const correct = aggs.reduce((s, a) => s + a.correctRuns, 0), total = aggs.reduce((s, a) => s + a.totalRuns, 0);
  const strict = aggs.reduce((s, a) => s + (a.strictRuns ?? 0), 0);
  console.log(`  = task ${pct(correct, total)} · strict ${pct(strict, total)} /100  (${correct}/${total})`);

  // Capped/unhealthy-provider guard: errored cases (thrown → not checkpointed) get NO real answer. If many
  // errored, do NOT finalize a mostly-empty run as if it were real. Keep the partial + skip the json so the
  // next launch resumes. A genuinely-bad model still ANSWERS every case (0 errored) → finalizes as normal.
  // Count UNIQUE ids, not lines: two lanes racing the same model append the same id twice.
  const answered = existsSync(checkpoint)
    ? new Set(readFileSync(checkpoint, "utf8").split("\n").filter((l) => l.trim())
        .map((l) => { try { return String(JSON.parse(l).id); } catch { return null; } }).filter((x) => x != null)).size
    : 0;
  const errored = cases.length - answered;
  if (errored > cases.length * 0.2) {
    console.log(`  ⚠ ${errored}/${cases.length} cases errored (provider capped/unhealthy) — NOT finalizing; ${answered} real answers kept in partial for resume`);
    throw new Error(`convert ${variant} incomplete: ${errored}/${cases.length} errored — resumable`);
  }

  const summary = {
    provider: providerLabel, model: label, bench: "convert", format: "convert", mode: variant,
    repeat: opts.repeat, cases: cases.length, total, correct,
    score: pct(correct, total), strict, strictScore: pct(strict, total), explain,
    run: {
      started_at: startedAt, finished_at: new Date().toISOString(),
      temperature: opts.temperature, max_tokens: opts.maxTokens, thinking: opts.thinking ?? null,
      concurrency: opts.concurrency, dataset_sha256: datasetSha(),
      harness_version: HARNESS_VERSION, responses_saved: !!responsesFile,
    },
    results: aggs,
  };
  if (smoke) {
    console.log(`  (--limit ${opts.limit}: smoke test — no run file written)`);
    rmSync(checkpoint, { force: true });
  } else {
    writeFileSync(join(dir, `convert-${variant}.json`), JSON.stringify(summary, null, 2));
    if (existsSync(checkpoint)) rmSync(checkpoint);               // mode fully written → drop the resume checkpoint
  }

  const global = pct(correct, total);
  console.log(`\n★  ${providerLabel}/${label}  —  GLOBAL SCORE: ${global} / 100   (${correct}/${total} trials)`);
  return global;
}

export const HARNESS_VERSION = "1.0.0";

/**
 * Oracle mode: score the dataset's own reference answers. Must be 2025/2025 — proves the harness and the
 * scorer agree with the data, so a lab can tell "my model failed" from "the eval is broken" in 30 seconds.
 */
export function runGold(): boolean {
  const bench = loadBench();
  let task = 0, strict = 0;
  const bad: string[] = [];
  for (const c of bench.cases) {
    const v = scoreConvert(c.output ?? "", c.expected, (c.to ?? "json") as any);
    if (v.task) task++; else bad.push(c.id ?? "?");
    if (v.strict) strict++;
  }
  const n = bench.cases.length;
  console.log(`gold: task ${task}/${n} · strict ${strict}/${n}`);
  console.log(`dataset sha256: ${datasetSha()}`);
  if (task === n && strict === n) { console.log("✓ oracle passed — harness agrees with the reference answers"); return true; }
  console.log(`✗ oracle FAILED on ${bad.length} case(s): ${bad.slice(0, 10).join(", ")}`);
  return false;
}
