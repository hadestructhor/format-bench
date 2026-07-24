/**
 * Fetch REAL brand logos for each model family and bake them into scripts/logos.json (data, no network at render time).
 * Preference: Simple Icons (crisp official vector marks, viewBox 0 0 24 24 → drawn in white on the family badge);
 * fallback: the brand's real favicon via Google's favicon service (full-colour PNG on a white inset).
 * Run: bun scripts/fetch-logos.ts   (re-run only when the family set changes; output is committed as data).
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../providers.js";

// tag → { si?: Simple-Icons slug, domain?: favicon domain }. si tried first, domain is the fallback.
const SRC: Record<string, { si?: string; domain?: string }> = {
  "GPT-OSS": { si: "openai", domain: "openai.com" },
  "Nemotron": { si: "nvidia", domain: "nvidia.com" },
  "Gemma": { si: "googlegemini", domain: "gemini.google.com" },
  "DiffGemma": { si: "googlegemini", domain: "gemini.google.com" },
  "Hermes": { domain: "nousresearch.com" },
  "Dolphin": { domain: "huggingface.co" },
  "Llama": { si: "meta", domain: "meta.com" },
  "Qwen": { si: "qwen", domain: "qwen.ai" },
  "Granite": { si: "ibm", domain: "ibm.com" },
  "SmolLM": { domain: "huggingface.co" },
  "Phi": { domain: "microsoft.com" },
  "Mixtral": { si: "mistralai", domain: "mistral.ai" },
  "Hy3": { domain: "tencent.com" },
  "Laguna": { domain: "poolside.ai" },
  "StepFun": { domain: "stepfun.com" },
  "MiniMax": { domain: "minimax.io" },
  "DeepSeek": { si: "deepseek", domain: "deepseek.com" },
  "LFM2": { domain: "liquid.ai" },
  "NuExtract": { domain: "numind.ai" },
  "Osmosis": { domain: "osmosis.ai" },
  "MiMo": { si: "xiaomi", domain: "mi.com" },
  "NorthMini": { si: "cohere", domain: "cohere.com" },
};

async function siPath(slug: string): Promise<string | null> {
  for (const url of [`https://cdn.jsdelivr.net/npm/simple-icons/icons/${slug}.svg`, `https://cdn.simpleicons.org/${slug}`]) {
    try {
      const r = await fetch(url);
      if (!r.ok) continue;
      const svg = await r.text();
      const m = svg.match(/<path[^>]*\sd="([^"]+)"/i);
      if (m && /^[Mm]/.test(m[1]) && m[1].length > 30) return m[1];
    } catch { /* try next */ }
  }
  return null;
}
async function favicon(domain: string): Promise<string | null> {
  try {
    const r = await fetch(`https://www.google.com/s2/favicons?domain=${domain}&sz=64`);
    if (!r.ok) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length < 120) return null; // google returns a tiny globe placeholder when it has nothing real
    return `data:image/png;base64,${buf.toString("base64")}`;
  } catch { return null; }
}

const out: Record<string, { kind: "svg"; d: string } | { kind: "img"; uri: string }> = {};
const report: string[] = [];
for (const [tag, s] of Object.entries(SRC)) {
  let done = false;
  if (s.si) { const d = await siPath(s.si); if (d) { out[tag] = { kind: "svg", d }; report.push(`  ${tag.padEnd(11)} ✓ simple-icons/${s.si}`); done = true; } }
  if (!done && s.domain) { const uri = await favicon(s.domain); if (uri) { out[tag] = { kind: "img", uri }; report.push(`  ${tag.padEnd(11)} ✓ favicon ${s.domain} (${Math.round(uri.length / 1.37)}b)`); done = true; } }
  if (!done) report.push(`  ${tag.padEnd(11)} ✗ no logo → keeps drawn glyph`);
}
writeFileSync(join(ROOT, "scripts", "logos.json"), JSON.stringify(out));
console.log(report.join("\n"));
console.log(`\n${Object.keys(out).length}/${Object.keys(SRC).length} logos → scripts/logos.json`);
