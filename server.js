import express from "express";
import cors from "cors";
import { app } from "./index.js";
import { v4 as uuidv4 } from "uuid";
import crypto from "crypto";

const server = express();
server.use(cors());
server.use(express.json());

function formatPMDecision(decision, reasoning, directive) {
    const agentEmoji = {
        business_analyst: "📋",
        software_architect: "🏗️",
        software_engineer: "💻",
        quality_engineer: "🔍",
        ux_engineer: "🎨",
        site_reliability_engineer: "📈",
        devops_engineer: "🚀",
        support_engineer: "🛠️",
        complete: "✅"
    };

    const emoji = agentEmoji[decision] || "🤖";
    const name = decision.replace("_", " ").toUpperCase();
    const cleanDirective = (directive || "Unknown Directive").replace(/["'`]/g, "").trim();

    return `
---
# ${emoji} Orchestration Update
- **Directive:** ${cleanDirective}
- **Next Specialist:** \`${name}\`
- **Strategy:** *${reasoning}*
---
`;
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
  const lastUserMessage = cleanedMessages[cleanedMessages.length - 1].content;
  const originalDirective = cleanedMessages[0].content || "Unknown Directive";
  const firstMsg = originalDirective;
  const threadId = crypto.createHash('md5').update(firstMsg).digest('hex').substring(0, 12);

  const config = { configurable: { thread_id: threadId }, recursionLimit: 100 };
  const requestId = `chatcmpl-${uuidv4()}`;

  await app.updateState(config, { messages: cleanedMessages.slice(0, -1) });

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

  const heartbeat = setInterval(() => {
    res.write(": keep-alive\n\n");
  }, 15000);

  try {
    const eventStream = await app.streamEvents(
      { messages: [{ role: "user", content: lastUserMessage }] },
      { ...config, version: "v2" }
    );

    let isThinking = false;
    let hasThoughtStarted = false;

    for await (const event of eventStream) {
      const eventType = event.event;

      if (eventType === "on_chat_model_stream") {
        const nodeName = event.metadata?.langgraph_node;
        if (nodeName === "project_manager") continue;

        let content = event.data.chunk.content;
        if (content) {
          if (process.env.DEBUG === "true") process.stdout.write(content);

          if (!hasThoughtStarted && content.trim().length > 0) {
              const looksLikeHeader = content.startsWith("#") || content.startsWith("1.") || content.startsWith("**");
              const hasThinkToken = content.includes("<think>");
              
              if (!looksLikeHeader && !hasThinkToken) {
                  content = `<think>${content}`;
                  isThinking = true;
              } else if (hasThinkToken) {
                  isThinking = true;
              }
              hasThoughtStarted = true;
          }

          if (isThinking && content.includes("</think>")) {
              isThinking = false;
          }
          else if (isThinking && (content.includes("# ") || content.includes("1. MISSION") || content.includes("Technical System Design") || content.includes("Requirements Specification"))) {
              content = `\n</think>\n\n${content}`;
              isThinking = false;
          }

          const chunk = {
            id: requestId, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: model || "ai-it-org",
            choices: [{ index: 0, delta: { content }, finish_reason: null }],
          };
          res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        }
      }

      if (eventType === "on_chain_start" && event.name?.endsWith("Node")) {
          isThinking = false;
          hasThoughtStarted = false;

          const node = event.name.replace("Node", "").replace("_", " ");
          const statusText = `\n\n> **[System]: ${node.toUpperCase()} is active...**\n\n`;
          const chunk = {
            id: requestId, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: model || "ai-it-org",
            choices: [{ index: 0, delta: { content: statusText }, finish_reason: null }],
          };
          res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      }

      if (eventType === "on_chain_end" && event.name === "project_manager") {
          isThinking = false;
          hasThoughtStarted = false;

          const output = event.data.output;
          if (output && output.next_agent) {
              const pmText = formatPMDecision(output.next_agent, output.pm_reasoning, originalDirective);
              const chunk = {
                id: requestId, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: model || "ai-it-org",
                choices: [{ index: 0, delta: { content: pmText }, finish_reason: null }],
              };
              res.write(`data: ${JSON.stringify(chunk)}\n\n`);
          }
      }
    }

    res.write(`data: ${JSON.stringify({ id: requestId, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
    res.write("data: [DONE]\n\n");
  } catch (error) {
    console.error("Stream Error:", error);
    const errorMsg = `\n\n> **[ERROR]: ${error.message}**\n\n`;
    res.write(`data: ${JSON.stringify({ id: requestId, object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: errorMsg }, finish_reason: "stop" }] })}\n\n`);
    res.write("data: [DONE]\n\n");
  } finally {
    clearInterval(heartbeat);
    res.end();
  }
});

const PORT = 3000;
server.listen(PORT, () => {
  console.log(`\n🚀 AI-IT OpenAI-Compatible API running at http://localhost:${PORT}`);
  console.log(`🔗 OpenAI Base URL for Open WebUI: http://localhost:${PORT}/v1`);
  if (process.env.DEBUG === "true") {
      console.log(`\x1b[35m🔧 DEBUG MODE ACTIVE: All inference responses will be logged.\x1b[0m`);
  }
});
