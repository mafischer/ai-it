import Mustache from "mustache";
import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { getAgent } from "./loader.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = join(__dirname, "../../templates");

// Disable HTML escaping — prompts are plain text, not HTML
Mustache.escape = (text) => text;

// Cache loaded templates
const templateCache = {};

function loadTemplate(agentId, variant) {
    const key = `${agentId}/${variant}`;
    if (templateCache[key]) return templateCache[key];

    // 1. Try loading from template file
    const filePath = join(TEMPLATES_DIR, agentId, `${variant}.md`);
    if (existsSync(filePath)) {
        const content = readFileSync(filePath, "utf8");
        templateCache[key] = content;
        return content;
    }

    // 2. Fall back to inline template in workflow.json
    const agent = getAgent(agentId);
    if (agent?.prompts?.[variant]) {
        templateCache[key] = agent.prompts[variant];
        return agent.prompts[variant];
    }

    return null;
}

export function renderPrompt(agentId, variant, values) {
    const template = loadTemplate(agentId, variant);
    if (!template) return null;
    return Mustache.render(template, values);
}
