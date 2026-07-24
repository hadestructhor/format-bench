/**
 * Probe each candidate OVH model once (a real tiny convert-style completion), paced ≥31s apart to respect the
 * 2 RPM anonymous cap. Reports which models actually return a completion vs 4xx/5xx/hang. Read-only — no runs written.
 * Run: bun scripts/ovh-probe.ts   (~5 min for 8 models; run in background).
 */
import { PROVIDERS, loadEnv } from "../providers.ts";
loadEnv();
const p: any = PROVIDERS.ovh;
const key = process.env.OVH_API_KEY || ""; // anonymous → empty bearer (OVH 403s on the literal "none")
const MODELS = [
  "Mistral-7B-Instruct-v0.3", "Qwen3.5-9B", "Mistral-Nemo-Instruct-2407", "Mistral-Small-3.2-24B-Instruct-2506",
  "Qwen3.6-27B", "Qwen3-Coder-30B-A3B-Instruct", "Qwen3-32B", "Qwen3.5-397B-A17B",
];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function probe(model: string) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 40_000);
    try {
      const r = await fetch(`${p.base.openai}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify({ model, messages: [{ role: "user", content: 'Reply with ONLY this JSON: {"ok":true}' }], max_tokens: 20, temperature: 0 }),
        signal: ctrl.signal,
      });
      const txt = await r.text();
      if (r.status === 429 || r.status >= 500) { // contended free tier → honour retry-after, try again
        const wait = (Number(r.headers.get("retry-after")) || 32) * 1000;
        if (attempt < 2) { await sleep(wait); continue; }
        return `HTTP ${r.status} (throttled after retries)`;
      }
      if (!r.ok) return `HTTP ${r.status}: ${txt.replace(/\s+/g, " ").slice(0, 80)}`;
      let content = "";
      try { content = JSON.parse(txt).choices?.[0]?.message?.content ?? ""; } catch { /* non-json */ }
      return `OK 200 · reply: ${JSON.stringify(content).slice(0, 60)}`;
    } catch (e: any) { if (attempt < 2) { await sleep(32_000); continue; } return `HANG/${e?.name || e}`; }
    finally { clearTimeout(timer); }
  }
  return "unreachable";
}
console.log(`OVH probe — ${MODELS.length} models, ≥31s apart (2 RPM). key=${key === "none" ? "anonymous" : "set"}\n`);
for (let i = 0; i < MODELS.length; i++) {
  const t0 = Date.now();
  const res = await probe(MODELS[i]);
  console.log(`  ${(res.startsWith("OK") ? "✓" : "✗")} ${MODELS[i].padEnd(34)} ${res}`);
  if (i < MODELS.length - 1) await sleep(Math.max(0, 32_000 - (Date.now() - t0)));
}
console.log("\ndone.");
