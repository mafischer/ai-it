import { StateGraph, MessagesAnnotation, Annotation, START, END } from "@langchain/langgraph";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { createLLM } from "./src/utils/llm.js";
import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { getConfig, getActiveAgents, getRouting, getPipeline, getRouterConfig, initConfig } from "./src/config/loader.js";
import { renderPrompt } from "./src/config/templates.js";
import { resolveTarget } from "./src/config/routing.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const checkpointer = SqliteSaver.fromConnString("./checkpoints.db");
const config = getConfig();

const GraphState = Annotation.Root({
  ...MessagesAnnotation.spec
});

// Create LLMs from config (keyed by model key, not model ID)
const llms = {};
for (const key of Object.keys(config.models)) {
    llms[key] = createLLM(key);
}

const routerLLM = llms[config.router.model];

function extractStatus(content) {
    if (!content) return null;
    // Strip <think> blocks to avoid matching STATUS tokens from reasoning
    const cleaned = content.replace(/<think>[\s\S]*?<\/think>/g, "").replace(/<\/?think>/g, "");
    const matches = [...cleaned.matchAll(/STATUS:\s*([A-Z_]+)/g)];
    return matches.length ? matches[matches.length - 1][1] : null;
}

function cleanSpecialistOutput(content) {
    if (typeof content !== 'string') return String(content || "");
    return content.replace(/<think>[\s\S]*?<\/think>/g, "").replace(/<\/?think>/g, "").trim();
}

function getMsgName(m) {
    return m?.name || m?.kwargs?.name || m?.additional_kwargs?.name || "";
}

function getMsgRole(m) {
    const type = m?.type || m?._getType?.() || "";
    return m?.role || m?.kwargs?.role || (type === "human" ? "user" : getMsgName(m) ? "assistant" : type === "ai" ? "assistant" : "user");
}

function getMsgContent(m) {
    return m?.content || m?.kwargs?.content || "";
}

