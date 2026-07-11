import http from "node:http";

/**
 * Free Router gateway — a tiny, dependency-free, OpenAI-compatible proxy.
 *
 * It accepts Pi's OpenAI-completions requests on localhost and fans them out
 * across a pool of (mostly free-tier) providers with automatic fallback.
 *
 * This module has NO dependency on Pi, so it can be tested standalone with
 * `bun smoke.ts` without a running Pi session.
 */

export interface ProviderEntry {
  id: string;
  label: string;
  /** Upstream OpenAI-compatible base, e.g. https://text.pollinations.ai/openai */
  baseUrl: string;
  /** Empty / undefined = keyless provider */
  apiKey?: string;
  /** Upstream model id, e.g. openai-fast */
  model: string;
  /** Pi-facing model id, e.g. fr-pollinations-fast */
  piModel: string;
  contextWindow: number;
  maxTokens: number;
  supportsTools: boolean;
  enabled: boolean;
}

export type Strategy = "priority" | "round-robin" | "random";

export interface GatewayConfig {
  port: number;
  strategy: Strategy;
  providers: ProviderEntry[];
}

export interface GatewayHandle {
  port: number;
  close(): void;
}

function chatUrl(base: string): string {
  return base.replace(/\/+$/, "") + "/chat/completions";
}

export function createGateway(config: GatewayConfig) {
  const enabled = () => config.providers.filter((p) => p.enabled);
  const byPiModel = new Map<string, ProviderEntry>();
  for (const p of enabled()) byPiModel.set(p.piModel, p);

  let server: http.Server | null = null;
  let rr = 0;

  /** Build the ordered candidate list for a requested Pi model. */
  function order(piModel: string): ProviderEntry[] {
    const list = enabled();
    const req = byPiModel.get(piModel);
    if (config.strategy === "round-robin" && list.length) {
      const start = rr++ % list.length;
      return [...list.slice(start), ...list.slice(0, start)];
    }
    if (config.strategy === "random" && list.length) {
      return [...list].sort(() => Math.random() - 0.5);
    }
    if (req) return [req, ...list.filter((p) => p !== req)];
    return list;
  }

  async function handleChat(
    _req: http.IncomingMessage,
    res: http.ServerResponse,
    raw: string,
  ) {
    let parsed: any;
    try {
      parsed = JSON.parse(raw);
    } catch {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "invalid json body" }));
      return;
    }

    const candidates = order(parsed.model);
    if (!candidates.length) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: `unknown model ${parsed.model}` }));
      return;
    }

    const piWantsStream = parsed.stream === true;

    for (const prov of candidates) {
      const upstreamBody: any = { ...parsed, model: prov.model, stream: false };
      // Providers that can't do tool calls would 400 on `tools`; strip them.
      if (!prov.supportsTools) {
        delete upstreamBody.tools;
        delete upstreamBody.tool_choice;
      }
      try {
        const r = await fetch(chatUrl(prov.baseUrl), {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(prov.apiKey ? { authorization: `Bearer ${prov.apiKey}` } : {}),
          },
          body: JSON.stringify(upstreamBody),
          // Abort if this provider is slow/hung (15s). Client-disconnect is
          // handled by the read-loop throwing once res is closed.
          signal: AbortSignal.timeout(15000),
        });

        // 429 / 5xx → try the next provider.
        if (!r.ok) continue;

        // Always read upstream non-streaming (some runtimes' fetch streaming
        // hangs on certain providers). We re-emit SSE to Pi below.
        let data: any;
        try {
          data = await r.json();
        } catch {
          continue; // non-JSON body → unusable
        }
        if (data && data.error) continue; // error-as-200

        if (!piWantsStream) {
          res.writeHead(200, {
            "content-type": "application/json",
            "x-free-router-provider": prov.id,
          });
          res.end(JSON.stringify(data));
          return;
        }

        // Re-emit as OpenAI SSE chunks.
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          "x-free-router-provider": prov.id,
        });
        const choice = data.choices?.[0] ?? {};
        const msg = choice.message ?? {};
        const cid = data.id ?? "fr";
        const cmodel = data.model ?? prov.model;
        const ccreated = data.created ?? 0;
        const chunk = (delta: any, finish_reason: string | null = null) =>
          "data: " +
          JSON.stringify({
            id: cid,
            object: "chat.completion.chunk",
            created: ccreated,
            model: cmodel,
            choices: [{ index: 0, delta, finish_reason }],
          }) +
          "\n\n";

        if (msg.role) res.write(chunk({ role: msg.role }));
        if (msg.content) {
          // Emit in word-ish pieces for a smoother streaming feel.
          const pieces = msg.content.match(/\S+\s*/g) ?? [msg.content];
          for (const p of pieces) res.write(chunk({ content: p }));
        }
        if (Array.isArray(msg.tool_calls)) {
          msg.tool_calls.forEach((tc: any, i: number) => {
            res.write(
              chunk({
                tool_calls: [
                  {
                    index: i,
                    id: tc.id,
                    type: "function",
                    function: {
                      name: tc.function?.name,
                      arguments: tc.function?.arguments ?? "",
                    },
                  },
                ],
              }),
            );
          });
        }
        res.write(
          chunk({}, (choice.finish_reason as string) ?? "stop"),
        );
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      } catch {
        // Network error / timeout / abort → next provider.
        continue;
      }
    }

    if (!res.headersSent) {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "all free-router providers failed" }));
    } else {
      res.end();
    }
  }

  async function start(): Promise<GatewayHandle> {
    server = http.createServer((req, res) => {
      const url = (req.url || "/").split("?")[0];

      if (
        req.method === "POST" &&
        (url === "/v1/chat/completions" || url === "/chat/completions")
      ) {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => handleChat(req, res, body));
        return;
      }

      if (
        req.method === "GET" &&
        (url === "/v1/models" || url === "/models")
      ) {
        const data = enabled().map((p) => ({
          id: p.piModel,
          object: "model",
          created: 0,
          owned_by: "free-router",
          label: p.label,
        }));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ object: "list", data }));
        return;
      }

      if (url === "/" || url === "/healthz") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("free-router ok");
        return;
      }

      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
    });

    await new Promise<void>((resolve, reject) => {
      server!.once("error", reject);
      server!.listen(config.port, "127.0.0.1", () => resolve());
    }).catch((err: any) => {
      // Another Pi session likely already owns this port — that's fine, the
      // registered provider will route to it.
      if (err?.code === "EADDRINUSE") {
        return { port: config.port, close() {} } as GatewayHandle;
      }
      throw err;
    });

    return {
      port: config.port,
      close() {
        try {
          server?.close();
        } catch {}
        server = null;
      },
    };
  }

  return { start };
}
