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
    const agentStats = {}; // { agentName: { startTime, tokenCount, promptChars } }

    // Stale request guard — abort if no tokens arrive within 90s
    let lastTokenTime = Date.now();
    const staleGuard = setInterval(() => {
        if (Date.now() - lastTokenTime > 90000) {
            console.error("[STREAM] Stale request detected (no tokens for 90s), aborting");
            abortController.abort();
            clearInterval(staleGuard);
        }
    }, 10000);

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

server.get("/admin", (req, res) => {
    res.type("html").send(`<!DOCTYPE html>
<html><head><title>AI-IT Admin</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0d1117; color: #c9d1d9; padding: 2rem; }
  h1 { color: #58a6ff; margin-bottom: 1.5rem; }
  .thread { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 1rem 1.25rem; margin-bottom: 0.75rem; cursor: pointer; transition: border-color 0.2s; }
  .thread:hover { border-color: #58a6ff; }
  .thread-id { font-family: monospace; color: #8b949e; font-size: 0.85rem; }
  .directive { margin: 0.4rem 0; font-size: 1rem; }
  .meta { color: #8b949e; font-size: 0.85rem; }
  .agent-tag { display: inline-block; background: #1f6feb22; color: #58a6ff; padding: 0.1rem 0.5rem; border-radius: 4px; font-size: 0.75rem; margin-right: 0.3rem; }
  .thread-row { display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.75rem; }
  .thread-row .thread { margin-bottom: 0; }
  .btn { border: none; border-radius: 6px; padding: 0.5rem 1rem; cursor: pointer; font-size: 0.85rem; }
  .btn-danger { background: #da3633; color: #fff; margin-bottom: 1rem; }
  .btn-danger:hover { background: #f85149; }
  .btn-sm-danger { background: #da363344; color: #f85149; border: 1px solid #da363366; border-radius: 6px; padding: 0.5rem 0.75rem; cursor: pointer; font-size: 1rem; }
  .btn-sm-danger:hover { background: #da3633; color: #fff; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .spinner { display: inline-block; width: 14px; height: 14px; border: 2px solid #58a6ff44; border-top-color: #58a6ff; border-radius: 50%; animation: spin 0.8s linear infinite; margin-left: 0.5rem; vertical-align: middle; }
</style></head><body>
<script>
function esc(s){return(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}
async function pollList(){
  try{
    const[threadsRes,activeRes]=await Promise.all([fetch('/admin/api/threads'),fetch('/admin/api/active')]);
    const threads=await threadsRes.json();
    const activeIds=(await activeRes.json()).map(i=>i.thread_id);
    const container=document.getElementById('thread-list');
    container.innerHTML=threads.map(t=>{
      const spin=activeIds.includes(t.thread_id)?'<span class="spinner"></span>':'';
      return '<div class="thread-row" data-thread="'+t.thread_id+'">'
        +'<a href="/admin/thread/'+t.thread_id+'" style="text-decoration:none;color:inherit;flex:1">'
        +'<div class="thread"><div class="thread-id">'+t.thread_id+spin+'</div>'
        +'<div class="directive">'+esc(t.directive)+'</div>'
        +'<div class="meta">'+t.msgCount+' messages &middot; '+t.agents.map(a=>'<span class="agent-tag">'+esc(a)+'</span>').join('')+'</div>'
        +'</div></a>'
        +'<button class="btn btn-sm-danger" onclick="event.stopPropagation();if(confirm(&quot;Delete this conversation?&quot;)){fetch(&quot;/admin/api/threads/'+t.thread_id+'&quot;,{method:&quot;DELETE&quot;}).then(()=>pollList())}">🗑</button>'
        +'</div>';
    }).join('')||'<p style="color:#8b949e">No conversations yet.</p>';
  }catch{}
}
pollList();setInterval(pollList,3000);
</script>
<h1>🧠 AI-IT Conversations</h1>
<button class="btn btn-danger" onclick="if(confirm('Delete ALL conversations?')){fetch('/admin/api/threads',{method:'DELETE'}).then(()=>pollList())}">🗑 Delete All</button>
<div id="thread-list"></div>
</body></html>`);
});

