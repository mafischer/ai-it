import "dotenv/config";
import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from "@langchain/core/messages";
import { StateGraph, MessagesAnnotation, Annotation, START, END } from "@langchain/langgraph";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { createLLM, createAgentLLM } from "./src/utils/llm.js";
import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { z } from "zod";
import { getConfig, getActiveAgents, getRouting, getPipeline, getRouterConfig, initConfig } from "./src/config/loader.js";
import { renderPrompt } from "./src/config/templates.js";
import { resolveTarget } from "./src/config/routing.js";
import { searchDDG, fetchPageWithMeta } from "./tools/web-search/tools.js";
import { initRagDB, storeArticle, queryChunks } from "./src/utils/rag.js";
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
initRagDB().catch(err => console.error("[RAG] Init failed:", err.message));

const GraphState = Annotation.Root({
  ...MessagesAnnotation.spec
});

// Create shared LLMs (for router and fallback use)
const llms = {};
for (const key of Object.keys(config.models)) {
    llms[key] = createLLM(key);
}

// Create per-agent LLM instances so parallel agents get independent round-robin
// counters and hit different endpoints concurrently (e.g., SA on host A, UX on host B)
const agentLLMs = {};
const activeAgentNames = getActiveAgents();
activeAgentNames.forEach((name, idx) => {
    const modelKey = config.agents[name]?.model || "specialist";
    agentLLMs[name] = createAgentLLM(modelKey, idx);
    console.log(`[LLM]: Agent "${name}" → dedicated instance (offset ${idx % 2})`);
});

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

const imageGenerationTools = [
    {
        type: "function",
        function: {
            name: "generate_image_mockup",
            description: "Generate a UI mockup image using ComfyUI (Flux.dev). Accepts a Flux prompt string with optional aspect ratio. Returns a URL to the generated image. The prompt should describe the visual UI mockup in detail.",
            parameters: {
                type: "object",
                properties: {
                    prompt: { type: "string", description: "Detailed Flux prompt text describing the UI mockup. Do not include --ar in the text." },
                    aspect_ratio: { type: "string", default: "9:16", description: "Aspect ratio as 'W:H'. Portrait: '9:16', '3:4'. Landscape: '16:9', '4:3'. Square: '1:1'." },
                    screen_name: { type: "string", default: "UI Mockup", description: "Screen name for identification (e.g., 'Main Menu', 'Login Screen')." }
                },
                required: ["prompt"]
            }
        }
    }
];

async function executeToolCall(call, ctx, nodeConfig) {
    const emit = (data) => { if (ctx) researchEvents.emit("tool", { ...data, threadId: ctx.threadId, agent: ctx.agent }); };

    // Langfuse tracing — create span within the existing trace using the Langfuse client directly
    const callbacks = nodeConfig?.callbacks;
    const handlers = Array.isArray(callbacks) ? callbacks : callbacks?.handlers || [];
    const lfHandler = handlers.find(c => c instanceof CallbackHandler);
    let span = null;

    if (lfHandler?.traceId) {
        const lf = lfHandler.langfuse || langfuse;
        span = lf.span({
            traceId: lfHandler.traceId,
            parentObservationId: ctx?.parentRunId,
            name: `tool_${call.name}`,
            input: call.args,
            metadata: { agent: ctx?.agent }
        });
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
        if (call.name === "generate_image_mockup") {
            console.error(`[TOOL] generate_image_mockup called for "${call.args.screen_name || 'UI'}"`);
            emit({ type: "image_gen", status: "starting", screen: call.args.screen_name, prompt: call.args.prompt.slice(0, 100) });

            // Heartbeat every 30s to keep the stale guard from killing long image generations
            const heartbeat = setInterval(() => {
                emit({ type: "image_gen", status: "generating", screen: call.args.screen_name });
            }, 30000);

            try {
                const { generateMockup } = await import("./tools/comfyui/tools.js");
                const result = await generateMockup(
                    call.args.prompt,
                    call.args.aspect_ratio || "9:16",
                    call.args.screen_name || "UI Mockup"
                );

                emit({ type: "image_gen", status: "complete", screen: result.screenName, url: result.url });
                if (span) span.end({ output: { url: result.url, dimensions: `${result.width}x${result.height}` } });

                return `✅ Image generated:\n**Screen**: ${result.screenName}\n**Dimensions**: ${result.width}x${result.height}\n**URL**: ${result.url}\n\nMarkdown: ![${result.screenName}](${result.url})`;
            } finally {
                clearInterval(heartbeat);
            }
        }
    } catch (err) {
        const toolType = call.name === "web_search" ? "search" : call.name === "fetch_page" ? "fetch" : "image_gen";
        emit({ type: toolType, status: "error", error: err.message });
        if (span) span.end({ level: "ERROR", statusMessage: err.message });
        return `Error: ${err.message}`;
    }
    if (span) span.end({ output: "Unknown tool" });
    return "Unknown tool";
}

