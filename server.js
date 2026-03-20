import express from "express";
import cors from "cors";
import { app, routerLLM as utilityLLM } from "./index.js";
import { v4 as uuidv4 } from "uuid";
import crypto from "crypto";
import Database from "better-sqlite3";

const server = express();
server.use(cors());
server.use(express.json());

const activeThreads = new Set();
const threadAbortControllers = {};

const agentEmoji = {
    business_analyst: "📋",
    software_architect: "🏗️",
    backend_software_engineer: "⚙️",
    frontend_software_engineer: "🖥️",
    ux_designer: "🎨",
    quality_engineer: "🔍",
    site_reliability_engineer: "📈",
    devops_engineer: "🚀",
    support_engineer: "🛠️",
    complete: "✅"
};

const agentMissions = {
    business_analyst: "Extract technical requirements from the USER directive.",
    software_architect: "Create technical design based on BA requirements.",
    backend_software_engineer: "Implement backend code based on Architect's design.",
    frontend_software_engineer: "Implement frontend code based on UX Designer's design.",
    ux_designer: "Design User Interface and Experience based on requirements.",
    quality_engineer: "Test and validate implementations.",
    site_reliability_engineer: "Review implementation for reliability and scalability.",
    devops_engineer: "Create CI/CD pipeline and deployment infrastructure.",
    support_engineer: "Provide support feedback and customer concerns.",
    complete: "All tasks have been successfully completed."
};

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

server.get("/v1/models", (req, res) => {
  res.json({
    object: "list",
    data: [{ id: "ai-it-org", object: "model", created: Math.floor(Date.now() / 1000), owned_by: "ai-it" }],
  });
});

