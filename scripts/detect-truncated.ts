/**
 * Find runs whose scores were destroyed by the old fixed 2048-token output ceiling.
 *
 * The signature: reasoning models spend the ceiling on reasoning, so the answer never gets written. That
 * failure is LENGTH-DEPENDENT — short reference answers still squeak through, long ones go to zero — while
 * the same model's other mode, or a genuinely weak model, decays evenly. So we bucket each mode's pass rate
 * by reference-answer length and look for a cliff that the model's other mode does not have.
 *
 * Runs written after the fix cannot be affected: truncation now throws, so the case errors instead of
 * scoring 0, and a mostly-errored run refuses to finalize (see run.ts).
 *
 * Usage: bun scripts/detect-truncated.ts [--json]
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../providers.js";

type Row = { id?: string; correctRuns: number };
const BUCKETS = [0, 250, 500, 750];                        // reference-answer length, chars

const meta = new Map<string, number>();                     // case id → reference answer length
for (const l of readFileSync(join(ROOT, "benches", "convert", "test.jsonl"), "utf8").split("\n")) {
  if (!l.trim()) continue;
  const c = JSON.parse(l);
  meta.set(c.id, String(c.output ?? "").length);
}

const bucketOf = (len: number) => Math.min(BUCKETS.length - 1, Math.floor(len / 250));

/** Pass rate per length bucket for one mode. */
function profile(results: Row[]): { rate: number[]; n: number[] } {
  const hit = new Array(BUCKETS.length).fill(0), tot = new Array(BUCKETS.length).fill(0);
  for (const r of results) {
    const len = r.id != null ? meta.get(r.id) : undefined;
    if (len == null) continue;
    const b = bucketOf(len);
    tot[b]++; if (r.correctRuns > 0) hit[b]++;
  }
  return { rate: hit.map((h, i) => (tot[i] ? h / tot[i] : NaN)), n: tot };
}

export type Casualty = {
  provider: string; model: string; mode: "plain" | "ex";
  score: number; otherScore: number;
  shortRate: number; longRate: number; otherLongRate: number;
  reason: string;
};

export function detect(): Casualty[] {
  const out: Casualty[] = [];
  const runsDir = join(ROOT, "runs");
  if (!existsSync(runsDir)) return out;
  for (const prov of readdirSync(runsDir)) {
    if (prov.startsWith(".")) continue;
    const pd = join(runsDir, prov);
    for (const model of readdirSync(pd)) {
      const md = join(pd, model);
      const load = (m: string) => {
        const f = join(md, `convert-${m}.json`);
        return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : null;
      };
      const runs: Record<string, any> = { plain: load("plain"), ex: load("ex") };
      if (!runs.plain || !runs.ex) continue;
      // A run recorded under the fixed harness carries its ceiling; ≥32k could not have truncated an
      // answer whose reference is at most ~250 tokens.
      for (const mode of ["plain", "ex"] as const) {
        const self = runs[mode], other = runs[mode === "plain" ? "ex" : "plain"];
        if ((self.run?.max_tokens ?? 2048) >= 32768) continue;
        const ps = profile(self.results ?? []), po = profile(other.results ?? []);
        const shortRate = ps.rate[0];
        // Longest buckets that actually have cases.
        const longIdx = [3, 2].filter((i) => ps.n[i] >= 20);
        if (!longIdx.length || !isFinite(shortRate)) continue;
        const longRate = Math.min(...longIdx.map((i) => ps.rate[i]));
        const otherLongRate = Math.min(...longIdx.map((i) => po.rate[i]));
        // Cliff: long answers collapse to ~nothing while short ones work AND the other mode holds up on
        // exactly those long cases. That difference is what rules out "this model is simply bad at long output".
        if (longRate <= 0.02 && shortRate >= 0.10 && otherLongRate >= 0.25) {
          out.push({
            provider: prov, model, mode,
            score: self.score, otherScore: other.score,
            shortRate, longRate, otherLongRate,
            reason: `${(shortRate * 100).toFixed(0)}% on short answers → ${(longRate * 100).toFixed(0)}% on long ones, while ${mode === "plain" ? "ex" : "plain"} holds ${(otherLongRate * 100).toFixed(0)}% on the same long cases`,
          });
        }
      }
    }
  }
  return out.sort((a, b) => a.longRate - b.longRate || a.score - b.score);
}

if (import.meta.main) {
  const cs = detect();
  if (process.argv.includes("--json")) { console.log(JSON.stringify(cs, null, 2)); process.exit(0); }
  if (!cs.length) { console.log("No truncation casualties detected."); process.exit(0); }
  console.log(`${cs.length} run(s) invalidated by the old 2048-token ceiling:\n`);
  for (const c of cs) {
    console.log(`  ${c.provider}/${c.model}  [${c.mode}]  score ${c.score} (other mode ${c.otherScore})`);
    console.log(`    ${c.reason}`);
  }
}
