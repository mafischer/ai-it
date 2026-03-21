const fs = require('fs');
let code = fs.readFileSync('index.js', 'utf8');

const helpers = `
function getMsgName(m) {
    return m?.name || m?.kwargs?.name || m?.additional_kwargs?.name || "";
}
function getMsgRole(m) {
    const type = m?.type || m?._getType?.() || "";
    return m?.role || (type === "human" ? "user" : getMsgName(m) ? "assistant" : type === "ai" ? "assistant" : "user");
}
function getMsgContent(m) {
    return m?.content || m?.kwargs?.content || "";
}
`;

// Insert helpers before getPromptForNode
code = code.replace("function getPromptForNode", helpers + "\nfunction getPromptForNode");

// Replace in getPromptForNode
code = code.replace(/m \=\> m\.name === nodeName && \!m\.name\?\.endsWith\("__prompt"\)/g, 'm => getMsgName(m) === nodeName && !getMsgName(m).endsWith("__prompt")');
code = code.replace(/m \=\> \!m\.name\?\.endsWith\("__prompt"\)/g, 'm => !getMsgName(m).endsWith("__prompt")');
code = code.replace(/extractStatus\(msgs\[msgs\.length \- 1\]\.content\)/g, 'extractStatus(getMsgContent(msgs[msgs.length - 1]))');
code = code.replace(/lastMsg\.role === "user" \|\| lastMsg\.role === "human"/g, 'getMsgRole(lastMsg) === "user"');
code = code.replace(/extractStatus\(lastMsg\.content\)/g, 'extractStatus(getMsgContent(lastMsg))');
code = code.replace(/m\.name === nodeName/g, 'getMsgName(m) === nodeName');
code = code.replace(/m\.content/g, 'getMsgContent(m)');
code = code.replace(/lastMsg\.content/g, 'getMsgContent(lastMsg)');
code = code.replace(/nextUser\.content/g, 'getMsgContent(nextUser)');
code = code.replace(/n \=\> n\.role === "user" \|\| n\.role === "human"/g, 'n => getMsgRole(n) === "user"');
code = code.replace(/selfLastContent = msgs\.length \? msgs\[msgs\.length - 1\]\.content : ""/g, 'selfLastContent = msgs.length ? getMsgContent(msgs[msgs.length - 1]) : ""');

// Replace in agentNode
code = code.replace(/m \=\> m\.name === \`\$\{nodeName\}__prompt\`/g, 'm => getMsgName(m) === `${nodeName}__prompt`');
code = code.replace(/m \=\> \!m\.name\?\.endsWith\("__prompt"\) && m\.name \!\=\= \`\$\{nodeName\}__prompt\`/g, 'm => !getMsgName(m).endsWith("__prompt") && getMsgName(m) !== `${nodeName}__prompt`');
code = code.replace(/state\.messages\[0\]\.content/g, 'getMsgContent(state.messages[0])');

// Replace in fallbackRouter
code = code.replace(/lastMsg\.name \|\| lastMsg\.role/g, 'getMsgName(lastMsg) || getMsgRole(lastMsg)');
code = code.replace(/prevMsg\?\.name \|\| prevMsg\?\.role/g, 'getMsgName(prevMsg) || getMsgRole(prevMsg)');

// Replace in buildRouteFunction
code = code.replace(/m \=\> m\.name === agentId && \!m\.name\?\.endsWith\("__prompt"\)/g, 'm => getMsgName(m) === agentId && !getMsgName(m).endsWith("__prompt")');

// Replace in routeFromStart
code = code.replace(/m \=\> m\.role === "assistant" && \!m\.name\?\.endsWith\("__prompt"\)/g, 'm => getMsgRole(m) === "assistant" && !getMsgName(m).endsWith("__prompt")');
code = code.replace(/lastAssistant\.name/g, 'getMsgName(lastAssistant)');
code = code.replace(/extractStatus\(lastAssistant\.content\)/g, 'extractStatus(getMsgContent(lastAssistant))');

fs.writeFileSync('index.js', code);
