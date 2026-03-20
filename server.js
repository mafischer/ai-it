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

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const server = Fastify({ logger: false });
await server.register(fastifyCors);
await server.register(fastifyStatic, { root: path.join(__dirname, "app"), prefix: "/" });

const activeThreads = new Set();
const threadAbortControllers = {};
const activeThreadAgents = {};

const agentEmoji = { ...getAgentEmojis(), complete: "✅" };
const agentMissions = { ...getAgentMissions(), complete: "All tasks have been successfully completed." };

function formatPMDecision(decision, reasoning, directive) {
    const emoji = agentEmoji[decision] || "🤖";
    const name = decision.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
    const mission = agentMissions[decision] || "Continue project workflow.";
    return `\n\n---\n\n> ${emoji} **${name}** — *${mission}*\n\n`;
}

function getAgentActiveHeader(agentId, prompt) {
    const emoji = agentEmoji[agentId] || "🤖";
    const name = agentId.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
    return `\n\n---\n\n#### ${emoji} ${name} Prompt\n\n> ${prompt.replace(/\n/g, "\n> ")}\n\n#### ${emoji} ${name} Response\n\n`;
}

function cleanIncomingHistory(messages) {
    return messages.map(msg => ({
        ...msg,
        content: (msg.content || "").replace(/<think>[\s\S]*?<\/think>/g, "").replace(/<\/?think>/g, "").trim()
    }));
}

