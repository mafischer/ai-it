import { ChatOpenAI } from "@langchain/openai";
import { setGlobalDispatcher, Agent } from "undici";
import { getConfig } from "../config/loader.js";

// Disable native fetch timeouts for long-running local LLM inferences
setGlobalDispatcher(new Agent({
  headersTimeout: 0,
  bodyTimeout: 0,
}));

/**
 * Resolve engine URLs and API key for a model key from workflow.json.
 * Falls back to env vars and hardcoded defaults for backward compatibility.
 */
function resolveEngine(modelKey) {
  const cfg = getConfig();
  const model = cfg.models?.[modelKey];
  const engine = model?.engine ? cfg.engines?.[model.engine] : null;

  if (engine) {
    const urls = Array.isArray(engine.url) ? engine.url : [engine.url];
    return {
      urls,
      apiKey: engine.apiKey || "not-needed",
      modelId: model.modelId || modelKey,
      capabilities: engine.capabilities || [],
    };
  }

  // Legacy fallback: resolve from env vars
  const modelId = model?.modelId || modelKey;
  const envPrefix = modelId.toUpperCase().replace(/[:\.-]/g, "_");
  return {
    urls: [process.env[`${envPrefix}_URL`] || "http://localhost:11434/v1"],
    apiKey: process.env[`${envPrefix}_KEY`] || "not-needed",
    modelId,
    capabilities: model?.capabilities || [],
  };
}

/**
 * Round-robin wrapper around multiple ChatOpenAI instances.
 * Proxies all property access and method calls to the current instance,
 * advancing the index on each stream() or invoke() call.
 */
function createRoundRobinLLM(instances) {
  if (instances.length === 1) return instances[0];

  let index = 0;

  return new Proxy(instances[0], {
    get(target, prop, receiver) {
      if (prop === "stream" || prop === "invoke") {
        return (...args) => {
          const current = instances[index];
          index = (index + 1) % instances.length;
          return current[prop](...args);
        };
      }
      // For all other properties, use the first instance
      return Reflect.get(target, prop, receiver);
    }
  });
}

/**
 * Factory to create a (possibly round-robin) ChatOpenAI for a model key defined in workflow.json.
 */
export function createLLM(modelKey) {
  const engine = resolveEngine(modelKey);
  console.log(`[LLM]: Creating model "${engine.modelId}" with ${engine.urls.length} endpoint(s): ${engine.urls.join(", ")}`);

  const instances = engine.urls.map(url => {
    const options = {
      apiKey: engine.apiKey || "sk-no-key",
      configuration: { baseURL: url },
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
  });

  return createRoundRobinLLM(instances);
}
