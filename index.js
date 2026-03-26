import "dotenv/config";
import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from "@langchain/core/messages";
import { StateGraph, MessagesAnnotation, Annotation, START, END } from "@langchain/langgraph";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { createLLM } from "./src/utils/llm.js";
import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { z } from "zod";
import { getConfig, getActiveAgents, getRouting, getPipeline, getRouterConfig, initConfig } from "./src/config/loader.js";
import { renderPrompt } from "./src/config/templates.js";
import { resolveTarget } from "./src/config/routing.js";
import { searchDDG, fetchPageWithMeta } from "./tools/web-search/tools.js";
import { EventEmitter } from "events";
import { Langfuse } from "langfuse";
import { CallbackHandler } from "langfuse-langchain";

const langfuse = new Langfuse({
  publicKey: process.env.LANGFUSE_PUBLIC_KEY,
  secretKey: process.env.LANGFUSE_SECRET_KEY,
  baseUrl: process.env.LANGFUSE_BASE_URL || process.env.LANGFUSE_HOST
});

const __dirname = dirname(fileURLToPath(import.meta.url));

export const researchEvents = new EventEmitter();

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

// Web research tools for main-phase agents
const TOOL_ELIGIBLE_AGENTS = ["business_analyst", "software_architect", "ux_designer"];

