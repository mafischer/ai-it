# GEMINI.md

This file provides guidance and technical context for Gemini CLI when working with code in this repository. *(Note: `CLAUDE.md` is symlinked to `GEMINI.md` for efficiency purposes).*

## Running the Project

```bash
npm install          # Install dependencies (runs postinstall patch for LangChain)
node server.js       # Start API server on port 3000
node test-run.js     # Run a test workflow (streams output, no assertions)
./restart.sh         # Restart the ai-it API server
```

## Architecture

**AI-IT** is a multi-agent system where tech org roles are filled by AI agents. It exposes an **OpenAI-compatible API** on port 3000 (`/v1/models`, `/v1/chat/completions`) and an **MCP endpoint** (`/mcp`) and is designed to work with any OpenAI-compatible client (e.g., Open WebUI) or MCP client.

### Tech Stack
- **Server:** Fastify (migrated from Express)
- **Workflow:** `@langchain/langgraph`
- **Persistence:** SQLite (`@langchain/langgraph-checkpoint-sqlite`)
- **LLM Engine:** Multi-engine support with round-robin load balancing, configured in `workflow.json` (e.g., LM Studio, Llama Server)
- **Tools:** MCP-based tool system (`@modelcontextprotocol/sdk`) with web search and page fetching

### Agent Pipeline

```
User Directive → Business Analyst → [Software Architect ‖ UX Designer] → [Backend Engineer ‖ Frontend Engineer] → Quality Engineer → END
```

Approval loops allow Quality Engineer to send work back upstream. The two parallel pairs (Architect+UX, Backend+Frontend) run concurrently via LangGraph.

### Parallel Synchronization (Fan-In)
`index.js` implements a `sync_node` mechanism for parallel branches (e.g., Software Architect and UX Designer).
- Branches route to a `sync_<group>` node which pauses until all members finish.
- The sync node evaluates combined status: if any member requires clarification from the parent (e.g., Business Analyst), the entire group is routed back.
- If all are approved, the flow proceeds to implementers (Backend/Frontend).

### Routing Mechanism
Agents append `STATUS: <TOKEN>` to their output.
- **`workflow.json`**: Declarative routing rules.
- **DSL Tokens**: `$self`, `__end__`, `$map_previous`, `$previous_matching`, and array targets for fan-out.
- **Prompt Selection**: `index.js` intelligently selects templates:
    - **`query`**: Initial gathering/ambiguity phase. Bypassed if rounds are exhausted or if a "CLEAR/DRAFTED" state was already reached.
    - **`approval`**: Triggered when downstream agents return work for review.
    - **`main`**: The standard drafting/refinement phase. Injects `{{self}}` for iterative updates. For tool-eligible agents, enables web research tools.
- **Auto-Continuation**: To handle context window truncation, `index.js` uses an **Assistant Prefill** pattern. When a response is cut off, the system provides the accumulated text as the final assistant message in the next turn. This signals the LLM to resume typing without a new instruction turn, preventing repetition loops and preserving the train of thought. All whitespace is preserved during stitching for a 100% seamless transition.

### Clarification Rounds
- Configured via `pipeline.maxClarificationRounds` in `workflow.json` (default: 5).
- `pipeline.question_statuses` defines which STATUS tokens count as clarification rounds: `["DIRECTIVE_AMBIGUOUS", "REQUIREMENTS_AMBIGUOUS", "QUESTION"]`.
- When rounds are exhausted, agents are instructed to fill remaining gaps using professional judgment, industry standards, and best practices.
- The `{{self}}` template variable filters out query-phase outputs (statuses ending in `_CLEAR`) so they don't appear as prior work product in the main phase.

### Web Research Tools
During the main phase, tool-eligible agents (Business Analyst, Software Architect, UX Designer) perform a structured, two-phase web research pass before drafting to ensure their recommendations align with the latest industry standards:
- **Phase 1 (Search & Select)**: The agent uses `web_search` (DuckDuckGo HTML lite) to find current best practices and submits up to 5 URLs via the `submit_links` tool. The agent's prompt automatically injects the current date so searches target recent information.
- **Phase 2 (Parallel Extraction)**: The system automatically fetches the submitted URLs using `fetch_page` in parallel. For each successfully fetched page, a dynamically generated sub-agent reads the content and extracts *only* the relevant industry best practices, streaming its extraction back to the UI. The aggregated extractions are then appended to the final context window for the Phase 3 drafting agent.

