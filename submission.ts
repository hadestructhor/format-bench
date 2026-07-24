/**
 * Submission validation. A results/ entry is what someone opens a PR with, so the checks here are the
 * contract: right layout, both modes, the full 2025 cases, and — the one that actually matters — the same
 * dataset. A score computed against a different test.jsonl is not comparable to anything on the board.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { datasetSha, loadBench } from "./run.js";

const DIR_RE = /^\d{8}_[A-Za-z0-9.-]+_[A-Za-z0-9._-]+$/;

export function validateSubmission(dir: string): boolean {
  const errs: string[] = [];
  const warns: string[] = [];
  const say = (ok: boolean, msg: string) => console.log(`  ${ok ? "✓" : "✗"} ${msg}`);

  console.log(`\nValidating ${dir}`);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) { console.log(`  ✗ not a directory`); return false; }

  const name = basename(dir.replace(/\/$/, ""));
  const nameOk = DIR_RE.test(name);
  say(nameOk, `directory name "${name}" ${nameOk ? "matches" : "must match"} <YYYYMMDD>_<org>_<model>`);
  if (!nameOk) errs.push("name");

  const files = readdirSync(dir);
  const expectedCases = loadBench().cases.length;
  const wantSha = datasetSha();

  for (const mode of ["plain", "ex"] as const) {
    const f = join(dir, `convert-${mode}.json`);
    if (!existsSync(f)) { say(false, `convert-${mode}.json present`); errs.push(`missing convert-${mode}.json`); continue; }
    let j: any;
    try { j = JSON.parse(readFileSync(f, "utf8")); } catch (e) { say(false, `convert-${mode}.json parses`); errs.push(`bad json ${mode}`); continue; }
    say(true, `convert-${mode}.json present`);

    const full = j.cases === expectedCases && j.total === expectedCases;
    say(full, `  ${mode}: all ${expectedCases} cases (got cases=${j.cases}, total=${j.total})`);
    if (!full) errs.push(`${mode} incomplete`);

    const sha = j.run?.dataset_sha256;
    if (!sha) { say(false, `  ${mode}: run.dataset_sha256 recorded`); errs.push(`${mode} no dataset sha`); }
    else if (sha !== wantSha) { say(false, `  ${mode}: dataset sha matches this repo's test.jsonl`); errs.push(`${mode} dataset mismatch — scored against a different dataset`); }
    else say(true, `  ${mode}: dataset sha matches`);

    for (const k of ["score", "strictScore"]) {
      if (typeof j[k] !== "number") { say(false, `  ${mode}: ${k} is a number`); errs.push(`${mode} ${k}`); }
    }
    if (j.results?.length !== expectedCases) { say(false, `  ${mode}: results[] has ${expectedCases} rows (got ${j.results?.length})`); errs.push(`${mode} results length`); }

    const resp = files.includes(`convert-${mode}.responses.jsonl`);
    if (!resp) warns.push(`${mode}: no responses.jsonl — rerun with --save-responses so failures can be audited`);
  }

  if (!files.includes("README.md")) warns.push("no README.md — say how the model was served (vLLM? hosted API? quantisation?)");

  for (const w of warns) console.log(`  ⚠ ${w}`);
  if (errs.length) { console.log(`\n✗ ${errs.length} problem(s): ${errs.join("; ")}\n`); return false; }
  console.log(`\n✓ submission looks good${warns.length ? ` (${warns.length} warning(s))` : ""}\n`);
  return true;
}
