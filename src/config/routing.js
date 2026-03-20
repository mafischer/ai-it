import { END } from "@langchain/langgraph";

/**
 * Resolve a routing target from the DSL into concrete agent ID(s).
 *
 * Supported target formats:
 *   "agent_id"                    → [agentId]
 *   "$self"                       → [currentAgent]
 *   "__end__"                     → [END]
 *   ["a", "b"]                    → [a, b]  (parallel fan-out)
 *   { "$map_previous": { "agent_a": "target_a", ... , "default": "fallback" } }
 *   { "$previous_matching": ["agent_a", "agent_b"], "default": "fallback" }
 */
export function resolveTarget(target, currentAgent, state) {
    if (Array.isArray(target)) {
        return target.map(t => resolveSingle(t, currentAgent, state));
    }
    if (typeof target === "object" && target !== null) {
        return resolveComplexTarget(target, currentAgent, state);
    }
    return [resolveSingle(target, currentAgent, state)];
}

function resolveSingle(token, currentAgent, state) {
    if (token === "$self") return currentAgent;
    if (token === "__end__") return END;
    return token;
}

function resolveComplexTarget(target, currentAgent, state) {
    const prevMsgs = state.messages.slice(0, -1);

    // $map_previous: find last non-self speaker, map to a target
    if (target.$map_previous) {
        const map = target.$map_previous;
        const prev = prevMsgs.filter(m => m.name && m.name !== currentAgent).pop();
        const prevName = prev?.name;
        const resolved = map[prevName] || map.default || currentAgent;
        return [resolved === "__end__" ? END : resolved];
    }

    // $previous_matching: find last speaker matching one of the given agent IDs
    if (target.$previous_matching) {
        const candidates = target.$previous_matching;
        const match = prevMsgs.filter(m => candidates.includes(m.name)).pop();
        const resolved = match?.name || target.default || candidates[0];
        return [resolved === "__end__" ? END : resolved];
    }

    // Fallback: treat as plain agent ID
    return [END];
}