**How it works:**
1. `getPromptForNode()` returns `{ prompt, useTools }` — `useTools: true` for main prompts of BA, SA, UX.
2. `promptNode` stores the `useTools` flag in the system message's `additional_kwargs`.
3. `agentNode` checks the flag and runs `runResearch()` before the streamed final generation.
4. `runResearch()` triggers Phase 1, looping with `web_search` and `submit_links` (max 5 rounds).
5. The selected links are processed in parallel in Phase 2, using `fetch_page` and a dedicated extraction LLM prompt. The sub-agent names (e.g. `business_analyst_research_phase_2_1`) ensure the UI properly multiplexes and renders each parallel extraction stream.
6. The combined research findings are injected into the context for the final Phase 3 streamed generation.

### UI Empty State Workflows
When starting a new thread, users must select a predefined workflow from a dropdown (e.g., "Standard Software Development", "Research Only", "Frontend Feature"). The UI blocks the input text area until a valid workflow route is selected.

### Load Balancing
Engine URLs in `workflow.json` accept an array for round-robin load balancing:
```json
"lm-studio": {
  "url": ["http://host1:1234/v1", "http://host2:1234/v1"],
  "capabilities": ["text", "reasoning"]
}
```
`src/utils/llm.js` creates a `ChatOpenAI` instance per URL and wraps them in a `Proxy` that cycles through on each `stream()` or `invoke()` call. Single-URL engines skip the proxy.

### Streaming & Real-time UI
- **Parallel SSE Multiplexing**: `server.js` buffers parallel chunks and serializes them. Each agent's stream includes an `agent` identifier in the chunk delta.
- **Frontend Buffering**: `app/chat.js` and `app/index.html` maintain `activeStreamStates` per agent to prevent text interleaving during parallel execution. Uses a robust regex-based multi-block thinking parser.
- **Finish Signals**: The server emits a per-agent `finish_reason: "stop"` to allow the UI to clear individual spinners immediately.

## Key Features

### Admin UI (Thread List & Detail)
- **Thread List**: Displays active status, message counts, participating agents, and sticky control panel header.
- **Rewind**: Restarts the workflow from a specific historical message. Detects prompt-rewinds to bypass regeneration.
- **Edit & Restart**: Allows modifying a message's content (via a popup editor) before triggering a rewind.
- **Expand/Collapse**: Support for individual message toggling (click bubble) and "Expand/Collapse All".
- **Timestamps**: Preserved across rewinds and refreshes using `additional_kwargs` in LangGraph messages.

### Chat UI
- **Interactive Bubbles**: Clicking any message bubble toggles its expansion. Chevrons are located inside the top-right corner.
- **Control Layout**: "Expand/Collapse" is aligned left of the reply box; "Stop" is accessible via the sidebar item menu for active threads.
- **History Export**: Generates a JSON file (or refined HTML via export function) with collapsible `<think>` blocks, agent labels, and timestamps.

## Key Files & Directories

- **`workflow.json`** — Workflow DSL: engines, models, entry, agent definitions, and routing.
- **`templates/`** — Markdown templates using Mustache. Supports `{{self}}` for iterative refinement and `{{clarificationHistory}}` with `{{responder}}` labels.
- **`index.js`** — LangGraph definition. Contains `sync_node` logic, prompt selection heuristics, and web research tool-calling loop.
- **`server.js`** — Fastify server + SSE multiplexer. Handles `/api/threads/*` admin endpoints and `/mcp` MCP tool endpoint.
- **`src/config/loader.js`** — Configuration parser. Handles env var resolution, engine discovery.
- **`src/utils/llm.js`** — LLM factory with round-robin load balancing.
- **`patches/langchain-openai-reasoning.js`** — Preserves `<think>` blocks from reasoning models.

## Service Configuration

- **`ai-it-service/`** — macOS LaunchAgent for `server.js`.
- **`vllm-service/`** — LaunchAgent for local LLM serving.

## Unintegrated Agents

`Site Reliability Engineer`, `DevOps Engineer`, and `Support Engineer` are defined in `workflow.json` with `"active": false`.
