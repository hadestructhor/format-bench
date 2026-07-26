/**
 * Integrity audit of every convert run on disk.
 *
 * The 410 rate-limited cases scored as 0 were found by accident. This looks for that failure mode and
 * every neighbour of it, on all runs, so "thorough" is a measured claim rather than a hope.
 *
 *   bun scripts/audit-runs.ts [--json]
 *
 * Checks, per run file:
 *   1. case count            — did every frozen case get a row?
 *   2. errored               — `note: "ERROR …"`, i.e. never answered, but scored 0
 *   3. no attempt            — totalRuns is 0
 *   4. empty reply           — the model answered with nothing (a real 0, but worth counting)
 *   5. off-dataset rows      — an input that is not in the frozen test set
 *   6. duplicate inputs      — the same case counted twice
 *   7. score drift           — the stored headline vs the one recomputed from the rows
 *   8. impossible rows       — correctRuns/strictRuns outside 0..totalRuns, or strict without task
 */
import { readFileSync, existsSync, readdirSync, statSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");
const cases = JSON.parse(readFileSync(join(ROOT, "docs", "data", "cases.json"), "utf8")) as
  { id: string; input: string }[];
const idByInput = new Map(cases.map((c) => [c.input, c.id]));
const byId = new Set(cases.map((c) => c.id));
const EXPECTED = cases.length;

// Two shapes on disk: the current compact rows keyed by `id`, and older rows keyed by `input` that
// also carry the reply and any error note. Only the older shape can report *why* a case scored 0.
type Row = { id?: string; input?: string; correctRuns?: number; strictRuns?: number; totalRuns?: number; sample?: string; note?: string };
type Run = { provider?: string; model?: string; mode?: string; total?: number; correct?: number; score?: number; strict?: number; strictScore?: number; results: Row[] };

type Finding = {
  file: string; mode: string; rows: number; missing: number; errored: number; noAttempt: number;
  emptyReply: number; offDataset: number; dupes: number; impossible: number; detailed: boolean;
  score: number | null; recomputed: number; scoreExErrors: number; errKinds: Record<string, number>;
};

const findings: Finding[] = [];
const runsDir = join(ROOT, "runs");

for (const prov of readdirSync(runsDir)) {
  const pdir = join(runsDir, prov);
  if (!statSync(pdir).isDirectory() || prov.startsWith(".")) continue;
  for (const model of readdirSync(pdir)) {
    const mdir = join(pdir, model);
    if (!statSync(mdir).isDirectory()) continue;
    for (const [mode, file] of [["plain", "convert-plain.json"], ["ex", "convert-ex.json"]] as const) {
      const path = join(mdir, file);
      if (!existsSync(path)) continue;
      const run = JSON.parse(readFileSync(path, "utf8")) as Run;
      const rows = run.results ?? [];

      let errored = 0, noAttempt = 0, emptyReply = 0, offDataset = 0, dupes = 0, impossible = 0;
      const errKinds: Record<string, number> = {};
      const ids = new Set<string>();
      // `note`/`sample` only exist in the older shape, so a compact run cannot be checked for the
      // "answered with an error, scored 0" failure at all — that limitation is reported, not hidden.
      const detailed = rows.some((r) => r.note !== undefined || r.sample !== undefined);

      for (const r of rows) {
        const id = r.id ?? (r.input != null ? idByInput.get(r.input) : undefined);
        if (!id || !byId.has(id)) offDataset++; else { if (ids.has(id)) dupes++; ids.add(id); }

        const isErr = typeof r.note === "string" && r.note.startsWith("ERROR");
        if (isErr) {
          errored++;
          const k = r.note!.match(/HTTP \d+/)?.[0] ?? r.note!.slice(0, 40);
          errKinds[k] = (errKinds[k] ?? 0) + 1;
        }
        const total = r.totalRuns ?? 0, corr = r.correctRuns ?? 0, strict = r.strictRuns ?? 0;
        if (total === 0) noAttempt++;
        if (!isErr && typeof r.sample === "string" && r.sample.trim() === "") emptyReply++;
        if (corr < 0 || corr > total || strict < 0 || strict > total || strict > corr) impossible++;
      }

      const answered = rows.filter((r) => !(typeof r.note === "string" && r.note.startsWith("ERROR")));
      const recomputed = rows.length ? Math.round(rows.filter((r) => (r.correctRuns ?? 0) > 0).length / rows.length * 100) : 0;
      const scoreExErrors = answered.length ? Math.round(answered.filter((r) => (r.correctRuns ?? 0) > 0).length / answered.length * 100) : 0;

      findings.push({
        file: `${prov}/${model}`, mode, rows: rows.length, missing: EXPECTED - ids.size,
        errored, noAttempt, emptyReply, offDataset, dupes, impossible, detailed,
        score: run.score ?? null, recomputed, scoreExErrors, errKinds,
      });
    }
  }
}

if (process.argv.includes("--json")) {
  console.log(JSON.stringify(findings, null, 2));
} else {
  const bad = findings.filter((f) =>
    f.missing || f.errored || f.noAttempt || f.offDataset || f.dupes || f.impossible ||
    (f.score != null && Math.abs(f.score - f.recomputed) > 1));
  console.log(`audited ${findings.length} run files over ${new Set(findings.map((f) => f.file)).size} models\n`);
  if (!bad.length) console.log("no integrity problems found");
  for (const f of bad.sort((a, b) => (b.errored + b.missing) - (a.errored + a.missing))) {
    const flags = [
      f.missing && `missing ${f.missing}`,
      f.errored && `errored ${f.errored} ${JSON.stringify(f.errKinds)}`,
      f.noAttempt && `no-attempt ${f.noAttempt}`,
      f.offDataset && `off-dataset ${f.offDataset}`,
      f.dupes && `duplicates ${f.dupes}`,
      f.impossible && `impossible ${f.impossible}`,
      f.score != null && Math.abs(f.score - f.recomputed) > 1 && `score drift ${f.score}→${f.recomputed}`,
    ].filter(Boolean);
    console.log(`${f.file} · ${f.mode}${f.detailed ? "" : "  [compact rows — no error notes on record]"}`);
    console.log(`  rows ${f.rows}  score ${f.score} → excluding errors ${f.scoreExErrors}`);
    for (const x of flags) console.log(`  ${x}`);
  }
  const totals = findings.reduce((a, f) => ({
    errored: a.errored + f.errored, missing: a.missing + f.missing, empty: a.empty + f.emptyReply,
    noAttempt: a.noAttempt + f.noAttempt, off: a.off + f.offDataset,
  }), { errored: 0, missing: 0, empty: 0, noAttempt: 0, off: 0 });
  console.log(`\ntotals — errored ${totals.errored} · missing ${totals.missing} · no-attempt ${totals.noAttempt}`
    + ` · empty replies ${totals.empty} · off-dataset ${totals.off}`);
}
