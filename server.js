import "dotenv/config";
import Fastify from "fastify";
import fastifyCors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import { v4 as uuidv4 } from "uuid";
import crypto from "crypto";
import Database from "better-sqlite3";
import { existsSync } from "fs";
import { execSync } from "child_process";
import { fileURLToPath } from "url";
import path from "path";
import { HumanMessage, AIMessage, SystemMessage } from "@langchain/core/messages";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallbackHandler } from "langfuse-langchain";
import { Langfuse } from "langfuse";

// Import app last to ensure process.env is set before index.js initializes Langfuse
import { app, routerLLM as utilityLLM, initConfig, researchEvents, THREAD_SPAWN_MILESTONES, extractStatus as extractStatusFromContent } from "./index.js";
import { getAgentEmojis, getAgentMissions, getActiveAgents, getConfig, getPipeline } from "./src/config/loader.js";
import { registerTools } from "./tools/web-search/tools.js";

console.log(`[LANGFUSE] Initialized with host: ${process.env.LANGFUSE_HOST || process.env.LANGFUSE_BASE_URL}`);

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const server = Fastify({ logger: false });
await server.register(fastifyCors);
await server.register(fastifyStatic, { root: path.join(__dirname, "app"), prefix: "/" });

const activeThreads = new Set();
const threadAbortControllers = {};
const activeThreadAgents = {};
const threadPauseRequested = {};

// Background workflow jobs — decoupled from HTTP connections
// Each job accumulates SSE events that clients can tap into
const workflowJobs = {}; // { threadId: { events: [], done: false, error: null } }

const agentEmoji = { ...getAgentEmojis(), complete: "✅" };
const agentMissions = { ...getAgentMissions(), complete: "All tasks have been successfully completed." };


// Orchestration headers removed — prompts are delivered via system_prompt SSE chunks
// and rendered by the internal chat UI.

function cleanIncomingHistory(messages) {
    return messages.map(msg => ({
        ...msg,
        content: (msg.content || "").replace(/<think>[\s\S]*?<\/think>/g, "").replace(/<\/?think>/g, "").trim()
    }));
}

function getCheckpointDB(writable = false) {
    const dbPath = "./checkpoints.db";
    if (!existsSync(dbPath)) return null;
    // Open in read-write mode even for reads — readonly connections can't see
    // uncommitted WAL data from the LangGraph checkpointer's connection.
    const db = new Database(dbPath);
    db.pragma("wal_checkpoint(PASSIVE)");
    return db;
}

function dbHasTable(db) {
    try { db.prepare("SELECT 1 FROM checkpoints LIMIT 0"); return true; } catch { return false; }
}

