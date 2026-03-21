import Fastify from "fastify";
import fastifyCors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import { app, routerLLM as utilityLLM, initConfig } from "./index.js";
import { v4 as uuidv4 } from "uuid";
import crypto from "crypto";
import Database from "better-sqlite3";
import { existsSync } from "fs";
import { execSync } from "child_process";
import { fileURLToPath } from "url";
import path from "path";
import { getAgentEmojis, getAgentMissions, getActiveAgents, getConfig } from "./src/config/loader.js";
import { HumanMessage, AIMessage, SystemMessage } from "@langchain/core/messages";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const server = Fastify({ logger: false });
await server.register(fastifyCors);
await server.register(fastifyStatic, { root: path.join(__dirname, "app"), prefix: "/" });

const activeThreads = new Set();
const threadAbortControllers = {};
const activeThreadAgents = {};

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
        try {
            if (!stream) {
                const response = await utilityLLM.invoke(cleanedMessages);
                return {
                    id: requestId, object: "chat.completion", created: Math.floor(Date.now() / 1000), model: model || "ai-it-org",
                    choices: [{ index: 0, message: { role: "assistant", content: response.content }, finish_reason: "stop" }],
                };
            }
            reply.hijack();
            reply.raw.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no" });
            const writeChunk = (content) => reply.raw.write(`data: ${JSON.stringify({ id: requestId, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: model || "ai-it-org", choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n`);
            for await (const chunk of await utilityLLM.stream(cleanedMessages)) {
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

    const config = { configurable: { thread_id: threadId }, recursionLimit: 100 };

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

        const emit = (data) => { job.events.push(data); for (const fn of job.listeners) { try { fn(data); } catch {} } };
        const emitChunk = (content, agent) => emit({ id: requestId, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: model || "ai-it-org", choices: [{ index: 0, delta: { content, ...(agent && { agent }) }, finish_reason: null }] });

        let lastTokenTime = Date.now();
        const staleGuard = setInterval(() => { if (Date.now() - lastTokenTime > 600000) { abortController.abort(); clearInterval(staleGuard); } }, 10000);

        (async () => {
            try {
                console.error(`[STREAM] Starting workflow for thread ${threadId}`);
                const eventStream = await app.streamEvents({ messages: [new HumanMessage({ content: lastUserMessage, timestamp: Date.now() })] }, { ...config, version: "v2", signal: abortController.signal });
                const agentQueue = [], agentBuffers = {}, agentDone = {}, agentHeaders = {}, agentStats = {};
                let activeAgent = null;
                const syncActiveAgent = () => { activeThreadAgents[threadId] = { current: activeAgent, queue: [...agentQueue] }; };

                for await (const event of eventStream) {
                    const eventType = event.event, nodeName = event.metadata?.langgraph_node;
                    if (!nodeName || nodeName === "__start__") continue;
                    if (nodeName === "project_manager" && eventType === "on_chain_end") {
                        const output = event.data.output;
                        // PM routing decisions are handled internally, not streamed
                        continue;
                    }
                    if (nodeName === "project_manager") continue;
                    const validAgents = getActiveAgents();
                    const isPromptNode = event.name?.endsWith("_prompt") && validAgents.includes(event.name.replace(/_prompt$/, ""));
                    const resolvedAgentName = isPromptNode ? event.name.replace(/_prompt$/, "") : event.name;
                    if (eventType === "on_chain_end" && isPromptNode) {
                        for (const pm of (event.data?.output?.messages || [])) {
                            const pc = pm.content || pm.kwargs?.content || "";
                            if (pc) emit({ id: requestId, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: model || "ai-it-org", choices: [{ index: 0, delta: { content: "", system_prompt: pc, agent: resolvedAgentName }, finish_reason: null }] });
                        }
                        continue;
                    }
                    if (eventType === "on_chain_start" && (validAgents.includes(event.name) || isPromptNode)) {
                        const agentName = resolvedAgentName;
                        if (!agentQueue.includes(agentName)) { agentQueue.push(agentName); agentBuffers[agentName] = ""; agentDone[agentName] = false; agentHeaders[agentName] = { prompt: null, headerSent: false }; if (!activeAgent) activeAgent = agentName; syncActiveAgent(); }
                    }
                    if (eventType === "on_chat_model_start" && validAgents.includes(nodeName)) {
                        const inputMsgs = event.data.input?.messages || [];
                        let prompt = "Processing...";
                        if (inputMsgs.length > 0) { const fm = Array.isArray(inputMsgs[0]) ? inputMsgs[0][0] : inputMsgs[0]; prompt = fm.kwargs?.content || fm.content || prompt; }
                        agentHeaders[nodeName] = agentHeaders[nodeName] || { prompt: null, headerSent: false };
                        agentHeaders[nodeName].prompt = prompt.trim();
                        agentStats[nodeName] = { startTime: Date.now(), tokenCount: 0, promptChars: prompt.length };
                        process.stderr.write(`[STATS] ${nodeName} prompt: ${prompt.length.toLocaleString()} chars\n`);
                        agentHeaders[nodeName].headerSent = true;
                    }
                    if (eventType === "on_chat_model_stream" && validAgents.includes(nodeName)) {
                        lastTokenTime = Date.now();
                        const rawContent = event.data.chunk.content;
                        if (!rawContent) continue;
                        if (agentStats[nodeName]) agentStats[nodeName].tokenCount++;
                        if (activeAgent === nodeName) emitChunk(rawContent, nodeName); else agentBuffers[nodeName] = (agentBuffers[nodeName] || "") + rawContent;
                    }
                    if (eventType === "on_chain_end" && validAgents.includes(event.name)) {
                        const agentName = event.name;
                        agentDone[agentName] = true;
                        const stats = agentStats[agentName];
                        if (stats) { const el = ((Date.now() - stats.startTime) / 1000).toFixed(1); process.stderr.write(`[STATS] ${agentName} done: ${stats.tokenCount} tokens in ${el}s (${(stats.tokenCount / (parseFloat(el) || 1)).toFixed(1)} t/s)\n`); delete agentStats[agentName]; }
                        if (activeAgent === agentName) {
                            emit({ id: requestId, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: "ai-it-org", choices: [{ index: 0, delta: { content: "", agent: agentName }, finish_reason: "stop" }] });
                            agentQueue.shift();
                            while (agentQueue.length > 0) {
                                const na = agentQueue[0];
                                activeAgent = na;
                                const bc = agentBuffers[na];
                                if (bc) { emitChunk(bc, na); agentBuffers[na] = ""; }
                                if (agentDone[na]) {
                                    emit({ id: requestId, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: "ai-it-org", choices: [{ index: 0, delta: { content: "", agent: na }, finish_reason: "stop" }] });
                                    agentQueue.shift();
                                } else break;
                            }
                            if (agentQueue.length === 0) activeAgent = null;
                            syncActiveAgent();
                        }
                    }
                }
                emit({ id: requestId, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
                emit("[DONE]");
            } catch (error) {
                if (!(error.name === "AbortError" || error.message === "Abort" || error.message === "The operation was aborted")) {
                    console.error("Stream Error:", error); job.error = error.message;
                } else { console.error("[STREAM] Aborted"); }
            } finally {
                job.done = true; activeThreads.delete(threadId); delete activeThreadAgents[threadId]; delete threadAbortControllers[threadId]; clearInterval(staleGuard);
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
            const firstMsg = msgs[0]?.kwargs?.content || "(empty)";
            const directive = firstMsg;
            const agentNames = [...new Set(msgs.filter(m => m.kwargs?.name).map(m => m.kwargs.name))];
            
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
    db.close();

    // Generate titles in background for threads that don't have one
    for (const t of result) {
        if (t.title === t.directive.slice(0, 80) && t.directive.length > 20) {
            generateTitle(t.thread_id, t.directive);
        }
    }

    return result;
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

server.get("/api/threads/:threadId/messages", async (request) => {
    const db = getCheckpointDB();
    if (!db || !dbHasTable(db)) { db?.close(); return []; }
    const row = db.prepare("SELECT checkpoint FROM checkpoints WHERE thread_id = ? AND checkpoint_ns = '' ORDER BY checkpoint_id DESC LIMIT 1").get(request.params.threadId);
    db.close();
    if (!row) return [];
    try {
        const data = JSON.parse(row.checkpoint);
        return (data.channel_values?.messages || []).map(m => {
            const kwargs = m.kwargs || {};
            const type = m.type || "";
            const role = type === "human" ? "user" : kwargs.name ? "assistant" : kwargs.role === "user" || kwargs.role === "human" ? "user" : type === "ai" ? "assistant" : "user";
            const name = kwargs.name || "";
            const isPrompt = name.endsWith("__prompt");
            const add = m.additional_kwargs || {};
            return {
                role: isPrompt ? "system" : role,
                name: isPrompt ? name.replace("__prompt", "") : name,
                content: kwargs.content || m.content || "",
                timestamp: kwargs.timestamp || add.timestamp || m.timestamp || null,
                ...(isPrompt && { type: "prompt" }),
            };
        });
        return msgs;
    } catch { return []; }
});

server.get("/api/active", async () => {
    return [...activeThreads].map(tid => ({
        thread_id: tid,
        agent: activeThreadAgents[tid]?.current || null,
        queue: activeThreadAgents[tid]?.queue || [],
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
        if (messageIndex < 0 || messageIndex >= msgs.length) return reply.code(400).send({ error: "Invalid message index" });
        
        const getMsgName = (m) => m?.name || m?.kwargs?.name || m?.additional_kwargs?.name || undefined;
        const getMsgRole = (m) => { const t = m?.type || ""; return m?.role || m?.kwargs?.role || (t === "human" ? "user" : getMsgName(m) ? "assistant" : t === "ai" ? "assistant" : "user"); };
        const getMsgContent = (m) => m?.content || m?.kwargs?.content || "";

        const toLangChainMessage = (role, content, name, timestamp) => {
            const fields = { content, name, additional_kwargs: {} };
            if (timestamp) fields.additional_kwargs.timestamp = timestamp;
            if (role === "user") return new HumanMessage(fields);
            if (role === "system") return new SystemMessage(fields);
            return new AIMessage(fields);
        };

        const truncatedMsgs = msgs.slice(0, messageIndex).map(m => {
            const kwargs = m.kwargs || {};
            return toLangChainMessage(getMsgRole(m), getMsgContent(m), getMsgName(m), kwargs.timestamp || m.timestamp);
        });

        const rewindMsg = msgs[messageIndex];
        const rewindRole = getMsgRole(rewindMsg);
        const rewindName = getMsgName(rewindMsg);
        const rewindContent = newContent !== undefined ? newContent : getMsgContent(rewindMsg);

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
        
        const cfg = { configurable: { thread_id: threadId }, recursionLimit: 100 };
        if (truncatedMsgs.length > 0) await app.updateState(cfg, { messages: truncatedMsgs });

        const requestId = `chatcmpl-${uuidv4()}`;
        const job = { events: [], done: false, error: null, listeners: new Set() };
        workflowJobs[threadId] = job;
        activeThreads.add(threadId);
        const newAbortController = new AbortController();
        threadAbortControllers[threadId] = newAbortController;

        const emit = (d) => { job.events.push(d); for (const fn of job.listeners) { try { fn(d); } catch {} } };
        const emitChunk = (content, agent) => emit({ id: requestId, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: "ai-it-org", choices: [{ index: 0, delta: { content, ...(agent && { agent }) }, finish_reason: null }] });

        let lastTokenTime = Date.now();
        const staleGuard = setInterval(() => { if (Date.now() - lastTokenTime > 600000) { newAbortController.abort(); clearInterval(staleGuard); } }, 10000);

        (async () => {
            try {
                const invokeMsg = toLangChainMessage(rewindRole, rewindContent, rewindName, Date.now());
                const eventStream = await app.streamEvents({ messages: [invokeMsg] }, { ...cfg, version: "v2", signal: newAbortController.signal });
                const agentQueue = [], agentBuffers = {}, agentDone = {}, agentHeaders = {}, agentStats = {};
                let activeAgent = null;
                const syncActiveAgent = () => { activeThreadAgents[threadId] = { current: activeAgent, queue: [...agentQueue] }; };

                for await (const event of eventStream) {
                    const eventType = event.event, nodeName = event.metadata?.langgraph_node;
                    if (!nodeName || nodeName === "__start__" || nodeName === "project_manager") continue;
                    const validAgents = getActiveAgents();
                    const isPromptNode = event.name?.endsWith("_prompt") && validAgents.includes(event.name.replace(/_prompt$/, ""));
                    const resolvedAgentName = isPromptNode ? event.name.replace(/_prompt$/, "") : event.name;
                    if (eventType === "on_chain_end" && isPromptNode) {
                        for (const pm of (event.data?.output?.messages || [])) {
                            const pc = pm.content || pm.kwargs?.content || "";
                            if (pc) emit({ id: requestId, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: "ai-it-org", choices: [{ index: 0, delta: { content: "", system_prompt: pc, agent: resolvedAgentName }, finish_reason: null }] });
                        }
                        continue;
                    }
                    if (eventType === "on_chain_start" && (validAgents.includes(event.name) || isPromptNode)) {
                        const agentName = resolvedAgentName;
                        if (!agentQueue.includes(agentName)) { agentQueue.push(agentName); agentBuffers[agentName] = ""; agentDone[agentName] = false; agentHeaders[agentName] = { prompt: null, headerSent: false }; if (!activeAgent) activeAgent = agentName; syncActiveAgent(); }
                    }
                    if (eventType === "on_chat_model_start" && validAgents.includes(nodeName)) {
                        const inputMsgs = event.data.input?.messages || [];
                        let prompt = "Processing...";
                        if (inputMsgs.length > 0) { const fm = Array.isArray(inputMsgs[0]) ? inputMsgs[0][0] : inputMsgs[0]; prompt = fm.kwargs?.content || fm.content || prompt; }
                        agentHeaders[nodeName] = agentHeaders[nodeName] || { prompt: null, headerSent: false };
                        agentHeaders[nodeName].prompt = prompt.trim();
                        agentStats[nodeName] = { startTime: Date.now(), tokenCount: 0, promptChars: prompt.length };
                        agentHeaders[nodeName].headerSent = true;
                    }
                    if (eventType === "on_chat_model_stream" && validAgents.includes(nodeName)) {
                        lastTokenTime = Date.now();
                        const rawContent = event.data.chunk.content;
                        if (!rawContent) continue;
                        if (agentStats[nodeName]) agentStats[nodeName].tokenCount++;
                        if (activeAgent === nodeName) emitChunk(rawContent, nodeName); else agentBuffers[nodeName] = (agentBuffers[nodeName] || "") + rawContent;
                    }
                    if (eventType === "on_chain_end" && validAgents.includes(event.name)) {
                        const agentName = event.name;
                        agentDone[agentName] = true;
                        if (agentStats[agentName]) delete agentStats[agentName];
                        if (activeAgent === agentName) {
                            emit({ id: requestId, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: "ai-it-org", choices: [{ index: 0, delta: { content: "", agent: agentName }, finish_reason: "stop" }] });
                            agentQueue.shift();
                            while (agentQueue.length > 0) {
                                const na = agentQueue[0];
                                activeAgent = na;
                                const bc = agentBuffers[na];
                                if (bc) { emitChunk(bc, na); agentBuffers[na] = ""; }
                                if (agentDone[na]) {
                                    emit({ id: requestId, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: "ai-it-org", choices: [{ index: 0, delta: { content: "", agent: na }, finish_reason: "stop" }] });
                                    agentQueue.shift();
                                } else break;
                            }
                            if (agentQueue.length === 0) activeAgent = null;
                            syncActiveAgent();
                        }
                    }
                }
                emit({ id: requestId, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
                emit("[DONE]");
            } catch (error) {
                if (!(error.name === "AbortError" || error.message === "Abort" || error.message === "The operation was aborted")) {
                    console.error("Stream Error:", error); job.error = error.message;
                }
            } finally {
                job.done = true; activeThreads.delete(threadId); delete activeThreadAgents[threadId]; delete threadAbortControllers[threadId]; clearInterval(staleGuard);
                setTimeout(() => { delete workflowJobs[threadId]; }, 300000);
            }
        })();

        return { message: "Rewound to message " + messageIndex + " and re-invoked" };
    } catch (e) {
        console.error("[ADMIN] Rewind error:", e);
        return reply.code(500).send({ error: e.message });
    }
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
