import { HumanMessage } from "@langchain/core/messages";
import { app, initConfig } from "./index.js";
import { v4 as uuidv4 } from "uuid";

async function run() {
    await initConfig();
    const threadId = uuidv4().substring(0, 12);
    const directive = process.argv[2] || "Create a hello world app in Python";
    
    console.log(`[TEST] Starting workflow for thread ${threadId}`);
    console.log(`[TEST] Directive: ${directive}`);

    const config = { configurable: { thread_id: threadId }, recursionLimit: 100 };
    const stream = await app.streamEvents(
        { messages: [new HumanMessage({ content: directive, timestamp: Date.now() })] }, 
        { ...config, version: "v2" }
    );

    for await (const event of stream) {
        const eventType = event.event;
        const nodeName = event.metadata?.langgraph_node;
        
        if (eventType === "on_chat_model_stream") {
            const content = event.data.chunk.content;
            if (content) {
                process.stdout.write(typeof content === "string" ? content : JSON.stringify(content));
            }
        } else if (eventType === "on_chain_start") {
            if (nodeName && !nodeName.endsWith("_prompt")) {
                console.log(`\n\n--- [AGENT: ${nodeName}] ---`);
            }
        }
    }
    console.log("\n\n[TEST] Workflow complete.");
}

run().catch(console.error);
