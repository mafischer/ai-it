# AI-IT: Artificial Intelligence Information Technology

AI-IT is an agentic technology organization where typical tech roles are filled by AI agents. Powered by **LangGraph** and **LangChain** (Node.js), it uses distributed inference nodes to process complex tasks through a collaborative workflow.

## Project Structure

- `index.js`: The main entry point and LangGraph workflow definition.
- `server.js`: OpenAI-compatible HTTP API server (Express).
- `src/agents/`:
  - `factory.js`: Factory function for creating LangChain agents.
  - `roles.js`: System prompts and definitions for each organizational role.
- `src/utils/llm.js`: Configuration for distributed LLM runtimes (vLLM, Ollama, LM Studio, etc.).
- `service/`: macOS LaunchAgent for running the local inference backend.
  - `com.aiit.vllm-mlx.plist`: LaunchAgent plist.
  - `vllm-mlx-wrapper`: Wrapper script — see [Local Inference Service](#local-inference-service) below.

## API Server

`server.js` exposes an OpenAI-compatible API on port `3000`, making the agent organization usable from any OpenAI-compatible client (Open WebUI, curl, etc.).

| Endpoint | Description |
|---|---|
| `GET /v1/models` | Returns the `ai-it-org` model identifier |
| `POST /v1/chat/completions` | Accepts a user directive and runs it through the agent pipeline; supports both streaming (`stream: true`) and non-streaming responses |

**Streaming** uses Server-Sent Events. Responses from parallel agents (e.g. Software Architect and UX Designer running concurrently) are multiplexed into a single ordered stream with orchestration headers between each agent's output.

```bash
node server.js
```

Set `DEBUG=true` to log all raw inference output to stdout.

## Agents

- **Business Analyst**: Translates business needs into requirements.
- **Software Architect**: High-level system design and technical integrity.
- **UX Engineer**: Focuses on user interface and experience.
- **Software Engineer**: Implementation and coding.
- **Quality Engineer**: Testing and validation.
- **Support Engineer**: Debugging and user assistance.
- **Site Reliability Engineer**: System availability and performance.
- **DevOps Engineer**: CI/CD and automation.

## Getting Started

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure LLM Runtimes

AI-IT uses two models with separate roles:

| Model | Role | Default endpoint |
|---|---|---|
| `qwen3.5-27b` | Specialist agents (all reasoning work) | `http://127.0.0.1:8081/v1` |
| `lfm2-8b` | Fallback router (JSON routing decisions) | `http://10.3.0.241:8080/v1` |

Override endpoints and API keys via environment variables — the model ID is uppercased with non-alphanumeric characters replaced by `_`:

```bash
export QWEN3_5_27B_URL="http://your-host:8081/v1"
export QWEN3_5_27B_KEY="your-api-key"   # optional

export LFM2_8B_URL="http://your-host:8080/v1"
```

**Thinking budget** for the Qwen3.5-27B model defaults to `1500` tokens and can be overridden:

```bash
export THINKING_BUDGET=2048
```

### 3. Run the Server

```bash
node server.js
```

Point any OpenAI-compatible client at `http://localhost:3000/v1`.

## Local Inference Service

`service/` contains a macOS LaunchAgent that runs `vllm-mlx` serving `mlx-community/Qwen3.5-27B-5bit` on port `8081`.

### vllm-mlx-wrapper

`vllm-mlx` exposes no server-level flags for context window or thinking budget — these are model config values. The wrapper script (`service/vllm-mlx-wrapper`) works around this by:

1. Intercepting `--thinking-budget` and `--context-window` arguments (not passed to vllm-mlx)
2. Resolving the model's Hugging Face cache directory from the model ID argument
3. Patching `config.json` (`text_config.max_position_embeddings`) and `generation_config.json` (`thinking_budget`) in-place before launch
4. Restoring the original files on exit, crash, or signal (`EXIT`, `INT`, `TERM`, `HUP`)

### Installing the service

```bash
cp service/com.aiit.vllm-mlx.plist ~/Library/LaunchAgents/
cp service/vllm-mlx-wrapper ~/.vllm-mlx/
chmod +x ~/.vllm-mlx/vllm-mlx-wrapper
launchctl load ~/Library/LaunchAgents/com.aiit.vllm-mlx.plist
```

### Service configuration

Edit the `ProgramArguments` in the plist to change inference parameters:

| Flag | Description | Default |
|---|---|---|
| `--port` | Port vllm-mlx listens on | `8081` |
| `--max-tokens` | Max output tokens per request | `8192` |
| `--thinking-budget` | Thinking token budget (wrapper flag) | `1500` |
| `--context-window` | Context window size (wrapper flag) | `10240` |

After editing the plist, reload the service:

```bash
cp service/com.aiit.vllm-mlx.plist ~/Library/LaunchAgents/
launchctl unload ~/Library/LaunchAgents/com.aiit.vllm-mlx.plist
launchctl load ~/Library/LaunchAgents/com.aiit.vllm-mlx.plist
```

Logs are written to `~/.vllm-mlx/vllm.out` and `~/.vllm-mlx/vllm.err`.

## Workflow

The pipeline is status-driven: each agent appends a `STATUS: <TOKEN>` tag to its output, and the LangGraph router uses that to determine the next node. An LLM-based fallback router handles any unrecognised status.

```
User Directive
      |
 Business Analyst  ←─────────────────────────────┐
      |                                           │ (approval / rejection loop)
      ├──────────────────────────┐                │
      ↓                          ↓                │
Software Architect          UX Designer           │
      │                          │                │
      ↓                          ↓                │
Backend Engineer         Frontend Engineer        │
      │                          │                │
      └──────────┬───────────────┘                │
                 ↓                                │
          Quality Engineer ───────────────────────┘
                 |
                END
```

Agents can loop within their own phase (e.g. `BA_PHASE_CONTINUE`) and escalate questions upstream before proceeding. Thread state is persisted in `checkpoints.db` (SQLite) keyed by an MD5 of the original directive, so conversations can be resumed across sessions.
