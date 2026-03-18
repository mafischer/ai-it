# AI-IT: Artificial Intelligence Information Technology

AI-IT is an agentic technology organization where typical tech roles are filled by AI agents. Powered by **LangGraph** and **LangChain** (Node.js), it uses distributed inference nodes to process complex tasks through a collaborative workflow.

## Project Structure

- `index.js`: The main entry point and LangGraph workflow definition.
- `src/agents/`:
  - `factory.js`: Factory function for creating LangChain agents.
  - `roles.js`: System prompts and definitions for each organizational role.
- `src/utils/llm.js`: Configuration for distributed LLM runtimes (vLLM, Ollama, LM Studio, etc.).

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

### 1. Configure LLM Runtimes

AI-IT dynamically resolves inference nodes based on model IDs. You can specify a separate URL for each model by setting environment variables in the format `[MODEL]_[SIZE]_[QUANT]_URL`.

For example, to configure a Llama3 8B node:

```bash
# Map "llama3-8b" to its inference endpoint
export LLAMA3_8B_URL="http://your-ollama-node:11434/v1"

# Optionally, provide an API key for secure endpoints
export LLAMA3_8B_KEY="your-api-key"
```

The system will normalize the model ID (e.g., `llama3.1-70b-q4` becomes `LLAMA3_1_70B_Q4`) for looking up its corresponding environment variable.

### 2. Install Dependencies

```bash
npm install
```

### 3. Run the Organization

You can run the main workflow by executing `index.js`. You can also integrate it into your own scripts by importing the compiled `app` from `index.js`.

```bash
node index.js
```

## Workflow

The default workflow follows this path:
1. **User Request** -> **Business Analyst**
2. **Business Analyst** -> **Software Architect**
3. **Software Architect** -> **UX Engineer**
4. **UX Engineer** -> **Software Engineer**
5. **Software Engineer** -> **Quality Engineer**
6. **Quality Engineer** -> **End**