// ── Thread lineage (milestone-based thread spawning) ─────────────────────────
function ensureThreadLinksTable(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS thread_links (
        child_thread_id TEXT PRIMARY KEY,
        parent_thread_id TEXT NOT NULL,
        milestone_status TEXT NOT NULL,
        milestone_agent TEXT NOT NULL,
        created_at INTEGER NOT NULL
    )`);
}

function linkThreads(parentId, childId, milestoneStatus, milestoneAgent) {
    const db = getCheckpointDB(true);
    if (!db) return;
    try {
        ensureThreadLinksTable(db);
        db.prepare("INSERT OR REPLACE INTO thread_links (child_thread_id, parent_thread_id, milestone_status, milestone_agent, created_at) VALUES (?, ?, ?, ?, ?)").run(childId, parentId, milestoneStatus, milestoneAgent, Date.now());
    } finally { db.close(); }
}

function getRootThread(threadId) {
    const db = getCheckpointDB();
    if (!db) return threadId;
    try {
        ensureThreadLinksTable(db);
        let current = threadId;
        for (let i = 0; i < 50; i++) { // safety limit
            const row = db.prepare("SELECT parent_thread_id FROM thread_links WHERE child_thread_id = ?").get(current);
            if (!row) return current;
            current = row.parent_thread_id;
        }
        return current;
    } finally { db.close(); }
}

function getThreadChain(threadId) {
    const db = getCheckpointDB();
    if (!db) return [{ threadId }];
    try {
        ensureThreadLinksTable(db);
        // Walk up to root
        const rootId = getRootThread(threadId);
        // Walk down from root collecting the chain
        const chain = [{ threadId: rootId }];
        let current = rootId;
        for (let i = 0; i < 50; i++) {
            const row = db.prepare("SELECT child_thread_id, milestone_status, milestone_agent, created_at FROM thread_links WHERE parent_thread_id = ?").get(current);
            if (!row) break;
            chain.push({ threadId: row.child_thread_id, milestoneStatus: row.milestone_status, milestoneAgent: row.milestone_agent, createdAt: row.created_at });
            current = row.child_thread_id;
        }
        return chain;
    } finally { db.close(); }
}

function isChildThread(threadId) {
    const db = getCheckpointDB();
    if (!db) return false;
    try {
        ensureThreadLinksTable(db);
        return !!db.prepare("SELECT 1 FROM thread_links WHERE child_thread_id = ?").get(threadId);
    } finally { db.close(); }
}

function getDescendantThreads(threadId) {
    const db = getCheckpointDB();
    if (!db) return [];
    try {
        ensureThreadLinksTable(db);
        const descendants = [];
        const queue = [threadId];
        while (queue.length > 0 && descendants.length < 100) {
            const current = queue.shift();
            const rows = db.prepare("SELECT child_thread_id FROM thread_links WHERE parent_thread_id = ?").all(current);
            for (const row of rows) {
                descendants.push(row.child_thread_id);
                queue.push(row.child_thread_id);
            }
        }
        return descendants;
    } finally { db.close(); }
}

// ── OpenAI-compatible API ────────────────────────────────────────────────────
server.get("/v1/models", async (request, reply) => {
    return {
        object: "list",
        data: [{ id: "ai-it-org", object: "model", created: Math.floor(Date.now() / 1000), owned_by: "ai-it" }],
    };
});

server.post("/v1/chat/completions", async (request, reply) => {
    const { messages: rawMessages, stream = false, model, user } = request.body;

    if (!rawMessages || rawMessages.length === 0) {
        return reply.code(400).send({ error: "No messages provided." });
    }

    const cleanedMessages = cleanIncomingHistory(rawMessages);
    const requestId = `chatcmpl-${uuidv4()}`;

    // Utility requests (title generation, follow-up suggestions, etc.)
    if (cleanedMessages[0]?.role === "system") {
        console.error(`[UTILITY] Proxying to lfm2-8b (${cleanedMessages.length} msgs)`);
        const utilityConfig = { ...config };
        try {
            if (!stream) {
                const response = await utilityLLM.invoke(cleanedMessages, utilityConfig);
                return {
                    id: requestId, object: "chat.completion", created: Math.floor(Date.now() / 1000), model: model || "ai-it-org",
                    choices: [{ index: 0, message: { role: "assistant", content: response.content }, finish_reason: "stop" }],
                };
            }
            reply.hijack();
            reply.raw.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no" });
            const writeChunk = (content) => reply.raw.write(`data: ${JSON.stringify({ id: requestId, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: model || "ai-it-org", choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n`);
            for await (const chunk of await utilityLLM.stream(cleanedMessages, utilityConfig)) {
                if (chunk.content) writeChunk(chunk.content);
            }
            reply.raw.write(`data: ${JSON.stringify({ id: requestId, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
            reply.raw.write("data: [DONE]\n\n");
        } catch (error) {
            console.error("[UTILITY] Error:", error.message);
            if (!reply.raw.headersSent) return reply.code(500).send({ error: error.message });
        }
        reply.raw.end();
        return;
    }

    const lastUserMessage = cleanedMessages[cleanedMessages.length - 1].content;
    const originalDirective = cleanedMessages[0].content || "Unknown Directive";
    const firstMsg = originalDirective;
    const threadId = crypto.createHash('md5').update(firstMsg).digest('hex').substring(0, 12);

    const directivePreview = originalDirective.length > 80 ? originalDirective.slice(0, 80) + "…" : originalDirective;
    const config = { configurable: { thread_id: threadId, root_thread_id: threadId }, recursionLimit: 100 };
    if (process.env.LANGFUSE_SECRET_KEY || process.env.LANGFUSE_PUBLIC_KEY) {
        console.error(`[LANGFUSE] Creating CallbackHandler for thread ${threadId}`);
        config.callbacks = [new CallbackHandler({
            sessionId: threadId,
            userId: "user",
            publicKey: process.env.LANGFUSE_PUBLIC_KEY,
            secretKey: process.env.LANGFUSE_SECRET_KEY,
            baseUrl: process.env.LANGFUSE_BASE_URL || process.env.LANGFUSE_HOST
        })];
    }

    if (!stream) {
        try {
            const result = await app.invoke({ messages: [{ role: "user", content: lastUserMessage }] }, config);
            const lastMsg = result.messages[result.messages.length - 1];
            return {
                id: requestId, object: "chat.completion", created: Math.floor(Date.now() / 1000), model: model || "ai-it-org",
                choices: [{ index: 0, message: { role: "assistant", content: lastMsg.content }, finish_reason: "stop" }],
            };
        } catch (error) {
            return reply.code(500).send({ error: error.message });
        }
    }

    // --- Background workflow job (decoupled from HTTP connection) ---
    if (!workflowJobs[threadId] || workflowJobs[threadId].done) {
        const job = { events: [], done: false, error: null, listeners: new Set() };
        workflowJobs[threadId] = job;
        activeThreads.add(threadId);
        const abortController = new AbortController();
        threadAbortControllers[threadId] = abortController;

        let lastTokenTime = Date.now();
        const activeAgentSet = new Set(), agentStats = {};
        const syncActiveAgent = () => { activeThreadAgents[threadId] = { agents: [...activeAgentSet] }; };

        const emit = (data) => { 
            lastTokenTime = Date.now();
            job.events.push(data); 
            for (const fn of job.listeners) { try { fn(data); } catch {} } 
        };
        const emitChunk = (content, agent) => emit({ id: requestId, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: model || "ai-it-org", choices: [{ index: 0, delta: { content, ...(agent && { agent }) }, finish_reason: null }] });
        const emitToolActivity = (data) => emit({ id: requestId, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: model || "ai-it-org", choices: [{ index: 0, delta: { agent: data.agent, tool_activity: data }, finish_reason: null }] });
        // Track all thread IDs in the chain (original + spawned) for research event matching
        const activeChainThreadIds = new Set([threadId]);
        const isChainThread = (id) => activeChainThreadIds.has(id);
        const onResearchEvent = (data) => { if (isChainThread(data.threadId)) { console.error(`[SSE TOOL] ${data.agent} ${data.type} ${data.status} ${data.query || data.url || ""}`); emitToolActivity(data); } };
        const onResearchPrompt = (data) => { if (isChainThread(data.threadId)) emit({ id: requestId, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: (typeof model !== "undefined" ? model : "ai-it-org"), choices: [{ index: 0, delta: { content: "", system_prompt: data.prompt, agent: data.agent }, finish_reason: null }] }); };
        const onResearchChunk = (data) => { if (isChainThread(data.threadId)) emitChunk(data.content, data.agent); };
        const onResearchStop = (data) => {
            if (isChainThread(data.threadId)) {
                emit({ id: requestId, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: (typeof model !== "undefined" ? model : "ai-it-org"), choices: [{ index: 0, delta: { content: "", agent: data.agent }, finish_reason: "stop" }] });
                activeAgentSet.delete(data.agent);
                syncActiveAgent();
            }
        };
        researchEvents.on("tool", onResearchEvent);

        researchEvents.on("prompt", onResearchPrompt);
        researchEvents.on("chunk", onResearchChunk);
        researchEvents.on("stop", onResearchStop);

        const staleGuard = setInterval(() => { 
            if (Date.now() - lastTokenTime > 600000) { 
                const activeJobs = Object.entries(agentStats).map(([name, stats]) => {
                    const duration = ((Date.now() - stats.startTime) / 1000).toFixed(1);
                    return `${name} (${duration}s, ${stats.tokenCount} tokens)`;
                }).join(", ");
                console.error(`[STALE] Aborting thread ${threadId}. Active jobs: ${activeJobs || "none"}. Last token: ${((Date.now() - lastTokenTime)/1000).toFixed(1)}s ago`);
                abortController.abort(); 
                clearInterval(staleGuard); 
            } 
        }, 10000);

        // Stream processing loop — runs the graph and checks for spawn milestones after each run
        async function runStreamLoop(currentThreadId, initialMessages, streamConfig) {
            console.error(`[STREAM] Starting workflow for thread ${currentThreadId}`);
            const eventStream = await app.streamEvents({ messages: initialMessages }, { ...streamConfig, version: "v2", signal: abortController.signal });
            const researchPromptSent = new Set();
            const agentContentBuffers = {};
            const agentRoundCounters = {};
            let lastAgentName = null, lastAgentContent = null;

            for await (const event of eventStream) {
                const eventType = event.event, nodeName = event.metadata?.langgraph_node;

                if (!nodeName || nodeName === "__start__" || nodeName === "project_manager") continue;
                if (event.tags?.includes("hide_stream") || event.metadata?.tags?.includes("hide_stream")) continue;
                const validAgents = getActiveAgents();

                const actualNodeName = event.metadata?.langgraph_node || "";
                const isPromptNode = actualNodeName.endsWith("_prompt") && validAgents.includes(actualNodeName.replace(/_prompt$/, ""));

                console.error(`[STREAM EVENT] type=${eventType} name=${event.name} nodeName=${nodeName} actual=${actualNodeName} prompt=${isPromptNode}`);

                if (isPromptNode) continue;

                const isResearchNode = actualNodeName.endsWith("_research") && validAgents.includes(actualNodeName.replace(/_research$/, ""));
                const resolvedAgentName = isResearchNode ? actualNodeName : actualNodeName;

                if (eventType === "on_chain_start" && (validAgents.includes(actualNodeName) || isResearchNode)) {
                    activeAgentSet.add(resolvedAgentName);
                    syncActiveAgent();
                    emitChunk("", resolvedAgentName);
                }
                if (eventType === "on_chat_model_start" && (validAgents.includes(actualNodeName) || isResearchNode)) {
                    lastTokenTime = Date.now();
                    const inputMsgs = event.data.input?.messages || [];
                    let prompt = "Processing...";
                    if (inputMsgs.length > 0) { const fm = Array.isArray(inputMsgs[0]) ? inputMsgs[0][0] : inputMsgs[0]; prompt = fm.kwargs?.content || fm.content || prompt; }
                    agentStats[actualNodeName] = { startTime: Date.now(), tokenCount: 0, promptChars: prompt.length };
                    process.stderr.write(`[STATS] ${actualNodeName} prompt: ${prompt.length.toLocaleString()} chars\n`);

                    if (!researchPromptSent.has(actualNodeName)) {
                        researchPromptSent.add(actualNodeName);
                        emit({ id: requestId, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: "ai-it-org", choices: [{ index: 0, delta: { content: "", system_prompt: prompt, agent: resolvedAgentName }, finish_reason: null }] });
                    }
                }
                if (eventType === "on_chat_model_stream") {
                    const targetAgent = actualNodeName;
                    if (targetAgent && (validAgents.includes(targetAgent) || isResearchNode)) {
                        lastTokenTime = Date.now();
                        let rawContent = event.data.chunk.content;
                        if (Array.isArray(rawContent)) rawContent = rawContent.map(c => typeof c === 'string' ? c : (c.text || "")).join("");
                        if (!rawContent) continue;
                        if (agentStats[targetAgent]) agentStats[targetAgent].tokenCount++;
                        if (!agentContentBuffers[targetAgent]) agentContentBuffers[targetAgent] = "";
                        agentContentBuffers[targetAgent] += rawContent;
                        emitChunk(rawContent, targetAgent);
                    }
                }
                if (eventType === "on_chain_end" && (validAgents.includes(actualNodeName) || isResearchNode)) {
                    const agentName = resolvedAgentName;
                    const stats = agentStats[agentName];
                    if (stats) { const el = ((Date.now() - stats.startTime) / 1000).toFixed(1); process.stderr.write(`[STATS] ${agentName} done: ${stats.tokenCount} tokens in ${el}s (${(stats.tokenCount / (parseFloat(el) || 1)).toFixed(1)} t/s)\n`); delete agentStats[agentName]; }
                    // Agent scoring: extract STATUS and send Langfuse scores
                    if (agentContentBuffers[agentName]) {
                        const statusMatch = agentContentBuffers[agentName].match(/STATUS:\s*(\w+)/);
                        if (statusMatch) {
                            const status = statusMatch[1];
                            if (agentName === "quality_engineer") {
                                const scoreMap = { TESTS_PASSED: 1, TESTING_COMPLETE: 1, REJECTED: 0, QUESTION: 0.5, TESTING_AMBIGUOUS: 0.5, TESTING_CLEAR: 0.75 };
                                const scoreValue = scoreMap[status] ?? 0.5;
                                try {
                                    const lfHandler = streamConfig.callbacks?.find(c => c instanceof CallbackHandler);
                                    const traceId = lfHandler?.traceId;
                                    const lf = new Langfuse({ publicKey: process.env.LANGFUSE_PUBLIC_KEY, secretKey: process.env.LANGFUSE_SECRET_KEY, baseUrl: process.env.LANGFUSE_BASE_URL || process.env.LANGFUSE_HOST });
                                    lf.score({ traceId, name: "qe_approval", value: scoreValue, comment: `STATUS: ${status}`, metadata: { agent: "quality_engineer", status } });
                                    await lf.flushAsync();
                                    console.error(`[LANGFUSE] QE score: ${status} = ${scoreValue} for thread ${currentThreadId}`);
                                } catch (e) { console.error("[LANGFUSE] QE score error:", e.message); }
                            }
                            // Track clarification rounds for all agents
                            const questionStatuses = getPipeline().question_statuses || [];
                            if (questionStatuses.includes(status)) {
                                agentRoundCounters[agentName] = (agentRoundCounters[agentName] || 0) + 1;
                                console.error(`[LANGFUSE] ${agentName} clarification round ${agentRoundCounters[agentName]} for thread ${currentThreadId}`);
                            } else if (status.endsWith("_CLEAR") || status.endsWith("_DRAFTED") || status.endsWith("_APPROVED")) {
                                const rounds = agentRoundCounters[agentName] || 0;
                                try {
                                    const lfHandler = streamConfig.callbacks?.find(c => c instanceof CallbackHandler);
                                    const traceId = lfHandler?.traceId;
                                    const lf = new Langfuse({ publicKey: process.env.LANGFUSE_PUBLIC_KEY, secretKey: process.env.LANGFUSE_SECRET_KEY, baseUrl: process.env.LANGFUSE_BASE_URL || process.env.LANGFUSE_HOST });
                                    lf.score({ traceId, name: "clarification_rounds", value: rounds, comment: rounds === 0 ? "No clarification needed" : `${rounds} round(s) before ${status}`, metadata: { agent: agentName, finalStatus: status } });
                                    await lf.flushAsync();
                                    console.error(`[LANGFUSE] ${agentName} clarification_rounds: ${rounds} for thread ${currentThreadId}`);
                                } catch (e) { console.error("[LANGFUSE] clarification score error:", e.message); }
                            }
                        }
                        // Track last agent output for spawn detection
                        lastAgentName = agentName;
                        lastAgentContent = agentContentBuffers[agentName];
                    }
                    delete agentContentBuffers[agentName];
                    emit({ id: requestId, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: "ai-it-org", choices: [{ index: 0, delta: { content: "", agent: agentName }, finish_reason: "stop" }] });
                    activeAgentSet.delete(agentName);
                    syncActiveAgent();
                    if (threadPauseRequested[currentThreadId] && activeAgentSet.size === 0) {
                        const activeJobs = Object.entries(agentStats).map(([name, stats]) => {
                            const duration = ((Date.now() - stats.startTime) / 1000).toFixed(1);
                            return `${name} (${duration}s, ${stats.tokenCount} tokens)`;
                        }).join(", ");
                        console.error(`[PAUSE] All agents drained for thread ${currentThreadId}, pausing workflow. Active jobs: ${activeJobs || "none"}`);
                        abortController.abort();
                    }
                }
            }

            // Check if the last agent output was a spawn milestone
            if (lastAgentContent) {
                const lastStatus = extractStatusFromContent(lastAgentContent);
                if (lastStatus && THREAD_SPAWN_MILESTONES.includes(lastStatus) && lastAgentName) {
                    return { spawn: true, status: lastStatus, agent: lastAgentName, content: lastAgentContent, threadId: currentThreadId };
                }
            }
            return { spawn: false, threadId: currentThreadId };
        }

        (async () => {
            let currentThreadId = threadId;
            const rootThreadId = threadId; // For Langfuse session continuity
            try {
                // Initial run
                let result = await runStreamLoop(
                    currentThreadId,
                    [new HumanMessage({ content: lastUserMessage, additional_kwargs: { timestamp: Date.now() } })],
                    config
                );

                // Spawn loop: keep spawning new threads at milestone boundaries
                while (result.spawn) {
                    const newThreadId = crypto.randomUUID().substring(0, 12);
                    console.error(`[SPAWN] Milestone ${result.status} from ${result.agent} in thread ${result.threadId} → spawning new thread ${newThreadId}`);

                    // Seed the new thread: original directive + milestone output
                    const seedMessages = [
                        new HumanMessage({ content: originalDirective, additional_kwargs: { timestamp: Date.now() } }),
                        new AIMessage({ content: result.content, name: result.agent, additional_kwargs: { timestamp: Date.now() } })
                    ];

                    // Record the link
                    linkThreads(result.threadId, newThreadId, result.status, result.agent);

                    // Emit thread transition event to SSE clients
                    emit({ id: requestId, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: model || "ai-it-org",
                        choices: [{ index: 0, delta: { thread_transition: { from: result.threadId, to: newThreadId, milestone: result.status, agent: result.agent } }, finish_reason: null }] });

                    // Flush Langfuse for the completed thread segment
                    const prevLfHandler = config.callbacks?.find(c => c instanceof CallbackHandler);
                    if (prevLfHandler) {
                        try { await prevLfHandler.flushAsync(); } catch {}
                    }

                    // Create new Langfuse handler for the spawned thread, same session as root
                    const newConfig = { configurable: { thread_id: newThreadId, root_thread_id: rootThreadId }, recursionLimit: 100 };
                    if (process.env.LANGFUSE_SECRET_KEY || process.env.LANGFUSE_PUBLIC_KEY) {
                        newConfig.callbacks = [new CallbackHandler({
                            sessionId: rootThreadId, // Same session for the whole chain
                            userId: "user",
                            publicKey: process.env.LANGFUSE_PUBLIC_KEY,
                            secretKey: process.env.LANGFUSE_SECRET_KEY,
                            baseUrl: process.env.LANGFUSE_BASE_URL || process.env.LANGFUSE_HOST
                        })];
                    }

                    currentThreadId = newThreadId;
                    // Track the new thread in active state
                    activeThreads.add(currentThreadId);
                    activeChainThreadIds.add(currentThreadId);
                    threadAbortControllers[currentThreadId] = abortController;

                    result = await runStreamLoop(currentThreadId, seedMessages, newConfig);
                }

                emit({ id: requestId, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
                emit("[DONE]");
            } catch (error) {
                if (!(error.name === "AbortError" || error.message === "Abort" || error.message === "The operation was aborted")) {
                    console.error("Stream Error:", error); job.error = error.message;
                } else { console.error("[STREAM] Aborted"); }
                // Emit stop signals for any agents still active so UI clears spinners
                for (const agent of activeAgentSet) {
                    emit({ id: requestId, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: "ai-it-org", choices: [{ index: 0, delta: { content: "", agent }, finish_reason: "stop" }] });
                }
                emit({ id: requestId, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
                emit("[DONE]");
            } finally {
                researchEvents.off("tool", onResearchEvent);
                researchEvents.off("prompt", onResearchPrompt);
                researchEvents.off("chunk", onResearchChunk);
                researchEvents.off("stop", onResearchStop);
                // Flush Langfuse for the final thread segment
                const lfHandler = config.callbacks?.find(c => c instanceof CallbackHandler);
                if (lfHandler) {
                    try {
                        await lfHandler.flushAsync();
                        const traceId = lfHandler.traceId;
                        if (traceId) {
                            const lf = new Langfuse({ publicKey: process.env.LANGFUSE_PUBLIC_KEY, secretKey: process.env.LANGFUSE_SECRET_KEY, baseUrl: process.env.LANGFUSE_BASE_URL || process.env.LANGFUSE_HOST });
                            lf.trace({
                                id: traceId,
                                name: directivePreview,
                                sessionId: threadId,
                                input: originalDirective,
                                output: job.error ? { error: job.error } : { status: "completed" },
                                tags: ["ai-it", "chat"],
                                metadata: { thread_id: threadId, directive: originalDirective }
                            });
                            await lf.flushAsync();
                        }
                    } catch (e) { console.error("[LANGFUSE] Flush error:", e.message); }
                }
                job.done = true; activeThreads.delete(threadId); activeThreads.delete(currentThreadId); delete activeThreadAgents[threadId]; delete threadAbortControllers[threadId]; delete threadPauseRequested[threadId]; clearInterval(staleGuard);
                setTimeout(() => { delete workflowJobs[threadId]; }, 300000);
            }
        })();
    }

    // SSE client connection — replay buffered events then follow live
    const job = workflowJobs[threadId];
    reply.hijack();
    reply.raw.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no" });
    reply.raw.socket?.setNoDelay(true);

    let clientDisconnected = false;

    const socket = reply.raw.socket;
    socket.on("close", () => { clientDisconnected = true; });

    const heartbeat = setInterval(() => {
        if (!clientDisconnected) { try { reply.raw.write(": keep-alive\n\n"); } catch {} }
    }, 15000);

    const writeToClient = (data) => {
        if (clientDisconnected) return;
        try {
            if (data === "[DONE]") reply.raw.write("data: [DONE]\n\n");
            else reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
        } catch {}
    };

    // Replay all buffered events from the job
    for (const evt of job.events) {
        if (clientDisconnected) break;
        writeToClient(evt);
    }

    if (job.done) {
        clearInterval(heartbeat);
        if (!clientDisconnected) reply.raw.end();
    } else {
        // Follow live events
        const listener = (data) => {
            writeToClient(data);
            // Only end the stream on global DONE or global finish_reason: stop (without agent field)
            const isGlobalStop = data?.choices?.[0]?.finish_reason === "stop" && !data?.choices?.[0]?.delta?.agent;
            if (data === "[DONE]" || isGlobalStop) {
                job.listeners.delete(listener);
                clearInterval(heartbeat);
                if (!clientDisconnected) reply.raw.end();
            }
        };
        job.listeners.add(listener);
        socket.on("close", () => { job.listeners.delete(listener); clearInterval(heartbeat); });
    }
});

// ── Admin API ────────────────────────────────────────────────────────────────
server.get("/api/threads", async () => {
    const db = getCheckpointDB();
    if (!db || !dbHasTable(db)) { db?.close(); return []; }
    const threads = db.prepare(`
        SELECT c.thread_id, c.checkpoint_id
        FROM checkpoints c
        INNER JOIN (SELECT thread_id, MAX(checkpoint_id) as max_cp FROM checkpoints WHERE checkpoint_ns = '' GROUP BY thread_id) latest
        ON c.thread_id = latest.thread_id AND c.checkpoint_id = latest.max_cp
        WHERE c.checkpoint_ns = '' ORDER BY c.checkpoint_id DESC
    `).all();
    // Ensure thread_titles table exists for caching generated titles and creation dates
    try { db.exec("CREATE TABLE IF NOT EXISTS thread_titles (thread_id TEXT PRIMARY KEY, title TEXT NOT NULL)"); } catch {}
    try { db.exec("ALTER TABLE thread_titles ADD COLUMN created_at INTEGER"); } catch {}

    const result = threads.map(t => {
        try {
            const cp = JSON.parse(db.prepare("SELECT checkpoint FROM checkpoints WHERE thread_id = ? AND checkpoint_id = ? AND checkpoint_ns = ''").get(t.thread_id, t.checkpoint_id).checkpoint);
            const msgs = cp.channel_values?.messages || [];
            const firstMsgRaw = msgs[0]?.kwargs?.content || "(empty)";
            const firstMsg = typeof firstMsgRaw === 'string' ? firstMsgRaw : JSON.stringify(firstMsgRaw);
            const directive = firstMsg;
            const agentNames = [...new Set(msgs.filter(m => m.kwargs?.name).map(m => {
                const name = m.kwargs.name;
                return typeof name === 'string' ? name : String(name || "");
            }))];
            
            // Get cached title and created_at
            let title = null;
            let created_at = null;
            try { 
                const titleRow = db.prepare("SELECT title, created_at FROM thread_titles WHERE thread_id = ?").get(t.thread_id); 
                title = titleRow?.title;
                created_at = titleRow?.created_at;
            } catch {}

            if (!created_at) {
                try {
                    const firstRow = db.prepare("SELECT checkpoint FROM checkpoints WHERE thread_id = ? AND checkpoint_ns = '' ORDER BY checkpoint_id ASC LIMIT 1").get(t.thread_id);
                    if (firstRow) {
                        const firstCp = JSON.parse(firstRow.checkpoint);
                        if (firstCp.ts) {
                            created_at = Math.floor(new Date(firstCp.ts).getTime() / 1000);
                        }
                    }
                } catch {}
            }
            return { thread_id: t.thread_id, directive, title: title || directive.slice(0, 80), msgCount: msgs.length, agents: agentNames, created_at };
        } catch { return null; }
    }).filter(t => t && !t.directive.startsWith("### Task:") && !t.directive.startsWith("(empty)"));

    // Filter out child threads from the sidebar list (they're part of a chain, not standalone)
    ensureThreadLinksTable(db);
    const childThreadIds = new Set(db.prepare("SELECT child_thread_id FROM thread_links").all().map(r => r.child_thread_id));
    const filtered = result.filter(t => !childThreadIds.has(t.thread_id));

    db.close();

    // Generate titles in background for threads that don't have one
    for (const t of result) {
        if (t.title === t.directive.slice(0, 80) && t.directive.length > 20) {
            generateTitle(t.thread_id, t.directive);
        }
    }

    return filtered;
});

const titleGenerating = new Set();
async function generateTitle(threadId, directive) {
    if (titleGenerating.has(threadId)) return;
    titleGenerating.add(threadId);
    try {
        const response = await utilityLLM.invoke([
            { role: "system", content: 'Generate a short title (5-8 words max) summarizing this user request. Respond with ONLY a JSON object in this exact format: {"title": "Your Short Title Here"}. No other text.' },
            { role: "user", content: directive.slice(0, 500) }
        ]);
        let raw = (response.content || "").replace(/<think>[\s\S]*?<\/think>/g, "").replace(/<\/?think>/g, "").trim();
        // Handle JSON responses — extract title field or first string value
        let title = raw;
        try {
            const parsed = JSON.parse(raw);
            title = parsed.title || parsed.name || parsed.summary || Object.values(parsed).find(v => typeof v === "string") || raw;
        } catch {
            // Not JSON — use as-is, strip quotes
            title = raw.replace(/^["']|["']$/g, "");
        }
        if (title && title.length < 100) {
            const db = getCheckpointDB(true);
            if (db) {
                try { db.exec("CREATE TABLE IF NOT EXISTS thread_titles (thread_id TEXT PRIMARY KEY, title TEXT NOT NULL)"); } catch {}
                try { db.exec("ALTER TABLE thread_titles ADD COLUMN created_at INTEGER"); } catch {}
                const existing = db.prepare("SELECT * FROM thread_titles WHERE thread_id = ?").get(threadId);
                if (existing) {
                    db.prepare("UPDATE thread_titles SET title = ? WHERE thread_id = ?").run(title, threadId);
                } else {
                    db.prepare("INSERT INTO thread_titles (thread_id, title) VALUES (?, ?)").run(threadId, title);
                }
                db.close();
            }
        }
    } catch (e) {
        console.error("[TITLE] Failed for", threadId, e.message);
    } finally {
        titleGenerating.delete(threadId);
    }
}

function parseCheckpointMessages(rawMsgs, threadId) {
    const msgs = rawMsgs.map(m => {
        const kwargs = m.kwargs || {};
        const type = m.type || "";
        const idTag = Array.isArray(m.id) ? m.id.find(s => typeof s === 'string' && s.endsWith("Message")) || "" : "";
        const isHuman = type === "human" || idTag === "HumanMessage";
        const isSystem = type === "system" || idTag === "SystemMessage";
        const isAI = type === "ai" || idTag === "AIMessage";
        const roleRaw = isSystem ? "system" : isHuman ? "user" : (typeof kwargs.name === 'string' && kwargs.name && !kwargs.name.startsWith("[")) ? "assistant" : kwargs.role === "user" || kwargs.role === "human" ? "user" : isAI ? "assistant" : "user";
        const role = typeof roleRaw === 'string' ? roleRaw : String(roleRaw || "user");
        const nameRaw = isHuman ? "" : (typeof kwargs.name === 'string' ? kwargs.name : null) || (typeof m.name === 'string' ? m.name : null) || (typeof m.additional_kwargs?.name === 'string' ? m.additional_kwargs.name : null) || "";
        const name = typeof nameRaw === 'string' ? nameRaw : String(nameRaw || "");
        const isPrompt = name.endsWith("__prompt");
        const isResearch = name.endsWith("__research");

        let cleanName = name;
        if (isPrompt) cleanName = name.replace("__prompt", "");
        else if (isResearch) cleanName = name.replace("__research", "");

        const contentRaw = kwargs.content || m.content || "";
        const content = typeof contentRaw === 'string' ? contentRaw : JSON.stringify(contentRaw);

        const add = kwargs.additional_kwargs || m.additional_kwargs || {};
        return {
            role: isPrompt ? "system" : role,
            name: cleanName,
            content: content,
            timestamp: add.timestamp || kwargs.timestamp || m.timestamp || null,
            ...(isPrompt && { type: "prompt" }),
            ...(name === "__boundary__" && { type: "boundary", milestoneStatus: add.milestoneStatus || "", milestoneAgent: add.milestoneAgent || "" }),
            _isPromptOriginal: isPrompt,
            // Carry chain metadata through for resolving rewind/edit targets
            ...(m._chainThreadId && { _threadId: m._chainThreadId, _threadMsgIndex: m._chainMsgIndex }),
        };
    });
    // Merge saved ratings
    try {
        const rdb = getCheckpointDB();
        try { rdb.exec("CREATE TABLE IF NOT EXISTS message_ratings (thread_id TEXT, message_index INTEGER, rating INTEGER, PRIMARY KEY (thread_id, message_index))"); } catch {}
        const ratings = rdb.prepare("SELECT message_index, rating FROM message_ratings WHERE thread_id = ?").all(threadId);
        rdb.close();
        const ratingsMap = new Map(ratings.map(r => [r.message_index, r.rating]));
        const withRatings = msgs.map((m, i) => ({ ...m, rating: ratingsMap.get(i) || 0, _origIndex: i }));

        // Inject synthetic milestone boundaries based on status transitions
        // When an assistant message emits a spawn milestone status, insert a boundary after it
        const milestoneStatuses = new Set(THREAD_SPAWN_MILESTONES);
        const result = [];
        for (let i = 0; i < withRatings.length; i++) {
            const m = withRatings[i];
            result.push(m);
            if (m.type === "boundary") continue; // Already a real boundary
            if (m.role === "assistant" && m.name && !m._isPromptOriginal) {
                const statusMatches = (m.content || "").match(/STATUS:\s*([A-Z_]+)/g);
                if (statusMatches) {
                    const lastStatus = statusMatches[statusMatches.length - 1].replace("STATUS: ", "").replace("STATUS:", "").trim();
                    if (milestoneStatuses.has(lastStatus) && i < withRatings.length - 1) {
                        // Skip if a real boundary already follows (chain mode)
                        const nextNonPrompt = withRatings.slice(i + 1).find(n => n.type === "boundary" || (n.role === "assistant" && n.name && !n._isPromptOriginal));
                        if (nextNonPrompt && nextNonPrompt.type === "boundary") continue;
                        // Check that subsequent messages involve a different agent (assistant response OR system prompt to a different agent)
                        const nextDifferent = withRatings.slice(i + 1).find(n =>
                            (n.role === "assistant" && n.name && !n._isPromptOriginal && n.name !== m.name) ||
                            (n._isPromptOriginal && n.name && n.name !== m.name)
                        );
                        if (nextDifferent) {
                            result.push({
                                role: "system", name: "__boundary__", type: "boundary",
                                content: `── ${lastStatus} ──`,
                                milestoneStatus: lastStatus, milestoneAgent: m.name,
                                timestamp: m.timestamp, rating: 0
                            });
                        }
                    }
                }
            }
        }
        return result;
    } catch { return msgs; }
}

server.get("/api/threads/:threadId/chain", async (request) => {
    return getThreadChain(request.params.threadId);
});

server.get("/api/threads/:threadId/messages", async (request) => {
    const chainMode = request.query?.chain === "true";
    const threadIds = chainMode ? getThreadChain(request.params.threadId).map(c => c.threadId) : [request.params.threadId];

    const db = getCheckpointDB();
    if (!db || !dbHasTable(db)) { db?.close(); return []; }

    // For chain mode, collect messages from all threads in order, skipping duplicate directives
    if (chainMode && threadIds.length > 1) {
        const allMsgs = [];
        for (let ti = 0; ti < threadIds.length; ti++) {
            const row = db.prepare("SELECT checkpoint FROM checkpoints WHERE thread_id = ? AND checkpoint_ns = '' ORDER BY checkpoint_id DESC LIMIT 1").get(threadIds[ti]);
            if (!row) continue;
            try {
                const data = JSON.parse(row.checkpoint);
                const msgs = data.channel_values?.messages || [];
                const startIdx = ti > 0 ? 2 : 0;
                for (let i = startIdx; i < msgs.length; i++) {
                    // Tag raw messages with chain metadata before parsing
                    msgs[i]._chainThreadId = threadIds[ti];
                    msgs[i]._chainMsgIndex = i;
                    allMsgs.push(msgs[i]);
                }
                if (ti < threadIds.length - 1) {
                    const chain = getThreadChain(request.params.threadId);
                    const milestone = chain[ti + 1];
                    allMsgs.push({ id: ["system", "ThreadBoundary"], kwargs: { content: `── Thread transition: ${milestone?.milestoneStatus || "milestone"} ──`, name: "__boundary__", additional_kwargs: { milestoneStatus: milestone?.milestoneStatus || "", milestoneAgent: milestone?.milestoneAgent || "" } }, type: "system" });
                }
            } catch {}
        }
        db.close();
        return parseCheckpointMessages(allMsgs, request.params.threadId);
    }

    const row = db.prepare("SELECT checkpoint FROM checkpoints WHERE thread_id = ? AND checkpoint_ns = '' ORDER BY checkpoint_id DESC LIMIT 1").get(request.params.threadId);
    db.close();
    if (!row) return [];
    try {
        const data = JSON.parse(row.checkpoint);
        return parseCheckpointMessages(data.channel_values?.messages || [], request.params.threadId);
    } catch (e) { console.error("[MESSAGES] Error parsing messages", e); return []; }
});

server.post("/api/threads/:threadId/messages/:messageIndex/score", async (request, reply) => {
    const { threadId, messageIndex } = request.params;
    const idx = parseInt(messageIndex, 10);
    const { rating, agentName } = request.body || {};
    if (rating === undefined || rating === null || rating < 0 || rating > 5) return reply.code(400).send({ error: "Rating must be 0-5" });

    // Persist locally
    const db = getCheckpointDB(true);
    try { db.exec("CREATE TABLE IF NOT EXISTS message_ratings (thread_id TEXT, message_index INTEGER, rating INTEGER, PRIMARY KEY (thread_id, message_index))"); } catch {}
    if (rating === 0) {
        db.prepare("DELETE FROM message_ratings WHERE thread_id = ? AND message_index = ?").run(threadId, idx);
    } else {
        db.prepare("INSERT OR REPLACE INTO message_ratings (thread_id, message_index, rating) VALUES (?, ?, ?)").run(threadId, idx, rating);
    }
    db.close();

    // Send to Langfuse — look up latest trace for this session
    if (process.env.LANGFUSE_SECRET_KEY) {
        try {
            const authHeader = "Basic " + Buffer.from(`${process.env.LANGFUSE_PUBLIC_KEY}:${process.env.LANGFUSE_SECRET_KEY}`).toString("base64");
            const baseUrl = process.env.LANGFUSE_BASE_URL || process.env.LANGFUSE_HOST;
            const traceRes = await fetch(`${baseUrl}/api/public/traces?sessionId=${encodeURIComponent(threadId)}&limit=1`, { headers: { Authorization: authHeader } });
            const traceData = await traceRes.json();
            const traceId = traceData.data?.[0]?.id;
            if (traceId) {
                const lf = new Langfuse({ publicKey: process.env.LANGFUSE_PUBLIC_KEY, secretKey: process.env.LANGFUSE_SECRET_KEY, baseUrl });
                lf.score({ traceId, name: "user_rating", value: rating, comment: agentName || "", metadata: { agent: agentName, messageIndex: idx } });
                await lf.flushAsync();
            } else {
                console.error(`[LANGFUSE] No trace found for session ${threadId}, score not sent`);
            }
        } catch (e) { console.error("[LANGFUSE] User rating score error:", e.message); }
    }

    return { ok: true };
});

server.get("/api/active", async () => {
    return [...activeThreads].map(tid => ({
        thread_id: tid,
        agent: (activeThreadAgents[tid]?.agents || [])[0] || null,
        agents: activeThreadAgents[tid]?.agents || [],
    }));
});

// Stream/replay the workflow job buffer for an active (or recently completed) thread
server.get("/api/threads/:threadId/stream", async (request, reply) => {
    const job = workflowJobs[request.params.threadId];
    if (!job) return reply.code(404).send({ error: "No active workflow" });

    reply.hijack();
    reply.raw.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" });
    reply.raw.socket?.setNoDelay(true);

    let clientDisconnected = false;
    reply.raw.socket.on("close", () => { clientDisconnected = true; });

    const writeToClient = (data) => {
        if (clientDisconnected) return;
        try {
            if (data === "[DONE]") reply.raw.write("data: [DONE]\n\n");
            else reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
        } catch {}
    };

    // Replay buffered events
    for (const evt of job.events) {
        if (clientDisconnected) break;
        writeToClient(evt);
    }

    if (job.done) {
        if (!clientDisconnected) reply.raw.end();
    } else {
        // Follow live
        const heartbeat = setInterval(() => { if (!clientDisconnected) { try { reply.raw.write(": keep-alive\n\n"); } catch {} } }, 15000);
        const listener = (data) => {
            writeToClient(data);
            // Only end the stream on global DONE or global finish_reason: stop (without agent field)
            const isGlobalStop = data?.choices?.[0]?.finish_reason === "stop" && !data?.choices?.[0]?.delta?.agent;
            if (data === "[DONE]" || isGlobalStop) {
                job.listeners.delete(listener);
                clearInterval(heartbeat);
                if (!clientDisconnected) reply.raw.end();
            }
        };
        job.listeners.add(listener);
        reply.raw.socket.on("close", () => { job.listeners.delete(listener); clearInterval(heartbeat); });
    }
});

server.delete("/api/threads", async () => {
    const db = getCheckpointDB(true);
    if (db && dbHasTable(db)) { db.exec("DELETE FROM checkpoints"); db.exec("DELETE FROM writes"); }
    if (db) { try { db.exec("DELETE FROM thread_titles"); } catch {} }
    db?.close();
    return { message: "All conversations deleted" };
});

server.delete("/api/threads/:threadId", async (request) => {
    const db = getCheckpointDB(true);
    if (db && dbHasTable(db)) {
        db.prepare("DELETE FROM checkpoints WHERE thread_id = ?").run(request.params.threadId);
        db.prepare("DELETE FROM writes WHERE thread_id = ?").run(request.params.threadId);
    }
    if (db) { try { db.prepare("DELETE FROM thread_titles WHERE thread_id = ?").run(request.params.threadId); } catch {} }
    db?.close();
    return { message: "Conversation deleted" };
});

server.post("/api/threads/:threadId/abort", async (request, reply) => {
    const controller = threadAbortControllers[request.params.threadId];
    if (controller) { controller.abort(); return { message: "Workflow aborted" }; }
    return reply.code(404).send({ error: "No active workflow for this thread" });
});

server.post("/api/threads/:threadId/pause", async (request, reply) => {
    const { threadId } = request.params;
    if (!activeThreads.has(threadId)) return reply.code(404).send({ error: "No active workflow for this thread" });
    threadPauseRequested[threadId] = true;
    console.error(`[PAUSE] Pause requested for thread ${threadId}`);
    return { message: "Pause requested — workflow will stop after current inference(s) complete" };
});

server.post("/api/threads/:threadId/clone", async (request, reply) => {
    const { threadId } = request.params;
    const { messageIndex } = request.body;

    try {
        const db = getCheckpointDB();
        const row = db.prepare("SELECT checkpoint FROM checkpoints WHERE thread_id = ? AND checkpoint_ns = '' ORDER BY checkpoint_id DESC LIMIT 1").get(threadId);
        db.close();
        if (!row) return reply.code(404).send({ error: "Thread not found" });
        const data = JSON.parse(row.checkpoint);
        const msgs = data.channel_values?.messages || [];
        if (messageIndex < 0 || messageIndex >= msgs.length) return reply.code(400).send({ error: "Invalid message index" });

        const getMsgName = (m) => {
            const isHuman = m?.type === "human" || (Array.isArray(m?.id) && m.id.includes("HumanMessage"));
            if (isHuman) return "";
            const name = (typeof m?.kwargs?.name === 'string' ? m.kwargs.name : null) || (typeof m?.name === 'string' ? m.name : null) || (typeof m?.additional_kwargs?.name === 'string' ? m.additional_kwargs.name : null) || "";
            return typeof name === 'string' ? name : "";
        };
        const getMsgRole = (m) => { const t = m?.type || ""; if (t === "system" || (Array.isArray(m?.id) && m.id.includes("SystemMessage")) || (getMsgName(m) || "").endsWith("__prompt")) return "system"; return m?.role || m?.kwargs?.role || (t === "human" || (Array.isArray(m?.id) && m.id.includes("HumanMessage")) ? "user" : getMsgName(m) ? "assistant" : t === "ai" ? "assistant" : "user"); };
        const getMsgContent = (m) => m?.content || m?.kwargs?.content || "";

        const toLangChainMessage = (role, content, name, timestamp) => {
            const fields = { content, name, additional_kwargs: {} };
            if (timestamp) fields.additional_kwargs.timestamp = timestamp;
            if (role === "user") return new HumanMessage(fields);
            if (role === "system") return new SystemMessage(fields);
            return new AIMessage(fields);
        };

        const clonedMsgs = msgs.slice(0, messageIndex + 1).map(m => {
            const kwargs = m.kwargs || {};
            return toLangChainMessage(getMsgRole(m), getMsgContent(m), getMsgName(m), kwargs.timestamp || m.timestamp);
        });

        const newThreadId = crypto.randomUUID().substring(0, 12);
        const cfg = { configurable: { thread_id: newThreadId }, recursionLimit: 100 };
        await app.updateState(cfg, { messages: clonedMsgs });

        // Copy title with "(clone)" suffix
        const titleDb = getCheckpointDB(true);
        if (titleDb) {
            try { titleDb.exec("CREATE TABLE IF NOT EXISTS thread_titles (thread_id TEXT PRIMARY KEY, title TEXT NOT NULL)"); } catch {}
            try { titleDb.exec("ALTER TABLE thread_titles ADD COLUMN created_at INTEGER"); } catch {}
            const titleRow = titleDb.prepare("SELECT title FROM thread_titles WHERE thread_id = ?").get(threadId);
            const cloneTitle = (titleRow?.title || "Untitled") + " (clone)";
            titleDb.prepare("INSERT OR REPLACE INTO thread_titles (thread_id, title, created_at) VALUES (?, ?, ?)").run(newThreadId, cloneTitle, Math.floor(Date.now() / 1000));
            titleDb.close();
        }

        return { thread_id: newThreadId, message: "Thread cloned successfully" };
    } catch (e) {
        console.error("[ADMIN] Clone error:", e);
        return reply.code(500).send({ error: e.message });
    }
});

server.post("/api/threads/:threadId/resume", async (request, reply) => {
    const { threadId } = request.params;

    try {
        const db = getCheckpointDB();
        const row = db.prepare("SELECT checkpoint FROM checkpoints WHERE thread_id = ? AND checkpoint_ns = '' ORDER BY checkpoint_id DESC LIMIT 1").get(threadId);
        db.close();
        if (!row) return reply.code(404).send({ error: "Thread not found" });
        const data = JSON.parse(row.checkpoint);
        const msgs = data.channel_values?.messages || [];
        if (!msgs.length) return reply.code(400).send({ error: "Thread has no messages" });

        // Find the last non-prompt message to resume from
        let resumeIndex = msgs.length - 1;
        for (let i = msgs.length - 1; i >= 0; i--) {
            const name = msgs[i]?.name || msgs[i]?.kwargs?.name || "";
            if (!name.endsWith("__prompt")) { resumeIndex = i; break; }
        }

        // Delegate to the rewind handler
        request.body = { messageIndex: resumeIndex };
        return server.inject({
            method: "POST",
            url: `/api/threads/${threadId}/rewind`,
            payload: { messageIndex: resumeIndex },
        }).then(res => {
            reply.code(res.statusCode).headers(res.headers).send(res.json());
        });
    } catch (e) {
        console.error("[ADMIN] Resume error:", e);
        return reply.code(500).send({ error: e.message });
    }
});

server.post("/api/threads/:threadId/rewind", async (request, reply) => {
    const { threadId } = request.params;
    const { messageIndex, newContent } = request.body;

    // Abort active job if any
    const controller = threadAbortControllers[threadId];
    if (controller) {
        controller.abort();
        delete threadAbortControllers[threadId];
        if (workflowJobs[threadId]) {
            workflowJobs[threadId].done = true;
            // leave it to be cleaned up or overwrite it
        }
    }

    try {
        const db = getCheckpointDB();
        const row = db.prepare("SELECT checkpoint FROM checkpoints WHERE thread_id = ? AND checkpoint_ns = '' ORDER BY checkpoint_id DESC LIMIT 1").get(threadId);
        db.close();
        if (!row) return reply.code(404).send({ error: "Thread not found" });
        const data = JSON.parse(row.checkpoint);
        const msgs = data.channel_values?.messages || [];

        const getMsgName = (m) => {
            const isHuman = m?.type === "human" || (Array.isArray(m?.id) && m.id.includes("HumanMessage"));
            if (isHuman) return "";
            const name = (typeof m?.kwargs?.name === 'string' ? m.kwargs.name : null) || (typeof m?.name === 'string' ? m.name : null) || (typeof m?.additional_kwargs?.name === 'string' ? m.additional_kwargs.name : null) || "";
            return typeof name === 'string' ? name : "";
        };
        const getMsgRole = (m) => { const t = m?.type || ""; if (t === "system" || (Array.isArray(m?.id) && m.id.includes("SystemMessage")) || (getMsgName(m) || "").endsWith("__prompt")) return "system"; return m?.role || m?.kwargs?.role || (t === "human" || (Array.isArray(m?.id) && m.id.includes("HumanMessage")) ? "user" : getMsgName(m) ? "assistant" : t === "ai" ? "assistant" : "user"); };
        const getMsgContent = (m) => m?.content || m?.kwargs?.content || "";
        if (messageIndex < 0 || messageIndex >= msgs.length) return reply.code(400).send({ error: "Invalid message index" });

        const toLangChainMessage = (role, content, name, timestamp) => {
            const fields = { content, name, additional_kwargs: {} };
            if (timestamp) fields.additional_kwargs.timestamp = timestamp;
            if (role === "user") return new HumanMessage(fields);
            if (role === "system") return new SystemMessage(fields);
            return new AIMessage(fields);
        };

        const truncatedMsgs = msgs.slice(0, messageIndex + 1).map((m, idx) => {
            const kwargs = m.kwargs || {};
            if (idx === messageIndex && newContent !== undefined) {
                return toLangChainMessage(getMsgRole(m), newContent, getMsgName(m), kwargs.timestamp || m.timestamp);
            }
            return toLangChainMessage(getMsgRole(m), getMsgContent(m), getMsgName(m), kwargs.timestamp || m.timestamp);
        });

        const rewindRole = getMsgRole(msgs[messageIndex]);
        const rewindName = getMsgName(msgs[messageIndex]);

        console.error(`[REWIND-DEBUG] rewindMsg.type=${msgs[messageIndex].type} role=${rewindRole} name=${rewindName}`);

        const dbw = getCheckpointDB(true);

        // Preserve creation time before deleting checkpoints
        let original_created_at = null;
        try {
            const titleRow = dbw.prepare("SELECT created_at FROM thread_titles WHERE thread_id = ?").get(threadId);
            original_created_at = titleRow?.created_at;
        } catch {}
        
        if (!original_created_at) {
            const firstRow = dbw.prepare("SELECT checkpoint FROM checkpoints WHERE thread_id = ? AND checkpoint_ns = '' ORDER BY checkpoint_id ASC LIMIT 1").get(threadId);
            if (firstRow) {
                const firstCp = JSON.parse(firstRow.checkpoint);
                if (firstCp.ts) original_created_at = Math.floor(new Date(firstCp.ts).getTime() / 1000);
            }
        }

        dbw.prepare("DELETE FROM checkpoints WHERE thread_id = ?").run(threadId);
        dbw.prepare("DELETE FROM writes WHERE thread_id = ?").run(threadId);

        // Clean up all descendant (child/grandchild) threads
        const descendantThreads = getDescendantThreads(threadId);
        if (descendantThreads.length > 0) {
            console.error(`[REWIND] Cleaning up ${descendantThreads.length} descendant thread(s): ${descendantThreads.join(", ")}`);
            ensureThreadLinksTable(dbw);
            for (const childId of descendantThreads) {
                dbw.prepare("DELETE FROM checkpoints WHERE thread_id = ?").run(childId);
                dbw.prepare("DELETE FROM writes WHERE thread_id = ?").run(childId);
                dbw.prepare("DELETE FROM thread_links WHERE child_thread_id = ?").run(childId);
                try { dbw.prepare("DELETE FROM thread_titles WHERE thread_id = ?").run(childId); } catch {}
                try { dbw.prepare("DELETE FROM message_ratings WHERE thread_id = ?").run(childId); } catch {}
                activeThreads.delete(childId);
                delete activeThreadAgents[childId];
                if (threadAbortControllers[childId]) {
                    threadAbortControllers[childId].abort();
                    delete threadAbortControllers[childId];
                }
            }
        }

        // Store creation time safely
        if (original_created_at) {
            try { dbw.exec("CREATE TABLE IF NOT EXISTS thread_titles (thread_id TEXT PRIMARY KEY, title TEXT NOT NULL)"); } catch {}
            try { dbw.exec("ALTER TABLE thread_titles ADD COLUMN created_at INTEGER"); } catch {}
            const existing = dbw.prepare("SELECT * FROM thread_titles WHERE thread_id = ?").get(threadId);
            if (existing) {
                dbw.prepare("UPDATE thread_titles SET created_at = ? WHERE thread_id = ?").run(original_created_at, threadId);
            } else {
                dbw.prepare("INSERT INTO thread_titles (thread_id, title, created_at) VALUES (?, '', ?)").run(threadId, original_created_at);
            }
        }

        dbw.close();

        // Clean up Langfuse traces created after the rewind point + all descendant thread traces
        if (process.env.LANGFUSE_SECRET_KEY) {
            try {
                const rewindMsg = msgs[messageIndex];
                const rewindTimestamp = rewindMsg?.kwargs?.timestamp || rewindMsg?.timestamp || rewindMsg?.additional_kwargs?.timestamp;
                const authHeader = "Basic " + Buffer.from(`${process.env.LANGFUSE_PUBLIC_KEY}:${process.env.LANGFUSE_SECRET_KEY}`).toString("base64");
                const baseUrl = process.env.LANGFUSE_BASE_URL || process.env.LANGFUSE_HOST;

                // Delete traces after rewind point in the target thread's session
                const traceRes = await fetch(`${baseUrl}/api/public/traces?sessionId=${encodeURIComponent(threadId)}&limit=100`, { headers: { Authorization: authHeader } });
                const traceData = await traceRes.json();
                const traces = traceData.data || [];
                const cutoff = rewindTimestamp ? new Date(rewindTimestamp).getTime() : 0;
                const toDelete = cutoff
                    ? traces.filter(t => new Date(t.timestamp).getTime() > cutoff)
                    : [];
                if (toDelete.length > 0) {
                    console.error(`[LANGFUSE] Rewind: deleting ${toDelete.length} trace(s) after rewind point (keeping ${traces.length - toDelete.length})`);
                    await Promise.all(toDelete.map(t =>
                        fetch(`${baseUrl}/api/public/traces/${t.id}`, { method: "DELETE", headers: { Authorization: authHeader } }).catch(() => {})
                    ));
                }

                // Delete ALL traces from descendant threads (they may use rootThreadId as sessionId)
                if (descendantThreads.length > 0) {
                    const rootId = getRootThread(threadId);
                    // Descendants share the root session — fetch all traces for the root session and delete those created by descendant threads
                    if (rootId !== threadId) {
                        const rootTraceRes = await fetch(`${baseUrl}/api/public/traces?sessionId=${encodeURIComponent(rootId)}&limit=200`, { headers: { Authorization: authHeader } });
                        const rootTraceData = await rootTraceRes.json();
                        const rootTraces = rootTraceData.data || [];
                        const descendantSet = new Set(descendantThreads);
                        const descendantTraces = rootTraces.filter(t => t.metadata?.thread_id && descendantSet.has(t.metadata.thread_id));
                        if (descendantTraces.length > 0) {
                            console.error(`[LANGFUSE] Rewind: deleting ${descendantTraces.length} trace(s) from ${descendantThreads.length} descendant thread(s)`);
                            await Promise.all(descendantTraces.map(t =>
                                fetch(`${baseUrl}/api/public/traces/${t.id}`, { method: "DELETE", headers: { Authorization: authHeader } }).catch(() => {})
                            ));
                        }
                    }
                }
            } catch (e) { console.error("[LANGFUSE] Rewind trace cleanup error:", e.message); }
        }

        // Also clean up saved ratings for messages beyond the rewind point
        try {
            const rdb = getCheckpointDB(true);
            try { rdb.prepare("DELETE FROM message_ratings WHERE thread_id = ? AND message_index > ?").run(threadId, messageIndex); } catch {}
            rdb.close();
        } catch {}

        const rewindDirective = getMsgContent(truncatedMsgs[0]) || "Rewind";
        const rewindPreview = rewindDirective.length > 80 ? rewindDirective.slice(0, 80) + "…" : rewindDirective;
        const cfg = { configurable: { thread_id: threadId, root_thread_id: threadId }, recursionLimit: 100 };
        if (process.env.LANGFUSE_SECRET_KEY || process.env.LANGFUSE_PUBLIC_KEY) {
            console.error(`[LANGFUSE] Creating CallbackHandler for rewind thread ${threadId}`);
            cfg.callbacks = [new CallbackHandler({
                sessionId: threadId,
                userId: "user",
                publicKey: process.env.LANGFUSE_PUBLIC_KEY,
                secretKey: process.env.LANGFUSE_SECRET_KEY,
                baseUrl: process.env.LANGFUSE_BASE_URL || process.env.LANGFUSE_HOST
            })];
        }

        const requestId = `chatcmpl-${uuidv4()}`;
        const job = { events: [], done: false, error: null, listeners: new Set() };
        workflowJobs[threadId] = job;
        activeThreads.add(threadId);
        const newAbortController = new AbortController();
        threadAbortControllers[threadId] = newAbortController;

        let lastTokenTime = Date.now();
        const activeAgentSet = new Set(), agentStats = {};
        const syncActiveAgent = () => { activeThreadAgents[threadId] = { agents: [...activeAgentSet] }; };

        const emit = (d) => { 
            lastTokenTime = Date.now();
            job.events.push(d); 
            for (const fn of job.listeners) { try { fn(d); } catch {} } 
        };
        const emitChunk = (text, agent) => emit({ id: requestId, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: "ai-it-org", choices: [{ index: 0, delta: { content: text, agent }, finish_reason: null }] });

        const rewindChainThreadIds = new Set([threadId]);
        const isRewindChainThread = (id) => rewindChainThreadIds.has(id);
        const onResearchEvent = (data) => { if (isRewindChainThread(data.threadId)) { console.error(`[SSE TOOL] ${data.agent} ${data.type} ${data.status} ${data.query || data.url || ""}`); emit({ id: requestId, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: "ai-it-org", choices: [{ index: 0, delta: { agent: data.agent, tool_activity: data }, finish_reason: null }] }); } };
        const onResearchPrompt = (data) => { if (isRewindChainThread(data.threadId)) { activeAgentSet.add(data.agent); syncActiveAgent(); emit({ id: requestId, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: "ai-it-org", choices: [{ index: 0, delta: { content: "", system_prompt: data.prompt, agent: data.agent }, finish_reason: null }] }); } };
        const onResearchChunk = (data) => { if (isRewindChainThread(data.threadId)) emitChunk(data.content, data.agent); };
        const onResearchStop = (data) => {
            if (isRewindChainThread(data.threadId)) {
                emit({ id: requestId, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: "ai-it-org", choices: [{ index: 0, delta: { content: "", agent: data.agent }, finish_reason: "stop" }] });
                activeAgentSet.delete(data.agent);
                syncActiveAgent();
            }
        };
        researchEvents.on("tool", onResearchEvent);
        researchEvents.on("prompt", onResearchPrompt);
        researchEvents.on("chunk", onResearchChunk);
        researchEvents.on("stop", onResearchStop);

        const staleGuard = setInterval(() => { 
            if (Date.now() - lastTokenTime > 600000) { 
                console.error(`[STALE] Aborting rewound thread ${threadId}`);
                newAbortController.abort(); 
                clearInterval(staleGuard); 
            } 
        }, 10000);

        // Reuse the same stream processing pattern as the main handler, with spawn support
        async function rewindStreamLoop(currentThreadId, initialMessages, streamConfig) {
            console.error(`[REWIND] Starting workflow for thread ${currentThreadId} passing ${initialMessages.length} messages`);
            const eventStream = await app.streamEvents(
                { messages: initialMessages },
                { ...streamConfig, version: "v2", signal: newAbortController.signal }
            );
            const agentContentBuffers = {};
            const agentRoundCounters = {};
            const researchPromptSent = new Set();
            let lastAgentName = null, lastAgentContent = null;

            for await (const event of eventStream) {
                const eventType = event.event, nodeName = event.metadata?.langgraph_node;

                if (!nodeName || nodeName === "__start__" || nodeName === "project_manager") continue;
                if (event.tags?.includes("hide_stream") || event.metadata?.tags?.includes("hide_stream")) continue;
                const validAgents = getActiveAgents();

                const actualNodeName = event.metadata?.langgraph_node || "";
                const isPromptNode = actualNodeName.endsWith("_prompt") && validAgents.includes(actualNodeName.replace(/_prompt$/, ""));

                if (isPromptNode) continue;

                const isResearchNode = actualNodeName.endsWith("_research") && validAgents.includes(actualNodeName.replace(/_research$/, ""));
                const resolvedAgentName = isResearchNode ? actualNodeName : actualNodeName;

                if (eventType === "on_chain_start" && (validAgents.includes(actualNodeName) || isResearchNode)) {
                    activeAgentSet.add(resolvedAgentName);
                    syncActiveAgent();
                    emitChunk("", resolvedAgentName);
                }
                if (eventType === "on_chat_model_start" && (validAgents.includes(actualNodeName) || isResearchNode)) {
                    lastTokenTime = Date.now();
                    const inputMsgs = event.data.input?.messages || [];
                    let prompt = "Processing...";
                    if (inputMsgs.length > 0) { const fm = Array.isArray(inputMsgs[0]) ? inputMsgs[0][0] : inputMsgs[0]; prompt = fm.kwargs?.content || fm.content || prompt; }
                    agentStats[actualNodeName] = { startTime: Date.now(), tokenCount: 0, promptChars: prompt.length };

                    if (!researchPromptSent.has(actualNodeName)) {
                        researchPromptSent.add(actualNodeName);
                        emit({ id: requestId, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: "ai-it-org", choices: [{ index: 0, delta: { content: "", system_prompt: prompt, agent: resolvedAgentName }, finish_reason: null }] });
                    }
                }
                if (eventType === "on_chat_model_stream") {
                    const targetAgent = actualNodeName;
                    if (targetAgent && (validAgents.includes(targetAgent) || isResearchNode)) {
                        lastTokenTime = Date.now();
                        let rawContent = event.data.chunk.content;
                        if (Array.isArray(rawContent)) rawContent = rawContent.map(c => typeof c === 'string' ? c : (c.text || "")).join("");
                        if (!rawContent) continue;
                        if (agentStats[targetAgent]) agentStats[targetAgent].tokenCount++;
                        if (!agentContentBuffers[targetAgent]) agentContentBuffers[targetAgent] = "";
                        agentContentBuffers[targetAgent] += rawContent;
                        emitChunk(rawContent, targetAgent);
                    }
                }
                if (eventType === "on_chain_end" && (validAgents.includes(actualNodeName) || isResearchNode)) {
                    const agentName = resolvedAgentName;
                    const stats = agentStats[agentName];
                    if (stats) { const el = ((Date.now() - stats.startTime) / 1000).toFixed(1); process.stderr.write(`[STATS] ${agentName} done: ${stats.tokenCount} tokens in ${el}s (${(stats.tokenCount / (parseFloat(el) || 1)).toFixed(1)} t/s)\n`); delete agentStats[agentName]; }
                    if (agentContentBuffers[agentName]) {
                        const statusMatch = agentContentBuffers[agentName].match(/STATUS:\s*(\w+)/);
                        if (statusMatch) {
                            const status = statusMatch[1];
                            if (agentName === "quality_engineer") {
                                const scoreMap = { TESTS_PASSED: 1, TESTING_COMPLETE: 1, REJECTED: 0, QUESTION: 0.5, TESTING_AMBIGUOUS: 0.5, TESTING_CLEAR: 0.75 };
                                const scoreValue = scoreMap[status] ?? 0.5;
                                try {
                                    const lfHandler = streamConfig.callbacks?.find(c => c instanceof CallbackHandler);
                                    const traceId = lfHandler?.traceId;
                                    const lf = new Langfuse({ publicKey: process.env.LANGFUSE_PUBLIC_KEY, secretKey: process.env.LANGFUSE_SECRET_KEY, baseUrl: process.env.LANGFUSE_BASE_URL || process.env.LANGFUSE_HOST });
                                    lf.score({ traceId, name: "qe_approval", value: scoreValue, comment: `STATUS: ${status}`, metadata: { agent: "quality_engineer", status } });
                                    await lf.flushAsync();
                                } catch (e) { console.error("[LANGFUSE] QE score error:", e.message); }
                            }
                            // Track clarification rounds for all agents
                            const questionStatuses = getPipeline().question_statuses || [];
                            if (questionStatuses.includes(status)) {
                                agentRoundCounters[agentName] = (agentRoundCounters[agentName] || 0) + 1;
                                console.error(`[LANGFUSE] ${agentName} clarification round ${agentRoundCounters[agentName]} for thread ${currentThreadId}`);
                            } else if (status.endsWith("_CLEAR") || status.endsWith("_DRAFTED") || status.endsWith("_APPROVED")) {
                                const rounds = agentRoundCounters[agentName] || 0;
                                try {
                                    const lfHandler = streamConfig.callbacks?.find(c => c instanceof CallbackHandler);
                                    const traceId = lfHandler?.traceId;
                                    const lf = new Langfuse({ publicKey: process.env.LANGFUSE_PUBLIC_KEY, secretKey: process.env.LANGFUSE_SECRET_KEY, baseUrl: process.env.LANGFUSE_BASE_URL || process.env.LANGFUSE_HOST });
                                    lf.score({ traceId, name: "clarification_rounds", value: rounds, comment: rounds === 0 ? "No clarification needed" : `${rounds} round(s) before ${status}`, metadata: { agent: agentName, finalStatus: status } });
                                    await lf.flushAsync();
                                    console.error(`[LANGFUSE] ${agentName} clarification_rounds: ${rounds} for thread ${currentThreadId}`);
                                } catch (e) { console.error("[LANGFUSE] clarification score error:", e.message); }
                            }
                        }
                        lastAgentName = agentName;
                        lastAgentContent = agentContentBuffers[agentName];
                    }
                    delete agentContentBuffers[agentName];
                    emit({ id: requestId, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: "ai-it-org", choices: [{ index: 0, delta: { content: "", agent: agentName }, finish_reason: "stop" }] });
                    activeAgentSet.delete(agentName);
                    syncActiveAgent();
                    if (threadPauseRequested[currentThreadId] && activeAgentSet.size === 0) {
                        newAbortController.abort();
                    }
                }
            }

            // Check for spawn milestone
            if (lastAgentContent) {
                const lastStatus = extractStatusFromContent(lastAgentContent);
                if (lastStatus && THREAD_SPAWN_MILESTONES.includes(lastStatus) && lastAgentName) {
                    return { spawn: true, status: lastStatus, agent: lastAgentName, content: lastAgentContent, threadId: currentThreadId };
                }
            }
            return { spawn: false, threadId: currentThreadId };
        }

        (async () => {
            let currentThreadId = threadId;
            const rootThreadId = getRootThread(threadId);
            try {
                let result = await rewindStreamLoop(currentThreadId, truncatedMsgs, cfg);

                // Spawn loop — same as main handler
                while (result.spawn) {
                    const newThreadId = crypto.randomUUID().substring(0, 12);
                    console.error(`[SPAWN] Milestone ${result.status} from ${result.agent} in thread ${result.threadId} → spawning new thread ${newThreadId}`);

                    const seedMessages = [
                        new HumanMessage({ content: rewindDirective, additional_kwargs: { timestamp: Date.now() } }),
                        new AIMessage({ content: result.content, name: result.agent, additional_kwargs: { timestamp: Date.now() } })
                    ];

                    linkThreads(result.threadId, newThreadId, result.status, result.agent);

                    emit({ id: requestId, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: "ai-it-org",
                        choices: [{ index: 0, delta: { thread_transition: { from: result.threadId, to: newThreadId, milestone: result.status, agent: result.agent } }, finish_reason: null }] });

                    const prevLfHandler = cfg.callbacks?.find(c => c instanceof CallbackHandler);
                    if (prevLfHandler) { try { await prevLfHandler.flushAsync(); } catch {} }

                    const newCfg = { configurable: { thread_id: newThreadId, root_thread_id: rootThreadId }, recursionLimit: 100 };
                    if (process.env.LANGFUSE_SECRET_KEY || process.env.LANGFUSE_PUBLIC_KEY) {
                        newCfg.callbacks = [new CallbackHandler({
                            sessionId: rootThreadId,
                            userId: "user",
                            publicKey: process.env.LANGFUSE_PUBLIC_KEY,
                            secretKey: process.env.LANGFUSE_SECRET_KEY,
                            baseUrl: process.env.LANGFUSE_BASE_URL || process.env.LANGFUSE_HOST
                        })];
                    }

                    currentThreadId = newThreadId;
                    activeThreads.add(currentThreadId);
                    rewindChainThreadIds.add(currentThreadId);
                    threadAbortControllers[currentThreadId] = newAbortController;

                    result = await rewindStreamLoop(currentThreadId, seedMessages, newCfg);
                }

                emit({ id: requestId, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
                emit("[DONE]");
            } catch (error) {
                if (!(error.name === "AbortError" || error.message === "Abort" || error.message === "The operation was aborted")) {
                    console.error("Stream Error:", error); job.error = error.message;
                }
                // Emit stop signals for any agents still active so UI clears spinners
                for (const agent of activeAgentSet) {
                    emit({ id: requestId, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: "ai-it-org", choices: [{ index: 0, delta: { content: "", agent }, finish_reason: "stop" }] });
                }
                emit({ id: requestId, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
                emit("[DONE]");
            } finally {
                researchEvents.off("tool", onResearchEvent);
                researchEvents.off("prompt", onResearchPrompt);
                researchEvents.off("chunk", onResearchChunk);
                researchEvents.off("stop", onResearchStop);
                const lfHandler = cfg.callbacks?.find(c => c instanceof CallbackHandler);
                if (lfHandler) {
                    try {
                        await lfHandler.flushAsync();
                        const traceId = lfHandler.traceId;
                        if (traceId) {
                            const lf = new Langfuse({ publicKey: process.env.LANGFUSE_PUBLIC_KEY, secretKey: process.env.LANGFUSE_SECRET_KEY, baseUrl: process.env.LANGFUSE_BASE_URL || process.env.LANGFUSE_HOST });
                            lf.trace({
                                id: traceId,
                                name: rewindPreview,
                                sessionId: threadId,
                                input: rewindDirective,
                                output: job.error ? { error: job.error } : { status: "completed" },
                                tags: ["ai-it", "rewind"],
                                metadata: { thread_id: threadId, rewind_from: rewindName, directive: rewindDirective }
                            });
                            await lf.flushAsync();
                        }
                    } catch (e) { console.error("[LANGFUSE] Flush error:", e.message); }
                }
                job.done = true; activeThreads.delete(threadId); activeThreads.delete(currentThreadId); delete activeThreadAgents[threadId]; delete threadAbortControllers[threadId]; delete threadPauseRequested[threadId]; clearInterval(staleGuard);
                setTimeout(() => { delete workflowJobs[threadId]; }, 300000);
            }
        })();

        return { message: "Rewound to message " + messageIndex + " and re-invoked" };
    } catch (e) {
        console.error("[ADMIN] Rewind error:", e);
        return reply.code(500).send({ error: e.message });
    }
});

// ── MCP Tools (Streamable HTTP) ───────────────────────────────────────────────
// Each session gets its own McpServer + transport pair
const mcpSessions = {};

async function createMcpSession() {
    const mcpServer = new McpServer({ name: "ai-it-tools", version: "1.0.0" });
    registerTools(mcpServer);
    const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        onsessioninitialized: (sid) => { mcpSessions[sid] = transport; },
    });
    transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid) delete mcpSessions[sid];
    };
    await mcpServer.connect(transport);
    return transport;
}

server.post("/mcp", async (request, reply) => {
    const sid = request.headers["mcp-session-id"];
    let transport = sid ? mcpSessions[sid] : null;
    if (!transport) {
        transport = await createMcpSession();
    }
    reply.hijack();
    await transport.handleRequest(request.raw, reply.raw, request.body);
});

server.get("/mcp", async (request, reply) => {
    const sid = request.headers["mcp-session-id"];
    const transport = mcpSessions[sid];
    if (!transport) return reply.code(400).send({ error: "No active MCP session. Send a POST to /mcp first." });
    reply.hijack();
    await transport.handleRequest(request.raw, reply.raw);
});

server.delete("/mcp", async (request, reply) => {
    const sid = request.headers["mcp-session-id"];
    const transport = mcpSessions[sid];
    if (!transport) return reply.code(400).send({ error: "No active MCP session." });
    reply.hijack();
    await transport.handleRequest(request.raw, reply.raw);
    delete mcpSessions[sid];
});

// ── Lifecycle ────────────────────────────────────────────────────────────────
function abortAllActive(reason) {
    for (const [tid, controller] of Object.entries(threadAbortControllers)) {
        console.error(`[LIFECYCLE] Aborting thread ${tid}: ${reason}`);
        controller.abort();
    }
    activeThreads.clear();
}

function getVllmUrl() {
    try { return getConfig().engines?.["lm-studio"]?.url || "http://localhost:1234/v1"; }
    catch { return "http://127.0.0.1:8081/v1"; }
}

let healthInterval = null;

async function checkVllmHealth() {
    try {
        const resp = await fetch(getVllmUrl() + "/models", { signal: AbortSignal.timeout(10000) });
        return resp.ok;
    } catch { return false; }
}

async function restartVllm() {
    console.error("[HEALTH] vllm-mlx unresponsive — force restarting");
    try {
        execSync("lsof -ti:8081 | xargs kill -9 2>/dev/null || true");
        await new Promise(r => setTimeout(r, 3000));
    } catch (e) { console.error("[HEALTH] Failed:", e.message); }
}

function startHealthMonitor() {
    // Don't health-check while inference is running — vllm-mlx can't respond to
    // /v1/models during serial mode inference. Only check when idle with stale threads.
    healthInterval = setInterval(async () => {
        if (activeThreads.size === 0) return;
        // Skip if tokens were received recently (inference is active)
        // The stale guard handles truly stuck requests
    }, 30000);
}

// ── SPA fallback ─────────────────────────────────────────────────────────────
server.setNotFoundHandler((request, reply) => {
    if (request.method === "GET" && request.headers.accept?.includes("text/html")) {
        return reply.sendFile("index.html");
    }
    reply.code(404).send({ error: "Not found" });
});

// ── Start ────────────────────────────────────────────────────────────────────
const PORT = 3000;
try {
    await server.listen({ port: PORT, host: "0.0.0.0" });
    console.log(`\n🚀 AI-IT API running at http://localhost:${PORT}`);
    initConfig().then(() => console.log("[LIFECYCLE] Engine discovery complete")).catch(e => console.error("[LIFECYCLE] Engine discovery failed:", e.message));
    const healthy = await checkVllmHealth();
    console.log(healthy ? "[LIFECYCLE] vllm-mlx is responsive" : "[LIFECYCLE] vllm-mlx not reachable on startup");
    startHealthMonitor();
} catch (err) {
    console.error("Failed to start:", err);
    process.exit(1);
}

for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(sig, () => {
        console.error(`\n[LIFECYCLE] Received ${sig}, aborting ${activeThreads.size} active thread(s)`);
        abortAllActive(sig);
        if (healthInterval) clearInterval(healthInterval);
        server.close().then(() => process.exit(0));
        setTimeout(() => process.exit(1), 5000);
    });
}
