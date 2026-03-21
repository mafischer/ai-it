# GEMINI.md

This file provides guidance and technical context for Gemini CLI when working with code in this repository.

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

### Routing Mechanism

Agents append `STATUS: <TOKEN>` to their output (e.g., `STATUS: REQUIREMENTS_DRAFTED`). Routing rules are defined declaratively in `workflow.json` — each agent has a `routes` map of STATUS tokens to targets. Special DSL tokens: `$self` (loop back), `__end__` (stop), `$map_previous` (context-dependent mapping), `$previous_matching` (find last matching agent), and array targets for parallel fan-out. Unrecognized tokens fall back to an LLM router.

### LLM Models & Engines

Configured in `workflow.json` under `engines` and `models`:
- **Specialist Model:** Used by main agents. Currently points to `lm-studio` running `qwen3.5-27b` (default URL: `http://localhost:1234/v1`).
- **Router/Utility Model:** Used by the fallback router. Currently points to `llama-server` running `lfm2-8b` (default URL: `http://10.3.0.241:8080/v1` via `LFM2_8B_KEY`).

### Thread Persistence

Thread IDs are MD5 hashes of the original user directive. LangGraph checkpoints are stored in `checkpoints.db` (SQLite), enabling conversation resumption across server restarts.

### Streaming & Job Handling

`server.js` acts as a background job runner and SSE multiplexer. It buffers parallel agent outputs and serializes them in order. Stats (tokens, latency, t/s) are tracked per agent and appended to stderr. A 15-second SSE heartbeat keeps connections alive. Client disconnects do not immediately abort the workflow; they operate as decoupled jobs. A stale request guard auto-aborts workflows that stop producing tokens. Abort signals propagate enabling server-side cancellation.

## Key Files & Directories

- **`workflow.json`** — Declarative workflow DSL: engines, models, pipeline entry, agent definitions (role, emoji, mission, model configuration), and routing rules.
- **`templates/`** — Markdown templates for agent prompts (e.g., `main.md`, `query.md`, `approval.md`, `continue.md`). They use Mustache tags to inject dynamic context.
- **`src/config/loader.js`** — Reads `workflow.json` and exports configuration helpers.
- **`src/config/templates.js`** — Mustache renderer (`renderPrompt`) with HTML escaping disabled.
- **`src/config/routing.js`** — Resolves DSL routing tokens (`$self`, `$map_previous`, `$previous_matching`, `__end__`, arrays) into concrete agent IDs.
- **`index.js`** — LangGraph workflow definition. Builds the StateGraph dynamically from `workflow.json`. Each agent is represented by two nodes: a prompt generation node and the LLM invocation node.
- **`server.js`** — Fastify server providing OpenAI-compatible endpoints (`/v1/chat/completions`), background workflow execution, SSE streaming multiplexer, thread ID management, and admin APIs (`/api/threads/*`).
- **`src/utils/llm.js`** — `createLLM(key)` factory mapped to `workflow.json` model configurations. Passes `thinking_budget` and custom modelKwargs.
- **`app/`** — Frontend assets for the admin UI.
- **`patches/langchain-openai-reasoning.js`** — Postinstall patch for `@langchain/openai` to preserve `reasoning_content` from vllm-mlx's reasoning parser; wraps it in `<think>` tags.

## Service Configuration

- **`ai-it-service/`** — macOS LaunchAgent plist to run `server.js` as a system service.
- **`vllm-service/`** — LaunchAgent + wrapper script to serve models locally via vllm-mlx on Apple Silicon.

## Unintegrated Agents

`Site Reliability Engineer`, `DevOps Engineer`, and `Support Engineer` are defined in `workflow.json` with `"active": false` — they have prompts and routing but are excluded from the graph at build time.
