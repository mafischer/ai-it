import { StateGraph, MessagesAnnotation, Annotation, START, END } from "@langchain/langgraph";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { createLLM } from "./src/utils/llm.js";
import { roles } from "./src/agents/roles.js";

const checkpointer = SqliteSaver.fromConnString("./checkpoints.db");

const GraphState = Annotation.Root({
  ...MessagesAnnotation.spec
});

const qwenLLM = createLLM("qwen3.5-27b");
const routerLLM = createLLM("lfm2-8b");

function extractStatus(content) {
    if (!content) return null;
    const matches = [...content.matchAll(/STATUS:\s*([A-Z_]+)/g)];
    return matches.length ? matches[matches.length - 1][1] : null;
}

function cleanSpecialistOutput(content) {
    if (typeof content !== 'string') return String(content || "");
    return content.replace(/<think>[\s\S]*?<\/think>/g, "").replace(/<\/?think>/g, "").trim();
}

function getPromptForNode(state, nodeName) {
    const msgs = state.messages.filter(m => m.name === nodeName);
    const lastSelfStatus = msgs.length ? extractStatus(msgs[msgs.length - 1].content) : null;
    const lastMsg = state.messages[state.messages.length - 1];
    const rolePrompts = roles[nodeName]?.prompts;
    
    if (!rolePrompts) return `You are ${nodeName}.`;

    const selfLastContent = msgs.length ? msgs[msgs.length - 1].content : "";
    const otherLastContent = lastMsg ? lastMsg.content : "";

    const isContinue = lastSelfStatus && lastSelfStatus.includes("_PHASE_CONTINUE");

    // If user is replying to this agent's questions, capture those questions
    const isUserReply = lastMsg.role === "user" || lastMsg.role === "human";
    let priorQuestions = "";
    if (isUserReply && msgs.length) {
        const lastSelf = msgs[msgs.length - 1];
        const selfStatus = extractStatus(lastSelf.content);
        if (selfStatus === "DIRECTIVE_AMBIGUOUS" || selfStatus === "QUESTION") {
            priorQuestions = lastSelf.content;
        }
    }

    const values = {
        currentDirective: state.messages[0] ? state.messages[0].content : "",
        currentRequirements: isContinue ? selfLastContent : otherLastContent,
        currentDesign: isContinue ? selfLastContent : otherLastContent,
        currentImplementation: isContinue ? selfLastContent : otherLastContent,
        currentCode: isContinue ? selfLastContent : otherLastContent,
        currentTestResults: isContinue ? selfLastContent : otherLastContent,
        currentFeedback: otherLastContent,
        priorQuestions,
        userResponse: isUserReply ? lastMsg.content : "",

        // Fallbacks just in case roles.js still references old names
        design: otherLastContent,
        requirements: otherLastContent,
        feedback: otherLastContent,
        testResults: otherLastContent
    };

    // 1. If continuing own phase
    if (lastSelfStatus && lastSelfStatus.includes("_PHASE_CONTINUE") && rolePrompts.continue) {
        return rolePrompts.continue(values);
    }

    const lastMsgStatus = extractStatus(lastMsg.content);

    // 2. If downstream agent sent work back for review/approval
    let useApproval = false;
    if (nodeName === "business_analyst" && lastMsgStatus === "DESIGN_COMPLETE") useApproval = true;
    if ((nodeName === "software_architect" || nodeName === "ux_designer") && lastMsgStatus === "IMPLEMENTATION_COMPLETE") useApproval = true;
    if ((nodeName === "backend_software_engineer" || nodeName === "frontend_software_engineer") && lastMsgStatus === "REJECTED") useApproval = true;

    if (useApproval && rolePrompts.approval) {
        return rolePrompts.approval(values);
    }

    // 3. If answering a QUESTION from downstream
    if (lastMsgStatus === "QUESTION") {
        return rolePrompts.main(values);
    }

    // 4. Otherwise, it's a new task from upstream.
    // Run 'query' to clarify ambiguities unless we just successfully completed clarification
    // OR the user is replying to our previous questions (skip straight to main).
    if (rolePrompts.query) {
        const isClarified = lastSelfStatus && (lastSelfStatus.endsWith("_CLEAR") || lastSelfStatus.endsWith("_CLARIFIED") || lastSelfStatus.endsWith("_APPROVED"));
        const userRepliedToQuestions = priorQuestions && isUserReply;
        if (!isClarified && !userRepliedToQuestions) {
            return rolePrompts.query(values);
        }
    }

    // Default to main prompt
    return rolePrompts.main(values);
}

async function genericNode(nodeName, state, config) {
    const systemPromptStr = getPromptForNode(state, nodeName);
    const directiveMsg = state.messages[0].content;
    const lastMsg = state.messages[state.messages.length - 1];

    const messagesToPass = [
        { role: "system", content: systemPromptStr },
        { role: "user", content: `[ORIGINAL DIRECTIVE]:\n${directiveMsg}\n\n[LATEST UPDATE FROM ${lastMsg.name || lastMsg.role || "USER"}]:\n${lastMsg.content}` }
    ];

    const response = await qwenLLM.invoke(messagesToPass, { signal: config?.signal });
    const content = cleanSpecialistOutput(response.content);
    return { messages: [{ role: "assistant", name: nodeName, content }] };
}

