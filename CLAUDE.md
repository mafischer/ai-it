# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Running the Project

```bash
npm install          # Install dependencies (runs postinstall patch for LangChain)
node server.js       # Start API server on port 3000
DEBUG=true node server.js  # With verbose logging
node test-run.js     # Run a test workflow (streams output, no assertions)
./restart.sh         # Restart vllm-mlx, ai-it, and Open WebUI services
```

## Environment Variables

| Variable | Default | Purpose |
|---|---|---|
| `QWEN3_5_27B_URL` | `http://127.0.0.1:8081/v1` | Specialist model endpoint |
| `QWEN3_5_27B_KEY` | (none) | API key for specialist model |
| `LFM2_8B_URL` | `http://10.3.0.241:8080/v1` | Router model endpoint |
| `THINKING_BUDGET` | `2048` | Token budget for reasoning |
| `DEBUG` | (unset) | Set to `true` for verbose logging |

## Architecture

**AI-IT** is a multi-agent system where tech org roles are filled by AI agents. It exposes an **OpenAI-compatible API** on port 3000 (`/v1/models`, `/v1/chat/completions`) and is designed to work with any OpenAI-compatible client (e.g., Open WebUI).

### Agent Pipeline

```
User Directive → Business Analyst → [Software Architect ‖ UX Designer] → [Backend Engineer ‖ Frontend Engineer] → Quality Engineer → END
```

Approval loops allow Quality Engineer to send work back upstream. The two parallel pairs (Architect+UX, Backend+Frontend) run concurrently via LangGraph.

### Routing Mechanism

Agents append `STATUS: <TOKEN>` to their output (e.g., `STATUS: REQUIREMENTS_DRAFTED`). Routing rules are defined declaratively in `workflow.json` — each agent has a `routes` map of STATUS tokens to targets. `index.js` builds route functions dynamically from this config, using the **last** STATUS match to avoid false matches from thinking content. Special DSL tokens: `$self` (loop back), `__end__` (stop), `$map_previous` (context-dependent mapping), `$previous_matching` (find last matching agent), and array targets for parallel fan-out. Unrecognized tokens fall back to an LLM router (`lfm2-8b`).

When BA outputs `DIRECTIVE_AMBIGUOUS`, the workflow stops at `END` and waits for user input. On the user's reply, BA skips the query prompt and goes directly to `main`, with the BA's prior questions and the user's answers injected via `priorQuestions`/`userResponse` Mustache template values in `workflow.json`.

### LLM Models

- **`qwen3.5-27b`** (specialist) — Used by all main agents; thinking budget enforced via patched vllm-mlx `MLXLanguageModel` (budget sent as `thinking_budget` in request body via `modelKwargs`). When budget is exceeded, generation is aborted and restarted with a continuation prompt that includes truncated thinking + `</think>`, forcing the model to produce content immediately.
- **`lfm2-8b`** (router/utility) — Used by the fallback router and for "utility" requests (messages with a system prompt)

### Thread Persistence

Thread IDs are MD5 hashes of the original user directive. LangGraph checkpoints are stored in `checkpoints.db` (SQLite), enabling conversation resumption across server restarts.

### Streaming

`server.js` buffers parallel agent outputs and serializes them in order with orchestration headers. Stats (tokens, latency, t/s) are tracked per agent and appended to output. A 15-second SSE heartbeat keeps connections alive. Client disconnect aborts the LangGraph workflow via `AbortController`. A 90-second stale request guard auto-aborts workflows that stop producing tokens. Abort signals propagate from `server.js` → LangGraph config → `genericNode` → `qwenLLM.invoke({ signal })` → HTTP fetch to vllm-mlx, enabling server-side cancellation.

## Key Files

- **`workflow.json`** — Declarative workflow DSL: agent definitions (role, emoji, mission, model, Mustache prompt templates), routing rules (STATUS → target with DSL tokens), pipeline config (entry agent, question statuses), and fallback router prompt. Edit this file to add/modify agents — no code changes needed.
- **`src/config/loader.js`** — Reads `workflow.json`; exports `getConfig()`, `getActiveAgents()`, `getAgent()`, `getAgentEmojis()`, `getAgentMissions()`, `getRouting()`, `getPipeline()`
- **`src/config/templates.js`** — Mustache renderer: `renderPrompt(agentId, variant, values)` with HTML escaping disabled
- **`src/config/routing.js`** — Resolves DSL routing tokens (`$self`, `$map_previous`, `$previous_matching`, `__end__`, arrays) into concrete agent IDs
- **`index.js`** — LangGraph workflow: builds graph dynamically from `workflow.json`, generic node implementation, config-driven routing and prompt selection, compiled with SQLite checkpointer
- **`server.js`** — Express server: OpenAI-compatible endpoints, streaming multiplexer, thread ID management, admin API (`/admin/api/*`), lifecycle hooks (graceful shutdown, stale connection flush)
- **`admin/index.html`** — Vue.js 3 + Vuetify 3 SPA for the admin UI (`/admin`). Thread list with active status polling, thread detail with message viewer, rewind, abort, and delete. Dark theme with Material Design.
- **`src/agents/roles.js`** — Legacy prompt definitions (no longer imported by `index.js`; prompts now live in `workflow.json` as Mustache templates)
- **`src/utils/llm.js`** — `createLLM(modelId)` factory; maps model IDs to env vars, sets `maxTokens: 32768`, temperature 0, disables fetch timeouts; passes `thinking_budget` via `modelKwargs` for Qwen3 models
- **`src/agents/factory.js`** — `createAgent()` helper (not used in main pipeline)
- **`patches/langchain-openai-reasoning.js`** — Postinstall patch for `@langchain/openai` to preserve `reasoning_content` from vllm-mlx's reasoning parser; wraps it in `<think>` tags so Open WebUI renders collapsible thinking blocks
- **`restart.sh`** — Restarts vllm-mlx, ai-it, and Open WebUI docker container
- **`vllm-service/vllm-mlx-wrapper`** — Wrapper script: intercepts `--thinking-budget` and `--context-window` flags, patches model's HF cache configs, kills zombie processes on the port, launches vllm-mlx, restores configs on exit/signal

## Service Configuration

- **`ai-it-service/`** — macOS LaunchAgent plist to run `server.js` as a system service (auto-start, auto-restart). Sets `THINKING_BUDGET=2048` env var.
- **`vllm-service/`** — LaunchAgent + wrapper script to serve `Qwen3.5-27B-5bit` locally via vllm-mlx on Apple Silicon (port 8081, 600s timeout); wrapper patches HF model cache configs at launch, kills zombie processes on the port, and restores configs on exit
- **Open WebUI** — Runs as a Docker container (`open-webui`), connecting to ai-it on port 3000
- LaunchAgent plists in `~/Library/LaunchAgents/` are **symlinks** to the repo copies — edit in-repo, then restart.

## Unintegrated Agents

`Site Reliability Engineer`, `DevOps Engineer`, and `Support Engineer` are defined in `workflow.json` with `"active": false` — they have prompts and routing but are excluded from the graph at build time.
