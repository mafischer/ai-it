/**
 * Post-install patch for @langchain/openai to preserve reasoning_content
 * from OpenAI-compatible APIs (e.g., vllm-mlx with --reasoning-parser).
 */
import { readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

for (const ext of ["js", "cjs"]) {
    const file = join(root, `node_modules/@langchain/openai/dist/converters/completions.${ext}`);
    try {
        let src = readFileSync(file, "utf8");
        let modified = false;

        // 1. Add per-stream state map
        if (!src.includes('const _reasoningStates = new Map();')) {
            src = 'const _reasoningStates = new Map();\n' + src;
            modified = true;
        }

        // 2. Patch convertCompletionsDeltaToBaseMessageChunk (streaming)
        // We use a Map to keep track of reasoning state per request ID to avoid parallel leakage.
        const deltaSearch = /const convertCompletionsDeltaToBaseMessageChunk = \(\{([\s\S]*?)\}\) => \{/m;
        if (deltaSearch.test(src) && !src.includes('const streamId = rawResponse.id')) {
            src = src.replace(deltaSearch, (match, args) => {
                return `const convertCompletionsDeltaToBaseMessageChunk = ({${args}}) => {
	const streamId = rawResponse.id;
	let _active = _reasoningStates.get(streamId) || false;
	const role = delta.role ?? defaultRole;
	const reasoning = delta.reasoning_content ?? delta.reasoning ?? "";
	let content = "";
	if (reasoning) {
		if (!_active) { content += "<think>"; _active = true; }
		content += reasoning;
	}
	if (delta.content) {
		if (_active) { content += "</think>"; _active = false; }
		content += delta.content;
	}
	_reasoningStates.set(streamId, _active);
	if (rawResponse.choices?.[0]?.finish_reason) _reasoningStates.delete(streamId);`
            });
            
            // Remove the old/original content/role lines that we just replaced with our custom logic
            // We need to be careful with the regex to not over-delete.
            // In my previous manual write, I had:
            // const role = delta.role ?? defaultRole;
            // const reasoning = delta.reasoning_content ?? delta.reasoning ?? "";
            // const content = (reasoning ? ("<think>" + reasoning + "</think>") : "") + (delta.content ?? "");
            
            src = src.replace(/(\t|\s)+const role = delta\.role \?\? defaultRole;\n(\t|\s)+const reasoning = delta\.reasoning_content [\s\S]*?const content = \(reasoning \? [\s\S]*?\)\n/m, "");
            // Or if it was the original:
            src = src.replace(/(\t|\s)+const role = delta\.role \?\? defaultRole;\n(\t|\s)+let content;\n(\t|\s)+if \(reasoning\) [\s\S]*?else \{[\s\S]*?content = delta\.content \?\? "";[\s\S]*?\}/m, "");
            
            modified = true;
        }

        // 3. Patch convertCompletionsMessageToBaseMessage (non-streaming / invoke)
        const msgSearch = /return new (?:_langchain_core_messages\.)?AIMessage\(\{([\s\S]*?)content: (?:require_output\.|handleMultiModalOutput\()(?:content|message\.content \|\| "")/m;
        if (msgSearch.test(src) && !src.includes('const reasoning = message.reasoning_content')) {
            src = src.replace(msgSearch, (match, args) => {
                const isCJS = match.includes('require_output.');
                const prefix = isCJS ? 'require_output.' : '';
                return `const reasoning = message.reasoning_content ?? message.reasoning ?? "";
			const content = (reasoning ? ("<think>" + reasoning + "</think>") : "") + (message.content || "");
			return new ${match.includes('_langchain_core_messages.') ? '_langchain_core_messages.' : ''}AIMessage({${args}content: ${prefix}handleMultiModalOutput(content`;
            });
            modified = true;
        }

        // 4. Global cleanup of _reasoningActive
        if (src.includes("_reasoningActive")) {
            src = src.replace(/let _reasoningActive = false;\n/g, "");
            modified = true;
        }

        if (modified) {
            writeFileSync(file, src);
            console.log(`[patch] ${ext}: patched successfully`);
        } else {
            console.log(`[patch] ${ext}: already patched or signature not found`);
        }
    } catch (e) {
        console.error(`[patch] ${ext}: ${e.message}`);
    }
}
