/**
 * Rate-limit prober: drip tiny chat requests at a fixed interval and record every rate-limit-ish response
 * header + any error body, so we can SEE how a provider signals its limits (limit/remaining/reset, Retry-After)
 * and when it flips to 429. Read-only w.r.t. the benchmark — writes only its own log.
 *   bun scripts/ratelimit-probe.ts <provider> <model> [count=60] [intervalMs=2000]
 * e.g. bun scripts/ratelimit-probe.ts groq llama-3.1-8b-instant 60 2000
 */
import { PROVIDERS, loadEnv } from "../providers.ts";
import { appendFileSync } from "node:fs";
loadEnv();
const [prov, model, countS, intS, concS] = process.argv.slice(2);
if (!prov || !model) { console.error("usage: ratelimit-probe.ts <provider> <model> [count] [intervalMs] [concurrency]"); process.exit(1); }
const count = Number(countS) || 60, interval = Number(intS) || 2000, conc = Number(concS) || 1; // conc>1 = fire in bursts of `conc` (find the ceiling on providers that hide their limit, e.g. nvidia)
const p: any = PROVIDERS[prov];
if (!p?.base?.openai) { console.error(`unknown provider '${prov}' or no openai base`); process.exit(1); }
const key = process.env[p.apiKeyEnv] || "";
const url = `${p.base.openai}/chat/completions`;
const out = `runs/.ratelimit-${prov}.jsonl`;
const HDR = /ratelimit|rate.?limit|retry-after|reset|remaining|quota|x-request-id|x-groq|cf-ray|x-served-by/i;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const g = (h: Record<string, string>, k: string) => h[k] ?? "";
let first429 = -1, oks = 0, limited = 0;
async function probe(i: number) {
  const t0 = Date.now();
  let status = 0; const hdrs: Record<string, string> = {}; let body = "";
  try {
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }], max_tokens: 1, temperature: 0 }) });
    status = r.status;
    r.headers.forEach((v, k) => { if (process.env.ALL_HEADERS === "1" || HDR.test(k)) hdrs[k.toLowerCase()] = v; }); // ALL_HEADERS=1 → capture every header (discover a provider's vocab)
    if (status !== 200) body = (await r.text()).replace(/\s+/g, " ").slice(0, 220);
  } catch (e: any) { status = -1; body = String(e?.name || e); }
  if (status === 200) oks++; if (status === 429) { limited++; if (first429 < 0) first429 = i; }
  appendFileSync(out, JSON.stringify({ i, t: new Date().toISOString(), ms: Date.now() - t0, status, ...hdrs, ...(body ? { body } : {}) }) + "\n");
  const parts = [
    g(hdrs, "x-ratelimit-remaining-requests") && `req_left=${g(hdrs, "x-ratelimit-remaining-requests")}/${g(hdrs, "x-ratelimit-limit-requests")}`,
    g(hdrs, "x-ratelimit-remaining-tokens") && `tok_left=${g(hdrs, "x-ratelimit-remaining-tokens")}/${g(hdrs, "x-ratelimit-limit-tokens")}`,
    g(hdrs, "x-ratelimit-reset-requests") && `req_reset=${g(hdrs, "x-ratelimit-reset-requests")}`,
    g(hdrs, "retry-after") && `retry-after=${g(hdrs, "retry-after")}`,
  ].filter(Boolean).join(" ");
  console.log(`  #${String(i).padStart(2)} ${status} ${Date.now() - t0}ms ${parts}${body ? " · " + body.slice(0, 90) : ""}`);
}
console.log(`▶ probe ${prov}/${model} — ${count} reqs${conc > 1 ? ` in bursts of ${conc}` : ""} @ ${interval}ms · key=${key ? "set" : "none"} · → ${out}\n`);
if (conc > 1) {                                    // burst mode: fire `conc` at once, pause `interval`, repeat
  for (let base = 0; base < count; base += conc) {
    await Promise.all([...Array(Math.min(conc, count - base))].map((_, j) => probe(base + j)));
    if (base + conc < count) await sleep(interval);
  }
} else for (let i = 0; i < count; i++) { const t0 = Date.now(); await probe(i); if (i < count - 1) await sleep(Math.max(0, interval - (Date.now() - t0))); }
console.log(`\n✔ done · ${oks} ok · ${limited} rate-limited · first 429 @ #${first429 < 0 ? "none" : first429} · full log ${out}`);
