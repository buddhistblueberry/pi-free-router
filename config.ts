/**
 * Configuration and provider catalog — ported from OmniRoute's provider reference.
 *
 * Ships with a default pool of free-tier providers (curated from
 * OmniRoute's FREE_TIERS + PROVIDER_REFERENCE) and an extensible system.
 * All keyed providers default to DISABLED — enable ones you have keys for.
 *
 * Zero native deps.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { GatewayConfig, ProviderEntry, ComboEntry } from "./gateway";

/** Where the user-editable pool config lives. */
export const CONFIG_PATH = join(homedir(), ".pi", "agent", "free-router.json");

/**
 * The full OmniRoute-inspired provider catalog.
 *
 * Sources:
 * - OmniRoute FREE_TIERS.md (2026-06-17 refresh) — token budgets, free tier types
 * - OmniRoute PROVIDER_REFERENCE.md (v3.8.43) — base URLs, categories, ToS notes
 *
 * All keyed providers are DISABLED by default. Flip `enabled: true` and
 * set the matching API key to activate. Keyless providers (LLM7, Pollinations)
 * are enabled by default for zero-setup use.
 *
 * Fields:
 *   category: "free" | "api-key" | "keyless" | "aggregator" | "oauth" | "local"
 *   freeTierNotes: from OmniRoute's FREE_TIERS table
 *   costPer1MTokens: rough estimate for cost-based routing (0 = free)
 *   avgE2ELatencyMs: rough estimate for latency-based routing
 */
