#!/usr/bin/env -S bun
/** format-bench CLI: run | gold | list | validate-submission. */
import { Command } from "commander";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { ROOT, PROVIDERS, loadProvider, loadEnv } from "./providers.js";
import { runOne, runGold, loadBench, datasetSha, HARNESS_VERSION } from "./run.js";
import { validateSubmission } from "./submission.js";

loadEnv();
const program = new Command();
program
  .name("format-bench")
  .version(HARNESS_VERSION)
  .description("Benchmark models on data-format conversion: text/JSON/YAML/CSV → JSON/YAML/CSV");

program
  .command("run")
  .description("evaluate a model against the convert bench (one mode per invocation)")
  .option("--provider <id>", "provider id from providers.ts / providers.local.json (nvidia, groq, llama, …)")
  .option("--base-url <url>", "OpenAI-compatible base URL — use instead of --provider for any endpoint")
  .option("--api-key <key>", "API key for --base-url (default: $FORMAT_BENCH_API_KEY)")
  .option("--local", "shortcut for --provider llama (llama-server on localhost:8091)")
  .option("-m, --model <id>", "model id sent as the API `model` field", "")
  .option("--explain", "explained mode: prepend a worked demo from the train split (default: plain)")
  .option("--repeat <n>", "run each case N times and average", (v) => parseInt(v, 10), 1)
  .option("--temperature <t>", "sampling temperature", (v) => parseFloat(v), 0)
  .option("--max-tokens <n>", "output ceiling; a reply cut off here is an ERROR, not a wrong answer", (v) => parseInt(v, 10), 32768)
  .option("--thinking <level>", "reasoning_effort (low|medium|high) — recorded as a distinct row")
  .option("--save-responses", "write every full reply to convert-<mode>.responses.jsonl (default: off)")
  .option("--limit <n>", "cap the number of cases (smoke tests)", (v) => parseInt(v, 10))
  .option("--concurrency <n>", "parallel in-flight requests", (v) => parseInt(v, 10), 4)
  .action(async (o: any) => {
    // --base-url is the lab-facing path: point it at any OpenAI-compatible endpoint, no repo edits needed.
    let provider: string | undefined = o.local ? "llama" : o.provider;
    if (o.baseUrl) {
      provider = "custom";
      PROVIDERS.custom = { id: "custom", label: "custom", apiKeyEnv: "FORMAT_BENCH_API_KEY", base: { openai: o.baseUrl.replace(/\/$/, "") }, free: false };
      if (o.apiKey) process.env.FORMAT_BENCH_API_KEY = o.apiKey;
    }
    if (!provider) { console.error("pass --provider <id>, --base-url <url>, or --local"); process.exit(1); }
    loadProvider(provider);
    let model = o.model || (o.local ? "local" : "");
    if (!model) { console.error("pass -m <model>"); process.exit(1); }
    // --local: -m "Org/Model" buckets the run under provider "Org" (llama-server serves whatever GGUF is loaded).
    let providerLabel: string | undefined;
    if (o.local && model.includes("/")) { const i = model.indexOf("/"); providerLabel = model.slice(0, i); model = model.slice(i + 1); }
    await runOne({
      provider, model, providerLabel, repeat: o.repeat, temperature: o.temperature, thinking: o.thinking,
      limit: o.limit, concurrency: o.concurrency, explain: o.explain,
      saveResponses: o.saveResponses, maxTokens: o.maxTokens,
    });
  });

program
  .command("gold")
  .description("score the dataset's own reference answers — must be 2025/2025 (proves the harness works)")
  .action(() => { process.exit(runGold() ? 0 : 1); });

program
  .command("list")
  .description("list the dataset, providers, and free-model lists")
  .action(() => {
    const b = loadBench();
    console.log(`Dataset: convert — ${b.cases.length} cases`);
    console.log(`  sha256 ${datasetSha()}`);
    console.log("\nProviders (openai base + key env):");
    for (const p of Object.values(PROVIDERS)) console.log(`  ${p.id.padEnd(12)} ${p.base.openai ?? "—"}  [${p.apiKeyEnv}${process.env[p.apiKeyEnv] ? " ✓" : ""}]`);
    console.log("\nFree-model lists:");
    for (const id of ["zenmux", "opencode", "nvidia", "openrouter", "googleai"]) {
      const f = join(ROOT, `models.${id}-free.txt`);
      if (existsSync(f)) console.log(`  ${id.padEnd(12)} ${readFileSync(f, "utf8").split("\n").filter((l) => l.trim() && !l.startsWith("#")).length} model(s)`);
    }
  });

program
  .command("validate-submission <dir>")
  .description("check a results/<date>_<org>_<model>/ dir before opening a PR")
  .action((dir: string) => { process.exit(validateSubmission(dir) ? 0 : 1); });

program.parseAsync();