const webResearchTools = [
    {
        type: "function",
        function: {
            name: "web_search",
            description: "Search the web for industry best practices and standards related to an identified gap. Use once per gap identified.",
            parameters: {
                type: "object",
                properties: {
                    query: { type: "string", description: "Search query focused on best practices/standards for a specific gap" }
                },
                required: ["query"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "fetch_page",
            description: "Fetch a web page to read detailed content. Choose the 3 strongest candidates from each web_search result (max 3 fetches per search).",
            parameters: {
                type: "object",
                properties: {
                    url: { type: "string", description: "URL to fetch" }
                },
                required: ["url"]
            }
        }
    }
];

async function executeToolCall(call, ctx, nodeConfig) {
    const emit = (data) => { if (ctx) researchEvents.emit("tool", { ...data, threadId: ctx.threadId, agent: ctx.agent }); };
    
    // Manual Langfuse span for tool execution
    let span = null;
    if (ctx?.threadId) {
        // nodeConfig.callbacks is a CallbackManager, not an array — check .handlers
        const callbacks = nodeConfig?.callbacks;
        const handlers = Array.isArray(callbacks) ? callbacks : callbacks?.handlers || [];
        const handler = handlers.find(c => c instanceof CallbackHandler);
        if (handler?.trace) {
            span = handler.trace.span({
                name: `tool_${call.name}`,
                input: call.args,
                metadata: { agent: ctx.agent }
            });
        } else {
            span = langfuse.span({
                name: `tool_${call.name}`,
                sessionId: ctx.threadId,
                input: call.args,
                metadata: { agent: ctx.agent }
            });
        }
    }

    try {
        if (call.name === "web_search") {
            emit({ type: "search", status: "running", query: call.args.query });
            const results = await searchDDG(call.args.query, 5);
            const mapped = results.map(r => ({ title: r.title, url: r.url, snippet: r.snippet }));
            emit({ type: "search", status: "complete", query: call.args.query, results: mapped });
            if (span) span.end({ output: mapped });
            return JSON.stringify(mapped);
        }
        if (call.name === "fetch_page") {
            let domain = "";
            try { domain = new URL(call.args.url).hostname; } catch {}
            emit({ type: "fetch", status: "running", url: call.args.url, domain, favicon: domain ? `https://www.google.com/s2/favicons?domain=${domain}&sz=32` : "" });
            const meta = await fetchPageWithMeta(call.args.url);
            emit({ type: "fetch", status: "complete", url: call.args.url, domain, title: meta.title, favicon: meta.favicon });
            if (span) span.end({ output: { title: meta.title, url: call.args.url, textLength: meta.text?.length } });
            return meta.text;
        }
    } catch (err) {
        emit({ type: call.name === "web_search" ? "search" : "fetch", status: "error", error: err.message });
        if (span) span.end({ level: "ERROR", statusMessage: err.message });
        return `Error: ${err.message}`;
    }
    if (span) span.end({ output: "Unknown tool" });
    return "Unknown tool";
}

const MAX_RESEARCH_ROUNDS = 5;

async function runResearch(llm, messages, ctx, nodeConfig) {
    const phase1Tools = [
        {
            type: "function",
            function: {
                name: "web_search",
                description: "Search DuckDuckGo for industry best practices.",
                parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] }
            }
        },
        {
            type: "function",
            function: {
                name: "submit_links",
                description: "Submit up to 5 relevant article URLs to be deeply researched.",
                parameters: {
                    type: "object",
                    properties: {
                        urls: { type: "array", items: { type: "string", description: "URL of the article" }, description: "Array of URLs" }
                    },
                    required: ["urls"]
                }
            }
        }
    ];

    // Phase 1 tools
    const phase1PromptMsg = messages.find(m => m.role === "system")?.content || "Phase 1: Search for industry best practices.";
    const phase1AgentName = ctx?.agent || "research";

    const llmPhase1 = llm.bindTools(phase1Tools);
    const phase1History = [...messages];
    
    phase1History.push({ role: "system", content: `You are in Phase 1 of research. Today's date is ${new Date().toDateString()}. Use the web_search tool to find industry best practices relative to the directive and rounds. Once you find good candidates, you MUST use the submit_links tool to provide up to 5 URLs to be researched. Do not attempt to read the articles yourself.` });

    let urlsToFetch = [];

    for (let round = 0; round < MAX_RESEARCH_ROUNDS; round++) {
        const response = await llmPhase1.invoke(phase1History, nodeConfig);

        if (!response.tool_calls?.length) {
            break; 
        }

        phase1History.push(response);
        let submitted = false;
        
        for (const call of response.tool_calls) {
            console.error(`[RESEARCH P1] Tool call: ${call.name}(${JSON.stringify(call.args).slice(0, 120)})`);
            if (call.name === "submit_links") {
                urlsToFetch = call.args.urls || [];
                phase1History.push(new ToolMessage({ content: "Links submitted successfully.", tool_call_id: call.id, name: call.name }));
                submitted = true;
            } else if (call.name === "web_search") {
                const result = await executeToolCall(call, ctx, nodeConfig);
                phase1History.push(new ToolMessage({ content: result || "No content found.", tool_call_id: call.id, name: call.name }));
            } else {
                phase1History.push(new ToolMessage({ content: "Unknown tool", tool_call_id: call.id, name: call.name }));
            }
        }
        
        if (submitted) break;
    }

    if (!urlsToFetch || urlsToFetch.length === 0) {
        return ""; // No links submitted
    }

    // Trim to 5 URLs
    urlsToFetch = urlsToFetch.slice(0, 5);
    console.error(`[RESEARCH P2] Fetching ${urlsToFetch.length} URLs in parallel...`);

    // Phase 2: Parallel Fetch and Summarize
    const phase2PromptText = `You are an expert researcher. Read the provided article content and extract ONLY the industry best practice details relevant to the user's directive and context. Do not output raw text, only the extracted relevant details. Ensure your extraction is concise and directly applicable.`;

    const phase2Promises = urlsToFetch.map(async (url, index) => {
        const subAgentName = `${phase1AgentName.replace("_research", "")}_research_phase_2_${index + 1}`;
        try {
            if (ctx && researchEvents) {
                researchEvents.emit("prompt", { threadId: ctx.threadId, agent: subAgentName, prompt: phase2PromptText + `\n\nTarget URL: ${url}` });
            }

            console.error(`[RESEARCH P2] Fetching ${url}`);
            const fetchCtx = { ...ctx, agent: subAgentName };
            const fetchResult = await executeToolCall({ name: "fetch_page", args: { url } }, fetchCtx, nodeConfig);
            
            if (!fetchResult || fetchResult.startsWith("Error:")) {
                const errStr = `URL: ${url}\nFailed to fetch or read content.`;
                if (ctx && researchEvents) {
                    researchEvents.emit("chunk", { threadId: ctx.threadId, agent: subAgentName, content: errStr });
                    researchEvents.emit("stop", { threadId: ctx.threadId, agent: subAgentName });
                }
                return errStr;
            }

            const phase2History = [
                ...messages.filter(m => m.role === "user"),
                { role: "system", content: phase2PromptText },
                { role: "user", content: `[SOURCE URL]: ${url}\n\n[ARTICLE CONTENT]:\n${fetchResult.slice(0, 20000)}\n\nExtract the relevant best practices from the article above.` }
            ];

            const stream = await llm.stream(phase2History, { ...nodeConfig, tags: ["hide_stream"] });
            let extracted = "";
            for await (const chunk of stream) {
                const text = typeof chunk.content === 'string' ? chunk.content : String(chunk.content || "");
                extracted += text;
                if (ctx && researchEvents) {
                    researchEvents.emit("chunk", { threadId: ctx.threadId, agent: subAgentName, content: text });
                }
            }

            if (ctx && researchEvents) {
                researchEvents.emit("stop", { threadId: ctx.threadId, agent: subAgentName });
            }

            let cleaned = extracted.replace(/<think>[\s\S]*?(?:<\/think>|$)/g, "").replace(/<\/?think>/g, "").trim();
            return `[SOURCE URL]: ${url}\n[RESEARCH-BASED RECOMMENDATIONS]:\n${cleaned}`;
            
        } catch (err) {
            console.error(`[RESEARCH P2] Error processing ${url}: ${err.message}`);
            if (ctx && researchEvents) {
                researchEvents.emit("stop", { threadId: ctx.threadId, agent: subAgentName });
            }
            return `URL: ${url}\nError processing content.`;
        }
    });

    const phase2Results = await Promise.all(phase2Promises);
    
    const combined = phase2Results.join("\n\n---\n\n");
    return phase2Results.length
        ? "\n\n[RESEARCH FINDINGS FROM WEB]:\n(Note: The following research represents aggregated industry trends and ideas. Use your professional judgment when considering this information; it is helpful context but not necessarily the ultimate truth on how to implement the solution.)\n\n" + combined
        : "";
}

