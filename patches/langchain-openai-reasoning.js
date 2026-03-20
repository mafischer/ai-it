/**
 * Post-install patch for @langchain/openai to preserve reasoning_content
 * from OpenAI-compatible APIs (e.g., vllm-mlx with --reasoning-parser).
 *
 * LangChain drops delta.reasoning_content entirely. This patch wraps it
 * in <think> tags so it flows through as content, which Open WebUI renders
 * as collapsible thinking blocks.
 */
import { readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

const ORIGINAL = `const content = delta.content ?? "";`;
const PATCHED = `let content;
\tif (reasoning) {
\t\tconst prefix = _reasoningActive ? "" : "<think>";
\t\t_reasoningActive = true;
\t\tcontent = prefix + reasoning + (delta.content ? "</think>" + delta.content : "");
\t\tif (delta.content) _reasoningActive = false;
\t} else if (_reasoningActive && delta.content) {
\t\t_reasoningActive = false;
\t\tcontent = "</think>" + delta.content;
\t} else {
\t\tcontent = delta.content ?? "";
\t}`;

const ORIGINAL_DECL = `const convertCompletionsDeltaToBaseMessageChunk = ({`;
const PATCHED_DECL = `let _reasoningActive = false;\nconst convertCompletionsDeltaToBaseMessageChunk = ({`;

const ORIGINAL_REASONING_LINE = `const content = delta.content ?? "";`;
const PATCHED_REASONING_DECL = `const reasoning = delta.reasoning_content ?? delta.reasoning ?? "";\n\t${PATCHED}`;

for (const ext of ["js", "cjs"]) {
    const file = join(root, `node_modules/@langchain/openai/dist/converters/completions.${ext}`);
    try {
        let src = readFileSync(file, "utf8");
        if (src.includes("_reasoningActive")) {
            console.log(`[patch] ${ext}: already patched`);
            continue;
        }
        if (!src.includes(ORIGINAL)) {
            console.warn(`[patch] ${ext}: original string not found, skipping`);
            continue;
        }
        // Add _reasoningActive state variable before the function
        src = src.replace(ORIGINAL_DECL, PATCHED_DECL);
        // Add reasoning extraction and replace content assignment
        src = src.replace(ORIGINAL_REASONING_LINE, PATCHED_REASONING_DECL);
        writeFileSync(file, src);
        console.log(`[patch] ${ext}: patched successfully`);
    } catch (e) {
        console.error(`[patch] ${ext}: ${e.message}`);
    }
}