function getPromptForNode(state, nodeName) {
    const msgs = state.messages.filter(m => getMsgName(m) === nodeName && !getMsgName(m).endsWith("__prompt"));
    const lastSelfStatus = msgs.length ? extractStatus(getMsgContent(msgs[msgs.length - 1])) : null;
    // Last non-prompt message for context
    const lastMsg = [...state.messages].reverse().find(m => !getMsgName(m).endsWith("__prompt")) || state.messages[state.messages.length - 1];
    const agent = config.agents[nodeName];

    const prompts = Array.isArray(agent?.prompts) ? agent.prompts : Object.keys(agent?.prompts || {});
    if (!prompts.length) return `You are ${nodeName}.`;
    const hasPrompt = (v) => prompts.includes(v);

    const selfLastContent = msgs.length ? getMsgContent(msgs[msgs.length - 1]) : "";
    const otherLastContent = lastMsg ? getMsgContent(lastMsg) : "";

    const isUserReply = getMsgRole(lastMsg) === "user";
    const questionStatuses = getPipeline().question_statuses || [];
    const stripThink = (s) => String(s || "").replace(/<think>[\s\S]*?<\/think>/g, "").replace(/<\/?think>/g, "").trim();

    // Build full clarification history — all Q&A rounds between this agent and the user
    let clarificationHistory = null;
    const allMsgs = state.messages.filter(m => !getMsgName(m).endsWith("__prompt"));
    const rounds = [];
    let roundCounter = 1;
    for (let i = 0; i < allMsgs.length; i++) {
        const m = allMsgs[i];
        if (getMsgName(m) === nodeName) {
            const content = getMsgContent(m);
            const status = extractStatus(content);
            if (questionStatuses.includes(status) || status === "QUESTION") {
                // This agent asked questions — find the next user reply
                const nextUser = allMsgs.slice(i + 1).find(n => getMsgRole(n) === "user");
                if (nextUser) {
                    rounds.push({ 
                        roundNumber: roundCounter++, 
                        priorQuestions: stripThink(content), 
                        userResponse: getMsgContent(nextUser)
                    });
                }
            }
        }
    }
    if (rounds.length) {
        clarificationHistory = rounds;
    }

    // Build values dynamically from state — no hardcoded domain concepts.
    // Templates can reference:
    //   {{directive}}          — the original user directive (first message)
    //   {{upstream}}           — last message content (from whoever spoke before this agent)
    //   {{self}}               — this agent's own last output (for continue/phase flows)
    //   {{input}}              — whichever is contextually relevant: self (continue) or upstream
    //   {{hasClarifications}}  — boolean true if there are clarification rounds
    //   {{clarificationHistory}} — array of objects containing priorQuestions and userResponse
    //   {{last.agentName}}     — last output from a specific agent (e.g., {{last.business_analyst}})
    //   {{lastStatus}}         — the STATUS token from the last message
    //   {{selfStatus}}         — this agent's own last STATUS token
    //   {{speaker}}            — name/role of whoever sent the last message

    // Per-agent last outputs: {{last.business_analyst}}, {{last.software_architect}}, etc.
    const last = {};
    for (const agentId of getActiveAgents()) {
        const agentMsgs = state.messages.filter(m => m.name === agentId);
        last[agentId] = agentMsgs.length ? agentMsgs[agentMsgs.length - 1].content : "";
    }

    const values = {
        // Core context
        directive: getMsgContent(state.messages[0]),
        upstream: otherLastContent,
        self: selfLastContent,
        input: otherLastContent,

        // Interaction / clarification history
        hasClarifications: rounds.length > 0,
        clarificationHistory,
        clarificationRound: rounds.length,
        maxClarificationRounds: getPipeline().maxClarificationRounds || 5,
        clarificationsRemaining: Math.max(0, (getPipeline().maxClarificationRounds || 5) - rounds.length),
        clarificationsExhausted: rounds.length >= (getPipeline().maxClarificationRounds || 5),

        // Per-agent outputs
        last,

        // Status metadata
        lastStatus: extractStatus(getMsgContent(lastMsg)) || "",
        selfStatus: lastSelfStatus || "",
        speaker: getMsgName(lastMsg) || getMsgRole(lastMsg),

    };

    const lastMsgStatus = extractStatus(lastMsg.content);

    // 2. If downstream agent sent work back for review (approval triggers from config)
    const routing = getRouting(nodeName);
    if (routing?.approval_triggers?.includes(lastMsgStatus) && hasPrompt("approval")) {
        return renderPrompt(nodeName, "approval", values);
    }

    // 3. If answering a QUESTION from downstream
    if (lastMsgStatus === "QUESTION") {
        return renderPrompt(nodeName, "main", values);
    }

    // 4. Run query to clarify ambiguities unless already clarified
    if (hasPrompt("query")) {
        const isClarified = lastSelfStatus && (lastSelfStatus.endsWith("_CLEAR") || lastSelfStatus.endsWith("_APPROVED"));
        if (!isClarified) {
            // Query template handles both initial questions and follow-up clarifications
            // (priorQuestions/userResponse are injected when available)
            return renderPrompt(nodeName, "query", values);
        }
    }

    return renderPrompt(nodeName, "main", values);
}

// Prompt node: generates the system prompt and commits it to state immediately
function promptNode(nodeName, state) {
    const systemPromptStr = getPromptForNode(state, nodeName);
    return { messages: [{ role: "system", name: `${nodeName}__prompt`, content: systemPromptStr }] };
}

// Agent node: reads the prompt from state, calls the LLM, and auto-continues on truncation.
// If the response has no STATUS token, it's assumed truncated and the LLM is called again
// with the accumulated output as context. The final committed message is the merged result.
const MAX_CONTINUATIONS = 5;

