// Debug: trace the full thinking_budget parameter chain
import { createLLM } from "./src/utils/llm.js";

const llm = createLLM("qwen3.5-27b");

// Check what params LangChain sends
const params = llm.invocationParams();
console.log("=== LangChain invocationParams ===");
console.log(JSON.stringify(params, null, 2));

// Check modelKwargs
console.log("\n=== modelKwargs ===");
console.log(JSON.stringify(llm.modelKwargs, null, 2));

// Now do a raw fetch to see if vllm-mlx accepts thinking_budget
console.log("\n=== Direct API test ===");
const resp = await fetch("http://127.0.0.1:8081/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
        model: "mlx-community/Qwen3.5-27B-5bit",
        messages: [{ role: "user", content: "what is 1+1" }],
        max_tokens: 500,
        stream: true,
        thinking_budget: 10,  // Very low budget to test
    }),
    signal: AbortSignal.timeout(120000),
});

let thinkingTokens = 0;
let inThinking = false;
let accumulated = "";

const reader = resp.body.getReader();
const decoder = new TextDecoder();
let buffer = "";

while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split("\n");
    buffer = lines.pop();

    for (const line of lines) {
        if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
        try {
            const data = JSON.parse(line.slice(6));
            const content = data.choices?.[0]?.delta?.content;
            const reasoning = data.choices?.[0]?.delta?.reasoning_content;

            if (reasoning) {
                thinkingTokens++;
                accumulated += reasoning;
                if (thinkingTokens <= 5 || thinkingTokens % 50 === 0) {
                    process.stdout.write(`[reasoning #${thinkingTokens}] ${JSON.stringify(reasoning).slice(0, 80)}\n`);
                }
            }
            if (content) {
                if (!inThinking && content.includes("<think>")) inThinking = true;
                if (inThinking) thinkingTokens++;
                accumulated += content;
                if (thinkingTokens <= 5 || content.includes("</think>")) {
                    process.stdout.write(`[content #${thinkingTokens}] ${JSON.stringify(content).slice(0, 80)}\n`);
                }
                if (content.includes("</think>")) {
                    inThinking = false;
                    console.log(`\n=== Thinking ended at token #${thinkingTokens} ===`);
                }
            }
        } catch {}
    }
}

console.log(`\nTotal thinking tokens: ${thinkingTokens}`);
console.log(`Budget was: 10`);
console.log(`Accumulated length: ${accumulated.length} chars`);