server.get("/admin/thread/:threadId", (req, res) => {
    const { threadId } = req.params;
    const db = getCheckpointDB();

    const checkpoints = db.prepare(`
        SELECT checkpoint_id, checkpoint FROM checkpoints
        WHERE thread_id = ? AND checkpoint_ns = ''
        ORDER BY checkpoint_id DESC
    `).all(threadId);

    if (!checkpoints.length) {
        db.close();
        return res.status(404).send("Thread not found");
    }

    // Collect all unique messages across all checkpoints (deduplicated by content hash)
    const seenIds = new Set();
    const allMessages = [];
    for (const cp of checkpoints) {
        try {
            const data = JSON.parse(cp.checkpoint);
            const msgs = data.channel_values?.messages || [];
            for (const m of msgs) {
                const id = m.id || m.kwargs?.id || JSON.stringify(m.kwargs?.content || "").slice(0, 80);
                if (!seenIds.has(id)) {
                    seenIds.add(id);
                    const kwargs = m.kwargs || {};
                    allMessages.push({
                        id,
                        type: m.type || kwargs.type || "unknown",
                        role: kwargs.role || (kwargs.name ? "assistant" : m.type === "human" ? "user" : "assistant"),
                        name: kwargs.name || "",
                        content: kwargs.content || "",
                        checkpoint_id: cp.checkpoint_id,
                    });
                }
            }
        } catch {}
    }
    db.close();

    // Show latest checkpoint state (messages in order)
    const latestData = JSON.parse(checkpoints[0].checkpoint);
    const latestMsgs = (latestData.channel_values?.messages || []).map(m => {
        const kwargs = m.kwargs || {};
        const type = m.type || "";
        const role = type === "human" ? "user"
            : kwargs.name ? "assistant"
            : kwargs.role === "user" || kwargs.role === "human" ? "user"
            : type === "ai" ? "assistant"
            : kwargs.content?.startsWith("---\n") ? "system" // orchestration headers (stale data)
            : "user";
        return { type, role, name: kwargs.name || "", content: kwargs.content || "" };
    });

    function esc(s) { return (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

    const msgsHtml = latestMsgs.map((m, i) => {
        const statusMatches = [...(m.content || "").matchAll(/STATUS:\s*([A-Z_]+)/g)];
        const status = statusMatches.length ? statusMatches[statusMatches.length - 1][1] : "";
        const statusClass = status.includes("COMPLETE") || status.includes("PASSED") || status.includes("APPROVED") ? "complete" : status.includes("AMBIGUOUS") ? "ambiguous" : "";
        const e = agentEmoji[m.name] || (m.role === "user" ? "👤" : "🤖");
        const statusTag = status ? '<span class="status-tag ' + statusClass + '">' + status + '</span>' : "";
        const rewindBtn = '<button class="btn-rewind rewind-btn" onclick="if(confirm(\'Rewind to this point and re-run?\')){fetch(\'/admin/api/threads/' + threadId + '/rewind\',{method:\'POST\',headers:{\'Content-Type\':\'application/json\'},body:JSON.stringify({messageIndex:' + i + '})}).then(r=>r.json()).then(d=>{alert(d.message||d.error);location.reload()})}">⏪ Rewind</button>';
        return '<div class="msg ' + m.role + '">' +
            '<div class="msg-header"><span class="msg-role ' + m.role + '">' + e + " " + esc(m.name || m.role) + '</span><span>' + statusTag + rewindBtn + '</span></div>' +
            '<div class="msg-content">' + esc(m.content) + '</div></div>';
    }).join("");

    res.type("html").send('<!DOCTYPE html><html><head><title>Thread ' + threadId + '</title>' +
'<style>' +
'* { margin: 0; padding: 0; box-sizing: border-box; }' +
'body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #0d1117; color: #c9d1d9; padding: 2rem; max-width: 960px; margin: 0 auto; }' +
'h1 { color: #58a6ff; margin-bottom: 0.5rem; }' +
'.back { color: #58a6ff; text-decoration: none; display: inline-block; margin-bottom: 1.5rem; }' +
'.back:hover { text-decoration: underline; }' +
'.meta-bar { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 1rem; margin-bottom: 1.5rem; font-size: 0.85rem; color: #8b949e; }' +
'.msg { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 1rem 1.25rem; margin-bottom: 0.75rem; }' +
'.msg.user { border-left: 3px solid #3fb950; }' +
'.msg.assistant { border-left: 3px solid #58a6ff; }' +
'.msg-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.5rem; }' +
'.msg-role { font-weight: 600; font-size: 0.9rem; }' +
'.msg-role.user { color: #3fb950; }' +
'.msg-role.assistant { color: #58a6ff; }' +
'.msg-content { white-space: pre-wrap; font-size: 0.9rem; line-height: 1.5; max-height: 400px; overflow-y: auto; }' +
'.status-tag { display: inline-block; background: #da3633; color: #fff; padding: 0.1rem 0.5rem; border-radius: 4px; font-size: 0.75rem; font-family: monospace; }' +
'.status-tag.complete { background: #3fb950; }' +
'.status-tag.ambiguous { background: #d29922; }' +
'.btn-rewind { background: #1f6feb33; color: #58a6ff; border: 1px solid #1f6feb66; border-radius: 4px; padding: 0.2rem 0.6rem; cursor: pointer; font-size: 0.75rem; margin-left: 0.5rem; }' +
'.btn-rewind:hover { background: #1f6feb; color: #fff; }' +
'.btn-abort { display: none; background: #da3633; color: #fff; border: none; border-radius: 6px; padding: 0.5rem 1rem; cursor: pointer; font-size: 0.85rem; margin-left: 1rem; }' +
'.btn-abort:hover { background: #f85149; }' +
'.btn-abort.visible { display: inline-block; }' +
'@keyframes spin { to { transform: rotate(360deg); } }' +
'.spinner { display: inline-block; width: 16px; height: 16px; border: 2px solid #58a6ff44; border-top-color: #58a6ff; border-radius: 50%; animation: spin 0.8s linear infinite; margin-left: 0.5rem; vertical-align: middle; }' +
'@keyframes shimmer { 0% { background-position: -200% 0; } 100% { background-position: 200% 0; } }' +
'.skeleton { background: #161b22; border: 1px solid #30363d; border-radius: 8px; border-left: 3px solid #58a6ff; padding: 1rem 1.25rem; margin-bottom: 0.75rem; display: none; }' +
'.skeleton.active { display: block; }' +
'.skeleton-line { height: 0.75rem; border-radius: 4px; margin-bottom: 0.5rem; background: linear-gradient(90deg, #21262d 25%, #30363d 50%, #21262d 75%); background-size: 200% 100%; animation: shimmer 1.5s ease-in-out infinite; }' +
'.skeleton-line:nth-child(1) { width: 30%; height: 0.85rem; margin-bottom: 0.75rem; }' +
'.skeleton-line:nth-child(2) { width: 90%; }' +
'.skeleton-line:nth-child(3) { width: 75%; }' +
'.skeleton-line:nth-child(4) { width: 60%; }' +
'</style></head><body>' +
'<script>const emojis=' + JSON.stringify(agentEmoji) + ';' +
'async function pollActive(){try{const r=await fetch("/admin/api/active");const items=await r.json();' +
'const entry=items.find(i=>i.thread_id==="' + threadId + '");const isActive=!!entry;' +
'const sp=document.getElementById("thread-spinner");if(isActive){if(!sp){const s=document.createElement("span");s.className="spinner";s.id="thread-spinner";document.getElementById("thread-title").appendChild(s)}}else{if(sp)sp.remove()}' +
'const sk=document.getElementById("skeleton-msg");const skTitle=document.getElementById("skeleton-title");' +
'if(isActive){sk.classList.add("active");const ag=entry.agent;if(ag&&skTitle){const name=ag.replace(/_/g," ").replace(/\\b\\w/g,c=>c.toUpperCase());skTitle.textContent=(emojis[ag]||"🤖")+" "+name+"…"}}else{sk.classList.remove("active")}' +
'document.querySelectorAll(".rewind-btn").forEach(b=>{b.style.display=isActive?"none":""});' +
'document.getElementById("abort-btn").classList.toggle("visible",isActive);' +
'}catch{}}pollActive();setInterval(pollActive,2000)</script>' +
'<a class="back" href="/admin">&larr; All Conversations</a>' +
'<div style="display:flex;align-items:center;margin-bottom:0.5rem"><h1 id="thread-title" style="margin:0">Thread ' + threadId + '</h1>' +
'<button class="btn-abort" id="abort-btn" onclick="if(confirm(\'Abort active workflow?\')){fetch(\'/admin/api/threads/' + threadId + '/abort\',{method:\'POST\'}).then(r=>r.json()).then(d=>{alert(d.message||d.error);location.reload()})}">⏹ Abort</button></div>' +
'<div class="meta-bar">' + checkpoints.length + ' checkpoints &middot; ' + latestMsgs.length + ' messages in latest state</div>' +
msgsHtml +
'<div class="skeleton" id="skeleton-msg">' +
'<div id="skeleton-title" style="font-weight:600;font-size:0.9rem;color:#58a6ff;margin-bottom:0.6rem">⏳ Processing…</div>' +
'<div class="skeleton-line"></div>' +
'<div class="skeleton-line"></div>' +
'<div class="skeleton-line"></div>' +
'</div>' +
'</body></html>');
});

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
