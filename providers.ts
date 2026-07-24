/**
 * Providers = an OpenAI-compatible endpoint + the env var holding its api key. We only ever use
 * `base.openai`. Local llama-server is just another provider (see providers.local.json). Secrets stay
 * in .env, never here. Add your own gateways in providers.local.json (merged over the built-ins).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const ROOT = import.meta.dirname;

export interface Provider {
  id: string;
  label: string;
  apiKeyEnv: string;
  base: { openai?: string };
  free?: boolean;
  /** Minimum spacing between requests, ms. For hard per-minute caps (OVH free = 2 RPM → 31000). */
  minIntervalMs?: number;
  /** API surface: "chat" (default, /chat/completions) or "responses" (/responses) for routers that only speak it. */
  api?: "chat" | "responses";
}

const BUILTIN: Record<string, Provider> = {
  zenmux: { id: "zenmux", label: "ZenMux", apiKeyEnv: "ZENMUX_API_KEY", base: { openai: "https://zenmux.ai/api/v1" }, free: true },
  openrouter: { id: "openrouter", label: "OpenRouter", apiKeyEnv: "OPENROUTER_API_KEY", base: { openai: "https://openrouter.ai/api/v1" }, free: true },
  groq: { id: "groq", label: "Groq", apiKeyEnv: "GROQ_API_KEY", base: { openai: "https://api.groq.com/openai/v1" }, free: true },
  cerebras: { id: "cerebras", label: "Cerebras", apiKeyEnv: "CEREBRAS_API_KEY", base: { openai: "https://api.cerebras.ai/v1" }, free: true },
  nvidia: { id: "nvidia", label: "NVIDIA", apiKeyEnv: "NVIDIA_API_KEY", base: { openai: "https://integrate.api.nvidia.com/v1" }, free: true },
  mistral: { id: "mistral", label: "Mistral", apiKeyEnv: "MISTRAL_API_KEY", base: { openai: "https://api.mistral.ai/v1" }, free: true },
  googleai: { id: "googleai", label: "Google AI Studio", apiKeyEnv: "GEMINI_API_KEY", base: { openai: "https://generativelanguage.googleapis.com/v1beta/openai" }, free: true },
  opencodezen: { id: "opencodezen", label: "opencode Zen", apiKeyEnv: "OPENCODE_API_KEY", base: { openai: "https://opencode.ai/zen/v1" }, free: true },
  hf: { id: "hf", label: "Hugging Face", apiKeyEnv: "HF_TOKEN", base: { openai: "https://router.huggingface.co/v1" }, free: true },
};

function readLocal(): Record<string, Provider> {
  const f = join(ROOT, "providers.local.json");
  if (!existsSync(f)) return {};
  try { return JSON.parse(readFileSync(f, "utf8")) as Record<string, Provider>; } catch { return {}; }
}

export const PROVIDERS: Record<string, Provider> = { ...BUILTIN, ...readLocal() };

export function loadProvider(id: string): Provider {
  const p = PROVIDERS[id];
  if (!p) throw new Error(`Unknown provider '${id}'. Known: ${Object.keys(PROVIDERS).join(", ")}`);
  return p;
}

/** Minimal .env loader (bun auto-loads from cwd, but this makes runs cwd-independent). Doesn't clobber. */
export function loadEnv(): void {
  const f = join(ROOT, ".env");
  if (!existsSync(f)) return;
  for (const line of readFileSync(f, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
