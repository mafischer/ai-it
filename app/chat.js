(function() {
const { ref, reactive, computed, onMounted, onUnmounted, nextTick, watch, triggerRef } = Vue;
const { useRoute: useChatRoute, useRouter: useChatRouter } = VueRouter;

const EMOJIS = {
  business_analyst: "\u{1F4CB}", software_architect: "\u{1F3D7}\uFE0F",
  backend_software_engineer: "\u2699\uFE0F", frontend_software_engineer: "\u{1F5A5}\uFE0F",
  ux_designer: "\u{1F3A8}", quality_engineer: "\u{1F50D}",
  site_reliability_engineer: "\u{1F4C8}", devops_engineer: "\u{1F680}",
  support_engineer: "\u{1F6E0}\uFE0F", complete: "\u2705"
};

function agentDisplayName(id) {
  return (id || "").replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
}

const ChatView = {
  template: `
    <v-layout class="fill-height">
      <!-- Sidebar -->
      <v-navigation-drawer v-model="drawer" :rail="rail" permanent @click="rail = false"
        color="surface" border="r" width="300">
        <v-list-item :prepend-icon="rail ? 'mdi-menu' : undefined" nav>
          <template v-if="!rail">
            <v-list-item-title class="text-h6 font-weight-bold">
              <v-icon class="mr-2">mdi-brain</v-icon>AI-IT
            </v-list-item-title>
          </template>
          <template v-slot:append>
            <v-btn variant="text" :icon="rail ? 'mdi-chevron-right' : 'mdi-chevron-left'" @click.stop="rail = !rail" />
          </template>
        </v-list-item>

        <v-divider />

        <v-list-item v-if="!rail" prepend-icon="mdi-plus" title="New Chat" @click="startNewChat"
          color="primary" variant="tonal" class="ma-2" rounded />

        <v-btn v-if="rail" icon="mdi-plus" variant="text" color="primary" class="ma-2" @click="startNewChat" />

        <v-divider v-if="threads.length" />

        <v-list density="compact" nav>
          <v-list-item v-for="t in threads" :key="t.thread_id"
            :active="currentThreadId === t.thread_id"
            @click="selectThread(t.thread_id, t.directive)"
            :title="rail ? '' : (t.title || (t.directive?.length > 60 ? t.directive.slice(0, 60) + '...' : t.directive))"
            :prepend-icon="rail ? 'mdi-message-outline' : undefined"
            rounded color="primary">
            <template v-if="!rail" v-slot:subtitle>
              <span class="text-caption text-medium-emphasis">{{ timeAgo(t.created_at) }}</span>
              <v-progress-circular v-if="activeThreadIds.includes(t.thread_id)" indeterminate size="12" width="1" color="primary" class="ml-2" />
            </template>
            <template v-if="!rail" v-slot:append>
              <v-menu>
                <template v-slot:activator="{ props }">
                  <v-btn icon="mdi-dots-horizontal" size="x-small" variant="text" v-bind="props" @click.stop />
                </template>
                <v-list density="compact">
                  <v-list-item v-if="activeThreadIds.includes(t.thread_id)" prepend-icon="mdi-stop" title="Stop" @click="stopThread(t.thread_id)" color="error" />
                  <v-list-item prepend-icon="mdi-export" title="Export" @click="exportThread(t.thread_id)" />
                  <v-list-item prepend-icon="mdi-delete" title="Delete" @click="deleteThread(t.thread_id)" />
                </v-list>
              </v-menu>
            </template>
          </v-list-item>
        </v-list>

        <template v-if="!rail" v-slot:append>
          <v-divider />
          <v-list-item prepend-icon="mdi-cog" title="Admin" @click="$router.push('/admin')" rounded nav />
        </template>
      </v-navigation-drawer>

      <!-- Main Chat Area -->
      <v-main class="d-flex flex-column" style="height:100vh">
        <!-- Empty state -->
        <div v-if="!messages.length && !streaming" class="d-flex flex-column align-center justify-center flex-grow-1 pa-4">
          <v-icon size="64" color="primary" class="mb-4">mdi-brain</v-icon>
          <h2 class="text-h5 font-weight-bold mb-2" style="color:#cdd6f4">AI-IT</h2>
          <p class="text-body-1 text-medium-emphasis mb-6">Multi-agent <s>software engineering</s> <em>anything</em></p>
          <div style="width:100%;max-width:700px">
            <v-textarea v-model="input" placeholder="Describe what you want to build..."
              variant="outlined" rows="3" auto-grow hide-details
              @keydown.enter.exact.prevent="send"
              :disabled="streaming" />
            <div class="d-flex justify-end mt-2">
              <v-btn color="primary" :disabled="!input.trim() || streaming" @click="send"
                prepend-icon="mdi-send">Send</v-btn>
            </div>
          </div>
        </div>

        <!-- Messages -->
        <div v-else class="flex-grow-1 pa-4" ref="messagesContainer" style="max-width:900px;margin:0 auto;width:100%;overflow-y:scroll">
          <div v-for="(m, i) in displayMessages" :key="i" class="mb-4">
            <div :class="m.role === 'user' ? 'text-right' : 'text-left'" class="mb-1">
              <span class="text-caption text-medium-emphasis">{{ formatTime(m._timestamp) }}</span>
            </div>

            <!-- User message -->
            <div v-if="m.role === 'user'" class="d-flex justify-end">
              <v-card color="primary" variant="tonal" max-width="80%" rounded="lg" 
                class="pa-3 cursor-pointer" @click="m._msgOpen = !m._msgOpen"
                style="position: relative">
                <v-icon size="x-small" style="position: absolute; top: 4px; right: 4px;" class="opacity-50">
                  {{ m._msgOpen === false ? 'mdi-chevron-left' : 'mdi-chevron-up' }}
                </v-icon>
                <div v-show="m._msgOpen !== false" class="md-content pr-4" v-html="renderMd(m.content)"></div>
                <div v-show="m._msgOpen === false" class="md-content opacity-70 pr-4">
                  {{ m.content.slice(0, 100) }}{{ m.content.length > 100 ? '...' : '' }}
                </div>
              </v-card>
            </div>

            <!-- System prompt message (directed at an agent) -->
            <div v-else-if="m.type === 'prompt'" class="d-flex justify-start">
              <div style="max-width:90%;width:100%">
                <div class="d-flex align-center mb-1">
                  <v-chip size="x-small" variant="tonal" color="warning" class="mr-2">
                    <v-icon start size="x-small">mdi-arrow-right</v-icon>
                    System prompt to {{ agentDisplayName(m.name) }}
                  </v-chip>
                </div>
                <v-card variant="outlined" color="surface-variant" rounded="lg" 
                  class="cursor-pointer" @click="m._msgOpen = !m._msgOpen"
                  style="position: relative">
                  <v-icon size="x-small" style="position: absolute; top: 4px; right: 4px;" class="opacity-50">
                    {{ m._msgOpen === false ? 'mdi-chevron-right' : 'mdi-chevron-up' }}
                  </v-icon>
                  <v-card-text class="pa-2">
                    <div class="d-flex align-center" @click.stop="m._promptOpen = !m._promptOpen">
                      <v-icon size="small" class="mr-2">{{ m._promptOpen ? 'mdi-chevron-down' : 'mdi-chevron-right' }}</v-icon>
                      <span class="text-caption text-medium-emphasis">{{ getEmoji(m.name) }} {{ agentDisplayName(m.name) }} Prompt</span>
                    </div>
                    <div v-if="m._msgOpen !== false && m._promptOpen" class="md-content mt-2 text-medium-emphasis pr-4" style="font-size:0.85rem" v-html="renderMd(m.content)"></div>
                    <div v-if="m._msgOpen === false" class="md-content mt-1 text-medium-emphasis opacity-70 pr-4" style="font-size:0.85rem">
                      {{ m.content.slice(0, 100) }}{{ m.content.length > 100 ? '...' : '' }}
                    </div>
                  </v-card-text>
                </v-card>
              </div>
            </div>

            <!-- Agent message -->
            <div v-else class="d-flex justify-start">
              <div style="max-width:90%;width:100%">
                <div class="d-flex align-center mb-1">
                  <v-chip size="small" color="primary" variant="flat">
                    {{ getEmoji(m.name) }} {{ agentDisplayName(m.name || 'assistant') }}
                  </v-chip>
                </div>

                <v-card elevation="2" rounded="lg" class="pa-3 cursor-pointer" @click="m._msgOpen = !m._msgOpen" style="position: relative">
                  <v-icon size="x-small" style="position: absolute; top: 4px; right: 4px;" class="opacity-50">
                    {{ m._msgOpen === false ? 'mdi-chevron-right' : 'mdi-chevron-up' }}
                  </v-icon>
                  
                  <div v-show="m._msgOpen !== false">
                    <!-- Agent prompt section -->
                    <v-card v-if="m.prompt" variant="outlined" color="surface-variant" class="mb-2" rounded="lg" @click.stop>
                      <v-card-text class="pa-2">
                        <div class="d-flex align-center cursor-pointer" @click="m._promptOpen = !m._promptOpen">
                          <v-icon size="small" class="mr-2">{{ m._promptOpen ? 'mdi-chevron-down' : 'mdi-chevron-right' }}</v-icon>
                          <span class="text-caption text-medium-emphasis">Prompt</span>
                        </div>
                        <pre v-if="m._promptOpen" class="msg-text mt-2 text-medium-emphasis" style="font-size:0.8rem">{{ m.prompt }}</pre>
                      </v-card-text>
                    </v-card>

                    <!-- Thinking section -->
                    <v-card v-if="m.thinking" variant="outlined" class="mb-2" rounded="lg" @click.stop>
                      <v-card-text class="pa-2">
                        <div class="d-flex align-center cursor-pointer" @click="m._thinkOpen = !m._thinkOpen; m._userToggledThink = true">
                          <v-icon size="small" class="mr-2">{{ m._thinkOpen ? 'mdi-chevron-down' : 'mdi-chevron-right' }}</v-icon>
                          <span class="text-caption text-medium-emphasis">
                            <template v-if="m._thinkingActive">Thinking</template>
                            <template v-else>{{ formatThinkDuration(m) ? 'Thought for ' + formatThinkDuration(m) : 'Thought' }}</template>
                          </span>
                          <v-progress-circular v-if="m._thinkingActive" indeterminate size="14" width="2" color="primary" class="ml-2" />
                        </div>
                        <div v-if="m._thinkOpen" class="md-content mt-2 text-medium-emphasis" style="font-size:0.8rem" v-html="renderMd(m.thinking)"></div>
                      </v-card-text>
                    </v-card>

                    <!-- Response content -->
                    <div v-if="m.content" class="md-content pr-4" v-html="renderMd(m.content)"></div>

                    <!-- Streaming placeholder -->
                    <v-skeleton-loader v-if="m._streaming && !m.content" type="paragraph" />
                  </div>

                  <div v-show="m._msgOpen === false" class="md-content opacity-70 pr-4">
                    {{ m.content.slice(0, 100) }}{{ m.content.length > 100 ? '...' : '' }}
                  </div>
                </v-card>
              </div>
            </div>
          </div>
        </div>

        <!-- Bottom input (when messages exist) -->
        <div v-if="messages.length || streaming" class="pa-4" style="max-width:900px;margin:0 auto;width:100%">
          <v-textarea v-model="input" placeholder="Reply..."
            variant="outlined" rows="1" auto-grow hide-details max-rows="6"
            @keydown.enter.exact.prevent="send"
            :disabled="streaming" />
          <div class="d-flex align-center mt-2">
            <v-btn size="small" variant="tonal" color="medium-emphasis"
              :prepend-icon="allExpanded ? 'mdi-collapse-all' : 'mdi-expand-all'"
              @click="toggleAllMessages">
              {{ allExpanded ? 'Collapse' : 'Expand' }}
            </v-btn>
            <v-spacer />
            <v-btn color="primary" :disabled="!input.trim() || streaming" @click="send"
              prepend-icon="mdi-send" size="small">Send</v-btn>
          </div>
        </div>
      </v-main>
    </v-layout>
  `,
  setup() {
    const route = useChatRoute();
    const router = useChatRouter();
    const drawer = ref(true);
    const rail = ref(false);
    const input = ref("");
    const threads = ref([]);
    const activeThreadIds = ref([]);
    const currentThreadId = ref(route.query.t || null);
    const currentDirective = ref("");
    const messages = ref([]);
    const streaming = ref(false);
    const messagesContainer = ref(null);
    const drafts = {};  // { threadId|"new": "draft text" }
    const now = ref(Date.now());
    let nowInterval = null;
    let abortController = null;
    let pollInterval = null;

    function saveDraft() {
      const key = currentThreadId.value || "_new";
      drafts[key] = input.value;
    }

    function restoreDraft() {
      const key = currentThreadId.value || "_new";
      input.value = drafts[key] || "";
    }

    // Display messages: merge stored + streaming state
    const displayMessages = computed(() => messages.value);
    const allExpanded = computed(() => messages.value.length > 0 && messages.value.every(m => m._msgOpen !== false));

    function toggleAllMessages() {
      const targetState = !allExpanded.value;
      messages.value.forEach(m => m._msgOpen = targetState);
    }

    function getEmoji(name) { return EMOJIS[name] || "\u{1F916}"; }

    function renderMd(text) {
      if (!text) return "";
      try { return marked.parse(text, { breaks: true }); }
      catch { return text; }
    }

    function timeAgo(ts) {
      if (!ts) return "";
      const sec = Math.floor((now.value / 1000) - ts);
      if (sec < 60) return "just now";
      if (sec < 3600) return Math.floor(sec / 60) + "m";
      if (sec < 86400) return Math.floor(sec / 3600) + "h";
      
      const date = new Date(ts * 1000);
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      
      const yesterday = new Date(today);
      yesterday.setDate(yesterday.getDate() - 1);
      
      const lastWeekStart = new Date(today);
      lastWeekStart.setDate(lastWeekStart.getDate() - 7);
      
      if (date >= yesterday && date < today) {
          return "yesterday";
      } else if (date >= lastWeekStart && date < yesterday) {
          return "last week";
      } else {
          const m = date.getMonth() + 1;
          const d = date.getDate();
          const y = date.getFullYear().toString().slice(2);
          return `${m}/${d}/${y}`;
      }
    }

    function formatThinkDuration(m) {
      let sec;
      if (m._thinkStart) {
        const end = m._thinkEnd || Date.now();
        sec = Math.round((end - m._thinkStart) / 1000);
      } else if (m.thinking) {
        // Estimate from content length (~4 chars per token, ~10 tokens/sec)
        sec = Math.max(1, Math.round(m.thinking.length / 4 / 10));
      } else {
        return "";
      }
      if (sec < 2) return "a moment";
      if (sec < 60) return sec + " seconds";
      const min = Math.round(sec / 60);
      return min + " minute" + (min !== 1 ? "s" : "");
    }

    function formatTime(ts) {
      if (!ts) return "";
      const d = ts instanceof Date ? ts : new Date(ts);
      const now = new Date();
      const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
      if (d.toDateString() === now.toDateString()) return time;
      return d.toLocaleDateString([], { month: "short", day: "numeric" }) + " " + time;
    }

    async function fetchThreads() {
      try {
        const [tr, ar] = await Promise.all([fetch("/api/threads"), fetch("/api/active")]);
        const newThreads = await tr.json();
        const newActive = (await ar.json()).map(i => i.thread_id);
        // If we had a pending thread and a new real thread appeared, update the reference
        if (threads.value.some(t => t.thread_id === "_pending") && newThreads.length > threads.value.filter(t => t.thread_id !== "_pending").length) {
          // Find the new thread (first one not in old list)
          const oldIds = new Set(threads.value.filter(t => t.thread_id !== "_pending").map(t => t.thread_id));
          const created = newThreads.find(t => !oldIds.has(t.thread_id));
          if (created) {
            currentThreadId.value = created.thread_id;
            router.replace({ query: { t: created.thread_id } });
          }
        }
        threads.value = newThreads;
        activeThreadIds.value = newActive;
      } catch {}
    }

    async function deleteThread(threadId) {
      await fetch("/api/threads/" + threadId, { method: "DELETE" });
      if (currentThreadId.value === threadId) startNewChat();
      fetchThreads();
    }

    async function stopThread(threadId) {
      if (currentThreadId.value === threadId && currentStreamController) {
        currentStreamController.abort();
        currentStreamController = null;
      }
      await fetch("/api/threads/" + threadId + "/abort", { method: "POST" });
      fetchThreads();
    }

    async function exportThread(threadId) {
      try {
        const r = await fetch("/api/threads/" + threadId + "/messages");
        if (!r.ok) return;
        const msgs = await r.json();
        
        const t = threads.value.find(th => th.thread_id === threadId);
        let displayName = threadId;
        if (t) {
          displayName = t.title || t.directive || threadId;
          if (displayName.length > 50) displayName = displayName.slice(0, 50) + "...";
        }
        // Sanitize for filename
        const safeName = displayName.replace(/[^a-z0-9]/gi, '_').toLowerCase();

        let html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Export Thread: ${displayName}</title>
<link href="https://cdn.jsdelivr.net/npm/vuetify@3.7.6/dist/vuetify.min.css" rel="stylesheet">
<link href="https://cdn.jsdelivr.net/npm/@mdi/font@7.4.47/css/materialdesignicons.min.css" rel="stylesheet">
<style>
  body { background-color: #121212; color: #fff; font-family: Roboto, sans-serif; padding: 20px; }
  .chat-container { max-width: 900px; margin: 0 auto; width: 100%; }
  .msg-row { display: flex; margin-bottom: 20px; flex-direction: column; }
  .msg-row.user { align-items: flex-end; }
  .msg-row.agent { align-items: flex-start; }
  .msg-meta { font-size: 0.75rem; color: #aaa; margin-bottom: 4px; }
  .msg-card { padding: 12px; border-radius: 8px; max-width: 80%; line-height: 1.6; }
  .msg-row.user .msg-card { background-color: #2b3b4e; border: 1px solid #1976D2; }
  .msg-row.agent .msg-card { background-color: #1e1e1e; border: 1px solid #424242; }
  .agent-badge { display: inline-flex; align-items: center; background: #1976D2; color: #fff; padding: 2px 8px; border-radius: 12px; font-size: 0.85rem; margin-bottom: 8px; }
  pre { background: #000; padding: 12px; border-radius: 6px; overflow-x: auto; margin: 8px 0; font-size: 0.85rem; }
  code { font-family: monospace; }
  a { color: #64B5F6; text-decoration: none; }
  a:hover { text-decoration: underline; }
  .think-block { margin-bottom: 12px; font-size: 0.85rem; color: #aaa; }
  .think-summary { cursor: pointer; user-select: none; }
  .think-content { padding-top: 8px; border-left: 2px solid #555; padding-left: 12px; margin-top: 8px; }
</style>
</head>
<body>
<div class="chat-container">
  <div style="margin-bottom: 24px; padding-bottom: 12px; border-bottom: 1px solid #333;">
    <h2>Thread: ${displayName}</h2>
  </div>
`;

        for (const m of msgs) {
          const isUser = m.role === 'user';
          if (m.type === 'prompt') continue;
          
          const name = m.name || m.role;
          const display = isUser ? 'User' : agentDisplayName(name);
          const emoji = isUser ? '👤' : getEmoji(name);
          const content = m.content || "";
          
          let thinking = null, displayContent = content;
          const thinkMatch = content.match(/<think>([\s\S]*?)<\/think>/);
          if (thinkMatch) {
            thinking = thinkMatch[1].trim();
            displayContent = content.replace(/<think>[\s\S]*?<\/think>/, '').trim();
          }

          let rendered = marked.parse(displayContent, { breaks: true });
          let thinkRendered = thinking ? marked.parse(thinking, { breaks: true }) : '';

          let ts = m.timestamp ? new Date(m.timestamp) : new Date();

          html += `
  <div class="msg-row ${isUser ? 'user' : 'agent'}">
    <div class="msg-meta">${ts.toLocaleString()}</div>
    <div class="msg-card">
      ${!isUser ? `<div class="agent-badge">${emoji} ${display}</div>` : ''}
      ${thinking ? `<details class="think-block"><summary class="think-summary">Thinking Process</summary><div class="think-content">${thinkRendered}</div></details>` : ''}
      <div class="md-content">${rendered}</div>
    </div>
  </div>`;
        }

        html += `</div></body></html>`;

        const blob = new Blob([html], { type: "text/html" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `chat_${safeName}.html`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      } catch (e) {
        console.error("Export failed", e);
        alert("Failed to export thread.");
      }
    }

    async function selectThread(threadId, directive) {
      // Abort any active stream before switching
      if (currentStreamController) {
        currentStreamController.abort();
        currentStreamController = null;
      }
      streaming.value = false;
      saveDraft();
      currentThreadId.value = threadId;
      currentDirective.value = directive || "";
      restoreDraft();
      router.replace({ query: { t: threadId } });
      try {
        const r = await fetch("/api/threads/" + threadId + "/messages");
        if (r.ok) {
          const msgs = await r.json();
          messages.value = msgs.map((m, i) => {
            // Parse <think> tags from stored content
            let thinking = null, displayContent = m.content;
            const thinkMatch = (m.content || "").match(/<think>([\s\S]*?)<\/think>/);
            if (thinkMatch) {
              thinking = thinkMatch[1].trim();
              displayContent = m.content.replace(/<think>[\s\S]*?<\/think>/, "").replace(/<\/?think>/g, "").trim();
            }
            return reactive({
              ...m,
              content: displayContent,
              thinking,
              _thinkOpen: false,
              _thinkingActive: false,
              _promptOpen: false,
              _streaming: false,
              _msgOpen: true,
              _timestamp: m.timestamp ? new Date(m.timestamp) : null,
            });
          });
        }
      } catch {}
      scrollToBottom(true);

      // If thread is active, reconnect to the stream buffer
      if (activeThreadIds.value.includes(threadId)) {
        reconnectStream(threadId);
      }
    }

    function startNewChat() {
      saveDraft();
      currentThreadId.value = null;
      currentDirective.value = "";
      messages.value = [];
      streaming.value = false;
      for (const key in activeStreamStates) delete activeStreamStates[key];
      restoreDraft();
      router.replace({ query: {} });
    }

    const activeStreamStates = {};

    function getStreamState(agentId, forceNew = false) {
      if (!activeStreamStates[agentId]) {
        const lastUserIdx = messages.value.findLastIndex(m => m.role === "user");
        let target = forceNew ? null : messages.value.findLast((m, idx) => idx > lastUserIdx && m.role === "assistant" && m.name === agentId && m.type !== "prompt");
        if (!target) {
          target = reactive({
            role: "assistant", name: agentId, content: "", prompt: "",
            thinking: null, _thinkOpen: false, _thinkingActive: false, _streaming: true,
            _promptOpen: false, _msgOpen: true, _timestamp: new Date(),
          });
          messages.value.push(target);
        }
        activeStreamStates[agentId] = {
          msg: target,
          inThink: !!target._thinkingActive,
          thinkBuf: target.thinking || "",
          contentBuf: target.content || ""
        };
      }
      return activeStreamStates[agentId];
    }

    function processStreamDelta(deltaObj, choiceObj) {
      const agentId = deltaObj.agent || "";
      
      if (deltaObj.system_prompt) {
        if (activeStreamStates[agentId]) {
          activeStreamStates[agentId].msg._streaming = false;
          activeStreamStates[agentId].msg._thinkingActive = false;
          delete activeStreamStates[agentId];
        }

        const exists = messages.value.some(m => m.type === "prompt" && m.name === agentId && m.content === deltaObj.system_prompt);
        if (!exists) {
          messages.value.push(reactive({
            role: "system", name: agentId, content: deltaObj.system_prompt,
            type: "prompt", thinking: null, _thinkOpen: false, _thinkingActive: false,
            _promptOpen: false, _streaming: false, _msgOpen: true, _timestamp: new Date(),
          }));
        }
        
        getStreamState(agentId, true);
        triggerRef(messages);
        scrollToBottom();
        return;
      }

      if (choiceObj?.finish_reason === "stop" && agentId) {
        if (activeStreamStates[agentId]) {
          activeStreamStates[agentId].msg._streaming = false;
          activeStreamStates[agentId].msg._thinkingActive = false;
          delete activeStreamStates[agentId];
        }
        return;
      }

      const delta = deltaObj.content || "";
      if (!delta) return;

      const state = getStreamState(agentId);
      state.msg._streaming = true;

      for (let i = 0; i < delta.length; i++) {
        const remaining = delta.slice(i);
        if (!state.inThink && remaining.startsWith("<think>")) {
          state.inThink = true;
          state.msg._thinkingActive = true;
          if (!state.msg._userToggledThink) state.msg._thinkOpen = true;
          state.msg._thinkStart = state.msg._thinkStart || Date.now();
          i += 6;
          continue;
        }
        if (state.inThink && remaining.startsWith("</think>")) {
          state.inThink = false;
          state.msg._thinkingActive = false;
          state.msg._thinkEnd = Date.now();
          state.msg.thinking = state.thinkBuf;
          state.msg._thinkOpen = false;
          i += 7;
          continue;
        }

        if (state.inThink) {
          state.thinkBuf += delta[i];
          state.msg.thinking = state.thinkBuf;
        } else {
          state.contentBuf += delta[i];
          state.msg.content = state.contentBuf;
        }
      }
      scrollToBottom();
    }

    async function send() {
      const text = input.value.trim();
      if (!text || streaming.value) return;
      input.value = "";
      const key = currentThreadId.value || "_new";
      drafts[key] = "";

      // Add user message
      messages.value.push(reactive({ role: "user", content: text, name: "", _msgOpen: true, _timestamp: new Date() }));

      // Build conversation for the API
      const apiMessages = [];
      if (currentDirective.value) {
        // Existing thread: send full history
        apiMessages.push({ role: "user", content: currentDirective.value });
        for (const m of messages.value) {
          if (m === messages.value[0] && m.content === currentDirective.value) continue;
          apiMessages.push({ role: m.role === "user" ? "user" : "assistant", content: m.content || "" });
        }
      } else {
        // New chat — add optimistic sidebar entry
        currentDirective.value = text;
        apiMessages.push({ role: "user", content: text });
        // Thread ID will be assigned after first poll; add placeholder
        threads.value.unshift({ thread_id: "_pending", directive: text.slice(0, 120), msgCount: 1, agents: [] });
      }

      streaming.value = true;
      if (currentStreamController) currentStreamController.abort();
      currentStreamController = new AbortController();
      const signal = currentStreamController.signal;

      // Immediately show active state in sidebar
      activeThreadIds.value.push(currentThreadId.value || "_pending");

      // Current agent message being streamed
      let currentMsg = null;
      let inThink = false;
      let thinkBuf = "";
      let contentBuf = "";

      function newAgentMsg(name, prompt) {
        // Finalize previous message
        if (currentMsg) {
          currentMsg._streaming = false;
          currentMsg._thinkingActive = false;
        }
        const msg = reactive({
          role: "assistant", name: name || "", content: "", prompt: prompt || "",
          thinking: null, _thinkOpen: false, _thinkingActive: false, _streaming: true,
          _promptOpen: false, _msgOpen: true, _timestamp: new Date(),
        });
        messages.value.push(msg);
        currentMsg = msg;
        inThink = false;
        thinkBuf = "";
        contentBuf = "";
        scrollToBottom(true);
        return msg;
      }

      try {
        const resp = await fetch("/v1/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: "ai-it-org", messages: apiMessages, stream: true }),
          signal,
        });

        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          if (signal.aborted) break;
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          const lines = buffer.split("\n");
          buffer = lines.pop();

          for (const line of lines) {
            if (signal.aborted) break;
            if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
            try {
              const data = JSON.parse(line.slice(6));
              const choiceObj = data.choices?.[0];
              const deltaObj = choiceObj?.delta || {};
              processStreamDelta(deltaObj, choiceObj);
            } catch {}
          }
        }
      } catch (e) {
        if (e.name !== "AbortError") console.error("Stream error:", e);
      } finally {
        if (!signal.aborted) {
          for (const key in activeStreamStates) {
            if (activeStreamStates[key].msg) {
              activeStreamStates[key].msg._streaming = false;
              activeStreamStates[key].msg._thinkingActive = false;
            }
            delete activeStreamStates[key];
          }
          streaming.value = false;
          currentStreamController = null;
          fetchThreads();
        }
      }
    }

    function abort() {
      if (currentStreamController) {
        currentStreamController.abort();
        currentStreamController = null;
      }
    }

    function scrollToBottom(force = false) {
      nextTick(() => {
        const el = messagesContainer.value;
        if (!el) return;
        // Only auto-scroll if user is near the bottom (within 150px) or forced
        const nearBottom = (el.scrollHeight - el.scrollTop - el.clientHeight) < 150;
        if (nearBottom || force) el.scrollTop = el.scrollHeight;
      });
    }

    let currentStreamController = null;

    async function reconnectStream(threadId) {
      if (!threadId) return;
      // If already streaming this thread, don't start another
      if (streaming.value && currentThreadId.value === threadId) return;
      
      // Abort any previous stream
      if (currentStreamController) currentStreamController.abort();
      const controller = new AbortController();
      currentStreamController = controller;
      const signal = controller.signal;

      streaming.value = true;
      for (const key in activeStreamStates) delete activeStreamStates[key];

      try {
        const resp = await fetch("/api/threads/" + threadId + "/stream", { signal });
        if (!resp.ok) { streaming.value = false; return; }

        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          if (signal.aborted) break;
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop();

          for (const line of lines) {
            if (signal.aborted) break;
            if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
            try {
              const data = JSON.parse(line.slice(6));
              const choiceObj = data.choices?.[0];
              const deltaObj = choiceObj?.delta || {};
              processStreamDelta(deltaObj, choiceObj);
            } catch {}
          }
        }
      } catch (e) {
        if (e.name !== "AbortError") console.error("Reconnect error:", e);
      } finally {
        if (!signal.aborted) {
          for (const key in activeStreamStates) {
            if (activeStreamStates[key].msg) {
              activeStreamStates[key].msg._streaming = false;
              activeStreamStates[key].msg._thinkingActive = false;
            }
            delete activeStreamStates[key];
          }
          streaming.value = false;
          currentStreamController = null;
          fetchThreads();
        }
      }
    }

    onMounted(async () => {
      await fetchThreads();
      // Restore thread from URL query if present
      if (currentThreadId.value) {
        const t = threads.value.find(th => th.thread_id === currentThreadId.value);
        if (t) {
          await selectThread(t.thread_id, t.directive);
          // If thread is active, reconnect to the stream buffer
          if (activeThreadIds.value.includes(t.thread_id)) {
            reconnectStream(t.thread_id);
          }
        }
      }
      pollInterval = setInterval(fetchThreads, 5000);
      nowInterval = setInterval(() => { now.value = Date.now(); }, 30000);
    });

    // Auto-connect to stream when the current thread becomes active
    watch(activeThreadIds, (newActive) => {
      if (currentThreadId.value && !streaming.value && newActive.includes(currentThreadId.value)) {
        // Reload messages from DB first (may have new prompts), then connect
        selectThread(currentThreadId.value, currentDirective.value);
      }
    });
    onUnmounted(() => { clearInterval(pollInterval); clearInterval(nowInterval); });

    return {
      drawer, rail, input, threads, activeThreadIds, currentThreadId, currentDirective,
      messages, displayMessages, streaming, messagesContainer,
      getEmoji, agentDisplayName, formatTime, formatThinkDuration, timeAgo, renderMd, fetchThreads, selectThread, deleteThread, stopThread, exportThread, startNewChat, send, abort,
      allExpanded, toggleAllMessages
      };
  }
};

// Export for use in main app
window.ChatView = ChatView;
})();
