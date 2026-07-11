import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { GatewayConfig } from "./gateway";

/** Where the user-editable pool config lives. */
export const CONFIG_PATH = join(homedir(), ".pi", "agent", "free-router.json");

/**
 * Default pool = Pollinations, which needs NO API key. This means the
 * extension works the moment it's loaded — the "$0 to start" promise.
 *
 * To add paid/keyed free tiers (Groq, Together, DeepSeek, OpenRouter, …),
 * edit free-router.json and add entries with an `apiKey` (env or literal).
 */
export function defaultConfig(): GatewayConfig {
  return {
    port: 8731,
    strategy: "priority",
    providers: [
      {
        id: "pollinations",
        label: "Pollinations (keyless)",
        baseUrl: "https://text.pollinations.ai/openai",
        apiKey: "",
        model: "openai-fast",
        piModel: "fr-pollinations-fast",
        contextWindow: 128000,
        maxTokens: 4096,
        supportsTools: false,
        enabled: true,
      },
    ],
  };
}

/** Load config, writing the default if it doesn't exist yet. */
export function loadConfig(): GatewayConfig {
  if (!existsSync(CONFIG_PATH)) {
    mkdirSync(dirname(CONFIG_PATH), { recursive: true });
    writeFileSync(CONFIG_PATH, JSON.stringify(defaultConfig(), null, 2));
  }
  return JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
}