const PROVIDER_CATALOG: ProviderEntry[] = [
  // ── Keyless (no API key needed) ──────────────────────────────────────────
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
    enabled: true,
    category: "keyless",
    freeTierNotes: "~150M tokens/mo, no signup needed (OmniRoute catalog)",
    costPer1MTokens: 0,
    avgE2ELatencyMs: 2000,
  },
  {
    id: "pollinations",
    label: "Pollinations (keyless, no signup)",
    baseUrl: "https://text.pollinations.ai/openai",
    apiKey: "",
    model: "openai-fast",
    piModel: "fr-pollinations-fast",
    contextWindow: 128000,
    maxTokens: 4096,
    supportsTools: false,
    enabled: true,
    category: "keyless",
    freeTierNotes: "Free keyless inference, MIT license (OmniRoute catalog)",
    costPer1MTokens: 0,
    avgE2ELatencyMs: 1500,
  },
  {
    id: "free-model-dev",
    label: "FreeModel.dev (keyless free tier)",
    baseUrl: "https://api.freemodel.dev/v1",
    apiKey: "",
    model: "gpt-4o-mini",
    piModel: "fr-free-model",
    contextWindow: 128000,
    maxTokens: 4096,
    supportsTools: false,
    enabled: true,
    category: "keyless",
    freeTierNotes: "$300 free credits on signup. Access GPT-5.4 and GPT-5.5 (OmniRoute catalog)",
    costPer1MTokens: 0,
    avgE2ELatencyMs: 2000,
  },

  // ── Free-tier with API key ═════════════════════════════════════════════════
  // All disabled by default — enable by setting the env var + flipping enabled

  // Groq — fast inference, good free tier
  {
    id: "groq",
    label: "Groq (free tier, tools)",
    baseUrl: "https://api.groq.com/openai",
    apiKey: "$GROQ_API_KEY",
    model: "llama-3.3-70b-versatile",
    piModel: "fr-groq-70b",
    contextWindow: 128000,
    maxTokens: 4096,
    supportsTools: true,
    enabled: false,
    category: "free",
    freeTierNotes: "~15M tokens/mo, 30 RPM, 14.4K RPD. No credit card (OmniRoute)",
    costPer1MTokens: 0,
    avgE2ELatencyMs: 400,
  },
  {
    id: "groq-fast",
    label: "Groq (fast, free tier)",
    baseUrl: "https://api.groq.com/openai",
    apiKey: "$GROQ_API_KEY",
    model: "llama-3.1-8b-instant",
    piModel: "fr-groq-fast",
    contextWindow: 128000,
    maxTokens: 4096,
    supportsTools: false,
    enabled: false,
    category: "free",
    freeTierNotes: "Groq fast model, same quota as groq",
    costPer1MTokens: 0,
    avgE2ELatencyMs: 150,
  },

  // DeepSeek — 5M free tokens on signup
  {
    id: "deepseek",
    label: "DeepSeek (5M free tokens, tools)",
    baseUrl: "https://api.deepseek.com/v1",
    apiKey: "$DEEPSEEK_API_KEY",
    model: "deepseek-chat",
    piModel: "fr-deepseek-chat",
    contextWindow: 128000,
    maxTokens: 4096,
    supportsTools: true,
    enabled: false,
    category: "free",
    freeTierNotes: "5M free tokens on signup, no credit card (OmniRoute)",
    costPer1MTokens: 0,
    avgE2ELatencyMs: 1200,
  },

  // Google AI Studio (Gemini) — free tier, 1500 req/day
  {
    id: "gemini",
    label: "Google AI Studio (Gemini free tier, tools)",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    apiKey: "$GOOGLE_API_KEY",
    model: "gemini-2.5-flash",
    piModel: "fr-gemini-flash",
    contextWindow: 128000,
    maxTokens: 8192,
    supportsTools: true,
    enabled: false,
    category: "free",
    freeTierNotes: "~60M tokens/mo. 1500 req/day, no credit card (OmniRoute 2026-06-17)",
    costPer1MTokens: 0,
    avgE2ELatencyMs: 800,
  },
  {
    id: "gemini-thinking",
    label: "Gemini (thinking model, free tier)",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    apiKey: "$GOOGLE_API_KEY",
    model: "gemini-2.5-pro",
    piModel: "fr-gemini-pro",
    contextWindow: 128000,
    maxTokens: 8192,
    supportsTools: true,
    enabled: false,
    category: "free",
    freeTierNotes: "Gemini 2.5 Pro (may have rate limits)",
    costPer1MTokens: 0,
    avgE2ELatencyMs: 1500,
  },

  // Together AI
  {
    id: "together",
    label: "Together (free credits, tools)",
    baseUrl: "https://api.together.xyz/v1",
    apiKey: "$TOGETHER_API_KEY",
    model: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
    piModel: "fr-together-llama33",
    contextWindow: 128000,
    maxTokens: 4096,
    supportsTools: true,
    enabled: false,
    category: "free",
    freeTierNotes: "$25 signup credit, then pay-as-you-go (OmniRoute 2026-06-17)",
    costPer1MTokens: 0.10,
    avgE2ELatencyMs: 1200,
  },

  // OpenRouter — aggregator with free models
  {
    id: "openrouter",
    label: "OpenRouter (aggregator, free models, tools)",
    baseUrl: "https://openrouter.ai/api/v1",
    apiKey: "$OPENROUTER_API_KEY",
    model: "openai/gpt-4o-mini",
    piModel: "fr-openrouter-gpt4o-mini",
    contextWindow: 128000,
    maxTokens: 4096,
    supportsTools: true,
    enabled: false,
    category: "aggregator",
    freeTierNotes: "Free models via :free suffix. 20 RPM / 200 RPD free (OmniRoute)",
    costPer1MTokens: 0,
    avgE2ELatencyMs: 1000,
  },
  {
    id: "openrouter-free",
    label: "OpenRouter (free models only)",
    baseUrl: "https://openrouter.ai/api/v1",
    apiKey: "$OPENROUTER_API_KEY",
    model: "gryphe/mythomax-l2-13b:free",
    piModel: "fr-openrouter-free",
    contextWindow: 8192,
    maxTokens: 2048,
    supportsTools: false,
    enabled: false,
    category: "aggregator",
    freeTierNotes: "Free tier models via :free suffix (OmniRoute)",
    costPer1MTokens: 0,
    avgE2ELatencyMs: 1500,
  },

  // Cerebras — 1M tokens/day free
  {
    id: "cerebras",
    label: "Cerebras (1M tok/day free, tools)",
    baseUrl: "https://api.cerebras.ai/v1",
    apiKey: "$CEREBRAS_API_KEY",
    model: "llama3.3-70b",
    piModel: "fr-cerebras-llama33",
    contextWindow: 128000,
    maxTokens: 4096,
    supportsTools: true,
    enabled: false,
    category: "free",
    freeTierNotes: "~30M tokens/mo. 1M/day, no credit card (OmniRoute 2026-06-17)",
    costPer1MTokens: 0,
    avgE2ELatencyMs: 600,
  },

  // Mistral — free experiment tier
  {
    id: "mistral",
    label: "Mistral (free experiment tier)",
    baseUrl: "https://api.mistral.ai/v1",
    apiKey: "$MISTRAL_API_KEY",
    model: "mistral-small-latest",
    piModel: "fr-mistral-small",
    contextWindow: 128000,
    maxTokens: 4096,
    supportsTools: true,
    enabled: false,
    category: "free",
    freeTierNotes: "~1B tokens/mo free tier. Rate-limited, no credit card (OmniRoute)",
    costPer1MTokens: 0,
    avgE2ELatencyMs: 1000,
  },
  {
    id: "mistral-large",
    label: "Mistral Large (free tier)",
    baseUrl: "https://api.mistral.ai/v1",
    apiKey: "$MISTRAL_API_KEY",
    model: "mistral-large-latest",
    piModel: "fr-mistral-large",
    contextWindow: 128000,
    maxTokens: 4096,
    supportsTools: true,
    enabled: false,
    category: "free",
    freeTierNotes: "Mistral Large, same free tier quota",
    costPer1MTokens: 0,
    avgE2ELatencyMs: 1500,
  },

  // DeepInfra
  {
    id: "deepinfra",
    label: "DeepInfra (free credits, tools)",
    baseUrl: "https://api.deepinfra.com/v1/openai",
    apiKey: "$DEEPINFRA_API_KEY",
    model: "meta-llama/Llama-3.3-70B-Instruct",
    piModel: "fr-deepinfra-llama33",
    contextWindow: 128000,
    maxTokens: 4096,
    supportsTools: true,
    enabled: false,
    category: "free",
    freeTierNotes: "Free signup credits for API testing (OmniRoute)",
    costPer1MTokens: 0,
    avgE2ELatencyMs: 1200,
  },

  // NVIDIA NIM — 40 RPM free
  {
    id: "nvidia-nim",
    label: "NVIDIA NIM (free dev access, 40 RPM)",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    apiKey: "$NVIDIA_NIM_API_KEY",
    model: "meta/llama-3.3-70b-instruct",
    piModel: "fr-nim-llama33",
    contextWindow: 128000,
    maxTokens: 4096,
    supportsTools: false,
    enabled: false,
    category: "free",
    freeTierNotes: "~40 RPM, 70+ free models. Dev access (OmniRoute catalog)",
    costPer1MTokens: 0,
    avgE2ELatencyMs: 1500,
  },

  // SiliconFlow
  {
    id: "siliconflow",
    label: "SiliconFlow (keyed, free after KYC, tools)",
    baseUrl: "https://api.siliconflow.cn/v1",
    apiKey: "$SILICONFLOW_API_KEY",
    model: "Qwen/Qwen2.5-72B-Instruct",
    piModel: "fr-siliconflow-qwen",
    contextWindow: 128000,
    maxTokens: 4096,
    supportsTools: true,
    enabled: false,
    category: "free",
    freeTierNotes: "Free after KYC. No published token cap (OmniRoute uncapped)",
    costPer1MTokens: 0,
    avgE2ELatencyMs: 1500,
  },

  // Cloudflare Workers AI
  {
    id: "cloudflare-ai",
    label: "Cloudflare Workers AI (30M tok/mo free)",
    baseUrl: "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/ai/v1",
    apiKey: "$CLOUDFLARE_API_TOKEN",
    model: "@cf/meta/llama-3.3-70b-instruct",
    piModel: "fr-cf-llama33",
    contextWindow: 32000,
    maxTokens: 2048,
    supportsTools: false,
    enabled: false,
    category: "free",
    freeTierNotes: "~30M tokens/mo. 10k Neurons/day free. Needs Account ID + API Token (OmniRoute 2026-06-17)",
    costPer1MTokens: 0,
    avgE2ELatencyMs: 1500,
  },

  // GitHub Models — free with PAT (closing to new users 2026-06-16)
  {
    id: "github-models",
    label: "GitHub Models (free with PAT)",
    baseUrl: "https://models.inference.ai.azure.com",
    apiKey: "$GITHUB_TOKEN",
    model: "gpt-4o-mini",
    piModel: "fr-gh-models",
    contextWindow: 128000,
    maxTokens: 4096,
    supportsTools: true,
    enabled: false,
    category: "free",
    freeTierNotes: "~18M tokens/mo. Needs GitHub PAT with 'models: read' scope. Closing to new signups (OmniRoute 2026-06-17)",
    costPer1MTokens: 0,
    avgE2ELatencyMs: 1000,
  },

  // Sambanova
  {
    id: "sambanova",
    label: "SambaNova (6M tokens/mo free)",
    baseUrl: "https://api.sambanova.ai/v1",
    apiKey: "$SAMBANOVA_API_KEY",
    model: "Meta-Llama-3.3-70B-Instruct",
    piModel: "fr-sambanova-llama33",
    contextWindow: 128000,
    maxTokens: 4096,
    supportsTools: false,
    enabled: false,
    category: "free",
    freeTierNotes: "~6M tokens/mo. No credit card (OmniRoute 2026-06-17)",
    costPer1MTokens: 0,
    avgE2ELatencyMs: 1500,
  },

  // Hugging Face
  {
    id: "huggingface",
    label: "Hugging Face (200K tok/mo free inference)",
    baseUrl: "https://api-inference.huggingface.co/v1",
    apiKey: "$HF_API_KEY",
    model: "meta-llama/Llama-3.3-70B-Instruct",
    piModel: "fr-hf-llama33",
    contextWindow: 8192,
    maxTokens: 2048,
    supportsTools: false,
    enabled: false,
    category: "free",
    freeTierNotes: "~200K tokens/mo. Thousands of free models (OmniRoute)",
    costPer1MTokens: 0,
    avgE2ELatencyMs: 3000,
  },

  // Cohere — 1000 API calls/mo free
  {
    id: "cohere",
    label: "Cohere (1K calls/mo free trial)",
    baseUrl: "https://api.cohere.ai/v1",
    apiKey: "$COHERE_API_KEY",
    model: "command-r-plus",
    piModel: "fr-cohere-command",
    contextWindow: 128000,
    maxTokens: 4096,
    supportsTools: true,
    enabled: false,
    category: "free",
    freeTierNotes: "~800K tokens/mo. 1000 API calls/month, no credit card (OmniRoute)",
    costPer1MTokens: 0,
    avgE2ELatencyMs: 1500,
  },

  // Inference.net — $25 free credits
  {
    id: "inference-net",
    label: "Inference.net ($25 free credits)",
    baseUrl: "https://api.inference.net/v1",
    apiKey: "$INFERENCE_NET_API_KEY",
    model: "meta-llama/Meta-Llama-3.3-70B-Instruct",
    piModel: "fr-inference-llama33",
    contextWindow: 128000,
    maxTokens: 4096,
    supportsTools: true,
    enabled: false,
    category: "free",
    freeTierNotes: "$25 free credits on signup. Research grants available (OmniRoute)",
    costPer1MTokens: 0.10,
    avgE2ELatencyMs: 1500,
  },

  // API Airforce — 55 free models
  {
    id: "api-airforce",
    label: "API Airforce (55 free models)",
    baseUrl: "https://api.airforce/v1",
    apiKey: "$API_AIRFORCE_KEY",
    model: "gpt-4o-mini",
    piModel: "fr-airforce",
    contextWindow: 128000,
    maxTokens: 4096,
    supportsTools: false,
    enabled: false,
    category: "free",
    freeTierNotes: "55 free tier models including Grok-3, Claude 3.7, Qwen3, Kimi-K2 (OmniRoute)",
    costPer1MTokens: 0,
    avgE2ELatencyMs: 1500,
  },

  // OpenAI (paid, but configurable)
  {
    id: "openai",
    label: "OpenAI (API key paid)",
    baseUrl: "https://api.openai.com/v1",
    apiKey: "$OPENAI_API_KEY",
    model: "gpt-4o-mini",
    piModel: "fr-openai-mini",
    contextWindow: 128000,
    maxTokens: 4096,
    supportsTools: true,
    enabled: false,
    category: "api-key",
    costPer1MTokens: 0.15,
    avgE2ELatencyMs: 800,
  },
  {
    id: "openai-4o",
    label: "OpenAI GPT-4o (paid)",
    baseUrl: "https://api.openai.com/v1",
    apiKey: "$OPENAI_API_KEY",
    model: "gpt-4o",
    piModel: "fr-openai-4o",
    contextWindow: 128000,
    maxTokens: 4096,
    supportsTools: true,
    enabled: false,
    category: "api-key",
    costPer1MTokens: 2.50,
    avgE2ELatencyMs: 1000,
  },

  // Anthropic (paid)
  {
    id: "anthropic",
    label: "Anthropic Claude (paid)",
    baseUrl: "https://api.anthropic.com/v1",
    apiKey: "$ANTHROPIC_API_KEY",
    model: "claude-sonnet-4-20250514",
    piModel: "fr-anthropic-sonnet",
    contextWindow: 200000,
    maxTokens: 8192,
    supportsTools: true,
    enabled: false,
    category: "api-key",
    costPer1MTokens: 3.00,
    avgE2ELatencyMs: 1500,
  },

  // Zero one (free tier existed)
  {
    id: "ollama-cloud",
    label: "Ollama Cloud (20M tok/mo free)",
    baseUrl: "https://api.ollama.cloud/v1",
    apiKey: "$OLLAMA_CLOUD_KEY",
    model: "llama3.3-70b",
    piModel: "fr-ollama-cloud",
    contextWindow: 128000,
    maxTokens: 4096,
    supportsTools: false,
    enabled: false,
    category: "free",
    freeTierNotes: "~20M tokens/mo (OmniRoute 2026-06-17)",
    costPer1MTokens: 0,
    avgE2ELatencyMs: 1500,
  },

  // BluesMinds — 7M tokens/mo, 200+ models
  {
    id: "bluesminds",
    label: "BluesMinds (7M tok/mo, 200+ models)",
    baseUrl: "https://api.bluesminds.com/v1",
    apiKey: "$BLUESMINDS_API_KEY",
    model: "gpt-4o-mini",
    piModel: "fr-bluesminds",
    contextWindow: 128000,
    maxTokens: 4096,
    supportsTools: false,
    enabled: false,
    category: "free",
    freeTierNotes: "~7M tokens/mo. 200+ models including GPT-4o, GPT-4.1, Claude Sonnet 4.5 (OmniRoute)",
    costPer1MTokens: 0,
    avgE2ELatencyMs: 1500,
  },

  // InclusionAI (15M tok/mo)
  {
    id: "inclusionai",
    label: "InclusionAI (15M tok/mo free)",
    baseUrl: "https://api.inclusionai.tech/v1",
    apiKey: "$INCLUSIONAI_API_KEY",
    model: "llama-3.3-70b",
    piModel: "fr-inclusion-llama33",
    contextWindow: 128000,
    maxTokens: 4096,
    supportsTools: false,
    enabled: false,
    category: "free",
    freeTierNotes: "~15M tokens/mo (OmniRoute 2026-06-17). API may be deprecated.",
    costPer1MTokens: 0,
    avgE2ELatencyMs: 1500,
  },

  // Morph — 250K credits/mo free
  {
    id: "morph",
    label: "Morph (250K credits/mo free)",
    baseUrl: "https://api.morphllm.com/v1",
    apiKey: "$MORPH_API_KEY",
    model: "morph-v1",
    piModel: "fr-morph",
    contextWindow: 128000,
    maxTokens: 4096,
    supportsTools: false,
    enabled: false,
    category: "free",
    freeTierNotes: "250K credits/month free (OmniRoute)",
    costPer1MTokens: 0,
    avgE2ELatencyMs: 1500,
  },

  // Hyperbolic — $1-5 trial credits
  {
    id: "hyperbolic",
    label: "Hyperbolic ($1-5 trial credits)",
    baseUrl: "https://api.hyperbolic.xyz/v1",
    apiKey: "$HYPERBOLIC_API_KEY",
    model: "meta-llama/Meta-Llama-3.3-70B-Instruct",
    piModel: "fr-hyperbolic-llama33",
    contextWindow: 128000,
    maxTokens: 4096,
    supportsTools: false,
    enabled: false,
    category: "free",
    freeTierNotes: "$1-5 trial credits for serverless inference (OmniRoute)",
    costPer1MTokens: 0.15,
    avgE2ELatencyMs: 1500,
  },

  // BazaarLink — 4M tok/mo
  {
    id: "bazaarlink",
    label: "BazaarLink (4M tok/mo free)",
    baseUrl: "https://bazaarlink.ai/api/v1",
    apiKey: "$BAZAARLINK_API_KEY",
    model: "gpt-4o-mini",
    piModel: "fr-bazaarlink",
    contextWindow: 128000,
    maxTokens: 4096,
    supportsTools: false,
    enabled: false,
    category: "free",
    freeTierNotes: "~4M tokens/mo. 32 free models (OmniRoute)",
    costPer1MTokens: 0,
    avgE2ELatencyMs: 1500,
  },

  // Novita — $0.50 trial credits
  {
    id: "novita",
    label: "Novita AI ($0.50 trial, 200+ models)",
    baseUrl: "https://api.novita.ai/v1",
    apiKey: "$NOVITA_API_KEY",
    model: "meta-llama/llama-3.3-70b-instruct",
    piModel: "fr-novita-llama33",
    contextWindow: 128000,
    maxTokens: 4096,
    supportsTools: true,
    enabled: false,
    category: "free",
    freeTierNotes: "$0.50 trial credits, valid ~1 year. 200+ models (OmniRoute)",
    costPer1MTokens: 0.15,
    avgE2ELatencyMs: 1500,
  },

  // Nebius — $1 trial credits
  {
    id: "nebius",
    label: "Nebius AI ($1 trial credits)",
    baseUrl: "https://api.nebius.com/v1",
    apiKey: "$NEBIUS_API_KEY",
    model: "meta-llama/Meta-Llama-3.3-70B-Instruct",
    piModel: "fr-nebius-llama33",
    contextWindow: 128000,
    maxTokens: 4096,
    supportsTools: true,
    enabled: false,
    category: "free",
    freeTierNotes: "~$1 trial credits on signup (OmniRoute)",
    costPer1MTokens: 0.20,
    avgE2ELatencyMs: 1500,
  },

  // nScale — $5 free credits
  {
    id: "nscale",
    label: "nScale ($5 free credits)",
    baseUrl: "https://api.nscale.com/v1",
    apiKey: "$NSCALE_API_KEY",
    model: "meta-llama/Llama-3.3-70B-Instruct",
    piModel: "fr-nscale-llama33",
    contextWindow: 128000,
    maxTokens: 4096,
    supportsTools: true,
    enabled: false,
    category: "free",
    freeTierNotes: "$5 free credits on signup (OmniRoute)",
    costPer1MTokens: 0.20,
    avgE2ELatencyMs: 1500,
  },

  // AI/ML API (free trial)
  {
    id: "aimlapi",
    label: "AI/ML API (aggregator, free tier paused)",
    baseUrl: "https://api.aimlapi.com/v1",
    apiKey: "$AIMLAPI_KEY",
    model: "gpt-4o-mini",
    piModel: "fr-aimlapi",
    contextWindow: 128000,
    maxTokens: 4096,
    supportsTools: true,
    enabled: false,
    category: "aggregator",
    freeTierNotes: "Free tier paused 2026. Pay-as-you-go min $20 top-up (OmniRoute)",
    costPer1MTokens: 0.20,
    avgE2ELatencyMs: 1000,
  },

  // Kilo Gateway — rotating free models (uncapped)
  {
    id: "kilo-gateway",
    label: "Kilo Gateway (rotating free models)",
    baseUrl: "https://api.kilo.ai/v1",
    apiKey: "$KILO_API_KEY",
    model: "nemotron-3",
    piModel: "fr-kilo-nemotron",
    contextWindow: 128000,
    maxTokens: 4096,
    supportsTools: false,
    enabled: false,
    category: "aggregator",
    freeTierNotes: "Rotating 'Auto Free' set: NVIDIA Nemotron 3, StepFun, Poolside. Uncapped (OmniRoute catalog)",
    costPer1MTokens: 0,
    avgE2ELatencyMs: 1500,
  },

  // OpenCode Zen — 6 rotating free coding models
  {
    id: "opencode-zen",
    label: "OpenCode Zen (6 free coding models)",
    baseUrl: "https://zen.opencode.ai/v1",
    apiKey: "$OPENCODE_ZEN_KEY",
    model: "auto",
    piModel: "fr-zen-auto",
    contextWindow: 128000,
    maxTokens: 4096,
    supportsTools: false,
    enabled: false,
    category: "free",
    freeTierNotes: "6 rotating free coding models. Uncapped rate/concurrency (OmniRoute catalog)",
    costPer1MTokens: 0,
    avgE2ELatencyMs: 1500,
  },

  // Fireworks AI
  {
    id: "fireworks",
    label: "Fireworks AI ($1 starter credits)",
    baseUrl: "https://api.fireworks.ai/inference/v1",
    apiKey: "$FIREWORKS_API_KEY",
    model: "accounts/fireworks/models/llama-v3p3-70b-instruct",
    piModel: "fr-fireworks-llama33",
    contextWindow: 128000,
    maxTokens: 4096,
    supportsTools: true,
    enabled: false,
    category: "free",
    freeTierNotes: "$1 free starter credits (OmniRoute)",
    costPer1MTokens: 0.20,
    avgE2ELatencyMs: 1000,
  },

  // FriendliAI
  {
    id: "friendliai",
    label: "FriendliAI (free serverless inference)",
    baseUrl: "https://api.friendli.ai/v1",
    apiKey: "$FRIENDLI_API_KEY",
    model: "meta-llama-3.3-70b-instruct",
    piModel: "fr-friendli-llama33",
    contextWindow: 128000,
    maxTokens: 4096,
    supportsTools: false,
    enabled: false,
    category: "free",
    freeTierNotes: "Free tier for serverless inference, no credit card (OmniRoute)",
    costPer1MTokens: 0,
    avgE2ELatencyMs: 1500,
  },

  // AgentaRouter
  {
    id: "agentrouter",
    label: "AgentRouter ($200 free credits, aggregator)",
    baseUrl: "https://api.agentrouter.org/v1",
    apiKey: "$AGENTROUTER_API_KEY",
    model: "gpt-4o-mini",
    piModel: "fr-agentrouter",
    contextWindow: 128000,
    maxTokens: 4096,
    supportsTools: true,
    enabled: false,
    category: "aggregator",
    freeTierNotes: "$200 free credits on signup - multi-model routing gateway (OmniRoute)",
    costPer1MTokens: 0,
    avgE2ELatencyMs: 1000,
  },

  // Featherless AI
  {
    id: "featherless",
    label: "Featherless AI (free tier)",
    baseUrl: "https://api.featherless.ai/v1",
    apiKey: "$FEATHERLESS_API_KEY",
    model: "meta-llama/Llama-3.3-70B-Instruct",
    piModel: "fr-featherless-llama33",
    contextWindow: 128000,
    maxTokens: 4096,
    supportsTools: false,
    enabled: false,
    category: "free",
    freeTierNotes: "Free tier available, no credit card required (OmniRoute)",
    costPer1MTokens: 0,
    avgE2ELatencyMs: 1500,
  },

  // Baseten — $30 trial
  {
    id: "baseten",
    label: "Baseten ($30 trial GPU inference)",
    baseUrl: "https://app.baseten.co/v1",
    apiKey: "$BASETEN_API_KEY",
    model: "meta-llama/Meta-Llama-3.3-70B-Instruct",
    piModel: "fr-baseten-llama33",
    contextWindow: 128000,
    maxTokens: 4096,
    supportsTools: true,
    enabled: false,
    category: "free",
    freeTierNotes: "$30 free trial credits for GPU inference (OmniRoute)",
    costPer1MTokens: 0.30,
    avgE2ELatencyMs: 1500,
  },

  // Arcee AI — 5M tok/mo
  {
    id: "arcee-ai",
    label: "Arcee AI (5M tok/mo, Trinity Large)",
    baseUrl: "https://api.arcee.ai/v1",
    apiKey: "$ARCEE_API_KEY",
    model: "trinity-large",
    piModel: "fr-arcee-trinity",
    contextWindow: 128000,
    maxTokens: 4096,
    supportsTools: false,
    enabled: false,
    category: "free",
    freeTierNotes: "~5M tokens/mo. Trinity Large Preview (OmniRoute 2026-06-17)",
    costPer1MTokens: 0,
    avgE2ELatencyMs: 1500,
  },

  // GLM (Zhipu) — free in China
  {
    id: "glm-cn",
    label: "GLM (Zhipu, free GLM-4-Flash, tools)",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    apiKey: "$GLM_API_KEY",
    model: "glm-4-flash",
    piModel: "fr-glm-flash",
    contextWindow: 128000,
    maxTokens: 4096,
    supportsTools: true,
    enabled: false,
    category: "free",
    freeTierNotes: "GLM-4-Flash permanently free, uncapped. +20M signup bonus (OmniRoute catalog)",
    costPer1MTokens: 0,
    avgE2ELatencyMs: 1500,
  },

  // Tencent (free in China, uncapped)
  {
    id: "tencent",
    label: "Tencent Hunyuan (free, China)",
    baseUrl: "https://api.hunyuan.cloud.tencent.com/v1",
    apiKey: "$TENCENT_API_KEY",
    model: "hunyuan-lite",
    piModel: "fr-tencent-hunyuan",
    contextWindow: 128000,
    maxTokens: 4096,
    supportsTools: false,
    enabled: false,
    category: "free",
    freeTierNotes: "Free model (uncapped rate/concurrency). China-only (OmniRoute catalog)",
    costPer1MTokens: 0,
    avgE2ELatencyMs: 2000,
  },

  // Baidu ERNIE (free in China, uncapped)
  {
    id: "baidu",
    label: "Baidu ERNIE (free, China)",
    baseUrl: "https://aip.baidubce.com/rpc/2.0/ai_custom/v1/wenxinworkshop/chat/v2",
    apiKey: "$BAIDU_API_KEY",
    model: "ernie-lite-8k",
    piModel: "fr-baidu-ernie",
    contextWindow: 8192,
    maxTokens: 2048,
    supportsTools: false,
    enabled: false,
    category: "free",
    freeTierNotes: "ERNIE Lite free, uncapped. China-only (OmniRoute catalog)",
    costPer1MTokens: 0,
    avgE2ELatencyMs: 2000,
  },

  // DGrid — free tier 100 req/day
  {
    id: "dgrid",
    label: "DGrid (100 req/day free)",
    baseUrl: "https://api.dgrid.ai/v1",
    apiKey: "$DGRID_API_KEY",
    model: "gpt-4o-mini",
    piModel: "fr-dgrid",
    contextWindow: 128000,
    maxTokens: 4096,
    supportsTools: false,
    enabled: false,
    category: "free",
    freeTierNotes: "10 req/min, 100 req/day free. $5 lifetime top-up unlocks more (OmniRoute)",
    costPer1MTokens: 0,
    avgE2ELatencyMs: 1500,
  },
];