async function agentNode(nodeName, state, nodeConfig) {
    const promptMsgs = state.messages.filter(m => getMsgName(m) === `${nodeName}__prompt`);
    const systemPromptStr = promptMsgs.length ? getMsgContent(promptMsgs[promptMsgs.length - 1]) : `You are ${nodeName}.`;

    const directiveMsg = getMsgContent(state.messages[0]);
    const lastNonPromptMsg = [...state.messages].reverse().find(m => !getMsgName(m).endsWith("__prompt") && getMsgName(m) !== `${nodeName}__prompt`);
    const lastMsg = lastNonPromptMsg || state.messages[state.messages.length - 1];

    const agentDef = config.agents[nodeName];
    const llm = llms[agentDef?.model || "specialist"];

    let accumulated = "";
    let messagesToPass = [
        { role: "system", content: systemPromptStr },
        { role: "user", content: `[ORIGINAL DIRECTIVE]:\n${directiveMsg}\n\n[LATEST UPDATE FROM ${getMsgName(lastMsg) || lastMsg.role || "USER"}]:\n${getMsgContent(lastMsg)}` }
    ];

    for (let attempt = 0; attempt <= MAX_CONTINUATIONS; attempt++) {
        const response = await llm.invoke(messagesToPass, { signal: nodeConfig?.signal });
        const chunk = typeof response.content === 'string' ? response.content.trim() : String(response.content || "");
        accumulated += (accumulated && !accumulated.endsWith("\n") ? "\n" : "") + chunk;

        // Check if the response has a STATUS token (after stripping <think> blocks)
        const status = extractStatus(accumulated);
        if (status) {
            // Complete response — commit the merged result
            return { messages: [{ role: "assistant", name: nodeName, content: accumulated }] };
        }

        if (attempt === MAX_CONTINUATIONS) {
            // Max continuations reached — commit what we have
            console.error(`[AGENT] ${nodeName}: max continuations (${MAX_CONTINUATIONS}) reached without STATUS token`);
            return { messages: [{ role: "assistant", name: nodeName, content: accumulated }] };
        }

        // No STATUS token — truncated. Continue with accumulated context.
        console.error(`[AGENT] ${nodeName}: no STATUS token, auto-continuing (attempt ${attempt + 1}/${MAX_CONTINUATIONS})`);
        messagesToPass = [
            { role: "system", content: systemPromptStr },
            { role: "user", content: `[ORIGINAL DIRECTIVE]:\n${directiveMsg}\n\n[LATEST UPDATE FROM ${getMsgName(lastMsg) || lastMsg.role || "USER"}]:\n${getMsgContent(lastMsg)}` },
            { role: "assistant", content: accumulated },
            { role: "user", content: "Your previous output was truncated due to length limits. Please continue EXACTLY where you left off. Do not repeat any content already written. When finished, end with the appropriate STATUS token." }
        ];
    }
}

async function fallbackRouter(state, currentAgent) {
    const lastMsg = state.messages[state.messages.length - 1];
    const status = extractStatus(getMsgContent(lastMsg));
    const context = status
        ? `Status: ${status}`
        : `No status token found. Last 500 chars of output:\n${getMsgContent(lastMsg).slice(-500)}`;

    const prevMsg = state.messages.length > 1 ? state.messages[state.messages.length - 2] : null;
    const prevSpeaker = getMsgName(prevMsg) || getMsgRole(prevMsg) || "unknown";
    const prevStatus = prevMsg ? (extractStatus(getMsgContent(prevMsg)) || "unknown") : "unknown";
    const orchestrationContext = `Previous orchestration: ${prevSpeaker} -> ${prevStatus} -> routed to ${currentAgent}`;

    const routerCfg = getRouterConfig();
    let systemPrompt = routerCfg?.systemPrompt || "You are the router.";
    // Load from template file if it's a path
    if (systemPrompt.endsWith(".md")) {
        const filePath = join(__dirname, systemPrompt);
        if (existsSync(filePath)) systemPrompt = readFileSync(filePath, "utf8");
    }
    const messagesToPass = [
        { role: "system", content: systemPrompt },
        { role: "user", content: `${orchestrationContext}\nCurrent speaker: ${currentAgent}\n${context}` }
    ];

    console.log(`[ROUTER]: Fallback invoked for ${currentAgent}`);
    try {
        const response = await routerLLM.invoke(messagesToPass);
        let cleanText = response.content.replace(/<think>[\s\S]*?<\/think>/g, "").replace(/<\/?think>/g, "").trim();
        const start = cleanText.indexOf("{");
        const end = cleanText.lastIndexOf("}");
        if (start !== -1 && end !== -1) {
            const parsed = JSON.parse(cleanText.substring(start, end + 1));
            if (parsed.next_agent && parsed.next_agent !== "complete") return [parsed.next_agent];
            if (parsed.next_agent === "complete") return [END];
        }
    } catch (e) {
        console.error("Fallback router failed", e);
    }
    return [END];
}

