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
    const matches = [...content.matchAll(/STATUS:\s*([A-Z_]+)/g)];
    return matches.length ? matches[matches.length - 1][1] : null;
}

function cleanSpecialistOutput(content) {
    if (typeof content !== 'string') return String(content || "");
    return content.replace(/<think>[\s\S]*?<\/think>/g, "").replace(/<\/?think>/g, "").trim();
}

function getPromptForNode(state, nodeName) {
    const msgs = state.messages.filter(m => m.name === nodeName);
    const lastSelfStatus = msgs.length ? extractStatus(msgs[msgs.length - 1].content) : null;
    const lastMsg = state.messages[state.messages.length - 1];
    const agent = config.agents[nodeName];

    const prompts = Array.isArray(agent?.prompts) ? agent.prompts : Object.keys(agent?.prompts || {});
    if (!prompts.length) return `You are ${nodeName}.`;
    const hasPrompt = (v) => prompts.includes(v);

    const selfLastContent = msgs.length ? msgs[msgs.length - 1].content : "";
    const otherLastContent = lastMsg ? lastMsg.content : "";
    const isContinue = lastSelfStatus && lastSelfStatus.includes("_PHASE_CONTINUE");

    const isUserReply = lastMsg.role === "user" || lastMsg.role === "human";
    let priorQuestions = "";
    if (isUserReply && msgs.length) {
        const lastSelf = msgs[msgs.length - 1];
        const selfStatus = extractStatus(lastSelf.content);
        const questionStatuses = getPipeline().question_statuses || [];
        if (questionStatuses.includes(selfStatus) || selfStatus === "QUESTION") {
            priorQuestions = lastSelf.content;
        }
    }

    // Build values dynamically from state — no hardcoded domain concepts.
    // Templates can reference:
    //   {{directive}}          — the original user directive (first message)
    //   {{upstream}}           — last message content (from whoever spoke before this agent)
    //   {{self}}               — this agent's own last output (for continue/phase flows)
    //   {{input}}              — whichever is contextually relevant: self (continue) or upstream
    //   {{priorQuestions}}     — this agent's last output IF it ended with a question status
    //   {{userResponse}}       — the user's latest message (if replying)
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
        directive: state.messages[0] ? state.messages[0].content : "",
        upstream: otherLastContent,
        self: selfLastContent,
        input: isContinue ? selfLastContent : otherLastContent,

        // Interaction
        priorQuestions,
        userResponse: isUserReply ? lastMsg.content : "",

        // Per-agent outputs
        last,

        // Status metadata
        lastStatus: lastMsg ? (extractStatus(lastMsg.content) || "") : "",
        selfStatus: lastSelfStatus || "",
        speaker: lastMsg?.name || lastMsg?.role || "user",

    };

    // 1. If continuing own phase
    if (lastSelfStatus && lastSelfStatus.includes("_PHASE_CONTINUE") && hasPrompt("continue")) {
        return renderPrompt(nodeName, "continue", values);
    }

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

    // 4. Run query to clarify ambiguities unless already clarified or user replied
    if (hasPrompt("query")) {
        const isClarified = lastSelfStatus && (lastSelfStatus.endsWith("_CLEAR") || lastSelfStatus.endsWith("_APPROVED"));
        const userRepliedToQuestions = priorQuestions && isUserReply;
        if (!isClarified && !userRepliedToQuestions) {
            return renderPrompt(nodeName, "query", values);
        }
    }

    return renderPrompt(nodeName, "main", values);
}

async function genericNode(nodeName, state, nodeConfig) {
    const systemPromptStr = getPromptForNode(state, nodeName);
    const directiveMsg = state.messages[0].content;
    const lastMsg = state.messages[state.messages.length - 1];

    const agentDef = config.agents[nodeName];
    const llm = llms[agentDef?.model || "specialist"];

    const messagesToPass = [
        { role: "system", content: systemPromptStr },
        { role: "user", content: `[ORIGINAL DIRECTIVE]:\n${directiveMsg}\n\n[LATEST UPDATE FROM ${lastMsg.name || lastMsg.role || "USER"}]:\n${lastMsg.content}` }
    ];

    const response = await llm.invoke(messagesToPass, { signal: nodeConfig?.signal });
    const content = cleanSpecialistOutput(response.content);
    return { messages: [{ role: "assistant", name: nodeName, content }] };
}

async function fallbackRouter(state, currentAgent) {
    const lastMsg = state.messages[state.messages.length - 1];
    const status = extractStatus(lastMsg.content);
    const context = status
        ? `Status: ${status}`
        : `No status token found. Last 500 chars of output:\n${lastMsg.content.slice(-500)}`;

    const prevMsg = state.messages.length > 1 ? state.messages[state.messages.length - 2] : null;
    const prevSpeaker = prevMsg?.name || prevMsg?.role || "unknown";
    const prevStatus = prevMsg ? (extractStatus(prevMsg.content) || "unknown") : "unknown";
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
        const msgs = state.messages.filter(m => m.name === agentId);
        if (!msgs.length) return fallbackRouter(state, agentId);
        const lastMsg = msgs[msgs.length - 1];
        const status = extractStatus(lastMsg.content);

        const target = routingDef.routes[status];
        if (target === undefined) return fallbackRouter(state, agentId);

        return resolveTarget(target, agentId, state);
    };
}

function routeFromStart(state) {
    const pipeline = getPipeline();
    if (!state.messages || state.messages.length === 0) return [pipeline.entry];
    const lastMsg = state.messages[state.messages.length - 1];
    const isUser = lastMsg && (lastMsg.role === "user" || lastMsg.role === "human");

    if (state.messages.length === 1) return [pipeline.entry];

    if (isUser) {
        const msgsBefore = state.messages.slice(0, -1);
        const lastAssistant = msgsBefore.filter(m => m.role === "assistant").pop();
        if (lastAssistant) {
            const status = extractStatus(lastAssistant.content);
            const questionStatuses = pipeline.question_statuses || [];
            if (questionStatuses.includes(status) || status === "QUESTION") {
                return [lastAssistant.name];
            }
        }
        return [pipeline.entry];
    }

    return fallbackRouter(state, "user");
}

// --- Build graph dynamically from config ---
const activeAgents = getActiveAgents();
const workflow = new StateGraph(GraphState);

for (const agentId of activeAgents) {
    workflow.addNode(agentId, (state, cfg) => genericNode(agentId, state, cfg));
}

workflow.addConditionalEdges(START, routeFromStart);

for (const agentId of activeAgents) {
    workflow.addConditionalEdges(agentId, buildRouteFunction(agentId));
}

const app = workflow.compile({ checkpointer });
export { app, routerLLM, initConfig };