function getCheckpointDB(writable = false) {
    const dbPath = "./checkpoints.db";
    if (!writable && !existsSync(dbPath)) return null;
    return new Database(dbPath, { readonly: !writable });
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

    // SSE streaming
    reply.raw.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no" });
    reply.raw.socket?.setNoDelay(true);

    const abortController = new AbortController();
    let clientDisconnected = false;
    activeThreads.add(threadId);
    threadAbortControllers[threadId] = abortController;

    // Listen on the socket for actual client disconnect, not req/res close events
    const socket = reply.raw.socket;
    const onDisconnect = () => {
        if (clientDisconnected) return;
        clientDisconnected = true;
        activeThreads.delete(threadId);
        abortController.abort();
        console.error("[STREAM] Client disconnected, aborting workflow");
    };
    socket.on("close", onDisconnect);

    const heartbeat = setInterval(() => {
        if (!clientDisconnected) reply.raw.write(": keep-alive\n\n");
    }, 15000);

    let lastTokenTime = Date.now();
    const staleGuard = setInterval(() => {
        if (Date.now() - lastTokenTime > 600000) {
            console.error("[STREAM] Stale request detected (no tokens for 90s), aborting");
            abortController.abort();
            clearInterval(staleGuard);
        }
    }, 10000);

    try {
        console.error(`[STREAM] Starting streamEvents for thread ${threadId}`);
        const eventStream = await app.streamEvents(
            { messages: [{ role: "user", content: lastUserMessage }] },
            { ...config, version: "v2", signal: abortController.signal }
        );

        const agentQueue = [];
        const agentBuffers = {};
        const agentDone = {};
        const agentHeaders = {};
        let activeAgent = null;
        const syncActiveAgent = () => { activeThreadAgents[threadId] = { current: activeAgent, queue: [...agentQueue] }; };
        const agentStats = {};

        const writeChunk = (content) => {
            const chunk = {
                id: requestId, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: model || "ai-it-org",
                choices: [{ index: 0, delta: { content }, finish_reason: null }],
            };
            reply.raw.write(`data: ${JSON.stringify(chunk)}\n\n`);
        };

        for await (const event of eventStream) {
            if (clientDisconnected) break;
            const eventType = event.event;
            const nodeName = event.metadata?.langgraph_node;

            if (!nodeName || nodeName === "__start__") continue;

            if (nodeName === "project_manager" && eventType === "on_chain_end") {
                const output = event.data.output;
                if (Array.isArray(output) && output[0] && output[0] !== "__end__") {
                    writeChunk(formatPMDecision(output[0], "", originalDirective));
                }
                continue;
            }
            if (nodeName === "project_manager") continue;

            const validAgents = getActiveAgents();

            if (eventType === "on_chain_start" && validAgents.includes(event.name)) {
                const agentName = event.name;
                if (!agentQueue.includes(agentName)) {
                    agentQueue.push(agentName);
                    agentBuffers[agentName] = "";
                    agentDone[agentName] = false;
                    agentHeaders[agentName] = { prompt: null, headerSent: false };
                    if (!activeAgent) activeAgent = agentName;
                    syncActiveAgent();
                }
            }

            if (eventType === "on_chat_model_start" && validAgents.includes(nodeName)) {
                const inputMsgs = event.data.input?.messages || [];
                let prompt = "Processing...";
                if (inputMsgs.length > 0) {
                    const firstMsg = Array.isArray(inputMsgs[0]) ? inputMsgs[0][0] : inputMsgs[0];
                    prompt = firstMsg.kwargs?.content || firstMsg.content || prompt;
                }
                agentHeaders[nodeName] = agentHeaders[nodeName] || { prompt: null, headerSent: false };
                agentHeaders[nodeName].prompt = prompt.trim();
                agentStats[nodeName] = { startTime: Date.now(), tokenCount: 0, promptChars: prompt.length };
                process.stderr.write(`[STATS] ${nodeName} prompt: ${prompt.length.toLocaleString()} chars\n`);

                if (activeAgent === nodeName && !agentHeaders[nodeName].headerSent) {
                    writeChunk(getAgentActiveHeader(nodeName, agentHeaders[nodeName].prompt));
                    agentHeaders[nodeName].headerSent = true;
                } else if (activeAgent !== nodeName) {
                    agentBuffers[nodeName] = getAgentActiveHeader(nodeName, agentHeaders[nodeName].prompt) + (agentBuffers[nodeName] || "");
                    agentHeaders[nodeName].headerSent = true;
                }
            }

            if (eventType === "on_chat_model_stream" && validAgents.includes(nodeName)) {
                lastTokenTime = Date.now();
                const rawContent = event.data.chunk.content;
                if (!rawContent) continue;
                if (agentStats[nodeName]) agentStats[nodeName].tokenCount++;
                if (activeAgent === nodeName) {
                    writeChunk(rawContent);
                } else {
                    agentBuffers[nodeName] = (agentBuffers[nodeName] || "") + rawContent;
                }
            }

            if (eventType === "on_chain_end" && validAgents.includes(event.name)) {
                const agentName = event.name;
                agentDone[agentName] = true;
                const stats = agentStats[agentName];
                if (stats) {
                    const elapsed = ((Date.now() - stats.startTime) / 1000).toFixed(1);
                    const tps = (stats.tokenCount / (parseFloat(elapsed) || 1)).toFixed(1);
                    process.stderr.write(`[STATS] ${agentName} done: ${stats.tokenCount} tokens in ${elapsed}s (${tps} t/s)\n`);
                    delete agentStats[agentName];
                }
                if (activeAgent === agentName) {
                    agentQueue.shift();
                    while (agentQueue.length > 0) {
                        const nextAgent = agentQueue[0];
                        activeAgent = nextAgent;
                        const bufferedContent = agentBuffers[nextAgent];
                        if (bufferedContent) {
                            writeChunk(bufferedContent);
                            agentBuffers[nextAgent] = "";
                        } else if (agentHeaders[nextAgent]?.prompt && !agentHeaders[nextAgent].headerSent) {
                            writeChunk(getAgentActiveHeader(nextAgent, agentHeaders[nextAgent].prompt));
                            agentHeaders[nextAgent].headerSent = true;
                        }
                        if (agentDone[nextAgent]) { agentQueue.shift(); } else { break; }
                    }
                    if (agentQueue.length === 0) activeAgent = null;
                    syncActiveAgent();
                }
            }
        }

        if (!clientDisconnected) {
            reply.raw.write(`data: ${JSON.stringify({ id: requestId, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
            reply.raw.write("data: [DONE]\n\n");
        }
    } catch (error) {
        if (clientDisconnected || error.name === "AbortError") {
            console.error("[STREAM] Aborted");
        } else {
            console.error("Stream Error:", error);
            if (!clientDisconnected) {
                const errorMsg = `\n\n> **[ERROR]: ${error.message}**\n\n`;
                reply.raw.write(`data: ${JSON.stringify({ id: requestId, object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: errorMsg }, finish_reason: "stop" }] })}\n\n`);
                reply.raw.write("data: [DONE]\n\n");
            }
        }
    } finally {
        activeThreads.delete(threadId);
        delete activeThreadAgents[threadId];
        delete threadAbortControllers[threadId];
        clearInterval(heartbeat);
        clearInterval(staleGuard);
        if (!clientDisconnected) reply.raw.end();
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
    const result = threads.map(t => {
        try {
            const cp = JSON.parse(db.prepare("SELECT checkpoint FROM checkpoints WHERE thread_id = ? AND checkpoint_id = ? AND checkpoint_ns = ''").get(t.thread_id, t.checkpoint_id).checkpoint);
            const msgs = cp.channel_values?.messages || [];
            const firstMsg = msgs[0]?.kwargs?.content || "(empty)";
            const directive = firstMsg.slice(0, 120);
            const agentNames = [...new Set(msgs.filter(m => m.kwargs?.name).map(m => m.kwargs.name))];
            return { thread_id: t.thread_id, directive, msgCount: msgs.length, agents: agentNames };
        } catch { return null; }
    }).filter(t => t && !t.directive.startsWith("### Task:") && !t.directive.startsWith("(empty)"));
    db.close();
    return result;
});

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
            return { role, name: kwargs.name || "", content: kwargs.content || "" };
        });
    } catch { return []; }
});

server.get("/api/active", async () => {
    return [...activeThreads].map(tid => ({
        thread_id: tid,
        agent: activeThreadAgents[tid]?.current || null,
        queue: activeThreadAgents[tid]?.queue || [],
    }));
});

server.delete("/api/threads", async () => {
    const db = getCheckpointDB(true);
    if (db && dbHasTable(db)) { db.exec("DELETE FROM checkpoints"); db.exec("DELETE FROM writes"); }
    db?.close();
    return { message: "All conversations deleted" };
});

server.delete("/api/threads/:threadId", async (request) => {
    const db = getCheckpointDB(true);
    if (db && dbHasTable(db)) {
        db.prepare("DELETE FROM checkpoints WHERE thread_id = ?").run(request.params.threadId);
        db.prepare("DELETE FROM writes WHERE thread_id = ?").run(request.params.threadId);
    }
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
    const { messageIndex } = request.body;
    try {
        const db = getCheckpointDB();
        const row = db.prepare("SELECT checkpoint FROM checkpoints WHERE thread_id = ? AND checkpoint_ns = '' ORDER BY checkpoint_id DESC LIMIT 1").get(threadId);
        db.close();
        if (!row) return reply.code(404).send({ error: "Thread not found" });
        const data = JSON.parse(row.checkpoint);
        const msgs = data.channel_values?.messages || [];
        if (messageIndex < 0 || messageIndex >= msgs.length) return reply.code(400).send({ error: "Invalid message index" });
        const truncatedMsgs = msgs.slice(0, messageIndex).map(m => {
            const kwargs = m.kwargs || {};
            return { role: kwargs.role || (kwargs.name ? "assistant" : m.type === "human" ? "user" : "assistant"), name: kwargs.name || undefined, content: kwargs.content || "" };
        });
        const rewindMsg = msgs[messageIndex];
        const rewindKwargs = rewindMsg.kwargs || {};
        const rewindContent = rewindKwargs.content || "";
        const rewindRole = rewindKwargs.role || (rewindKwargs.name ? "assistant" : rewindMsg.type === "human" ? "user" : "assistant");
        const dbw = getCheckpointDB(true);
        dbw.prepare("DELETE FROM checkpoints WHERE thread_id = ?").run(threadId);
        dbw.prepare("DELETE FROM writes WHERE thread_id = ?").run(threadId);
        dbw.close();
        const cfg = { configurable: { thread_id: threadId }, recursionLimit: 100 };
        if (truncatedMsgs.length > 0) await app.updateState(cfg, { messages: truncatedMsgs });
        await app.invoke({ messages: [{ role: rewindRole, content: rewindContent }] }, cfg);
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
    try { return getConfig().engines?.["vllm-local"]?.url || "http://127.0.0.1:8081/v1"; }
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
    healthInterval = setInterval(async () => {
        if (activeThreads.size === 0) return;
        if (!(await checkVllmHealth())) {
            console.error("[HEALTH] vllm-mlx failed health check with", activeThreads.size, "active thread(s)");
            await restartVllm();
        }
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
