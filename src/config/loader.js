import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(__dirname, "../../workflow.json");

let _config = null;

export function loadConfig(path = CONFIG_PATH) {
    const raw = readFileSync(path, "utf8");
    _config = JSON.parse(raw);
    resolveEnvVars(_config);
    return _config;
}

export async function initConfig() {
    if (!_config) loadConfig();
    await discoverEngines(_config);
    validateCapabilities(_config);
    return _config;
}

function resolveEnvVar(value) {
    if (typeof value === "string" && value.startsWith("${")) {
        const envKey = value.slice(2, -1);
        return process.env[envKey] || value;
    }
    return value;
}

function resolveEnvVars(cfg) {
    if (!cfg.engines) return;
    for (const engine of Object.values(cfg.engines)) {
        if (engine.url) {
            if (Array.isArray(engine.url)) {
                engine.url = engine.url.map(u => resolveEnvVar(u));
            } else {
                engine.url = resolveEnvVar(engine.url);
            }
        }
        if (engine.apiKey && engine.apiKey.startsWith("${")) {
            const envKey = engine.apiKey.slice(2, -1);
            engine.apiKey = process.env[envKey] || "";
        }
    }
}

async function discoverEngines(cfg) {
    if (!cfg.engines) return;
    for (const [engineId, engine] of Object.entries(cfg.engines)) {
        if (!engine.discover) continue;
        try {
            const discoveryUrl = Array.isArray(engine.url) ? engine.url[0] : engine.url;
            const resp = await fetch(`${discoveryUrl}/models`, {
                headers: engine.apiKey ? { "Authorization": `Bearer ${engine.apiKey}` } : {},
                signal: AbortSignal.timeout(5000),
            });
            if (!resp.ok) continue;
            const data = await resp.json();

            // Try to extract capabilities from the response
            // llama.cpp format: data.models[].capabilities
            const models = data.models || data.data || [];
            const discoveredCaps = new Set();
            for (const m of models) {
                if (m.capabilities) {
                    for (const cap of m.capabilities) {
                        // Normalize: "completion" → "text"
                        discoveredCaps.add(cap === "completion" ? "text" : cap);
                    }
                }
                // Infer from model metadata if available
                if (m.meta?.n_ctx_train) {
                    engine.contextWindow = m.meta.n_ctx_train;
                }
            }

            if (discoveredCaps.size > 0) {
                engine.capabilities = [...discoveredCaps];
                console.log(`[CONFIG] Engine "${engineId}": discovered capabilities [${engine.capabilities.join(", ")}]`);
            } else {
                console.log(`[CONFIG] Engine "${engineId}": reachable but no capabilities reported, using manual config`);
            }
        } catch (e) {
            console.error(`[CONFIG] Engine "${engineId}": discovery failed (${e.message}), using manual config`);
        }
    }
}

function getModelCapabilities(cfg, modelKey) {
    const model = cfg.models[modelKey];
    if (!model) return null;
    // Model can override capabilities, otherwise inherit from engine
    if (model.capabilities) return model.capabilities;
    const engine = cfg.engines?.[model.engine];
    return engine?.capabilities || [];
}

function validateCapabilities(cfg) {
    const errors = [];
    for (const [agentId, agent] of Object.entries(cfg.agents)) {
        if (agent.active === false) continue;
        const requires = agent.requires || [];
        if (!requires.length) continue;

        const modelKey = agent.model;
        const model = cfg.models[modelKey];
        if (!model) {
            errors.push(`Agent "${agentId}" references unknown model "${modelKey}"`);
            continue;
        }

        const provides = getModelCapabilities(cfg, modelKey);
        if (!provides) continue;
        const missing = requires.filter(cap => !provides.includes(cap));
        if (missing.length) {
            errors.push(`Agent "${agentId}" requires [${missing.join(", ")}] but model "${modelKey}" (${model.modelId}) via engine "${model.engine}" only provides [${provides.join(", ")}]`);
        }
    }
    if (errors.length) {
        console.error("[CONFIG] Capability validation errors:");
        errors.forEach(e => console.error(`  - ${e}`));
        throw new Error(`Workflow config has ${errors.length} capability error(s)`);
    }
}

export function getConfig() {
    if (!_config) loadConfig();
    return _config;
}

export function getActiveAgents() {
    const cfg = getConfig();
    return Object.keys(cfg.agents).filter(id => cfg.agents[id].active !== false);
}

export function getAgent(id) {
    return getConfig().agents[id] || null;
}

export function getAgentEmojis() {
    const cfg = getConfig();
    return Object.fromEntries(
        Object.entries(cfg.agents).map(([id, a]) => [id, a.emoji || "🤖"])
    );
}

export function getAgentMissions() {
    const cfg = getConfig();
    return Object.fromEntries(
        Object.entries(cfg.agents).map(([id, a]) => [id, a.mission || ""])
    );
}

export function getRouting(agentId) {
    return getConfig().routing[agentId] || null;
}

export function getPipeline() {
    return getConfig().pipeline;
}

export function getRouterConfig() {
    return getConfig().router;
}

export function getModelId(modelKey) {
    const model = getConfig().models[modelKey];
    return model?.modelId || modelKey;
}