const MAX_RESEARCH_ROUNDS = 3;

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
                description: "Submit relevant article URLs to be deeply researched. Submit one URL per topic or ambiguity — do not artificially limit the number.",
                parameters: {
                    type: "object",
                    properties: {
                        urls: { type: "array", items: { type: "string", description: "URL of the article" }, description: "Array of URLs — one per topic or ambiguity" }
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

    const currentYear = new Date().getFullYear();
    phase1History.push({ role: "system", content: `You are in Phase 1 of research. Today's date is ${new Date().toDateString()}. Use the web_search tool to find industry best practices relative to the directive and any team feedback. When including years in search queries, use ${currentYear} (the current year) — never use older years. Once you find good candidates, you MUST use the submit_links tool to submit URLs for deep research. Submit one URL per topic or ambiguity — do not artificially limit the number. Do not attempt to read the articles yourself.` });

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

    console.error(`[RESEARCH P2] Fetching ${urlsToFetch.length} URLs and storing in RAG...`);

    // Phase 2: Parallel Fetch → Store in pgvector → RAG Query → Single LLM Extraction
    // Use root thread ID so all agents in the chain share the same RAG session
    const sessionId = ctx?.rootThreadId || ctx?.threadId || "unknown";

    // 2a. Fetch all URLs in parallel and store in vector DB
    const fetchPromises = urlsToFetch.map(async (url, index) => {
        const subAgentName = `${phase1AgentName.replace("_research", "")}_research_phase_2_${index + 1}`;
        try {
            console.error(`[RESEARCH P2] Fetching ${url}`);
            const fetchCtx = { ...ctx, agent: subAgentName };
            const fetchResult = await executeToolCall({ name: "fetch_page", args: { url } }, fetchCtx, nodeConfig);

            if (!fetchResult || fetchResult.startsWith("Error:") || fetchResult.length < 200) {
                console.error(`[RESEARCH P2] Skipping ${url}: insufficient content (${fetchResult?.length || 0} chars)`);
                return { url, stored: 0 };
            }

            // Store in vector DB
            let domain = "";
            try { domain = new URL(url).hostname; } catch {}
            const chunks = await storeArticle(sessionId, url, domain, fetchResult);
            if (ctx && researchEvents) {
                researchEvents.emit("tool", { type: "fetch", status: "stored", url, domain, threadId: ctx.threadId, agent: ctx.agent, chunks });
            }
            return { url, stored: chunks };
        } catch (err) {
            console.error(`[RESEARCH P2] Error fetching ${url}: ${err.message}`);
            return { url, stored: 0 };
        }
    });

    const fetchResults = await Promise.all(fetchPromises);
    const storedCount = fetchResults.reduce((sum, r) => sum + r.stored, 0);
    console.error(`[RESEARCH P2] Stored ${storedCount} total chunks across ${fetchResults.filter(r => r.stored > 0).length} articles`);

    if (storedCount === 0) return "";

    // 2b. RAG query: retrieve relevant chunks using the directive as the query
    const directive = messages.find(m => m.role === "user")?.content || "";
    const ragChunks = await queryChunks(sessionId, directive, 12);

    // Log RAG retrieval to Langfuse
    const callbacks = nodeConfig?.callbacks;
    const handlers = Array.isArray(callbacks) ? callbacks : callbacks?.handlers || [];
    const lfHandler = handlers.find(c => c instanceof CallbackHandler);
    if (lfHandler?.traceId) {
        const lf = lfHandler.langfuse || langfuse;
        const p2scores = ragChunks.map(c => c.score);
        const p2uniqueSources = new Set(ragChunks.map(c => c.url)).size;
        lf.span({
            traceId: lfHandler.traceId,
            name: "rag_query_phase2",
            input: { query: directive.slice(0, 500), sessionId, topK: 12 },
            metadata: { agent: phase1AgentName, storedChunks: storedCount },
        }).end({
            output: ragChunks.map(c => ({ url: c.url, title: c.title, score: c.score, content: c.content.slice(0, 200) + "..." })),
            metadata: { resultCount: ragChunks.length, avgScore: +(p2scores.reduce((a, b) => a + b, 0) / p2scores.length).toFixed(4), minScore: +Math.min(...p2scores).toFixed(4), uniqueSources: p2uniqueSources }
        });
    }

    if (ragChunks.length === 0) return "";

    // 2c. Single LLM extraction with retrieved chunks (instead of 5 per-URL calls)
    const extractionAgentName = `${phase1AgentName.replace("_research", "")}_research_extraction`;
    const ragContext = ragChunks.map((c, i) =>
        `[${i + 1}] [Source: ${c.url}] (relevance: ${(c.score * 100).toFixed(0)}%)\n${c.content}`
    ).join("\n\n");

    const extractionPrompt = `You are an expert researcher. Below are excerpts from web articles retrieved via semantic search, ranked by relevance to the user's directive. Synthesize ONLY the industry best practices relevant to the directive. Cite sources using [Source: url] format. Be concise and directly applicable.`;

    if (ctx && researchEvents) {
        researchEvents.emit("prompt", { threadId: ctx.threadId, agent: extractionAgentName, prompt: extractionPrompt });
    }

    const extractionHistory = [
        ...messages.filter(m => m.role === "user"),
        { role: "system", content: extractionPrompt },
        { role: "user", content: `[RETRIEVED RESEARCH CONTEXT]:\n${ragContext}\n\nSynthesize the relevant best practices from the research above.` }
    ];

    const stream = await llm.stream(extractionHistory, { ...nodeConfig, tags: ["hide_stream"] });
    let extracted = "";
    for await (const chunk of stream) {
        const text = typeof chunk.content === 'string' ? chunk.content : String(chunk.content || "");
        extracted += text;
        if (ctx && researchEvents) {
            researchEvents.emit("chunk", { threadId: ctx.threadId, agent: extractionAgentName, content: text });
        }
    }
    if (ctx && researchEvents) {
        researchEvents.emit("stop", { threadId: ctx.threadId, agent: extractionAgentName });
    }

    let cleaned = extracted.replace(/<think>[\s\S]*?(?:<\/think>|$)/g, "").replace(/<\/?think>/g, "").trim();
    return cleaned
        ? "\n\n[RESEARCH FINDINGS FROM WEB]:\n(Note: The following research represents aggregated industry trends and ideas synthesized from web sources. Use your professional judgment when considering this information.)\n\n" + cleaned
        : "";
}

function extractStatus(content) {
    if (!content) return null;
    const cleaned = cleanSpecialistOutput(content);
    // Negative lookbehind: don't match prefixed patterns like SA_STATUS or UX_STATUS
    const matches = [...cleaned.matchAll(/(?<![A-Z_])STATUS:\s*([A-Z_]+)/g)];
    return matches.length ? matches[matches.length - 1][1] : null;
}

// Extract per-agent statuses from approval prompts (e.g., "SA_STATUS: DESIGN_APPROVED", "UX_STATUS: DESIGN_AMBIGUOUS")
function extractAgentStatuses(content) {
    if (!content) return {};
    const cleaned = cleanSpecialistOutput(content);
    const result = {};
    const matches = [...cleaned.matchAll(/([A-Z_]+)_STATUS:\s*([A-Z_]+)/g)];
    for (const match of matches) {
        result[match[1].toLowerCase()] = match[2];
    }
    return result;
}

// Milestones that trigger spawning a new thread — context resets at these boundaries
const THREAD_SPAWN_MILESTONES = [
    "REQUIREMENTS_DRAFTED",    // BA done → fan out to SA + UX
    "REQUIREMENTS_APPROVED",   // BA approved → fan out to BE + FE
    "DESIGNS_APPROVED",        // BA approved both designs (per-agent) → fan out to BE + FE
    "DESIGN_APPROVED",         // SA/UX approved → fan out to BE + FE
    "IMPLEMENTATION_APPROVED"  // BE/FE approved → go to QE
];

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
    // NOTE: _CLEAR statuses are query-phase completions (confirmations), NOT work products.
    // They must NOT be milestones — otherwise the agent's brief "looks good" review becomes
    // the effectiveDirective, losing the actual requirements/design document.
    const MILESTONE_STATUSES = [
        "REQUIREMENTS_DRAFTED", "TESTING_COMPLETE",
        "REQUIREMENTS_APPROVED", "DESIGNS_APPROVED", "DESIGN_APPROVED", "IMPLEMENTATION_APPROVED", "TESTS_PASSED"
    ];
    const allMsgsRaw = state.messages.filter(m => !getMsgName(m).endsWith("__prompt"));
    
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
    const effectiveDirective = milestoneIndex !== -1 ? cleanSpecialistOutput(getMsgContent(allMsgsRaw[milestoneIndex])) : getMsgContent(state.messages[0]);

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

        // Interaction / clarification history — per-agent override or pipeline default
        hasClarifications: rounds.length > 0,
        clarificationHistory,
        clarificationRound: rounds.length,
        nextRoundNumber: rounds.length + 1,
        maxClarificationRounds: agent?.maxClarificationRounds || getPipeline().maxClarificationRounds || 5,
        clarificationsRemaining: Math.max(0, (agent?.maxClarificationRounds || getPipeline().maxClarificationRounds || 5) - rounds.length),
        clarificationsExhausted: rounds.length >= (agent?.maxClarificationRounds || getPipeline().maxClarificationRounds || 5),

        // Per-agent outputs
        last,

        // Status metadata
        lastStatus: extractStatus(getMsgContent(lastMsg)) || "",
        selfStatus: lastSelfStatus || "",
        speaker: getMsgName(lastMsg) || getMsgRole(lastMsg),

    };

    const lastMsgStatus = extractStatus(lastMsg.content);

    const useToolsForMain = TOOL_ELIGIBLE_AGENTS.includes(nodeName);

    const maxRounds = agent?.maxClarificationRounds || getPipeline().maxClarificationRounds || 5;
    const roundMeta = { clarificationRound: rounds.length, maxClarificationRounds: maxRounds };

    // 2. If downstream agent sent work back for review (approval triggers from config)
    const routing = getRouting(nodeName);
    if (routing?.approval_triggers?.includes(lastMsgStatus) && hasPrompt("approval")) {
        return { prompt: renderPrompt(nodeName, "approval", values), useTools: false, ...roundMeta };
    }

    // 3. If answering a QUESTION from downstream
    if (lastMsgStatus === "QUESTION") {
        return { prompt: renderPrompt(nodeName, "main", values), useTools: useToolsForMain, ...roundMeta };
    }

    // 4. Run query to clarify ambiguities unless already clarified or exhausted
    if (hasPrompt("query")) {
        // We consider the query phase "done" if we've already reached a terminal state once.
        const isPastQueryPhase = lastSelfStatus && (
            lastSelfStatus.endsWith("_CLEAR") ||
            lastSelfStatus.endsWith("_APPROVED") ||
            lastSelfStatus.endsWith("_DRAFTED") ||
            lastSelfStatus.endsWith("_COMPLETE") ||
            lastSelfStatus.endsWith("_PASSED")
        );

        // If the user just replied, stay in query mode to potentially ask follow-ups,
        // unless we've already moved past the query phase. The query prompt handles exhaustion warnings.
        if (!isPastQueryPhase && !values.clarificationsExhausted) {
            return { prompt: renderPrompt(nodeName, "query", values), useTools: false, ...roundMeta };
        }
    }

    return { prompt: renderPrompt(nodeName, "main", values), useTools: useToolsForMain, ...roundMeta };
}