/**
 * Default combos — OmniRoute-inspired model chains.
 * Each combo tries providers in order with fallback.
 */
const DEFAULT_COMBOS: ComboEntry[] = [
  {
    name: "fr-auto",
    providerIds: ["llm7", "pollinations", "free-model-dev"],
    strategy: "priority",
    autoSelect: true,
  },
  {
    name: "fr-auto-all",
    providerIds: [], // dynamically filled from all enabled providers
    strategy: "priority",
    autoSelect: true,
  },
  {
    name: "fr-combo-free-fast",
    providerIds: ["groq-fast", "groq", "cerebras", "deepseek"],
    strategy: "priority",
    autoSelect: false,
  },
  {
    name: "fr-combo-free-smart",
    providerIds: ["gemini-flash", "mistral-small", "deepseek", "llm7"],
    strategy: "priority",
    autoSelect: false,
  },
];

/** Build the default config with full catalog. */
export function defaultConfig(): GatewayConfig {
  return {
    port: 8731,
    strategy: "priority",
    cooldownMs: 60000,
    circuitBreakerThreshold: 5,
    // Kind-aware cooldowns (OmniRoute pattern)
    cooldownByKind: {
      rate_limit: 60_000,
      quota_exhausted: 300_000,
      transient: 30_000,
    },
    providers: PROVIDER_CATALOG,
    combos: DEFAULT_COMBOS,
    globalFallbackProvider: "llm7",
    healthCheckIntervalMs: 60000,
  };
}

