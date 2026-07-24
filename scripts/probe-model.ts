/**
 * Saturation preflight: one cheap 1-token call to a hosted model. Reuses the real provider table
 * (base URL + api key, local JSON merged) so auth matches a real run. Exit 0 = responsive (HTTP 200),
 * exit 1 = saturated/dead (429/5xx/4xx, or hang → AbortError). Used by convert-hosted.sh to skip a
 * saturated model instead of blocking the lane for hours on retries.
 */
import { PROVIDERS, loadEnv } from "../providers.ts";
loadEnv();

const [prov, model] = process.argv.slice(2);
const p = PROVIDERS[prov];
if (!p?.base.openai) { console.error(`no openai base for provider '${prov}'`); process.exit(1); }
const key = process.env[p.apiKeyEnv] || "none";

// Mirrors call.ts semantics so a PASS predicts a real-run success. Failure modes:
//  • HANG (timeout / 000) or 404  → dead/unhosted → SKIP (this is what blocks a lane for hours).
//  • 422 on temperature           → model requires temp > 0 (e.g. NVIDIA gemma) → bump to 0.01 and retry (call.ts does the same).
//  • 429 / 5xx                    → transient burst limit (recovers → PASS) OR persistent free-tier cap (e.g. grok → SKIP). Retry a few times.
let temp = 0;
async function once(): Promise<{ ok: boolean; retry: boolean; why: string }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30_000); // healthy cold-starts (llama-3.3-70b ~24s) still pass
  try {
    const r = await fetch(`${p.base.openai}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }], max_tokens: 4, temperature: temp }),
      signal: ctrl.signal,
    });
    if (r.ok) return { ok: true, retry: false, why: `HTTP ${r.status}` };            // responsive
    if (r.status === 422 && temp === 0 && /temperature/i.test(await r.text())) { temp = 0.01; return { ok: false, retry: true, why: "422 temp→0.01" }; }
    if (r.status === 429 || r.status >= 500) return { ok: false, retry: true, why: `HTTP ${r.status}` }; // throttled → maybe transient
    return { ok: false, retry: false, why: `HTTP ${r.status}` };                     // 4xx (404 etc.) → dead
  } catch (e: any) {
    return { ok: false, retry: false, why: e?.name || String(e) };                   // AbortError/timeout → hang → dead
  } finally { clearTimeout(timer); }
}

for (let attempt = 0; attempt < 4; attempt++) {
  const r = await once();
  if (r.ok) { console.log(`ok ${r.why}`); process.exit(0); }
  if (!r.retry) { console.error(`skip ${r.why}`); process.exit(1); }
  if (r.why.startsWith("422")) continue;                                             // temp bump: retry immediately, no backoff
  if (attempt < 3) await new Promise((res) => setTimeout(res, 3000 + attempt * 3000)); // 3s,6s,9s — clear a burst limit
  else { console.error(`skip persistent ${r.why}`); process.exit(1); }               // still throttled after retries → capped
}