// Prompt node: generates the system prompt and commits it to state immediately
function promptNode(nodeName, state) {
    const { prompt, useTools, clarificationRound, maxClarificationRounds } = getPromptForNode(state, nodeName);
    return { messages: [new SystemMessage({ content: prompt, name: `${nodeName}__prompt`, additional_kwargs: { timestamp: Date.now(), useTools, clarificationRound, maxClarificationRounds } })] };
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
    const llm = agentLLMs[nodeName] || llms[agentDef?.model || "specialist"];

    // Detect if this is a subsequent round triggered by downstream ambiguities
    const lastMsgContent = cleanSpecialistOutput(getMsgContent(lastMsg));
    const lastMsgStatus = extractStatus(getMsgContent(lastMsg));
    const questionStatuses = getPipeline().question_statuses || [];
    const isAmbiguityRound = questionStatuses.includes(lastMsgStatus) || lastMsgStatus === "QUESTION";

    let researchFocus = "";
    if (isAmbiguityRound) {
        researchFocus = `\n\nIMPORTANT: This is a subsequent research round triggered by feedback from ${getMsgName(lastMsg) || "a downstream agent"}. Focus your research ONLY on the specific ambiguities and unresolved items raised in their feedback below. Do NOT re-research topics already covered.`;
    }

    const researchPrompt = `You are the ${nodeName}. Your task is ONLY to research industry best practices, standards, and existing solutions relevant to the user's directive and any team feedback.
Today's date is ${new Date().toDateString()} (year ${new Date().getFullYear()}). When including years in search queries, always use ${new Date().getFullYear()} — never use older years like 2024 or 2025.
Use the available tools to search the web and fetch pages.
DO NOT draft the final response or requirements yet. Gather as much useful information as possible using the tools.
When you are done researching, or if no research is needed, simply stop calling tools.${researchFocus}`;

    // When receiving feedback from a parallel sync group, include ALL member messages
    const parentGroup = syncGroups.find(g => g.parent === nodeName);
    let researchUserContent;
    if (parentGroup) {
        const memberFeedback = [];
        for (const member of parentGroup.members) {
            const memberMsgs = validMsgs.filter(m => getMsgName(m) === member);
            if (memberMsgs.length) {
                const latest = memberMsgs[memberMsgs.length - 1];
                memberFeedback.push(`[FEEDBACK FROM ${member}]:\n${cleanSpecialistOutput(getMsgContent(latest))}`);
            }
        }
        if (memberFeedback.length > 1) {
            researchUserContent = `[ORIGINAL DIRECTIVE]:\n${directiveMsg}\n\n${memberFeedback.join("\n\n")}`;
        }
    }
    if (!researchUserContent) {
        researchUserContent = `[ORIGINAL DIRECTIVE]:\n${directiveMsg}\n\n[LATEST UPDATE FROM ${getMsgName(lastMsg) || lastMsg.role || "USER"}]:\n${lastMsgContent}`;
    }

    let messagesToPass = [
        { role: "system", content: researchPrompt },
        { role: "user", content: researchUserContent }
    ];

    console.error(`[AGENT] ${nodeName}: running web research phase`);
    const threadId = nodeConfig?.configurable?.thread_id || "";
    const rootThreadId = nodeConfig?.configurable?.root_thread_id || threadId;
    const research = await runResearch(llm, messagesToPass, { threadId, rootThreadId, agent: `${nodeName}_research` }, nodeConfig);

    if (research) {
        console.error(`[AGENT] ${nodeName}: research complete (${research.length} chars)`);
        // Count existing research messages for this agent to determine the round/suffix
        const existingResearchCount = state.messages.filter(m => getMsgName(m).startsWith(`${nodeName}__research`)).length;
        const researchName = existingResearchCount > 0 ? `${nodeName}__research_round_${existingResearchCount}` : `${nodeName}__research`;
        return { messages: [new AIMessage({ content: research, name: researchName, additional_kwargs: { timestamp: Date.now() } })] };
    }
    return {};
}

