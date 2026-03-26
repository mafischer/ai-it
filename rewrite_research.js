const fs = require('fs');
let code = fs.readFileSync('index.js', 'utf8');

const newRunResearch = `
const MAX_RESEARCH_ROUNDS = 5;

async function runResearch(llm, messages, ctx) {
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

    // Emit Phase 1 prompt to UI
    const phase1PromptMsg = messages.find(m => m.role === "system")?.content || "Phase 1: Search for industry best practices.";
    const phase1AgentName = ctx.agent; // e.g. business_analyst_research
    if (ctx && global.researchEvents) {
        global.researchEvents.emit("prompt", { threadId: ctx.threadId, agent: phase1AgentName, prompt: phase1PromptMsg });
    }

    const llmPhase1 = llm.bindTools(phase1Tools);
    const phase1History = [...messages];
    
    // Add instruction to use submit_links to phase 1 history
    phase1History.push({ role: "system", content: "You are in Phase 1 of research. Use the web_search tool to find industry best practices. Once you find good candidates, you MUST use the submit_links tool to provide up to 5 URLs. Do not attempt to read the articles yourself." });

    let urlsToFetch = [];

    for (let round = 0; round < MAX_RESEARCH_ROUNDS; round++) {
        const response = await llmPhase1.invoke(phase1History);

        if (!response.tool_calls?.length) {
            break; // Finished without submitting links?
        }

        phase1History.push(response);
        let submitted = false;
        
        for (const call of response.tool_calls) {
            console.error(\`[RESEARCH P1] Tool call: \${call.name}(\${JSON.stringify(call.args).slice(0, 120)})\`);
            if (call.name === "submit_links") {
                urlsToFetch = call.args.urls || [];
                phase1History.push(new ToolMessage({ content: "Links submitted successfully.", tool_call_id: call.id, name: call.name }));
                submitted = true;
            } else if (call.name === "web_search") {
                const result = await executeToolCall(call, ctx);
                phase1History.push(new ToolMessage({ content: result || "No content found.", tool_call_id: call.id, name: call.name }));
            } else {
                phase1History.push(new ToolMessage({ content: "Unknown tool", tool_call_id: call.id, name: call.name }));
            }
        }
        
        if (submitted) break; // Finished Phase 1
    }

    if (urlsToFetch.length === 0) {
        return ""; // No links submitted
    }

    // Trim to 5 URLs just in case
    urlsToFetch = urlsToFetch.slice(0, 5);
    console.error(\`[RESEARCH P2] Fetching \${urlsToFetch.length} URLs in parallel...\`);

    // Phase 2: Parallel Fetch and Summarize
    const phase2PromptText = \`Phase 2: Extract Relevant Best Practices.
You are an expert researcher. Read the provided article content and extract ONLY the industry best practice details relevant to the user's directive and context. Do not output raw text, only the extracted relevant details. Ensure your extraction is concise and directly applicable.\`;
    
    if (ctx && global.researchEvents) {
        // We emit a prompt for Phase 2, we can just call it the same agent to group it, or add a suffix. Let's just keep the same agent, UI handles multiple prompts by overwriting or adding to the list.
        global.researchEvents.emit("prompt", { threadId: ctx.threadId, agent: phase1AgentName.replace("_research", "") + "_research_phase_2", prompt: phase2PromptText });
    }

    const phase2Promises = urlsToFetch.map(async (url) => {
        try {
            // First fetch the page
            console.error(\`[RESEARCH P2] Fetching \${url}\`);
            const fetchResult = await executeToolCall({ name: "fetch_page", args: { url } }, ctx);
            
            if (!fetchResult || fetchResult.startsWith("Error:")) {
                return \`URL: \${url}\\nFailed to fetch or read content.\`;
            }

            // Summarize with LLM
            const phase2History = [
                ...messages.filter(m => m.role === "user"), // Keep context
                { role: "system", content: phase2PromptText },
                { role: "user", content: \`[SOURCE URL]: \${url}\\n\\n[ARTICLE CONTENT]:\\n\${fetchResult.slice(0, 20000)}\\n\\nExtract the relevant best practices from the article above.\` }
            ];

            const stream = await llm.stream(phase2History);
            let extracted = "";
            for await (const chunk of stream) {
                const text = typeof chunk.content === 'string' ? chunk.content : String(chunk.content || "");
                extracted += text;
                if (ctx && global.researchEvents) {
                    global.researchEvents.emit("chunk", { threadId: ctx.threadId, agent: subAgentName, content: text });
                }
            }

            if (ctx && global.researchEvents) {
                global.researchEvents.emit("stop", { threadId: ctx.threadId, agent: subAgentName });
            }

            let cleaned = extracted.replace(/<think>[\s\S]*?(?:<\/think>|$)/g, "").replace(/<\/?think>/g, "").trim();
            return `[SOURCE URL]: ${url}\n[RESEARCH-BASED RECOMMENDATIONS]:\n${cleaned}`;
            
        } catch (err) {
            console.error(\`[RESEARCH P2] Error processing \${url}: \${err.message}\`);
            return \`URL: \${url}\\nError processing content.\`;
        }
    });

    const phase2Results = await Promise.all(phase2Promises);
    
    const combined = phase2Results.join("\\n\\n---\\n\\n");
    return phase2Results.length
        ? "\\n\\n[RESEARCH FINDINGS FROM WEB]:\\n" + (combined.length > 40000 ? combined.slice(0, 40000) + "\\n\\n[...truncated]" : combined)
        : "";
}
`;

code = code.replace(/const MAX_RESEARCH_ROUNDS = 5;[\s\S]*?function extractStatus/, newRunResearch + '\nfunction extractStatus');

fs.writeFileSync('index.js', code);
console.log("Updated index.js");
