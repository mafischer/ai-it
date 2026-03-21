# GEMINI.md

This file provides guidance and technical context for Gemini CLI when working with code in this repository. *(Note: `CLAUDE.md` is symlinked to `GEMINI.md` for efficiency purposes).*

## Running the Project

```bash
npm install          # Install dependencies (runs postinstall patch for LangChain)
node server.js       # Start API server on port 3000
node test-run.js     # Run a test workflow (streams output, no assertions)
./restart.sh         # Restart vllm-mlx, ai-it, and Open WebUI services
```

## Architecture

**AI-IT** is a multi-agent system where tech org roles are filled by AI agents. It exposes an **OpenAI-compatible API** on port 3000 (`/v1/models`, `/v1/chat/completions`) and is designed to work with any OpenAI-compatible client (e.g., Open WebUI).

### Tech Stack
- **Server:** Fastify (migrated from Express)
- **Workflow:** `@langchain/langgraph`
- **Persistence:** SQLite (`@langchain/langgraph-checkpoint-sqlite`)
- **LLM Engine:** Multi-engine support configured in `workflow.json` (e.g., LM Studio, Llama Server)

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
    - **`main`**: The standard drafting/refinement phase. Injects `{{self}}` for iterative updates.

### Streaming & Real-time UI
- **Parallel SSE Multiplexing**: `server.js` buffers parallel chunks and serializes them. Each agent's stream includes an `agent` identifier in the chunk delta.
- **Frontend Buffering**: `app/chat.js` and `app/index.html` maintain `activeStreamStates` per agent to prevent text interleaving during parallel execution.
- **Finish Signals**: The server emits a per-agent `finish_reason: "stop"` to allow the UI to clear individual spinners immediately.

## Key Features

### Admin UI (Thread List & Detail)
- **Thread List**: Displays active status, message counts, and participating agents.
- **Rewind**: Restarts the workflow from a specific historical message.
- **Edit & Restart**: Allows modifying a message's content (via a popup editor) before triggering a rewind.
- **Expand/Collapse**: Support for individual message toggling and "Expand/Collapse All".
- **Timestamps**: Preserved across rewinds and refreshes using `additional_kwargs` in LangGraph messages.

### Chat UI
- **Interactive Bubbles**: Clicking any message bubble toggles its expansion.
- **Control Layout**: "Expand/Collapse All" is aligned left of the reply box; "Stop" is accessible via the sidebar item menu for active threads.
- **History Export**: Generates a dark-themed HTML file with collapsible `<think>` blocks, agent labels, and timestamps.

## Key Files & Directories

- **`workflow.json`** — Workflow DSL: engines, models, entry, agent definitions, and routing.
- **`templates/`** — Markdown templates using Mustache. Supports `{{self}}` for iterative refinement and `{{clarificationHistory}}` with `{{responder}}` labels.
- **`index.js`** — LangGraph definition. Contains `sync_node` logic and prompt selection heuristics.
- **`server.js`** — Fastify server + SSE multiplexer. Handles `/api/threads/*` admin endpoints.
- **`src/config/loader.js`** — Configuration parser.
- **`src/utils/llm.js`** — LLM factory.
- **`patches/langchain-openai-reasoning.js`** — Preserves `<think>` blocks from reasoning models.

## Service Configuration

- **`ai-it-service/`** — macOS LaunchAgent for `server.js`.
- **`vllm-service/`** — LaunchAgent for local LLM serving.

## Unintegrated Agents

`Site Reliability Engineer`, `DevOps Engineer`, and `Support Engineer` are defined in `workflow.json` with `"active": false`.
