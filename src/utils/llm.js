import { ChatOpenAI } from "@langchain/openai";

/**
 * Helper to resolve runtime configuration from environment variables.
 */
export function getRuntimeConfig(modelId) {
  const envPrefix = modelId.toUpperCase().replace(/[:\.-]/g, "_");
  
  const defaults = {
      "LFM2_8B": "http://10.3.0.241:8080/v1",
      "QWEN3_5_27B": "http://localhost:1234/v1"
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
    timeout: 600000, // 10 minute timeout
    maxTokens: 8192, // Increased limit for long technical docs
  };

  const useStrictJson = modelId.toLowerCase().includes("qwen2.5-7b");
  if (useStrictJson) {
      options.model_kwargs = { response_format: { type: "json_object" } };
  }

  return new ChatOpenAI(options);
}
