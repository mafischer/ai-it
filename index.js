import { StateGraph, MessagesAnnotation, Annotation } from "@langchain/langgraph";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { createAgent } from "./src/agents/factory.js";
import { roles } from "./src/agents/roles.js";
import { z } from "zod";

const checkpointer = SqliteSaver.fromConnString("./checkpoints.db");

const GraphState = Annotation.Root({
  ...MessagesAnnotation.spec,
  next_agent: Annotation({ reducer: (x, y) => y ?? x, default: () => "business_analyst" }),
  last_speaker: Annotation({ reducer: (x, y) => y ?? x, default: () => "user" }),
  pm_reasoning: Annotation({ reducer: (x, y) => y ?? x, default: () => "" }),
  project_title: Annotation({ reducer: (x, y) => y ?? x, default: () => "New AI-IT Project" }),
  loop_step: Annotation({ reducer: (x, y) => (y === 0 ? 0 : x + 1), default: () => 0 }),
});

/**
 * STRICT AGENT IDS:
 * These must match the node names and the routing enum exactly.
 */
const AGENT_IDS = [
    "business_analyst", 
    "software_architect", 
    "software_engineer", 
    "quality_engineer", 
    "ux_engineer", 
    "site_reliability_engineer", 
    "devops_engineer", 
    "support_engineer", 
    "complete"
];

const routingSchema = z.object({
  next_agent: z.enum(AGENT_IDS),
  reasoning: z.string().describe("Workflow logic check"),
});

const projectManager = await createAgent("PM", roles.project_manager.role, roles.project_manager.prompt, "lfm2-8b", routingSchema);
const businessAnalyst = await createAgent("BA", roles.business_analyst.role, roles.business_analyst.prompt, "qwen3.5-27b");
const softwareArchitect = await createAgent("Architect", roles.software_architect.role, roles.software_architect.prompt, "qwen3.5-27b");
const softwareEngineer = await createAgent("SE", roles.software_engineer.role, roles.software_engineer.prompt, "qwen3.5-27b");
const uxEngineer = await createAgent("UXE", roles.ux_engineer.role, roles.ux_engineer.prompt, "qwen3.5-27b");
const qualityEngineer = await createAgent("QE", roles.quality_engineer.role, roles.quality_engineer.prompt, "qwen3.5-27b");
const supportEngineer = await createAgent("Support", roles.support_engineer.role, roles.support_engineer.prompt, "qwen3.5-27b");
const siteReliabilityEngineer = await createAgent("SRE", roles.site_reliability_engineer.role, roles.site_reliability_engineer.prompt, "qwen3.5-27b");
const devopsEngineer = await createAgent("DevOps", roles.devops_engineer.role, roles.devops_engineer.prompt, "qwen3.5-27b");

function cleanSpecialistOutput(content) {
    if (typeof content !== 'string') return String(content || "");
    return content.replace(/<think>[\s\S]*?<\/think>/g, "").replace(/<\/?think>/g, "").trim();
}

function getSurgicalContext(state) {
    if (state.messages.length <= 1) return state.messages;
    const userMsg = { role: "user", content: `[ORIGINAL USER DIRECTIVE]:\n${state.messages[0].content}` };
    const latestMsg = { role: "user", content: `[LATEST UPDATE FROM ${state.last_speaker.toUpperCase()}]:\n${state.messages[state.messages.length - 1].content}` };
    return [userMsg, latestMsg];
}

async function businessAnalystNode(state) {
  const content = await businessAnalyst.invoke({ messages: getSurgicalContext(state), last_speaker: state.last_speaker });
  return { messages: [{ role: "assistant", content: cleanSpecialistOutput(content) }], last_speaker: "business_analyst" };
}

async function softwareArchitectNode(state) {
  const content = await softwareArchitect.invoke({ messages: getSurgicalContext(state), last_speaker: state.last_speaker });
  return { messages: [{ role: "assistant", content: cleanSpecialistOutput(content) }], last_speaker: "software_architect" };
}

async function softwareEngineerNode(state) {
  const content = await softwareEngineer.invoke({ messages: getSurgicalContext(state), last_speaker: state.last_speaker });
  return { messages: [{ role: "assistant", content: cleanSpecialistOutput(content) }], last_speaker: "software_engineer" };
}

async function uxEngineerNode(state) {
  const content = await uxEngineer.invoke({ messages: getSurgicalContext(state), last_speaker: state.last_speaker });
  return { messages: [{ role: "assistant", content: cleanSpecialistOutput(content) }], last_speaker: "ux_engineer" };
}