async function fallbackRouter(state, currentAgent) {
    const lastMsg = state.messages[state.messages.length - 1];
    const status = extractStatus(lastMsg.content);
    const context = status
        ? `Status: ${status}`
        : `No status token found. Last 500 chars of output:\n${lastMsg.content.slice(-500)}`;

    const prevMsg = state.messages.length > 1 ? state.messages[state.messages.length - 2] : null;
    const prevSpeaker = prevMsg?.name || prevMsg?.role || "unknown";
    const prevStatus = prevMsg ? (extractStatus(prevMsg.content) || "unknown") : "unknown";
    const orchestrationContext = `Previous orchestration: ${prevSpeaker} -> ${prevStatus} -> routed to ${currentAgent}`;

    const systemPrompt = roles.project_manager?.prompts?.main ? roles.project_manager.prompts.main({}) : "You are the router.";
    const messagesToPass = [
        { role: "system", content: systemPrompt },
        { role: "user", content: `${orchestrationContext}\nCurrent speaker: ${currentAgent}\n${context}` }
    ];
    
    console.log(`[ROUTER]: Fallback invoked for ${currentAgent}`);
    try {
        const response = await routerLLM.invoke(messagesToPass);
        let cleanText = response.content.replace(/<think>[\s\S]*?<\/think>/g, "").replace(/<\/?think>/g, "").trim();
        const start = cleanText.indexOf("{");
        const end = cleanText.lastIndexOf("}");
        if (start !== -1 && end !== -1) {
            const parsed = JSON.parse(cleanText.substring(start, end + 1));
            if (parsed.next_agent && parsed.next_agent !== "complete") return [parsed.next_agent];
            if (parsed.next_agent === "complete") return [END];
        }
    } catch (e) {
        console.error("Fallback router failed", e);
    }
    return [END];
}

async function routeFromStart(state) {
    if (!state.messages || state.messages.length === 0) return ["business_analyst"];
    const lastMsg = state.messages[state.messages.length - 1];
    const isUser = lastMsg && (lastMsg.role === "user" || lastMsg.role === "human");
    
    if (state.messages.length === 1) return ["business_analyst"];

    if (isUser) {
        // Was it a reply to a question?
        const msgsBefore = state.messages.slice(0, -1);
        const lastAssistant = msgsBefore.filter(m => m.role === "assistant").pop();
        if (lastAssistant) {
            const status = extractStatus(lastAssistant.content);
            if (status === "DIRECTIVE_AMBIGUOUS" || status === "QUESTION") {
                return [lastAssistant.name];
            }
        }
        
        // If it wasn't a reply to a question, it's a new directive or a continuation.
        // In the new architecture, a new directive from the user should ALWAYS reset the flow to the BA.
        return ["business_analyst"];
    }

    return fallbackRouter(state, "user");
}

function routeFromBA(state) {
    const msgs = state.messages.filter(m => m.name === "business_analyst");
    if (!msgs.length) return fallbackRouter(state, "business_analyst");
    const lastMsg = msgs[msgs.length - 1];
    const status = extractStatus(lastMsg.content);

    switch(status) {
        case "REQUIREMENTS_DRAFTED":
            return ["software_architect", "ux_designer"];
        case "BA_PHASE_CONTINUE":
            return ["business_analyst"];
        case "REQUIREMENTS_APPROVED":
            const msgsBefore = state.messages.slice(0, -1);
            const lastOther = msgsBefore.filter(m => m.name !== "business_analyst").pop();
            if (lastOther && lastOther.name === "software_architect") return ["backend_software_engineer"];
            if (lastOther && lastOther.name === "ux_designer") return ["frontend_software_engineer"];
            return ["software_architect"]; 
        case "REQUIREMENTS_AMBIGUOUS":
            const msgsBefore2 = state.messages.slice(0, -1);
            const lastOther2 = msgsBefore2.filter(m => m.name !== "business_analyst").pop();
            if (lastOther2) return [lastOther2.name];
            return ["software_architect"];
        case "DIRECTIVE_CLEAR":
            return ["business_analyst"];
        case "DIRECTIVE_AMBIGUOUS":
        case "QUESTION":
            return [END]; 
        default:
            return fallbackRouter(state, "business_analyst");
    }
}

function routeFromSA(state) {
    const msgs = state.messages.filter(m => m.name === "software_architect");
    if (!msgs.length) return fallbackRouter(state, "software_architect");
    const lastMsg = msgs[msgs.length - 1];
    const status = extractStatus(lastMsg.content);

    switch(status) {
        case "DESIGN_COMPLETE":
            return ["business_analyst"];
        case "ARCHITECT_PHASE_CONTINUE":
            return ["software_architect"];
        case "DESIGN_SATISFIED":
        case "DESIGN_APPROVED":
            return ["backend_software_engineer"];
        case "QUESTION":
            return ["business_analyst"];
        case "DESIGN_CLARIFIED":
            return ["software_architect"];
        default:
            return fallbackRouter(state, "software_architect");
    }
}

