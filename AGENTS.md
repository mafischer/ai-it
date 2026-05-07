# GEMINI.md

This file provides guidance and technical context for Gemini CLI when working with code in this repository. *(Note: `CLAUDE.md` is symlinked to `GEMINI.md` for efficiency purposes).*

## Running the Project

```bash
npm install          # Install dependencies (runs postinstall patch for LangChain)
node server.js       # Start API server on port 3000
./restart.sh         # Restart the ai-it API server
```

## Architecture

**AI-IT** is a multi-agent system where tech org roles are filled by AI agents. It exposes an **OpenAI-compatible API** on port 3000 (`/v1/models`, `/v1/chat/completions`) and an **MCP endpoint** (`/mcp`) and is designed to work with any OpenAI-compatible client (e.g., Open WebUI) or MCP client.

### Tech Stack
- **Server:** Fastify (migrated from Express)
- **Workflow:** `@langchain/langgraph`
- **Persistence:** SQLite (`@langchain/langgraph-checkpoint-sqlite`) for checkpoints and thread lineage
- **RAG:** PostgreSQL + pgvector for research chunk storage and retrieval (`src/utils/rag.js`)
- **Embeddings:** `nomic-embed-text-v1.5` via local llama-server (768 dims)
- **LLM Engine:** Multi-engine support with round-robin load balancing, configured in `workflow.json` (e.g., LM Studio, Llama Server)
- **Tools:** MCP-based tool system (`@modelcontextprotocol/sdk`) with web search and page fetching

### Agent Pipeline

```
User Directive → Business Analyst → [Software Architect ‖ UX Designer] → [Backend Engineer ‖ Frontend Engineer] → Quality Engineer → END
```

Approval loops allow Quality Engineer to send work back upstream. The two parallel pairs (Architect+UX, Backend+Frontend) run concurrently via LangGraph.

### Pipeline Milestones
`workflow.json` now defines a `pipeline.milestones` array that structures the workflow into named phases:
- **Project Initiation** — `DIRECTIVE_CLEAR`, `DIRECTIVE_AMBIGUOUS`
- **Requirements Definition** — `REQUIREMENTS_DRAFTED`, `REQUIREMENTS_CLEAR`, `REQUIREMENTS_AMBIGUOUS`
- **System & UX Design** — `DESIGN_DRAFTED`, `DESIGN_AMBIGUOUS`, `DESIGNS_APPROVED`, `DESIGN_APPROVED`
- **Implementation** — `IMPLEMENTATION_COMPLETE`, `IMPLEMENTATION_APPROVED`, `IMPLEMENTATION_CLEAR`, `IMPLEMENTATION_AMBIGUOUS`
- **Quality Assurance** — `TESTING_COMPLETE`, `TESTS_PASSED`, `REJECTED`, `TESTING_CLEAR`, `TESTING_AMBIGUOUS`

Each milestone has `previous`/`next` links forming a doubly-linked list. Milestones end with `next: null` (no explicit "end" node). The UI uses milestone metadata for human-readable section labels instead of title-casing raw status tokens.

### Thread Spawning (Milestone-Based Context Reset)
At key milestone boundaries, the server ends the current LangGraph thread and spawns a new one, resetting the context window while preserving lineage:
- **Spawn milestones**: `REQUIREMENTS_CLEAR`, `DESIGNS_APPROVED`, `DESIGN_APPROVED`, `IMPLEMENTATION_APPROVED`
- The new thread is seeded with the original directive + milestone output(s) from prior agents, then routing continues forward.
- Parent-child links are stored in a `thread_links` SQLite table. `getRootThread()` walks up; `getThreadChain()` walks down.
- The thread list API filters out child threads (they appear as part of their parent chain, not standalone).
- The SSE stream emits `thread_transition` delta events so the UI can track the chain seamlessly.
- All threads in a chain share the same `root_thread_id` for RAG session continuity and Langfuse session grouping.

### Parallel Synchronization (Fan-In)
`index.js` implements a `sync_node` mechanism for parallel branches (e.g., Software Architect and UX Designer).
- Branches route to a `sync_<group>` node which pauses until all members finish.
- The sync node evaluates combined status: if any member requires clarification from the parent (e.g., Business Analyst), the entire group is routed back.
- If all are approved, the flow proceeds to implementers (Backend/Frontend).

### Routing Mechanism
Agents append `STATUS: <TOKEN>` to their output.
- **`workflow.json`**: Declarative routing rules.
- **DSL Tokens**: `$self` (same agent, same milestone context), `__end__` (return to user for input), `$map_previous`, `$previous_matching`, and array targets for fan-out. Named agent targets (e.g., `"business_analyst"`) resolve forward through the milestone chain, then same-milestone, then backward.
- **Prompt Selection**: `index.js` intelligently selects templates:
    - **`query`**: Initial gathering/ambiguity phase. Bypassed if rounds are exhausted or if a "CLEAR/DRAFTED" state was already reached.
    - **`approval`**: Triggered when downstream agents return work for review.
    - **`main`**: The standard drafting/refinement phase. Encompasses web research tools.