server.post("/v1/chat/completions", async (req, res) => {
  const { messages: rawMessages, stream = false, model, user } = req.body;
  
  if (!rawMessages || rawMessages.length === 0) {
      return res.status(400).json({ error: "No messages provided." });
  }

  const cleanedMessages = cleanIncomingHistory(rawMessages);
  const requestId = `chatcmpl-${uuidv4()}`;

  // Utility requests from Open WebUI (title generation, follow-up suggestions, etc.)
  // always start with a system message. Bypass the agent pipeline and proxy to lfm2-8b.
  if (cleanedMessages[0]?.role === "system") {
      console.error(`[UTILITY] Proxying to lfm2-8b (${cleanedMessages.length} msgs)`);
      try {
          if (!stream) {
              const response = await utilityLLM.invoke(cleanedMessages);
              return res.json({
                  id: requestId, object: "chat.completion", created: Math.floor(Date.now() / 1000), model: model || "ai-it-org",
                  choices: [{ index: 0, message: { role: "assistant", content: response.content }, finish_reason: "stop" }],
              });
          }
          res.setHeader("Content-Type", "text/event-stream");
          res.setHeader("Cache-Control", "no-cache");
          res.setHeader("Connection", "keep-alive");
          res.setHeader("X-Accel-Buffering", "no");
          res.flushHeaders();
          const writeChunk = (content) => res.write(`data: ${JSON.stringify({ id: requestId, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: model || "ai-it-org", choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n`);
          for await (const chunk of await utilityLLM.stream(cleanedMessages)) {
              if (chunk.content) writeChunk(chunk.content);
          }
          res.write(`data: ${JSON.stringify({ id: requestId, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
          res.write("data: [DONE]\n\n");
      } catch (error) {
          console.error("[UTILITY] Error:", error.message);
          if (!res.headersSent) res.status(500).json({ error: error.message });
      }
      return res.end();
  }

  const lastUserMessage = cleanedMessages[cleanedMessages.length - 1].content;
  const originalDirective = cleanedMessages[0].content || "Unknown Directive";
  const firstMsg = originalDirective;
  const threadId = crypto.createHash('md5').update(firstMsg).digest('hex').substring(0, 12);

  const config = { configurable: { thread_id: threadId }, recursionLimit: 100 };

  // Only seed state for brand-new threads. For existing threads, the checkpointer
  // already has the correct state — don't overwrite it with Open WebUI's rendered
  // conversation which contains formatting artifacts.
  const existingState = await app.getState(config);
  if (!existingState?.values?.messages?.length) {
      // New thread — seed with the original directive so the graph has context
      const priorMessages = cleanedMessages.slice(0, -1);
      if (priorMessages.length > 0) {
          await app.updateState(config, { messages: priorMessages });
      }
  }

  if (!stream) {
    try {
      const result = await app.invoke({ messages: [{ role: "user", content: lastUserMessage }] }, config);
      const lastMsg = result.messages[result.messages.length - 1];
      res.json({
        id: requestId, object: "chat.completion", created: Math.floor(Date.now() / 1000), model: model || "ai-it-org",
        choices: [{ index: 0, message: { role: "assistant", content: lastMsg.content }, finish_reason: "stop" }],
      });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
    return;
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();
  res.socket?.setNoDelay(true);

  const abortController = new AbortController();
  let clientDisconnected = false;
  activeThreads.add(threadId);
  threadAbortControllers[threadId] = abortController;

  req.on("close", () => {
    clientDisconnected = true;
    activeThreads.delete(threadId);
    abortController.abort();
    console.error("[STREAM] Client disconnected, aborting workflow");
  });

  const heartbeat = setInterval(() => {
    res.write(": keep-alive\n\n");
  }, 15000);

  // Stale request guard — abort if no tokens arrive within 90s
  let lastTokenTime = Date.now();
  const staleGuard = setInterval(() => {
      if (Date.now() - lastTokenTime > 90000) {
          console.error("[STREAM] Stale request detected (no tokens for 90s), aborting");
          abortController.abort();
          clearInterval(staleGuard);
      }
  }, 10000);

  try {
    const eventStream = await app.streamEvents(
      { messages: [{ role: "user", content: lastUserMessage }] },
      { ...config, version: "v2", signal: abortController.signal }
    );

    // --- MULTIPLEXER STATE ---
    const agentQueue = [];
    const agentBuffers = {};
    const agentDone = {};
    const agentHeaders = {}; // { agentName: { prompt, headerSent } }
    let activeAgent = null;
    const syncActiveAgent = () => { activeThreadAgents[threadId] = { current: activeAgent, queue: [...agentQueue] }; };

    // --- STATS ---
    const agentStats = {}; // { agentName: { startTime, tokenCount, promptChars } };

    const writeChunk = (content) => {
        const chunk = {
            id: requestId, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: model || "ai-it-org",
            choices: [{ index: 0, delta: { content }, finish_reason: null }],
        };
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    };

    for await (const event of eventStream) {
      if (clientDisconnected) break;
      const eventType = event.event;
      const nodeName = event.metadata?.langgraph_node;

      if (process.env.DEBUG === "true") {
          if (eventType === "on_chat_model_stream") {
              const chunk = event.data?.chunk;
              process.stderr.write(`[DEBUG] stream node=${nodeName} content=${JSON.stringify(chunk?.content)} reasoning=${JSON.stringify(chunk?.additional_kwargs?.reasoning_content)} additional_kwargs=${JSON.stringify(chunk?.additional_kwargs)} chunk_keys=${JSON.stringify(Object.keys(chunk || {}))}\n`);
          } else if (eventType !== "on_chat_model_stream") {
              process.stderr.write(`[DEBUG] event=${eventType} node=${nodeName} name=${event.name}\n`);
          }
      }

      if (!nodeName || nodeName === "__start__") continue;

      // --- PROJECT MANAGER STREAMING (Fallback Router) ---
      if (nodeName === "project_manager" && eventType === "on_chain_end") {
          const output = event.data.output;
          // output is an array of next nodes from routeFromStart/fallbackRouter, 
          // or from the routerLLM fallback
          // Since we changed to status-driven routing, the fallback returns an array
          if (Array.isArray(output) && output[0] && output[0] !== "__end__") {
              // Create a faux pmText to show orchestration update
              const pmText = formatPMDecision(output[0], "Routing based on agent status or fallback logic.", originalDirective);
              
              // We want to stream this immediately, but we might have a multiplexer active.
              // To keep it simple, we'll write it directly.
              writeChunk(pmText);
          }
          continue;
      }
      
      if (nodeName === "project_manager") continue; // Skip other PM events

      // --- SPECIALIST STREAMING ---
      const validAgents = ["business_analyst", "software_architect", "backend_software_engineer", "frontend_software_engineer", "ux_designer", "quality_engineer", "support_engineer", "site_reliability_engineer", "devops_engineer"];
      // 1. NODE START
      if (eventType === "on_chain_start" && validAgents.includes(event.name)) {
          const agentName = event.name; 

          if (!agentQueue.includes(agentName)) {
              agentQueue.push(agentName);
              agentBuffers[agentName] = "";
              agentDone[agentName] = false;
              agentHeaders[agentName] = { prompt: null, headerSent: false };

              if (!activeAgent) {
                  activeAgent = agentName;
              }
              syncActiveAgent();
          }
      }

      // 1.5 CHAT MODEL START (To grab the system prompt)
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

          // If this is the active agent and we haven't sent the header yet, send it now
          if (activeAgent === nodeName && !agentHeaders[nodeName].headerSent) {
               writeChunk(getAgentActiveHeader(nodeName, agentHeaders[nodeName].prompt));
               agentHeaders[nodeName].headerSent = true;
          } else if (activeAgent !== nodeName) {
               // Buffer the header so it's the first thing dumped when this agent takes the foreground
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

                  if (agentDone[nextAgent]) {
                      agentQueue.shift();
                  } else {
                      break;
                  }
              }

              if (agentQueue.length === 0) {
                  activeAgent = null;
              }
              syncActiveAgent();
          }
      }
    }

    if (!clientDisconnected) {
      res.write(`data: ${JSON.stringify({ id: requestId, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
      res.write("data: [DONE]\n\n");
    }
  } catch (error) {
    if (clientDisconnected || error.name === "AbortError") {
      console.error("[STREAM] Aborted");
    } else {
      console.error("Stream Error:", error);
      if (!clientDisconnected) {
        const errorMsg = `\n\n> **[ERROR]: ${error.message}**\n\n`;
        res.write(`data: ${JSON.stringify({ id: requestId, object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: errorMsg }, finish_reason: "stop" }] })}\n\n`);
        res.write("data: [DONE]\n\n");
      }
    }
  } finally {
    activeThreads.delete(threadId);
    delete activeThreadAgents[threadId];
    delete threadAbortControllers[threadId];
    clearInterval(heartbeat);
    clearInterval(staleGuard);
    if (!clientDisconnected) res.end();
  }
});

// ── Admin UI ─────────────────────────────────────────────────────────────────
function getCheckpointDB(writable = false) {
    return new Database("./checkpoints.db", { readonly: !writable });
}

// Serve Vue.js admin SPA
import { fileURLToPath } from "url";
import path from "path";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const adminDir = path.join(__dirname, "admin");
server.get("/admin", (req, res) => res.sendFile(path.join(adminDir, "index.html")));
server.use("/admin", express.static(adminDir));


// ── Admin API endpoints ──────────────────────────────────────────────────────
const activeThreadAgents = {}; // { threadId: { current: "business_analyst", queue: [...] } }

server.get("/admin/api/threads", (req, res) => {
    const db = getCheckpointDB();
    const threads = db.prepare(`
        SELECT c.thread_id, c.checkpoint_id
        FROM checkpoints c
        INNER JOIN (
            SELECT thread_id, MAX(checkpoint_id) as max_cp
            FROM checkpoints WHERE checkpoint_ns = ''
            GROUP BY thread_id
        ) latest ON c.thread_id = latest.thread_id AND c.checkpoint_id = latest.max_cp
        WHERE c.checkpoint_ns = ''
        ORDER BY c.checkpoint_id DESC
    `).all();

    const result = threads.map(t => {
        try {
            const cp = JSON.parse(db.prepare(
                "SELECT checkpoint FROM checkpoints WHERE thread_id = ? AND checkpoint_id = ? AND checkpoint_ns = ''"
            ).get(t.thread_id, t.checkpoint_id).checkpoint);
            const msgs = cp.channel_values?.messages || [];
            const firstMsg = msgs[0]?.kwargs?.content || "(empty)";
            const directive = firstMsg.slice(0, 120);
            const agentNames = [...new Set(msgs.filter(m => m.kwargs?.name).map(m => m.kwargs.name))];
            return { thread_id: t.thread_id, directive, msgCount: msgs.length, agents: agentNames };
        } catch { return null; }
    }).filter(t => t && !t.directive.startsWith("### Task:") && !t.directive.startsWith("(empty)"));
    db.close();
    res.json(result);
});

server.get("/admin/api/threads/:threadId/messages", (req, res) => {
    const db = getCheckpointDB();
    const row = db.prepare(
        "SELECT checkpoint FROM checkpoints WHERE thread_id = ? AND checkpoint_ns = '' ORDER BY checkpoint_id DESC LIMIT 1"
    ).get(req.params.threadId);
    db.close();
    if (!row) return res.status(404).json([]);
    try {
        const data = JSON.parse(row.checkpoint);
        const msgs = (data.channel_values?.messages || []).map(m => {
            const kwargs = m.kwargs || {};
            const type = m.type || "";
            const role = type === "human" ? "user"
                : kwargs.name ? "assistant"
                : kwargs.role === "user" || kwargs.role === "human" ? "user"
                : type === "ai" ? "assistant" : "user";
            return { role, name: kwargs.name || "", content: kwargs.content || "" };
        });
        res.json(msgs);
    } catch { res.json([]); }
});

server.get("/admin/api/active", (req, res) => {
    res.json([...activeThreads].map(tid => ({
        thread_id: tid,
        agent: activeThreadAgents[tid]?.current || null,
        queue: activeThreadAgents[tid]?.queue || [],
    })));
});

server.delete("/admin/api/threads", (req, res) => {
    const db = getCheckpointDB(true);
    db.exec("DELETE FROM checkpoints");
    db.exec("DELETE FROM writes");
    db.close();
    res.json({ message: "All conversations deleted" });
});

server.delete("/admin/api/threads/:threadId", (req, res) => {
    const db = getCheckpointDB(true);
    db.prepare("DELETE FROM checkpoints WHERE thread_id = ?").run(req.params.threadId);
    db.prepare("DELETE FROM writes WHERE thread_id = ?").run(req.params.threadId);
    db.close();
    res.json({ message: "Conversation deleted" });
});

server.post("/admin/api/threads/:threadId/abort", (req, res) => {
    const { threadId } = req.params;
    const controller = threadAbortControllers[threadId];
    if (controller) {
        controller.abort();
        res.json({ message: "Workflow aborted" });
    } else {
        res.status(404).json({ error: "No active workflow for this thread" });
    }
});

server.post("/admin/api/threads/:threadId/rewind", async (req, res) => {
    const { threadId } = req.params;
    const { messageIndex } = req.body;

    try {
        // Get latest checkpoint
        const db = getCheckpointDB();
        const row = db.prepare(
            "SELECT checkpoint FROM checkpoints WHERE thread_id = ? AND checkpoint_ns = '' ORDER BY checkpoint_id DESC LIMIT 1"
        ).get(threadId);
        db.close();

        if (!row) return res.status(404).json({ error: "Thread not found" });

        const data = JSON.parse(row.checkpoint);
        const msgs = data.channel_values?.messages || [];

        if (messageIndex < 0 || messageIndex >= msgs.length) {
            return res.status(400).json({ error: "Invalid message index" });
        }

        // Truncate messages to the rewind point
        const truncatedMsgs = msgs.slice(0, messageIndex).map(m => {
            const kwargs = m.kwargs || {};
            return {
                role: kwargs.role || (kwargs.name ? "assistant" : m.type === "human" ? "user" : "assistant"),
                name: kwargs.name || undefined,
                content: kwargs.content || "",
            };
        });

        // The message at the rewind point becomes the new input
        const rewindMsg = msgs[messageIndex];
        const rewindKwargs = rewindMsg.kwargs || {};
        const rewindContent = rewindKwargs.content || "";
        const rewindRole = rewindKwargs.role || (rewindKwargs.name ? "assistant" : rewindMsg.type === "human" ? "user" : "assistant");

        // Delete checkpoints after this point by deleting the whole thread and re-setting state
        const dbw = getCheckpointDB(true);
        dbw.prepare("DELETE FROM checkpoints WHERE thread_id = ?").run(threadId);
        dbw.prepare("DELETE FROM writes WHERE thread_id = ?").run(threadId);
        dbw.close();

        // Re-initialize state with truncated messages
        const config = { configurable: { thread_id: threadId }, recursionLimit: 100 };
        if (truncatedMsgs.length > 0) {
            await app.updateState(config, { messages: truncatedMsgs });
        }

        // Re-invoke with the rewind message
        const inputContent = rewindRole === "user" || rewindRole === "human"
            ? rewindContent
            : rewindContent.slice(0, 200); // For assistant messages, use as context

        await app.invoke(
            { messages: [{ role: rewindRole, content: rewindContent }] },
            config
        );

        res.json({ message: "Rewound to message " + messageIndex + " and re-invoked" });
    } catch (e) {
        console.error("[ADMIN] Rewind error:", e);
        res.status(500).json({ error: e.message });
    }
});

// ── Lifecycle: abort all active threads ──────────────────────────────────────
function abortAllActive(reason) {
    for (const [tid, controller] of Object.entries(threadAbortControllers)) {
        console.error(`[LIFECYCLE] Aborting thread ${tid}: ${reason}`);
        controller.abort();
    }
    activeThreads.clear();
}

// On startup: fire a dummy request to vllm-mlx to flush any stale connections
// from a previous server instance that died without cleaning up.
async function flushStaleConnections() {
    try {
        const resp = await fetch("http://127.0.0.1:8081/v1/models", { signal: AbortSignal.timeout(3000) });
        if (resp.ok) console.log("[LIFECYCLE] vllm-mlx is responsive, no stale connections detected");
    } catch {
        console.error("[LIFECYCLE] vllm-mlx not reachable on startup — stale connections may exist");
    }
}

const PORT = 3000;
const serverInstance = server.listen(PORT, () => {
  console.log(`\n🚀 AI-IT OpenAI-Compatible API running at http://localhost:${PORT}`);
  console.log(`🔗 OpenAI Base URL for Open WebUI: http://localhost:${PORT}/v1`);
  if (process.env.DEBUG === "true") {
      console.log(`\x1b[35m🔧 DEBUG MODE ACTIVE: All inference responses will be logged.\x1b[0m`);
  }
  flushStaleConnections();
});

// On shutdown: abort all in-flight workflows so vllm-mlx connections close cleanly
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(sig, () => {
        console.error(`\n[LIFECYCLE] Received ${sig}, aborting ${activeThreads.size} active thread(s)`);
        abortAllActive(sig);
        serverInstance.close(() => process.exit(0));
        // Force exit if graceful close takes too long
        setTimeout(() => process.exit(1), 5000);
    });
}

serverInstance.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
        console.error(`\n❌ ERROR: Port ${PORT} is already in use.`);
        console.error(`Please stop the process using port ${PORT} or change the port in server.js`);
        process.exit(1);
    } else {
        console.error(`\n❌ SERVER ERROR:`, error);
        process.exit(1);
    }
});
