import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { GatewayConfig } from "./gateway";

/** Where the user-editable pool config lives. */
export const CONFIG_PATH = join(homedir(), ".pi", "agent", "free-router.json");

/**
 * Default pool. Ships with a keyless provider enabled (works with zero setup)
 * and a catalog of free-tier providers DISABLED — flip `enabled: true` and set
 * the matching `$ENV` key to activate. Model ids should be verified on each
 * provider's dashboard; they change over time.
 */
export function defaultConfig(): GatewayConfig {
  return {
    port: 8731,
    strategy: "priority",
    cooldownMs: 60000,
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
      {
        id: "groq",
        label: "Groq (keyed, tools)",
        baseUrl: "https://api.groq.com/openai",
        apiKey: "$GROQ_API_KEY",
        model: "llama-3.3-70b-versatile",
        piModel: "fr-groq-70b",
        contextWindow: 128000,
        maxTokens: 4096,
        supportsTools: true,
        enabled: false,
      },
      {
        id: "deepseek",
        label: "DeepSeek (keyed, tools)",
        baseUrl: "https://api.deepseek.com/v1",
        apiKey: "$DEEPSEEK_API_KEY",
        model: "deepseek-chat",
        piModel: "fr-deepseek-chat",
        contextWindow: 128000,
        maxTokens: 4096,
        supportsTools: true,
        enabled: false,
      },
      {
        id: "together",
        label: "Together (keyed, tools)",
        baseUrl: "https://api.together.xyz/v1",
        apiKey: "$TOGETHER_API_KEY",
        model: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
        piModel: "fr-together-llama33",
        contextWindow: 128000,
        maxTokens: 4096,
        supportsTools: true,
        enabled: false,
      },
      {
        id: "openrouter",
        label: "OpenRouter (keyed, tools, aggregator)",
        baseUrl: "https://openrouter.ai/api/v1",
        apiKey: "$OPENROUTER_API_KEY",
        model: "openai/gpt-4o-mini",
        piModel: "fr-openrouter-gpt4o-mini",
        contextWindow: 128000,
        maxTokens: 4096,
        supportsTools: true,
        enabled: false,
      },
      {
        id: "cerebras",
        label: "Cerebras (keyed, tools)",
        baseUrl: "https://api.cerebras.ai/v1",
        apiKey: "$CEREBRAS_API_KEY",
        model: "llama3.3-70b",
        piModel: "fr-cerebras-llama33",
        contextWindow: 128000,
        maxTokens: 4096,
        supportsTools: true,
        enabled: false,
      },
      {
        id: "nvidia-nim",
        label: "NVIDIA NIM (keyed)",
        baseUrl: "https://integrate.api.nvidia.com/v1",
        apiKey: "$NVIDIA_NIM_API_KEY",
        model: "meta/llama-3.3-70b-instruct",
        piModel: "fr-nim-llama33",
        contextWindow: 128000,
        maxTokens: 4096,
        supportsTools: false,
        enabled: false,
      },
      {
        id: "deepinfra",
        label: "DeepInfra (keyed, tools)",
        baseUrl: "https://api.deepinfra.com/v1/openai",
        apiKey: "$DEEPINFRA_API_KEY",
        model: "meta-llama/Llama-3.3-70B-Instruct",
        piModel: "fr-deepinfra-llama33",
        contextWindow: 128000,
        maxTokens: 4096,
        supportsTools: true,
        enabled: false,
      },
      {
        id: "mistral",
        label: "Mistral (keyed, tools)",
        baseUrl: "https://api.mistral.ai/v1",
        apiKey: "$MISTRAL_API_KEY",
        model: "mistral-small-latest",
        piModel: "fr-mistral-small",
        contextWindow: 128000,
        maxTokens: 4096,
        supportsTools: true,
        enabled: false,
      },
      {
        id: "siliconflow",
        label: "SiliconFlow (keyed, tools)",
        baseUrl: "https://api.siliconflow.cn/v1",
        apiKey: "$SILICONFLOW_API_KEY",
        model: "Qwen/Qwen2.5-72B-Instruct",
        piModel: "fr-siliconflow-qwen",
        contextWindow: 128000,
        maxTokens: 4096,
        supportsTools: true,
        enabled: false,
      },
      {
        id: "llm7",
        label: "LLM7 (keyless, no signup)",
        baseUrl: "https://api.llm7.io/v1",
        apiKey: "",
        model: "llama-3.3-70b",
        piModel: "fr-llm7",
        contextWindow: 128000,
        maxTokens: 4096,
        supportsTools: false,
        enabled: false,
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
