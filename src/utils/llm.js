import { ChatOpenAI } from "@langchain/openai";
import { setGlobalDispatcher, Agent } from "undici";
import { getConfig } from "../config/loader.js";

// Disable native fetch timeouts for long-running local LLM inferences
setGlobalDispatcher(new Agent({
  headersTimeout: 0,
  bodyTimeout: 0,
}));

/**
 * Resolve engine URL and API key for a model key from workflow.json.
 * Falls back to env vars and hardcoded defaults for backward compatibility.
 */
function resolveEngine(modelKey) {
  const cfg = getConfig();
  const model = cfg.models?.[modelKey];
  const engine = model?.engine ? cfg.engines?.[model.engine] : null;

  if (engine) {
    return {
      baseURL: engine.url,
      apiKey: engine.apiKey || "not-needed",
      modelId: model.modelId || modelKey,
      capabilities: engine.capabilities || [],
    };
  }

  // Legacy fallback: resolve from env vars
  const modelId = model?.modelId || modelKey;
  const envPrefix = modelId.toUpperCase().replace(/[:\.-]/g, "_");
  return {
    baseURL: process.env[`${envPrefix}_URL`] || "http://localhost:11434/v1",
    apiKey: process.env[`${envPrefix}_KEY`] || "not-needed",
    modelId,
    capabilities: model?.capabilities || [],
  };
}

/**
 * Factory to create a ChatOpenAI instance for a model key defined in workflow.json.
 */
export function createLLM(modelKey) {
  const engine = resolveEngine(modelKey);
  console.log(`[LLM]: Creating model "${engine.modelId}" at ${engine.baseURL}`);

  const options = {
    apiKey: engine.apiKey || "sk-no-key",
    configuration: {
      baseURL: engine.baseURL,
    },
    modelName: engine.modelId,
    temperature: 0,
    streaming: true,
    maxRetries: 0,
    maxTokens: 32768,
  };

  // Pass thinking budget if engine supports reasoning
  if (engine.capabilities.includes("reasoning")) {
      const thinkingBudget = parseInt(process.env.THINKING_BUDGET ?? "2048", 10);
      options.modelKwargs = {
          ...options.modelKwargs,
          thinking_budget: thinkingBudget,
      };
  }

  return new ChatOpenAI(options);
}
