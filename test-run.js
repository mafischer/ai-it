import { app } from "./index.js";

async function main() {
  const directive = "Create a platform to sell cars";
  
  console.log(`\n🚀 Starting AI-IT Organization...`);
  console.log(`📝 Directive: "${directive}"\n`);

  const config = { configurable: { thread_id: "1" } };
  
  const eventStream = await app.streamEvents(
    {
      messages: [{ role: "user", content: directive }],
    },
    { ...config, version: "v2" }
  );

  for await (const event of eventStream) {
    const eventType = event.event;

    // Capture token stream from ALL agents (including PM reasoning)
    if (eventType === "on_chat_model_stream") {
      const content = event.data.chunk.content;
      if (content) {
        process.stdout.write(content);
      }
    }

    // Detect when a node ends to print a clean separator
    if (eventType === "on_chain_end" && event.name && event.name.endsWith("Node")) {
        console.log("\n" + "─".repeat(50));
    }

    // Print final PM decision metadata in yellow when it finishes
    if (eventType === "on_chain_end" && event.name === "project_manager") {
        const output = event.data.output;
        if (output && output.next_agent) {
            console.log(`\n\x1b[33m[PM DECISION]: Route to ${output.next_agent}. Logic: ${output.pm_reasoning}\x1b[0m`);
            console.log("─".repeat(50));
        }
    }
  }

  console.log("\n✅ AI-IT Workflow Complete.\n");
}

main().catch(console.error);