- **Context Handling (History vs. Prompts)**: To maintain efficiency, `index.js` prunes historical context variables (`last`, `self`, `input`, `upstream`) from the system prompt rendering. Instead, it injects the actual `validMsgs` chain directly into the LLM call (`messagesToPass`). This utilizes the LLM's natural ability to process conversation history while preventing compounding token growth and duplication.
- **Revision Rounds**: If an agent has already spoken in the current sub-chain, `index.js` injects explicit revision instructions at the end of the user prompt. For the UX Designer, this includes a strict directive to reuse Markdown image links for visually unchanged screens to prevent wasteful tool calls.
- **Auto-Continuation**: To handle context window truncation, `index.js` uses an **Assistant Prefill** pattern. When a response is cut off, the system provides the accumulated text as the final assistant message in the next turn. This signals the LLM to resume typing without a new instruction turn, preserving history and the train of thought.

### Clarification Rounds
- Configured via `pipeline.maxClarificationRounds` in `workflow.json` (default: 5). Can be overridden per-agent (e.g., `"maxClarificationRounds": 3` on SA/UX).
- `pipeline.question_statuses` defines which STATUS tokens count as clarification rounds: `["DIRECTIVE_AMBIGUOUS", "REQUIREMENTS_AMBIGUOUS", "QUESTION"]`.
- When rounds are exhausted, agents are instructed to fill remaining gaps using professional judgment, industry standards, and best practices.
- Templates bias agents toward confirming directives/requirements rather than inventing questions. SA/UX use "propose assumption + confirm" instead of open-ended questions.

### Web Research Tools
During the main phase, tool-eligible agents (Business Analyst, Software Architect, UX Designer) perform a structured research pass before drafting to ensure their recommendations align with the latest industry standards:
- **Phase 1 (Search & Select)**: The agent uses `web_search` (DuckDuckGo HTML lite) to find current best practices and submits URLs via the `submit_links` tool (max 3 rounds). The agent's prompt automatically injects the current date so searches target recent information.
- **Phase 2 (Fetch & Store in RAG)**: The system fetches submitted URLs in parallel using `fetch_page`, then stores the content as embedded chunks in PostgreSQL/pgvector via `storeArticle()`. A RAG query retrieves the most relevant chunks, followed by a single unified LLM extraction call that synthesizes findings with source citations.
- **RAG Sharing**: All agents in a thread chain share the same RAG session (`root_thread_id`), so research done by the BA is available to downstream agents (SA, UX, etc.) without re-fetching.

### Image Generation (ComfyUI / Flux 2 Klein)
The UX Designer agent can generate UI mockup images during the main phase via a `generate_image_mockup` tool:
- **Model**: Upgraded to **Flux 2 Klein 9B Distilled**, optimized for 4-step ultra-fast inference and unified editing.
- **Tool implementation**: `tools/comfyui/tools.js` communicates with ComfyUI via API, injecting prompts into the Qwen 3 8B text encoder.
- **Natural Language Prompting**: UX Designer system prompts include industry best practices for Flux 2, emphasizing descriptive natural language and accurate typography over keyword-based tags.
- **Reuse Policy**: During revision rounds, agents are instructed to reuse existing image URLs from the chat history rather than regenerating them, unless visual changes are required.
- **Heartbeat**: Emits status events every 30s during generation to prevent stale-guard kills.

### Content Extraction
`tools/web-search/tools.js` extracts page content by targeting `<article>` or `<main>` elements before falling back to `<body>`. It strips code blocks, sidebars, comments, navigation, pagination, and other non-content elements to maximize signal density for research extraction.

### UI Empty State Workflows
When starting a new thread, users select a workflow from a dynamically loaded dropdown (fetched from `/api/workflows`). The UI blocks the input text area until a valid workflow is selected.