const MAX_CONTINUATIONS = 5;

async function agentNode(nodeName, state, nodeConfig) {
    const promptMsgs = state.messages.filter(m => getMsgName(m) === `${nodeName}__prompt`);
    const lastPromptMsg = promptMsgs.length ? promptMsgs[promptMsgs.length - 1] : null;
    const systemPromptStr = lastPromptMsg ? getMsgContent(lastPromptMsg) : `You are ${nodeName}.`;
    const useTools = lastPromptMsg?.additional_kwargs?.useTools || false;
    const clarificationRound = lastPromptMsg?.additional_kwargs?.clarificationRound ?? 0;
    const maxClarificationRounds = lastPromptMsg?.additional_kwargs?.maxClarificationRounds ?? 5;

    // Identify the latest milestone for context isolation (same logic as getPromptForNode)
    const MILESTONE_STATUSES = [
        "REQUIREMENTS_DRAFTED", "TESTING_COMPLETE",
        "REQUIREMENTS_APPROVED", "DESIGNS_APPROVED", "DESIGN_APPROVED", "IMPLEMENTATION_APPROVED", "TESTS_PASSED"
    ];
    const allMsgsRaw = state.messages.filter(m => !getMsgName(m).endsWith("__prompt"));
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
    const llm = agentLLMs[nodeName] || llms[agentDef?.model || "specialist"];

    let accumulated = "";

    // Filter out __prompt for context building (research messages are kept for downstream visibility)
    const validStateMsgs = state.messages.filter(m => !getMsgName(m).endsWith("__prompt") && getMsgName(m) !== nodeName);
    const validLastMsg = validStateMsgs.length ? validStateMsgs[validStateMsgs.length - 1] : state.messages[0];

    // Find if there was research generated for THIS turn
    const researchMsgs = state.messages.filter(m => getMsgName(m) === `${nodeName}__research`);
    const latestResearchMsg = researchMsgs.length ? researchMsgs[researchMsgs.length - 1] : null;
    let researchText = "";
    if (latestResearchMsg && lastPromptMsg && state.messages.indexOf(latestResearchMsg) > state.messages.lastIndexOf(lastPromptMsg)) {
        researchText = getMsgContent(latestResearchMsg);
    }

    // Context building — the system prompt template already includes directive, input,
    // feedback ({{last.*}}), self, and clarification history via Mustache variables.
    // User content only carries research/RAG context to avoid duplication.
    let directiveToPass = cleanSpecialistOutput(directiveMsg);

    let userContent = "Proceed with the task described in your system prompt.";
    if (researchText) {
        userContent = researchText;
    }

    // RAG: inject relevant research context from the vector DB for all agents
    // Use root_thread_id so spawned threads can access research from the parent chain
    const threadId = nodeConfig?.configurable?.thread_id || "";
    const rootThreadId = nodeConfig?.configurable?.root_thread_id || threadId;
    try {
        const ragQuery = directiveToPass.slice(0, 500) + " " + cleanSpecialistOutput(getMsgContent(validLastMsg)).slice(0, 500);
        const ragChunks = await queryChunks(rootThreadId, ragQuery, 6);
        if (ragChunks.length > 0) {
            const ragContext = ragChunks.map(c => `[Source: ${c.url}]\n${c.content}`).join("\n\n");
            userContent += `\n\n[RESEARCH CONTEXT FROM WEB]:\n${ragContext}`;

            // Log RAG retrieval to Langfuse
            const agentCallbacks = nodeConfig?.callbacks;
            const agentHandlers = Array.isArray(agentCallbacks) ? agentCallbacks : agentCallbacks?.handlers || [];
            const agentLfHandler = agentHandlers.find(c => c instanceof CallbackHandler);
            if (agentLfHandler?.traceId) {
                const lf = agentLfHandler.langfuse || langfuse;
                const scores = ragChunks.map(c => c.score);
                const uniqueSources = new Set(ragChunks.map(c => c.url)).size;
                lf.span({
                    traceId: agentLfHandler.traceId,
                    name: `rag_query_${nodeName}`,
                    input: { query: ragQuery.slice(0, 500), threadId, topK: 6 },
                    metadata: { agent: nodeName },
                }).end({
                    output: ragChunks.map(c => ({ url: c.url, title: c.title, score: c.score, content: c.content.slice(0, 200) + "..." })),
                    metadata: { resultCount: ragChunks.length, avgScore: +(scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(4), minScore: +Math.min(...scores).toFixed(4), uniqueSources }
                });
            }
        }
    } catch (err) {
        console.error(`[RAG] Query failed for ${nodeName}: ${err.message}`);
    }

    // Log clarification round to Langfuse
    try {
        const roundCallbacks = nodeConfig?.callbacks;
        const roundHandlers = Array.isArray(roundCallbacks) ? roundCallbacks : roundCallbacks?.handlers || [];
        const roundLfHandler = roundHandlers.find(c => c instanceof CallbackHandler);
        if (roundLfHandler?.traceId) {
            const lf = roundLfHandler.langfuse || langfuse;
            lf.span({
                traceId: roundLfHandler.traceId,
                name: `agent_turn_${nodeName}`,
                metadata: { agent: nodeName, clarificationRound, maxClarificationRounds, useTools },
            }).end();
        }
    } catch {}

    let messagesToPass = [
        { role: "system", content: systemPromptStr },
        { role: "user", content: userContent }
    ];

    const totalChars = systemPromptStr.length + userContent.length;
    process.stderr.write(`[CONTEXT] ${nodeName}: system=${systemPromptStr.length.toLocaleString()} + user=${userContent.length.toLocaleString()} = ${totalChars.toLocaleString()} chars total\n`);

    // Bind image generation tools for UX designer during main generation
    let llmWithTools = llm;
    if (nodeName === "ux_designer" && useTools) {
        llmWithTools = llm.bindTools(imageGenerationTools);
        console.error(`[AGENT] ${nodeName} bound ${imageGenerationTools.length} image generation tools`);
    }

    for (let attempt = 0; attempt <= MAX_CONTINUATIONS; attempt++) {
        let chunkContent = "";
        let toolCallsDetected = [];

        const stream = await llmWithTools.stream(messagesToPass, nodeConfig);
        for await (const chunk of stream) {
            const text = typeof chunk.content === 'string' ? chunk.content : String(chunk.content || "");
            chunkContent += text;

            // LangChain accumulates tool_calls across chunks; collect from every chunk
            if (chunk.tool_calls && chunk.tool_calls.length > 0) {
                for (const tc of chunk.tool_calls) {
                    // Only add if not already tracked (by id)
                    if (!toolCallsDetected.find(t => t.id === tc.id)) {
                        toolCallsDetected.push(tc);
                    }
                }
            }
        }

        accumulated += chunkContent;

        // If tool calls were made, execute them and continue
        if (toolCallsDetected.length > 0) {
            console.error(`[AGENT] ${nodeName}: ${toolCallsDetected.length} tool call(s) detected`);
            messagesToPass.push(new AIMessage({ content: chunkContent, additional_kwargs: { tool_calls: toolCallsDetected.map(tc => ({ id: tc.id, type: "function", function: { name: tc.name, arguments: JSON.stringify(tc.args) } })) } }));

            for (const toolCall of toolCallsDetected) {
                console.error(`[AGENT] Executing tool: ${toolCall.name}`);
                const toolResult = await executeToolCall(toolCall, { threadId, rootThreadId, agent: nodeName }, nodeConfig);
                messagesToPass.push(new ToolMessage({ content: toolResult, tool_call_id: toolCall.id, name: toolCall.name }));
            }

            // Continue the conversation with tool results (don't increment attempt counter)
            continue;
        }

        // Check if the response has a STATUS token (after stripping <think> blocks)
        const status = extractStatus(accumulated);
        // Also check for per-agent approvals (e.g., BA approval with SA_STATUS + UX_STATUS)
        const agentStatuses = !status ? extractAgentStatuses(accumulated) : {};
        const allPerAgentApproved = Object.keys(agentStatuses).length > 0 &&
            Object.values(agentStatuses).every(s => s.includes("APPROVED"));
        const effectiveStatus = status || (allPerAgentApproved ? "DESIGNS_APPROVED" : null);

        if (effectiveStatus) {
            // Complete response — commit the merged result
            const kwargs = { timestamp: Date.now() };
            // For spawn milestones, record the intended routing target so the server knows where the new thread should go
            if (THREAD_SPAWN_MILESTONES.includes(effectiveStatus)) {
                const routingDef = getRouting(nodeName);
                const target = routingDef?.routes[effectiveStatus];
                if (target) kwargs.spawnTarget = resolveTarget(target, nodeName, state);
                // For per-agent approvals, carry forward the individual design outputs as spawn context
                if (allPerAgentApproved) {
                    const agentKeyToId = { sa: "software_architect", ux: "ux_designer" };
                    const spawnContext = [];
                    for (const key of Object.keys(agentStatuses)) {
                        const agentId = agentKeyToId[key];
                        if (!agentId) continue;
                        const agentMsgs = state.messages.filter(m => getMsgName(m) === agentId && !getMsgName(m).endsWith("__prompt") && !getMsgName(m).endsWith("__research"));
                        if (agentMsgs.length) {
                            spawnContext.push({ name: agentId, content: cleanSpecialistOutput(getMsgContent(agentMsgs[agentMsgs.length - 1])) });
                        }
                    }
                    if (spawnContext.length) kwargs.spawnContext = spawnContext;
                }
            }
            return { messages: [new AIMessage({ content: accumulated, name: nodeName, additional_kwargs: kwargs })] };
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
        const content = getMsgContent(lastMsg);
        const status = extractStatus(content);

        // Handle per-agent statuses from approval prompts (e.g., SA_STATUS / UX_STATUS)
        const agentStatuses = extractAgentStatuses(content);
        if (Object.keys(agentStatuses).length > 0) {
            const agentKeyToId = { sa: "software_architect", ux: "ux_designer" };
            const ambiguousTargets = [];
            const approvedDownstream = [];

            for (const [key, agentStatus] of Object.entries(agentStatuses)) {
                const targetAgentId = agentKeyToId[key];
                if (!targetAgentId) continue;
                if (agentStatus.includes("AMBIGUOUS")) {
                    ambiguousTargets.push(targetAgentId);
                } else if (agentStatus.includes("APPROVED")) {
                    approvedDownstream.push(targetAgentId);
                }
            }

            if (ambiguousTargets.length > 0) {
                console.log(`[ROUTER]: ${agentId} per-agent review — ambiguous: [${ambiguousTargets.join(", ")}], approved: [${approvedDownstream.join(", ")}]`);
                return ambiguousTargets;
            }

            // All approved — use the DESIGNS_APPROVED route
            const approvedTarget = routingDef.routes["DESIGNS_APPROVED"];
            if (approvedTarget) {
                if (THREAD_SPAWN_MILESTONES.includes("DESIGNS_APPROVED")) {
                    console.log(`[ROUTER]: Spawn milestone DESIGNS_APPROVED from ${agentId} (per-agent all approved) → END (server will spawn new thread)`);
                    return [END];
                }
                console.log(`[ROUTER]: ${agentId} per-agent review — all designs approved → routing to implementation.`);
                return resolveTarget(approvedTarget, agentId, state);
            }
        }

        if (!status) {
            console.log(`[ROUTER]: Missing status token for ${agentId}. Assuming truncation and auto-continuing.`);
            return resolveTarget("$self", agentId, state);
        }

        const target = routingDef.routes[status];
        if (target === undefined) return fallbackRouter(state, agentId);

        const resolved = resolveTarget(target, agentId, state);

        // Spawn milestone: route to END so the server can spawn a new thread
        if (THREAD_SPAWN_MILESTONES.includes(status)) {
            console.log(`[ROUTER]: Spawn milestone ${status} from ${agentId} → END (server will spawn new thread targeting ${JSON.stringify(resolved)})`);
            return [END];
        }

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
        // Check if this message has a spawn milestone status — if so, route FORWARD
        // (this happens when a new thread is seeded with the milestone output)
        const msgContent = getMsgContent(lastMsg);
        const status = extractStatus(msgContent);

        // Also check for per-agent approvals (spawned from BA approval with SA_STATUS/UX_STATUS)
        let effectiveStatus = status;
        if (!status) {
            const agentStatuses = extractAgentStatuses(msgContent);
            const allApproved = Object.keys(agentStatuses).length > 0 &&
                Object.values(agentStatuses).every(s => s.includes("APPROVED"));
            if (allApproved) effectiveStatus = "DESIGNS_APPROVED";
        }

        if (effectiveStatus) {
            const routingDef = getRouting(name);
            if (routingDef?.routes[effectiveStatus]) {
                const resolved = resolveTarget(routingDef.routes[effectiveStatus], name, state);
                console.log(`[ROUTER]: Spawned thread routing forward from ${name} (${effectiveStatus}) → ${JSON.stringify(resolved)}`);
                // Check sync groups
                const group = syncGroups.find(p => p.members.includes(name));
                if (group && resolved.some(t => t !== name)) return [`sync_${group.name}`];
                return resolved;
            }
        }
        // No routable status — rewind case: re-run that agent
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

        // Determine which members were actually triggered this round
        // by checking for __prompt messages after the parent's last output
        const triggeredMembers = new Set();
        for (let i = 0; i < state.messages.length; i++) {
            const name = getMsgName(state.messages[i]);
            // Find prompt messages after the parent's output position
            if (name && group.members.some(m => name === `${m}__prompt`)) {
                // Check if this prompt is after the parent's last output by comparing timestamps
                const parentTs = msgs[parentIndex].additional_kwargs?.timestamp || 0;
                const promptTs = state.messages[i].additional_kwargs?.timestamp || 0;
                if (promptTs > parentTs) {
                    triggeredMembers.add(name.replace("__prompt", ""));
                }
            }
        }

        // If we can't determine triggered members, assume all (first round)
        const expectedMembers = triggeredMembers.size > 0 ? [...triggeredMembers] : group.members;

        const memberMsgs = {};
        expectedMembers.forEach(m => memberMsgs[m] = null);

        for (let i = parentIndex + 1; i < msgs.length; i++) {
            const name = getMsgName(msgs[i]);
            if (expectedMembers.includes(name)) {
                memberMsgs[name] = msgs[i];
            }
        }

        const allFinished = Object.values(memberMsgs).every(msg => msg !== null);
        if (!allFinished) {
            console.log(`[SYNC]: Waiting for ${expectedMembers.filter(m => !memberMsgs[m]).join(", ")} of ${group.name} to finish.`);
            return [];
        }

        console.log(`[SYNC]: All expected members of ${group.name} finished (${expectedMembers.join(", ")}). Evaluating combined routing.`);

        const allTargets = new Set();
        let requiresParentClarification = false;

        for (const member of expectedMembers) {
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
export { app, routerLLM, initConfig, THREAD_SPAWN_MILESTONES, extractStatus, extractAgentStatuses };
