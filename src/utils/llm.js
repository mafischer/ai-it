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
 * Context-aware concurrency gate for an engine.
 *
 * Tracks how many context chars are actively being processed across all
 * concurrent requests to an engine. When a new request would push the total
 * over the threshold, it queues until enough active requests complete.
 *
 * This prevents the inference server from OOM-ing or returning 500s when
 * parallel agents submit large contexts simultaneously.
 */
const MAX_CONCURRENT_CONTEXT_CHARS = parseInt(process.env.MAX_CONCURRENT_CONTEXT_CHARS ?? "10000", 10);

class ContextGate {
  constructor() {
    this.activeChars = 0;
    this.waiters = [];
  }

  /** Estimate context size in chars from LangChain message arguments. */
  _estimateChars(args) {
    const messages = args[0];
    if (!Array.isArray(messages)) return 0;
    let chars = 0;
    for (const m of messages) {
      // LangChain message objects: .content or .kwargs.content
      const content = typeof m === "string" ? m
        : m?.content || m?.kwargs?.content || "";
      chars += typeof content === "string" ? content.length : 0;
    }
    return chars;
  }

  /** Acquire the gate. Resolves immediately if under limit, otherwise queues. */
  acquire(chars) {
    if (this.activeChars === 0 || this.activeChars + chars <= MAX_CONCURRENT_CONTEXT_CHARS) {
      this.activeChars += chars;
      return Promise.resolve();
    }
    return new Promise(resolve => {
      this.waiters.push({ chars, resolve });
    });
  }

  /** Release chars and unblock waiting requests that now fit. */
  release(chars) {
    this.activeChars -= chars;
    while (this.waiters.length > 0) {
      const next = this.waiters[0];
      if (this.activeChars === 0 || this.activeChars + next.chars <= MAX_CONCURRENT_CONTEXT_CHARS) {
        this.waiters.shift();
        this.activeChars += next.chars;
        next.resolve();
      } else {
        break;
      }
    }
  }
}

const urlGates = new Map();

function getGate(url) {
  if (!urlGates.has(url)) {
    urlGates.set(url, new ContextGate());
  }
  return urlGates.get(url);
}

/**
 * Wrap a ChatOpenAI instance's stream/invoke with the context gate.
 * Returns a Proxy that acquires/releases the gate around each call.
 */
function wrapWithGate(instance, gate, url) {
  return new Proxy(instance, {
    get(target, prop, receiver) {
      if (prop === "stream") {
        return async function* (...args) {
          const chars = gate._estimateChars(args);
          console.error(`[LLM GATE] stream acquire: ${chars} chars → ${url} (active: ${gate.activeChars}, waiting: ${gate.waiters.length})`);
          await gate.acquire(chars);
          try {
            const stream = await target.stream(...args);
            for await (const chunk of stream) {
              yield chunk;
            }
          } catch (e) {
            console.error(`[LLM ERROR] stream failed: ${url} (${chars} chars) — ${e.status || ""} ${e.message}`);
            throw e;
          } finally {
            gate.release(chars);
          }
        };
      }
      if (prop === "invoke") {
        return async (...args) => {
          const chars = gate._estimateChars(args);
          console.error(`[LLM GATE] invoke acquire: ${chars} chars → ${url} (active: ${gate.activeChars}, waiting: ${gate.waiters.length})`);
          await gate.acquire(chars);
          try {
            return await target.invoke(...args);
          } catch (e) {
            console.error(`[LLM ERROR] invoke failed: ${url} (${chars} chars) — ${e.status || ""} ${e.message}`);
            throw e;
          } finally {
            gate.release(chars);
          }
        };
      }
      return Reflect.get(target, prop, receiver);
    }
  });
}

/**
 * Round-robin wrapper around multiple ChatOpenAI instances.
 * Proxies all property access and method calls to the current instance,
 * advancing the index atomically on each stream() or invoke() call.
 *
 * When multiple agents share a model key, each should get its own LLM via
 * createAgentLLM() so their round-robin counters are independent — ensuring
 * parallel agents always hit different endpoints.
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
      // Expose internals for cloning
      if (prop === "_rrInstances") return instances;
      if (prop === "_rrIndex") return index;
      // For all other properties, use the first instance
      return Reflect.get(target, prop, receiver);
    }
  });
}

/**
 * Build ChatOpenAI option set for an engine (shared helper).
 */
function buildInstanceOptions(engine) {
  const base = {
    apiKey: engine.apiKey || "sk-no-key",
    modelName: engine.modelId,
    temperature: 0,
    streaming: true,
    maxRetries: 2,
    maxTokens: 32768,
  };

  if (engine.capabilities.includes("reasoning")) {
    const thinkingBudget = parseInt(process.env.THINKING_BUDGET ?? "2048", 10);
    base.modelKwargs = { ...base.modelKwargs, thinking_budget: thinkingBudget };
  }

  return base;
}

// Cache resolved engines so per-agent instances reuse the same config
const engineCache = new Map();

function getEngine(modelKey) {
  if (!engineCache.has(modelKey)) {
    engineCache.set(modelKey, resolveEngine(modelKey));
  }
  return engineCache.get(modelKey);
}

/**
 * Factory to create a (possibly round-robin) ChatOpenAI for a model key defined in workflow.json.
 */
export function createLLM(modelKey) {
  const engine = getEngine(modelKey);
  console.log(`[LLM]: Creating model "${engine.modelId}" with ${engine.urls.length} endpoint(s): ${engine.urls.join(", ")}`);

  const instances = engine.urls.map(url =>
    wrapWithGate(
      new ChatOpenAI({ ...buildInstanceOptions(engine), configuration: { baseURL: url } }),
      getGate(url), url
    )
  );

  return createRoundRobinLLM(instances);
}

/**
 * Create a dedicated LLM instance for a specific agent.
 *
 * Each agent gets its own independent round-robin counter and set of ChatOpenAI
 * instances. This ensures that when parallel agents (e.g., SA + UX) call .stream()
 * concurrently, they don't race on the same counter and can be pinned to different
 * endpoints for true parallel inference.
 *
 * With N endpoints and N parallel agents, agent i is offset to start at endpoint i,
 * so the first call from each agent always hits a distinct endpoint.
 *
 * All instances share a per-engine ContextGate that prevents overloading the
 * inference server when parallel requests have large combined contexts.
 */
export function createAgentLLM(modelKey, agentIndex = 0) {
  const engine = getEngine(modelKey);

  const instances = engine.urls.map(url =>
    wrapWithGate(
      new ChatOpenAI({ ...buildInstanceOptions(engine), configuration: { baseURL: url } }),
      getGate(url), url
    )
  );

  if (instances.length === 1) return instances[0];

  // Offset the starting index so parallel agents begin on different endpoints
  let index = agentIndex % instances.length;

  return new Proxy(instances[0], {
    get(target, prop, receiver) {
      if (prop === "stream" || prop === "invoke") {
        return (...args) => {
          const current = instances[index];
          index = (index + 1) % instances.length;
          return current[prop](...args);
        };
      }
      if (prop === "_rrInstances") return instances;
      if (prop === "_rrIndex") return index;
      return Reflect.get(target, prop, receiver);
    }
  });
}