### Workflow Builder (`app/builder.js`)
A visual drag-and-drop editor for `workflow.json` files, accessible at `/builder`:
- **Milestone-centric layout**: Agents appear once per milestone they participate in (not once globally). Each agent instance shows only the routes relevant to that milestone's statuses. Orphan statuses (not in any milestone) attach to the agent's last milestone instance.
- **Bounding boxes**: Dashed milestone boxes auto-computed from contained node positions with `MIN_EXTEND` (100px) padding. Boxes have top (incoming) and bottom (outgoing) connection dots. Boxes are draggable — moving all contained nodes collectively. Boxes repel each other with configurable gap to prevent overlap.
- **Node types**: Agent, User (teal border, for user interaction points), System (purple border), Milestone (dashed blue border). User nodes in the first milestone represent "Prompt & Feedback".
- **Edge routing**: Edges use cubic bezier curves extending `MIN_EXTEND` away from nodes before curving (visible in gap space, not behind nodes). Cross-milestone edges split into two segments routed through milestone boundary dots, connected by dashed milestone-to-milestone arrows.
- **Draggable labels**: Edge labels render as HTML divs above nodes (z-index 15). Labels repel away from node rects on initial render. Labels are draggable — the edge path re-routes through the label position using a single smooth cubic bezier (computed via t=0.5 pass-through formula). Labels move with their milestone when dragged.
- **Zoom**: Mouse-wheel zoom (0.01 step) with cursor-anchored scroll compensation. Canvas is 10000x10000px to support deep zoom-out.
- **JSON sync**: Visual state syncs bidirectionally with raw JSON. `syncToRawJson()` merges per-milestone agent routes back into unified routing, preserving `approval_triggers` and `fallback`. `parseJson()` auto-migrates legacy single-instance layouts to per-milestone instances.
- **Builder API**: `GET /api/workflows` (list), `GET /api/workflow?name=` (read), `PUT /api/workflow?name=` (write + re-init config).

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
- **Parallel SSE Multiplexing**: `server.js` buffers parallel chunks and serializes them. Each agent's stream includes an `agent` identifier in the chunk delta. Stream timestamps use the SSE `created` field for accurate event ordering across parallel agents.
- **Frontend Buffering**: `app/chat.js` and `app/index.html` maintain `activeStreamStates` per agent to prevent text interleaving during parallel execution. Uses a greedy regex thinking parser (first `<think>` to last `</think>`) to handle models that output `</think>...<think>` mid-thought.
- **Stream Reconnection**: On stream end or 404, the UI retries after 500ms–1s if the thread is still active. Rewind/edit operations properly stop existing streams before reconnecting.
- **Milestone Sections**: Both chat and admin UI group messages into collapsible milestone sections. Thread transitions insert boundary markers (`__boundary__` type, hidden from chat bubbles). Sections are labeled by milestone status or agent name, with round numbers for duplicates. Active sections stay open; completed ones auto-collapse.
- **Finish Signals**: The server emits a per-agent `finish_reason: "stop"` to allow the UI to clear individual spinners immediately.

## Key Features

### Admin UI (Thread List & Detail)
- **Thread List**: Displays active status, message counts, participating agents, and sticky control panel header. Child threads (spawned at milestones) are hidden from the list.
- **Thread Chain**: The `?chain=true` query param on `/api/threads/:id/messages` returns messages across the full thread chain with boundary markers. Rewind, edit, clone, and rate operations resolve to the correct source thread via `resolveMsg()`.
- **Workflow Visualizer**: A 'View Visualizer' button opens an iframe of the Workflow Builder in read-only mode, showing live execution progress across milestones and active agents.
- **Rewind**: Restarts the workflow from a specific historical message. Detects prompt-rewinds to bypass regeneration. Chain-aware: navigates to the source thread if different and fetches updated metadata (like thread title) immediately.
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
- **`index.js`** — LangGraph definition. Contains `sync_node` logic, prompt selection heuristics, web research tool-calling loop, and `THREAD_SPAWN_MILESTONES`.
- **`app/builder.js`** — Workflow Builder visual editor (Vue component). Milestone-centric drag-and-drop canvas with bezier edge routing.
- **`tools/comfyui/`** — ComfyUI/Flux 2 Klein integration for UX mockup image generation.
- **`server.js`** — Fastify server + SSE multiplexer. Handles `/api/threads/*` admin endpoints, `/api/workflow*` builder endpoints, `/mcp` MCP tool endpoint, thread spawning loop, and thread lineage tracking.
- **`src/utils/rag.js`** — RAG pipeline: pgvector-backed chunk storage, embedding via local llama-server, semantic query.
- **`src/config/loader.js`** — Configuration parser. Handles env var resolution, engine discovery.
- **`src/utils/llm.js`** — LLM factory with round-robin load balancing.
- **`patches/langchain-openai-reasoning.js`** — Preserves `<think>` blocks from reasoning models.

## Environment Variables
- `LANGFUSE_SECRET_KEY`, `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_HOST` / `LANGFUSE_BASE_URL` — Langfuse tracing
- `RAG_DATABASE_URL` — PostgreSQL connection string for pgvector RAG storage (e.g., `postgresql://user:pass@host:5432/db`)
- `RAG_EMBEDDINGS_URL` — Embedding endpoint URL (default: `http://10.3.0.241:8082/v1/embeddings`)

## Service Configuration

- **`ai-it-service/`** — macOS LaunchAgent for `server.js`.
- **`vllm-service/`** — LaunchAgent for local LLM serving.

## Unintegrated Agents

`Site Reliability Engineer`, `DevOps Engineer`, and `Support Engineer` are defined in `workflow.json` with `"active": false`.
