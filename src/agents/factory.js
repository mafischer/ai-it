import { ChatPromptTemplate, MessagesPlaceholder } from "@langchain/core/prompts";
import { createLLM } from "../utils/llm.js";
import { RunnableLambda } from "@langchain/core/runnables";

export async function createAgent(name, role, systemPrompt, modelId = "llama3-8b", schema = null) {
  const llm = createLLM(modelId);
  const prompt = ChatPromptTemplate.fromMessages([
    ["system", `You are a ${role} at AI-IT. ${systemPrompt}\n\nCURRENT STATE: The last agent to speak was: {last_speaker}`],
    new MessagesPlaceholder("messages"),
  ]);

  const responseGuard = new RunnableLambda({
    func: async (input) => {
      const response = await llm.invoke(input);
      const content = typeof response.content === 'string' 
        ? response.content 
        : (Array.isArray(response.content) ? response.content.map(c => c.text || "").join("") : "");
      
      if (process.env.DEBUG === "true") {
          console.log(`\n\x1b[35m[DEBUG - ${name}]: RAW LLM RESPONSE:\x1b[0m\n${content}\n\x1b[35m[END DEBUG]\x1b[0m\n`);
      }

      return content.trim();
    }
  });

  if (schema) {
    llm.streaming = false; 

    return prompt.pipe(responseGuard).pipe(new RunnableLambda({
        func: async (text) => {
            // 1. STICKY CLEANER: Strip tags and find JSON braces
            let cleanText = text.replace(/<think>[\s\S]*?<\/think>/g, "").replace(/<\/?think>/g, "").trim();
            const start = cleanText.indexOf("{");
            const end = cleanText.lastIndexOf("}");
            
            if (start !== -1 && end !== -1) {
                try {
                    return JSON.parse(cleanText.substring(start, end + 1));
                } catch (e) {
                    console.error(`[DEBUG]: JSON Fragment Parse Failed. Logic falling through to keyword search.`);
                }
            }

            // 2. KEYWORD HUNTING: If JSON fails, search for the agent name in the raw text
            // This is a safety net for very small models (1B)
            const agents = ["business_analyst", "architect", "software_engineer", "quality_engineer", "support_engineer", "complete"];
            for (const agent of agents) {
                if (text.toLowerCase().includes(agent)) {
                    console.log(`[INFO]: PM JSON failed, but found agent keyword: ${agent}`);
                    return { next_agent: agent, reasoning: "Extracted from raw text (JSON parse failed)." };
                }
            }

            // 3. ULTIMATE FALLBACK
            console.error(`[ERROR]: PM produced un-parseable output: "${text}"`);
            return { next_agent: "business_analyst", reasoning: "Critical parse failure fallback (Defaulting to BA)." };
        }
    }));
  }

  return prompt.pipe(responseGuard);
}