function extractStatus(content) {
    if (!content) return null;
    const cleaned = cleanSpecialistOutput(content);
    const matches = [...cleaned.matchAll(/STATUS:\s*([A-Z_]+)/g)];
    return matches.length ? matches[matches.length - 1][1] : null;
}

function cleanSpecialistOutput(content) {
    if (typeof content !== 'string') return String(content || "");
    return content.replace(/<think>[\s\S]*?(?:<\/think>|$)/g, "").replace(/<\/?think>/g, "").trim();
}

function getMsgName(m) {
    const name = m?.name || m?.kwargs?.name || m?.additional_kwargs?.name || "";
    return typeof name === 'string' ? name : String(name || "");
}

function getMsgRole(m) {
    const type = m?.type || m?._getType?.() || "";
    if (type === "system") return "system";
    return m?.role || m?.kwargs?.role || (type === "human" ? "user" : getMsgName(m) ? "assistant" : type === "ai" ? "assistant" : "user");
}

function getMsgContent(m) {
    return m?.content || m?.kwargs?.content || "";
}

function getPromptForNode(state, nodeName) {
    // 1. Identify "Milestones" to isolate context segments (Branching into a fresh state)
    const MILESTONE_STATUSES = [
        "DIRECTIVE_CLEAR", "REQUIREMENTS_CLEAR", "IMPLEMENTATION_CLEAR", "TESTING_CLEAR",
        "REQUIREMENTS_DRAFTED", "DESIGN_COMPLETE", "IMPLEMENTATION_COMPLETE", "TESTING_COMPLETE",
        "REQUIREMENTS_APPROVED", "DESIGN_APPROVED", "IMPLEMENTATION_APPROVED", "TESTS_PASSED"
    ];
    const allMsgsRaw = state.messages.filter(m => !getMsgName(m).endsWith("__prompt") && !getMsgName(m).endsWith("__research"));
    
    // Find the latest milestone to act as a context "firewall"
    let milestoneIndex = -1;
    for (let i = allMsgsRaw.length - 1; i >= 0; i--) {
        if (MILESTONE_STATUSES.includes(extractStatus(getMsgContent(allMsgsRaw[i])))) {
            milestoneIndex = i;
            break;
        }
    }

    // "Branching" the state: only use messages from the last milestone forward for context building
    const allMsgs = milestoneIndex !== -1 ? allMsgsRaw.slice(milestoneIndex) : allMsgsRaw;
    const effectiveDirective = milestoneIndex !== -1 ? getMsgContent(allMsgsRaw[milestoneIndex]) : getMsgContent(state.messages[0]);

    const msgs = allMsgs.filter(m => getMsgName(m) === nodeName);
    const lastSelfStatus = msgs.length ? extractStatus(getMsgContent(msgs[msgs.length - 1])) : null;
    
    // Last non-prompt message for context within this branch
    const lastMsg = allMsgs.length ? allMsgs[allMsgs.length - 1] : state.messages[state.messages.length - 1];
    const agent = config.agents[nodeName];

    const prompts = Array.isArray(agent?.prompts) ? agent.prompts : Object.keys(agent?.prompts || {});
    if (!prompts.length) return { prompt: `You are ${nodeName}.`, useTools: false };
    const hasPrompt = (v) => prompts.includes(v);

    // Find the last message from this agent that was NOT a query-phase output
    const questionStatuses = getPipeline().question_statuses || [];
    const queryEndStatuses = [...questionStatuses, "DIRECTIVE_CLEAR", "REQUIREMENTS_CLEAR"];
    const lastMainMsg = [...msgs].reverse().find(m => {
        const status = extractStatus(getMsgContent(m));
        return status && !queryEndStatuses.includes(status);
    });
    
    const selfLastContent = lastMainMsg ? cleanSpecialistOutput(getMsgContent(lastMainMsg)) : "";
    const otherLastContent = lastMsg ? cleanSpecialistOutput(getMsgContent(lastMsg)) : "";

    const isUserReply = getMsgRole(lastMsg) === "user";

    // Build full clarification history — only within the current "Branch"
    let clarificationHistory = null;
    const rounds = [];
    let roundCounter = 1;

    // Identify the "parent" agent (whoever this agent reports to)
    const group = syncGroups.find(p => p.members.includes(nodeName));
    const parentName = group ? group.parent : (getPipeline().entry || "business_analyst");

    for (let i = 0; i < allMsgs.length; i++) {
        const m = allMsgs[i];
        if (getMsgName(m) === nodeName) {
            const content = getMsgContent(m);
            const status = extractStatus(content);
            if (questionStatuses.includes(status) || status === "QUESTION") {
                const nextReply = allMsgs.slice(i + 1).find(n => {
                    const name = getMsgName(n);
                    const role = getMsgRole(n);
                    return name === parentName || role === "user";
                });

                if (nextReply) {
                    rounds.push({ 
                        roundNumber: roundCounter++, 
                        priorQuestions: cleanSpecialistOutput(content), 
                        userResponse: getMsgContent(nextReply),
                        responder: getMsgName(nextReply) || getMsgRole(nextReply)
                    });
                }
            }
        }
    }
    if (rounds.length) {
        clarificationHistory = rounds;
    }

    // Per-agent last outputs: {{last.business_analyst}}, {{last.software_architect}}, etc.
    const last = {};
    for (const agentId of getActiveAgents()) {
        const agentMsgs = allMsgs.filter(m => getMsgName(m) === agentId);
        last[agentId] = agentMsgs.length ? cleanSpecialistOutput(agentMsgs[agentMsgs.length - 1].content) : "";
    }

    const values = {
        // Core context
        directive: effectiveDirective,
        upstream: otherLastContent,
        self: selfLastContent,
        input: otherLastContent,

        // Interaction / clarification history
        hasClarifications: rounds.length > 0,
        clarificationHistory,
        clarificationRound: rounds.length,
        nextRoundNumber: rounds.length + 1,
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

    const useToolsForMain = TOOL_ELIGIBLE_AGENTS.includes(nodeName);

    // 2. If downstream agent sent work back for review (approval triggers from config)
    const routing = getRouting(nodeName);
    if (routing?.approval_triggers?.includes(lastMsgStatus) && hasPrompt("approval")) {
        return { prompt: renderPrompt(nodeName, "approval", values), useTools: false };
    }

    // 3. If answering a QUESTION from downstream
    if (lastMsgStatus === "QUESTION") {
        return { prompt: renderPrompt(nodeName, "main", values), useTools: useToolsForMain };
    }

    // 4. Run query to clarify ambiguities unless already clarified or exhausted
    if (hasPrompt("query")) {
        // We consider the query phase "done" if we've already reached a CLEAR, APPROVED, or DRAFTED state once.
        const isPastQueryPhase = lastSelfStatus && (
            lastSelfStatus.endsWith("_CLEAR") ||
            lastSelfStatus.endsWith("_APPROVED") ||
            lastSelfStatus.endsWith("_DRAFTED")
        );

        // If the user just replied, stay in query mode to potentially ask follow-ups,
        // unless we've already moved past the query phase. The query prompt handles exhaustion warnings.
        if (!isPastQueryPhase) {
            return { prompt: renderPrompt(nodeName, "query", values), useTools: false };
        }
    }

    return { prompt: renderPrompt(nodeName, "main", values), useTools: useToolsForMain };
}

// Prompt node: generates the system prompt and commits it to state immediately
function promptNode(nodeName, state) {
    const { prompt, useTools } = getPromptForNode(state, nodeName);
    return { messages: [new SystemMessage({ content: prompt, name: `${nodeName}__prompt`, additional_kwargs: { timestamp: Date.now(), useTools } })] };
}

// Agent node: reads the prompt from state, calls the LLM, and auto-continues on truncation.
// If the response has no STATUS token, it's assumed truncated and the LLM is called again
// with the accumulated output as context. The final committed message is the merged result.

async function researchNode(nodeName, state, nodeConfig) {
    const promptMsgs = state.messages.filter(m => getMsgName(m) === `${nodeName}__prompt`);
    const lastPromptMsg = promptMsgs.length ? promptMsgs[promptMsgs.length - 1] : null;
    const useTools = lastPromptMsg?.additional_kwargs?.useTools || false;

    if (!useTools) return {};

    const directiveMsg = getMsgContent(state.messages[0]);
    const validMsgs = state.messages.filter(m => !getMsgName(m).endsWith("__prompt") && !getMsgName(m).endsWith("__research"));
    const lastMsg = validMsgs.length > 1 ? validMsgs[validMsgs.length - 1] : state.messages[0];

    const agentDef = config.agents[nodeName];
    const llm = llms[agentDef?.model || "specialist"];

    const researchPrompt = `You are the ${nodeName}. Your task is ONLY to research industry best practices, standards, and existing solutions relevant to the user's directive and any team feedback.
Today's date is ${new Date().toDateString()}. Use this context when searching for the most recent and relevant information.
Use the available tools to search the web and fetch pages.
DO NOT draft the final response or requirements yet. Gather as much useful information as possible using the tools.
When you are done researching, or if no research is needed, simply stop calling tools.`;

    let messagesToPass = [
        { role: "system", content: researchPrompt },
        { role: "user", content: `[ORIGINAL DIRECTIVE]:\n${directiveMsg}\n\n[LATEST UPDATE FROM ${getMsgName(lastMsg) || lastMsg.role || "USER"}]:\n${cleanSpecialistOutput(getMsgContent(lastMsg))}` }
    ];

    console.error(`[AGENT] ${nodeName}: running web research phase`);
    const threadId = nodeConfig?.configurable?.thread_id || "";
    const research = await runResearch(llm, messagesToPass, { threadId, agent: `${nodeName}_research` }, nodeConfig);

    if (research) {
        console.error(`[AGENT] ${nodeName}: research complete (${research.length} chars)`);
        return { messages: [new AIMessage({ content: research, name: `${nodeName}__research`, additional_kwargs: { timestamp: Date.now() } })] };
    }
    return {};
}

const MAX_CONTINUATIONS = 5;

async function agentNode(nodeName, state, nodeConfig) {
    const promptMsgs = state.messages.filter(m => getMsgName(m) === `${nodeName}__prompt`);
    const lastPromptMsg = promptMsgs.length ? promptMsgs[promptMsgs.length - 1] : null;
    const systemPromptStr = lastPromptMsg ? getMsgContent(lastPromptMsg) : `You are ${nodeName}.`;
    const useTools = lastPromptMsg?.additional_kwargs?.useTools || false;

    // Identify the latest milestone for context isolation (same logic as getPromptForNode)
    const MILESTONE_STATUSES = [
        "DIRECTIVE_CLEAR", "REQUIREMENTS_CLEAR", "IMPLEMENTATION_CLEAR", "TESTING_CLEAR",
        "REQUIREMENTS_DRAFTED", "DESIGN_COMPLETE", "IMPLEMENTATION_COMPLETE", "TESTING_COMPLETE",
        "REQUIREMENTS_APPROVED", "DESIGN_APPROVED", "IMPLEMENTATION_APPROVED", "TESTS_PASSED"
    ];
    const allMsgsRaw = state.messages.filter(m => !getMsgName(m).endsWith("__prompt") && !getMsgName(m).endsWith("__research"));
    let milestoneIndex = -1;
    for (let i = allMsgsRaw.length - 1; i >= 0; i--) {
        if (MILESTONE_STATUSES.includes(extractStatus(getMsgContent(allMsgsRaw[i])))) {
            milestoneIndex = i;
            break;
        }
    }

    const directiveMsg = milestoneIndex !== -1 ? getMsgContent(allMsgsRaw[milestoneIndex]) : getMsgContent(state.messages[0]);
    const lastNonPromptMsg = [...state.messages].reverse().find(m => !getMsgName(m).endsWith("__prompt") && !getMsgName(m).endsWith("__research") && getMsgName(m) !== `${nodeName}__prompt`);
    const lastMsg = lastNonPromptMsg || state.messages[state.messages.length - 1];

    const agentDef = config.agents[nodeName];
    const llm = llms[agentDef?.model || "specialist"];

    let accumulated = "";
    
    // Filter out __prompt and __research for context building
    const validStateMsgs = state.messages.filter(m => !getMsgName(m).endsWith("__prompt") && !getMsgName(m).endsWith("__research") && getMsgName(m) !== nodeName);
    const validLastMsg = validStateMsgs.length ? validStateMsgs[validStateMsgs.length - 1] : state.messages[0];

    // Find if there was research generated for THIS turn
    const researchMsgs = state.messages.filter(m => getMsgName(m) === `${nodeName}__research`);
    const latestResearchMsg = researchMsgs.length ? researchMsgs[researchMsgs.length - 1] : null;
    let researchText = "";
    if (latestResearchMsg && lastPromptMsg && state.messages.indexOf(latestResearchMsg) > state.messages.lastIndexOf(lastPromptMsg)) {
        researchText = getMsgContent(latestResearchMsg);
    }

    // Context Pruning Interceptor: 
    // 1. Truncate Research (8k chars max = ~2k tokens) to prevent KV cache explosion
    const MAX_RESEARCH_CHARS = 8000;
    const prunedResearch = researchText.length > MAX_RESEARCH_CHARS 
        ? researchText.slice(0, MAX_RESEARCH_CHARS) + "\n\n[... Research findings truncated to save context window]" 
        : researchText;

    // 2. Truncate Directive if this is a late-stage revision or after a Milestone
    let directiveToPass = cleanSpecialistOutput(directiveMsg);
    if ((state.messages.length > 20 || milestoneIndex !== -1) && directiveToPass.length > 2000) {
        directiveToPass = directiveToPass.slice(0, 1500) + "\n\n[... directive truncated for length; see current status for full details]";
    }

    let userContent = `[ORIGINAL DIRECTIVE]:\n${directiveToPass}\n\n[LATEST UPDATE FROM ${getMsgName(validLastMsg) || validLastMsg.role || "USER"}]:\n${cleanSpecialistOutput(getMsgContent(validLastMsg))}`;
    if (prunedResearch) {
        userContent += "\n\n" + prunedResearch;
    }

    let messagesToPass = [
        { role: "system", content: systemPromptStr },
        { role: "user", content: userContent }
    ];

    for (let attempt = 0; attempt <= MAX_CONTINUATIONS; attempt++) {
        let chunkContent = "";
        const stream = await llm.stream(messagesToPass, nodeConfig);
        for await (const chunk of stream) {
            const text = typeof chunk.content === 'string' ? chunk.content : String(chunk.content || "");
            chunkContent += text;
        }
        
        accumulated += chunkContent;

        // Check if the response has a STATUS token (after stripping <think> blocks)
        const status = extractStatus(accumulated);
        if (status) {
            // Complete response — commit the merged result
            return { messages: [new AIMessage({ content: accumulated, name: nodeName, additional_kwargs: { timestamp: Date.now() } })] };
        }

        if (attempt === MAX_CONTINUATIONS) {
            // Max continuations reached — commit what we have
            console.error(`[AGENT] ${nodeName}: max continuations (${MAX_CONTINUATIONS}) reached without STATUS token`);
            return { messages: [new AIMessage({ content: accumulated, name: nodeName, additional_kwargs: { timestamp: Date.now() } })] };
        }

        // No STATUS token — truncated. Continue with accumulated context.
        console.error(`[AGENT] ${nodeName}: no STATUS token, auto-continuing (attempt ${attempt + 1}/${MAX_CONTINUATIONS})`);
        
        // Use Assistant Prefill pattern: the model continues from the last assistant message.
        messagesToPass = [
            { role: "system", content: systemPromptStr },
            { role: "user", content: userContent },
            { role: "assistant", content: accumulated }
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
const syncGroups = [
    { name: "design_sync", members: ["software_architect", "ux_designer"], parent: "business_analyst" }
];

function buildRouteFunction(agentId) {
    const routingDef = getRouting(agentId);
    if (!routingDef) return (state) => fallbackRouter(state, agentId);

    return (state) => {
        const msgs = state.messages.filter(m => getMsgName(m) === agentId && !getMsgName(m).endsWith("__prompt") && !getMsgName(m).endsWith("__research"));
        if (!msgs.length) return fallbackRouter(state, agentId);
        const lastMsg = msgs[msgs.length - 1];
        const status = extractStatus(getMsgContent(lastMsg));

        if (!status) {
            console.log(`[ROUTER]: Missing status token for ${agentId}. Assuming truncation and auto-continuing.`);
            return resolveTarget("$self", agentId, state);
        }

        const target = routingDef.routes[status];
        if (target === undefined) return fallbackRouter(state, agentId);

        const resolved = resolveTarget(target, agentId, state);

        // If it routes to itself, let it loop without syncing.
        if (resolved.length === 1 && resolved[0] === agentId) {
            return resolved;
        }

        const group = syncGroups.find(p => p.members.includes(agentId));
        if (group) {
            return [`sync_${group.name}`];
        }

        return resolved;
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
        const lastAssistant = msgsBefore.filter(m => getMsgRole(m) === "assistant" && !getMsgName(m).endsWith("__prompt") && !getMsgName(m).endsWith("__research")).pop();
        if (lastAssistant) {
            const status = extractStatus(getMsgContent(lastAssistant));
            const questionStatuses = pipeline.question_statuses || [];
            if (questionStatuses.includes(status) || status === "QUESTION") {
                return [getMsgName(lastAssistant)];
            }
        }
        return [pipeline.entry];
    }
    
    if (name && name.endsWith("__prompt")) {
        // Rewound to a system prompt. Route directly to the corresponding agent.
        return [`${name.replace("__prompt", "")}:skip_prompt`];
    }
    if (name && name.endsWith("__research")) {
        return [`${name.replace("__research", "")}`];
    }

    if (role === "assistant" && name && !name.endsWith("__prompt")) {
        // If we rewound to an assistant message, we want to re-run THAT agent,
        // not where its output would have routed to.
        return [`${name}_prompt`];
    }

    console.log(`[ROUTER-DEBUG]: routeFromStart falling back. role=${role}, name=${name}`);
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
    const researchId = `${agentId}_research`;
    
    workflow.addNode(promptId, (state) => promptNode(agentId, state));
    
    if (TOOL_ELIGIBLE_AGENTS.includes(agentId)) {
        workflow.addNode(researchId, (state, cfg) => researchNode(agentId, state, cfg));
        workflow.addEdge(promptId, researchId);
        workflow.addEdge(researchId, agentId);
    } else {
        workflow.addEdge(promptId, agentId);
    }
    
    workflow.addNode(agentId, (state, cfg) => agentNode(agentId, state, cfg));
}

// Add sync nodes for parallel groups
for (const group of syncGroups) {
    workflow.addNode(`sync_${group.name}`, (state) => ({}));
}

function appendPromptSuffix(targets) {
    if (!Array.isArray(targets)) return targets;
    return targets.map(t => {
        if (t === END) return END;
        if (typeof t === "string" && t.endsWith(":skip_prompt")) return t.replace(":skip_prompt", "");
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
        if (targets.length === 1 && targets[0].startsWith("sync_")) {
            return targets; // Route directly to sync node, no prompt suffix
        }
        return appendPromptSuffix(targets);
    });
}

// Add conditional edges from sync nodes to evaluate combined state
for (const group of syncGroups) {
    workflow.addConditionalEdges(`sync_${group.name}`, (state) => {
        const msgs = state.messages.filter(m => !getMsgName(m).endsWith("__prompt") && !getMsgName(m).endsWith("__research"));
        let parentIndex = -1;
        for (let i = msgs.length - 1; i >= 0; i--) {
            if (getMsgName(msgs[i]) === group.parent) {
                parentIndex = i;
                break;
            }
        }

        if (parentIndex === -1) return [END];

        const memberMsgs = {};
        group.members.forEach(m => memberMsgs[m] = null);

        for (let i = parentIndex + 1; i < msgs.length; i++) {
            const name = getMsgName(msgs[i]);
            if (group.members.includes(name)) {
                memberMsgs[name] = msgs[i];
            }
        }

        const allFinished = Object.values(memberMsgs).every(msg => msg !== null);
        if (!allFinished) {
            console.log(`[SYNC]: Waiting for all members of ${group.name} to finish.`);
            return [];
        }

        console.log(`[SYNC]: All members of ${group.name} finished. Evaluating combined routing.`);

        const allTargets = new Set();
        let requiresParentClarification = false;

        for (const member of group.members) {
            const msg = memberMsgs[member];
            const status = extractStatus(getMsgContent(msg));
            const memberRoutingDef = getRouting(member);
            const targetToken = memberRoutingDef?.routes[status] || "$self";
            const resolved = resolveTarget(targetToken, member, state);
            
            for (const t of resolved) {
                if (t === member) continue;
                allTargets.add(t);
                if (t === group.parent) {
                    requiresParentClarification = true;
                }
            }
        }

        if (requiresParentClarification) {
            console.log(`[SYNC]: ${group.name} needs parent review. Routing to ${group.parent}.`);
            return appendPromptSuffix([group.parent]);
        }

        const finalTargets = Array.from(allTargets);
        console.log(`[SYNC]: ${group.name} proceeding to ${finalTargets.join(", ")}.`);
        return appendPromptSuffix(finalTargets);
    });
}

const app = workflow.compile({ checkpointer });
export { app, routerLLM, initConfig };
