/**
 * The one model-calling primitive: a direct OpenAI-compatible chat completion. This is the whole
 * "runner seam" — swap httpRunner for a transformers.js (in-process) runner later without touching
 * run.ts / score.ts. Local llama-server is just another provider, no special case.
 */
import { PROVIDERS } from "./providers.js";

export type Msg = { role: "system" | "user" | "assistant"; content: string };
/** finishReason is surfaced so the caller can tell "the model answered" from "we cut it off" (see run.ts). */
export type Runner = (messages: Msg[], opts?: { maxTokens?: number }) => Promise<{ text: string; usage?: any; finishReason?: string }>;

// Provider-wide minimum spacing between requests (e.g. OVH free = 2 RPM → minIntervalMs 31000). A per-provider
// promise chain serialises calls so even at concurrency>1 we never exceed the cap. No-op when minMs is 0.
const gateChain: Record<string, Promise<void>> = {};
const gateNext: Record<string, number> = {};
function rateGate(providerId: string, minMs: number): Promise<void> {
  if (!minMs) return Promise.resolve();
  const next = (gateChain[providerId] ?? Promise.resolve()).then(async () => {
    const wait = Math.max(0, (gateNext[providerId] ?? 0) - Date.now());
    if (wait) await new Promise((r) => setTimeout(r, wait));
    gateNext[providerId] = Date.now() + minMs;
  });
  gateChain[providerId] = next.catch(() => {});
  return next;
}

export function httpRunner(providerId: string, model: string, temperature = 0, reasoningEffort?: string, maxTokens = 32768): Runner {
  const p = PROVIDERS[providerId];
  if (!p?.base.openai) throw new Error(`provider '${providerId}' has no openai base`);
  const key = process.env[p.apiKeyEnv]; // llama-server: unset is fine (dummy Bearer)
  const local = /localhost|127\.0\.0\.1/.test(p.base.openai ?? ""); // local llama-server: no timeout, just wait
  const minIntervalMs = p.minIntervalMs ?? 0; // provider rate cap (OVH free = 2 RPM); enforced by rateGate
  const api = p.api === "responses" ? "responses" : "chat"; // default OpenAI chat/completions; some routers only speak the Responses API
  const path = api === "responses" ? "/responses" : "/chat/completions";
  let temp = temperature; // some gateways (e.g. NVIDIA gemma) reject temperature:0 with 422 → bumped to 0.01 below
  const body = (m: Msg[], mt?: number) => {
    // Generous by default. A cap tight enough to cut a reply is a measurement bug: a reasoning model spends
    // its budget thinking and gets scored 0 for an answer it never got to write. run.ts treats a
    // finish_reason of "length" as an error rather than a wrong answer, and this ceiling keeps that rare.
    const max = mt ?? maxTokens;
    return api === "responses" // Responses API: messages go in `input`, cap is `max_output_tokens`, reasoning nests under `reasoning.effort`
      ? JSON.stringify({ model, input: m, temperature: temp, max_output_tokens: max, ...(reasoningEffort ? { reasoning: { effort: reasoningEffort } } : {}) })
      : JSON.stringify({ model, messages: m, temperature: temp, max_tokens: max, ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}) });
  };
  return async (messages, opts = {}) => {
    await rateGate(providerId, minIntervalMs); // pace to the provider's cap before spending a request
    // Retry on 429/5xx with backoff (honours Retry-After) — free gateways like NVIDIA throttle hard.
    for (let attempt = 0; ; attempt++) {
      const controller = new AbortController();
      const timer = local ? null : setTimeout(() => controller.abort(), 300_000); // slow local models run to completion
      try {
        const r = await fetch(`${p.base.openai}${path}`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${key || ""}` }, // keyless (llama-server, OVH anonymous): empty bearer — OVH 403s on the literal "none"
          body: body(messages, opts.maxTokens),
          signal: controller.signal,
        });
        if ((r.status === 429 || r.status >= 500) && attempt < 6) {
          const wait = (Number(r.headers.get("retry-after")) || Math.min(30, 2 ** attempt)) * 1000;
          await new Promise((res) => setTimeout(res, wait));
          continue;
        }
        if (r.status === 422 && temp === 0) { // model requires temperature > 0 (e.g. NVIDIA gemma) → bump to near-greedy and retry
          const txt = await r.text();
          if (/temperature/i.test(txt)) { temp = 0.01; continue; }
          throw new Error(`HTTP 422: ${txt.replace(/\s+/g, " ").slice(0, 160)}`);
        }
        if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).replace(/\s+/g, " ").slice(0, 160)}`);
        const j: any = await r.json();
        const text = api === "responses" // Responses API returns output_text (convenience) or output[].content[].text
          ? (j.output_text ?? (Array.isArray(j.output) ? j.output.flatMap((o: any) => o?.content ?? []).map((c: any) => c?.text ?? "").join("") : ""))
          : (j.choices?.[0]?.message?.content ?? "");
        // "length" here means the ceiling truncated the reply. Providers spell the field differently.
        const finishReason = api === "responses"
          ? (j.incomplete_details?.reason === "max_output_tokens" ? "length" : j.status)
          : j.choices?.[0]?.finish_reason;
        return { text, usage: j.usage, finishReason };
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
  };
}