/** Load config from disk, creating defaults if missing. */
export function loadConfig(): GatewayConfig {
  if (!existsSync(CONFIG_PATH)) {
    mkdirSync(dirname(CONFIG_PATH), { recursive: true });
    writeFileSync(CONFIG_PATH, JSON.stringify(defaultConfig(), null, 2));
  }
  const raw = readFileSync(CONFIG_PATH, "utf8");
  const parsed = JSON.parse(raw);

  // Fill in defaults for any missing fields (schema evolution)
  const defaults = defaultConfig();
  parsed.cooldownByKind = parsed.cooldownByKind ?? defaults.cooldownByKind;
  parsed.circuitBreakerThreshold = parsed.circuitBreakerThreshold ?? defaults.circuitBreakerThreshold;
  parsed.combos = parsed.combos ?? defaults.combos;
  parsed.globalFallbackProvider = parsed.globalFallbackProvider ?? defaults.globalFallbackProvider;
  parsed.healthCheckIntervalMs = parsed.healthCheckIntervalMs ?? defaults.healthCheckIntervalMs;

  // Merge providers: keep user's enabled state, add any new ones from catalog
  const existingIds = new Set(parsed.providers.map((p: ProviderEntry) => p.id));
  const newProviders = PROVIDER_CATALOG.filter((p) => !existingIds.has(p.id));
  parsed.providers = [...parsed.providers, ...newProviders];

  return parsed as GatewayConfig;
}