// --- Config-driven routing ---
function buildRouteFunction(agentId) {
    const routingDef = getRouting(agentId);
    if (!routingDef) return (state) => fallbackRouter(state, agentId);

    return (state) => {
        const msgs = state.messages.filter(m => getMsgName(m) === agentId && !getMsgName(m).endsWith("__prompt"));
        if (!msgs.length) return fallbackRouter(state, agentId);
        const lastMsg = msgs[msgs.length - 1];
        const status = extractStatus(getMsgContent(lastMsg));

        if (!status) {
            console.log(`[ROUTER]: Missing status token for ${agentId}. Assuming truncation and auto-continuing.`);
            return resolveTarget("$self", agentId, state);
        }

        const target = routingDef.routes[status];
        if (target === undefined) return fallbackRouter(state, agentId);

        return resolveTarget(target, agentId, state);
    };
}

function routeFromStart(state) {
    const pipeline = getPipeline();
    if (!state.messages || state.messages.length === 0) return [pipeline.entry];
    const lastMsg = state.messages[state.messages.length - 1];
    const role = getMsgRole(lastMsg);
    const name = getMsgName(lastMsg);

    if (state.messages.length === 1) return [pipeline.entry];

    if (role === "user") {
        const msgsBefore = state.messages.slice(0, -1);
        const lastAssistant = msgsBefore.filter(m => getMsgRole(m) === "assistant" && !getMsgName(m).endsWith("__prompt")).pop();
        if (lastAssistant) {
            const status = extractStatus(getMsgContent(lastAssistant));
            const questionStatuses = pipeline.question_statuses || [];
            if (questionStatuses.includes(status) || status === "QUESTION") {
                return [getMsgName(lastAssistant)];
            }
        }
        return [pipeline.entry];
    }
    
    if (role === "system" && name.endsWith("__prompt")) {
        // Rewound to a system prompt. Route directly to the corresponding agent.
        // Returning the agent name causes appendPromptSuffix to append __prompt,
        // but START edges don't allow skipping the prompt node if appendPromptSuffix is applied to everything.
        // Wait, if we return the agent name, appendPromptSuffix adds __prompt, so it just runs the prompt node AGAIN, replacing the one we just injected. This is fine and safe.
        return [name.replace("__prompt", "")];
    }

    if (role === "assistant" && name && !name.endsWith("__prompt")) {
        // Rewound to an assistant message. Execute its routing function.
        const routeFn = buildRouteFunction(name);
        return routeFn(state);
    }

    return fallbackRouter(state, "user");
}

// --- Build graph dynamically from config ---
// Each agent is split into two nodes:
//   {agent}_prompt → generates and commits the system prompt (checkpointed immediately)
//   {agent}        → calls the LLM with the prompt and commits the response
// Routing runs after the agent node (not the prompt node).

const activeAgents = getActiveAgents();
const workflow = new StateGraph(GraphState);

for (const agentId of activeAgents) {
    const promptId = `${agentId}_prompt`;
    workflow.addNode(promptId, (state) => promptNode(agentId, state));
    workflow.addNode(agentId, (state, cfg) => agentNode(agentId, state, cfg));
    // Wire: prompt → agent (sequential)
    workflow.addEdge(promptId, agentId);
}

function appendPromptSuffix(targets) {
    if (!Array.isArray(targets)) return targets;
    return targets.map(t => {
        if (t === END) return END;
        if (typeof t === "string" && activeAgents.includes(t)) return `${t}_prompt`;
        return t;
    });
}

// Routing from START goes to {agent}_prompt nodes
workflow.addConditionalEdges(START, async (state) => {
    const targets = await routeFromStart(state);
    return appendPromptSuffix(targets);
});

// Routing from each agent goes to the NEXT agent's prompt node
for (const agentId of activeAgents) {
    const routeFn = buildRouteFunction(agentId);
    workflow.addConditionalEdges(agentId, async (state) => {
        const targets = await routeFn(state);
        return appendPromptSuffix(targets);
    });
}

const app = workflow.compile({ checkpointer });
export { app, routerLLM, initConfig };