async function qualityEngineerNode(state) {
  const content = await qualityEngineer.invoke({ messages: getSurgicalContext(state), last_speaker: state.last_speaker });
  return { messages: [{ role: "assistant", content: cleanSpecialistOutput(content) }], last_speaker: "quality_engineer" };
}

async function supportEngineerNode(state) {
  const content = await supportEngineer.invoke({ messages: getSurgicalContext(state), last_speaker: state.last_speaker });
  return { messages: [{ role: "assistant", content: cleanSpecialistOutput(content) }], last_speaker: "support_engineer" };
}

async function siteReliabilityEngineerNode(state) {
  const content = await siteReliabilityEngineer.invoke({ messages: getSurgicalContext(state), last_speaker: state.last_speaker });
  return { messages: [{ role: "assistant", content: cleanSpecialistOutput(content) }], last_speaker: "site_reliability_engineer" };
}

async function devopsEngineerNode(state) {
  const content = await devopsEngineer.invoke({ messages: getSurgicalContext(state), last_speaker: state.last_speaker });
  return { messages: [{ role: "assistant", content: cleanSpecialistOutput(content) }], last_speaker: "devops_engineer" };
}

async function projectManagerNode(state) {
  const lastMsgInHistory = state.messages[state.messages.length - 1];
  const userText = (lastMsgInHistory.content || "").toLowerCase();
  const isHuman = lastMsgInHistory.role === "user" || lastMsgInHistory.role === "human";
  const isContinuation = isHuman && (userText.length < 15 && (userText.includes("yes") || userText.includes("continue") || userText.includes("proceed")));

  if (state.messages.length === 1 || (isHuman && !isContinuation && userText.length > 20)) {
      return { 
          next_agent: "business_analyst", 
          pm_reasoning: "New User Directive. Starting Requirements phase.",
          last_speaker: "user",
          loop_step: 0 
      };
  }

  if (isContinuation) return { loop_step: 0 };
  if (state.loop_step > 40) return { next_agent: "complete", pm_reasoning: "LOOP_LIMIT" };

  const analysisMessage = {
    role: "user",
    content: `[HIERARCHICAL STATE CHECK]\nLast Agent: ${state.last_speaker.toUpperCase()}\nMessage: ${lastMsgInHistory.content}`
  };
  
  const response = await projectManager.invoke({ messages: [analysisMessage], last_speaker: state.last_speaker });
  
  return { 
      next_agent: response.next_agent, 
      pm_reasoning: response.reasoning, 
      loop_step: state.loop_step 
  };
}

const workflow = new StateGraph(GraphState)
  .addNode("project_manager", projectManagerNode)
  .addNode("business_analyst", businessAnalystNode)
  .addNode("software_architect", softwareArchitectNode)
  .addNode("ux_engineer", uxEngineerNode)
  .addNode("software_engineer", softwareEngineerNode)
  .addNode("quality_engineer", qualityEngineerNode)
  .addNode("support_engineer", supportEngineerNode)
  .addNode("site_reliability_engineer", siteReliabilityEngineerNode)
  .addNode("devops_engineer", devopsEngineerNode)
  .addEdge("__start__", "project_manager")
  .addConditionalEdges("project_manager", (state) => {
      if (state.next_agent === "complete") return "__end__";
      // Safeguard: Fallback to __end__ if destination is unknown
      return AGENT_IDS.includes(state.next_agent) ? state.next_agent : "__end__";
  }, {
    business_analyst: "business_analyst", 
    software_architect: "software_architect", 
    ux_engineer: "ux_engineer",
    software_engineer: "software_engineer", 
    quality_engineer: "quality_engineer",
    support_engineer: "support_engineer", 
    site_reliability_engineer: "site_reliability_engineer",
    devops_engineer: "devops_engineer", 
    "__end__": "__end__"
  })
  .addEdge("business_analyst", "project_manager")
  .addEdge("software_architect", "project_manager")
  .addEdge("ux_engineer", "project_manager")
  .addEdge("software_engineer", "project_manager")
  .addEdge("quality_engineer", "project_manager")
  .addEdge("support_engineer", "project_manager")
  .addEdge("site_reliability_engineer", "project_manager")
  .addEdge("devops_engineer", "project_manager");

const app = workflow.compile({ checkpointer });
export { app };
