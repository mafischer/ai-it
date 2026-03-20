import { ChatOpenAI } from "@langchain/openai";
import { setGlobalDispatcher, Agent } from "undici";

// Disable native fetch timeouts for long-running local LLM inferences
setGlobalDispatcher(new Agent({
  headersTimeout: 0,
  bodyTimeout: 0,
}));

/**
 * Helper to resolve runtime configuration from environment variables.
 */
export function getRuntimeConfig(modelId) {
  const envPrefix = modelId.toUpperCase().replace(/[:\.-]/g, "_");
  
  const defaults = {
      "LFM2_8B": "http://10.3.0.241:8080/v1",
      "QWEN3_5_27B": "http://127.0.0.1:8081/v1"
  };

  return {
    baseURL: process.env[`${envPrefix}_URL`] || defaults[envPrefix] || "http://localhost:11434/v1",
    apiKey: process.env[`${envPrefix}_KEY`] || "not-needed",
  };
}

/**
 * Factory to create a ChatOpenAI instance for a specific model node.
 */
export function createLLM(modelId = "llama3-8b") {
  const config = getRuntimeConfig(modelId);
  console.log(`[LLM]: Creating model "${modelId}" at ${config.baseURL}`);
  
  const options = {
    apiKey: config.apiKey || "sk-no-key",
    configuration: {
      baseURL: config.baseURL,
    },
    modelName: modelId,
    temperature: 0,
    streaming: true,
    maxRetries: 0, 
    maxTokens: 32768,
  };

  // Explicit JSON mode for strict schema models
  const useStrictJson = modelId.toLowerCase().includes("qwen2.5-7b");
  if (useStrictJson) {
      options.modelKwargs = { response_format: { type: "json_object" } };
  }

  // Pass thinking budget for Qwen3 models (enforced in vllm-mlx's MLXLanguageModel)
  if (modelId.toLowerCase().includes("qwen3.5-27b")) {
      const thinkingBudget = parseInt(process.env.THINKING_BUDGET ?? "2048", 10);
      options.modelKwargs = {
          ...options.modelKwargs,
          thinking_budget: thinkingBudget,
      };
  }

  return new ChatOpenAI(options);
}