function routeFromUXD(state) {
    const msgs = state.messages.filter(m => m.name === "ux_designer");
    if (!msgs.length) return fallbackRouter(state, "ux_designer");
    const lastMsg = msgs[msgs.length - 1];
    const status = extractStatus(lastMsg.content);

    switch(status) {
        case "DESIGN_COMPLETE":
            return ["business_analyst"];
        case "UXD_PHASE_CONTINUE":
            return ["ux_designer"];
        case "DESIGN_APPROVED":
        case "DESIGN_SATISFIED":
            return ["frontend_software_engineer"];
        case "QUESTION":
            return ["business_analyst"];
        case "DESIGN_CLARIFIED":
            return ["ux_designer"];
        default:
            return fallbackRouter(state, "ux_designer");
    }
}

function routeFromBSE(state) {
    const msgs = state.messages.filter(m => m.name === "backend_software_engineer");
    if (!msgs.length) return fallbackRouter(state, "backend_software_engineer");
    const lastMsg = msgs[msgs.length - 1];
    const status = extractStatus(lastMsg.content);

    switch(status) {
        case "IMPLEMENTATION_COMPLETE":
            return ["software_architect"];
        case "BSE_PHASE_CONTINUE":
            return ["backend_software_engineer"];
        case "IMPLEMENTATION_APPROVED":
            return ["quality_engineer"];
        case "QUESTION":
            return ["software_architect"];
        case "IMPLEMENTATION_CLARIFIED":
            return ["backend_software_engineer"];
        default:
            return fallbackRouter(state, "backend_software_engineer");
    }
}

function routeFromFSE(state) {
    const msgs = state.messages.filter(m => m.name === "frontend_software_engineer");
    if (!msgs.length) return fallbackRouter(state, "frontend_software_engineer");
    const lastMsg = msgs[msgs.length - 1];
    const status = extractStatus(lastMsg.content);

    switch(status) {
        case "IMPLEMENTATION_COMPLETE":
            return ["ux_designer"];
        case "FSE_PHASE_CONTINUE":
            return ["frontend_software_engineer"];
        case "IMPLEMENTATION_APPROVED":
            return ["quality_engineer"];
        case "QUESTION":
            return ["ux_designer"];
        case "IMPLEMENTATION_CLARIFIED":
            return ["frontend_software_engineer"];
        default:
            return fallbackRouter(state, "frontend_software_engineer");
    }
}

function routeFromQE(state) {
    const msgs = state.messages.filter(m => m.name === "quality_engineer");
    if (!msgs.length) return fallbackRouter(state, "quality_engineer");
    const lastMsg = msgs[msgs.length - 1];
    const status = extractStatus(lastMsg.content);

    switch(status) {
        case "TESTING_COMPLETE":
        case "TESTS_PASSED":
            return [END];
        case "QE_PHASE_CONTINUE":
            return ["quality_engineer"];
        case "REJECTED":
            const msgsBefore = state.messages.slice(0, -1);
            const lastOther = msgsBefore.filter(m => m.name === "backend_software_engineer" || m.name === "frontend_software_engineer").pop();
            if (lastOther) return [lastOther.name];
            return ["backend_software_engineer"]; 
        case "QUESTION":
            const msgsBeforeQ = state.messages.slice(0, -1);
            const lastOtherQ = msgsBeforeQ.filter(m => m.name === "backend_software_engineer" || m.name === "frontend_software_engineer").pop();
            if (lastOtherQ) return [lastOtherQ.name];
            return ["backend_software_engineer"]; 
        case "QE_CLARIFIED":
            return ["quality_engineer"];
        default:
            return fallbackRouter(state, "quality_engineer");
    }
}

const workflow = new StateGraph(GraphState)
  .addNode("business_analyst", (state, config) => genericNode("business_analyst", state, config))
  .addNode("software_architect", (state, config) => genericNode("software_architect", state, config))
  .addNode("backend_software_engineer", (state, config) => genericNode("backend_software_engineer", state, config))
  .addNode("frontend_software_engineer", (state, config) => genericNode("frontend_software_engineer", state, config))
  .addNode("ux_designer", (state, config) => genericNode("ux_designer", state, config))
  .addNode("quality_engineer", (state, config) => genericNode("quality_engineer", state, config))
  
  .addConditionalEdges(START, routeFromStart)
  .addConditionalEdges("business_analyst", routeFromBA)
  .addConditionalEdges("software_architect", routeFromSA)
  .addConditionalEdges("ux_designer", routeFromUXD)
  .addConditionalEdges("backend_software_engineer", routeFromBSE)
  .addConditionalEdges("frontend_software_engineer", routeFromFSE)
  .addConditionalEdges("quality_engineer", routeFromQE);

const app = workflow.compile({ checkpointer });
export { app, routerLLM };
