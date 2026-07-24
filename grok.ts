import { spawn } from "node:child_process";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Runner, Msg } from "./call.ts";

/**
 * Runner that drives the installed Grok CLI (free X-account tier → model grok-4.5-build-free) in headless
 * single-turn mode: one `grok --prompt-file … --output-format json` subprocess per case, take `.text`.
 * No HTTP/key — auth is the CLI's ~/.grok/auth.json (OIDC, auto-refreshed by the CLI). Heavy: ~14k tokens of
 * agent system-prompt overhead per call, so keep concurrency low (~2) and expect the free quota to cap out.
 * `--cwd <tmp>` isolates it from the repo; `--always-approve` so it never blocks on a tool-permission prompt.
 */
export function grokRunner(_model: string): Runner {
  // The CLI exposes exactly one model (grok-4.5, its default); the run label may differ, so we don't pass -m.
  return async (messages: Msg[]) => {
    const prompt = messages.map((x) => x.content).join("\n\n"); // system + user → one self-contained prompt
    const dir = mkdtempSync(join(tmpdir(), "grok-"));
    const pf = join(dir, "prompt.txt");
    writeFileSync(pf, prompt);
    try {
      const out: string = await new Promise((resolve, reject) => {
        const ch = spawn("grok", ["--prompt-file", pf, "--output-format", "json", "--cwd", dir, "--always-approve"],
          { stdio: ["ignore", "pipe", "ignore"] });
        let buf = "";
        const timer = setTimeout(() => { ch.kill("SIGKILL"); reject(new Error("grok CLI timeout")); }, 180_000);
        ch.stdout.on("data", (d) => (buf += d));
        ch.on("error", (e) => { clearTimeout(timer); reject(e); });
        ch.on("close", () => { clearTimeout(timer); resolve(buf); });
      });
      let j: any; try { j = JSON.parse(out); } catch { throw new Error(`grok non-JSON: ${out.replace(/\s+/g, " ").slice(0, 160)}`); }
      // CRITICAL: on a cap/error the CLI returns {type:"error",message:"…free … usage limit …"} with NO .text.
      // Must THROW (so run.ts errors the case, doesn't checkpoint an empty "answer" that scores 0 as if real).
      if (j.type === "error" || typeof j.text !== "string") throw new Error(`grok CLI: ${String(j.message ?? out).replace(/\s+/g, " ").slice(0, 160)}`);
      return { text: j.text, usage: j.usage };
    } finally { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } }
  };
}
