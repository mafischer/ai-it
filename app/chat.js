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
              <v-card color="primary" variant="tonal" max-width="80%" rounded="lg" class="pa-3">
                <div class="md-content" v-html="renderMd(m.content)"></div>
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
                <v-card variant="outlined" color="surface-variant" rounded="lg">
                  <v-card-text class="pa-2">
                    <div class="d-flex align-center cursor-pointer" @click="m._promptOpen = !m._promptOpen">
                      <v-icon size="small" class="mr-2">{{ m._promptOpen ? 'mdi-chevron-down' : 'mdi-chevron-right' }}</v-icon>
                      <span class="text-caption text-medium-emphasis">{{ getEmoji(m.name) }} {{ agentDisplayName(m.name) }} Prompt</span>
                    </div>
                    <div v-if="m._promptOpen" class="md-content mt-2 text-medium-emphasis" style="font-size:0.85rem" v-html="renderMd(m.content)"></div>
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

                <!-- Agent prompt section -->
                <v-card v-if="m.prompt" variant="outlined" color="surface-variant" class="mb-2" rounded="lg">
                  <v-card-text class="pa-2">
                    <div class="d-flex align-center cursor-pointer" @click="m._promptOpen = !m._promptOpen">
                      <v-icon size="small" class="mr-2">{{ m._promptOpen ? 'mdi-chevron-down' : 'mdi-chevron-right' }}</v-icon>
                      <span class="text-caption text-medium-emphasis">Prompt</span>
                    </div>
                    <pre v-if="m._promptOpen" class="msg-text mt-2 text-medium-emphasis" style="font-size:0.8rem">{{ m.prompt }}</pre>
                  </v-card-text>
                </v-card>

                <!-- Thinking section -->
                <v-card v-if="m.thinking" variant="outlined" class="mb-2" rounded="lg">
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
                <v-card v-if="m.content" elevation="2" rounded="lg" class="pa-3">
                  <div class="md-content" v-html="renderMd(m.content)"></div>
                </v-card>

                <!-- Streaming placeholder -->
                <v-card v-if="m._streaming && !m.content" elevation="2" rounded="lg" class="pa-3">
                  <v-skeleton-loader type="paragraph" />
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
          <div class="d-flex justify-between align-center mt-2">
            <v-btn v-if="streaming" color="error" variant="outlined" size="small" prepend-icon="mdi-stop" @click="abort">Stop</v-btn>
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

    async function selectThread(threadId, directive) {
      // Abort any active stream before switching
      if (abortController) { abortController.abort(); abortController = null; }
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
      restoreDraft();
      router.replace({ query: {} });
    }

    async function send() {
      const text = input.value.trim();
      if (!text || streaming.value) return;
      input.value = "";
      const key = currentThreadId.value || "_new";
      drafts[key] = "";

      // Add user message
      messages.value.push({ role: "user", content: text, name: "", _timestamp: new Date() });

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
      abortController = new AbortController();

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
          _promptOpen: false, _timestamp: new Date(),
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
          signal: abortController.signal,
        });

        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          const lines = buffer.split("\n");
          buffer = lines.pop();

          for (const line of lines) {
            if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
            try {
              const data = JSON.parse(line.slice(6));
              const deltaObj = data.choices?.[0]?.delta || {};

              // Handle system prompt messages from prompt nodes
              if (deltaObj.system_prompt) {
                const agentId = deltaObj.agent || "";
                // Finalize any current streaming message
                if (currentMsg) {
                  currentMsg._streaming = false;
                  currentMsg._thinkingActive = false;
                }
                // Add the system prompt as its own message
                messages.value.push(reactive({
                  role: "system", name: agentId, content: deltaObj.system_prompt,
                  type: "prompt", thinking: null, _thinkOpen: false, _thinkingActive: false,
                  _promptOpen: false, _streaming: false, _timestamp: new Date(),
                }));
                // Create agent response message (or reuse existing from DB)
                inThink = false;
                thinkBuf = "";
                contentBuf = "";
                const lastUserIdx = messages.value.findLastIndex(m => m.role === "user");
                const existingAgent = messages.value.findLast((m, idx) => idx > lastUserIdx && m.role === "assistant" && m.name === agentId && m.type !== "prompt");
                if (existingAgent) {
                  currentMsg = existingAgent;
                  currentMsg._streaming = true;
                } else {
                  newAgentMsg(agentId, "");
                }
                triggerRef(messages);
                scrollToBottom();
                continue;
              }

              const delta = deltaObj.content || "";
              if (!delta) continue;

              // Route content to the correct agent message
              const contentAgent = deltaObj.agent || "";
              if (contentAgent && currentMsg && currentMsg.name !== contentAgent) {
                // Find the target agent's message
                const lastUserIdx = messages.value.findLastIndex(m => m.role === "user");
                const target = messages.value.findLast((m, idx) => idx > lastUserIdx && m.role === "assistant" && m.name === contentAgent && m.type !== "prompt");
                if (target) {
                  // Append to the target's content directly without switching currentMsg
                  target.content = (target.content || "") + delta;
                  target._streaming = true;
                  continue;
                }
                // If no existing message, switch to new agent
                newAgentMsg(contentAgent, "");
                inThink = false; thinkBuf = ""; contentBuf = "";
              }

              for (let i = 0; i < delta.length; i++) {
                // Parse <think> tags
                const remaining = delta.slice(i);
                if (!inThink && remaining.startsWith("<think>")) {
                  if (!currentMsg) newAgentMsg(contentAgent || "", "");
                  inThink = true;
                  currentMsg._thinkingActive = true;
                  if (!currentMsg._userToggledThink) currentMsg._thinkOpen = true;
                  currentMsg._thinkStart = currentMsg._thinkStart || Date.now();
                  i += 6;
                  continue;
                }
                if (inThink && remaining.startsWith("</think>")) {
                  inThink = false;
                  currentMsg._thinkingActive = false;
                  currentMsg._thinkEnd = Date.now();
                  currentMsg.thinking = thinkBuf;
                  currentMsg._thinkOpen = false;
                  i += 7;
                  continue;
                }

                if (inThink) {
                  thinkBuf += delta[i];
                  if (currentMsg) currentMsg.thinking = thinkBuf;
                } else {
                  if (!currentMsg) newAgentMsg("", "");
                  contentBuf += delta[i];
                  currentMsg.content = contentBuf;
                }
              }

              scrollToBottom();
            } catch {}
          }
        }
      } catch (e) {
        if (e.name !== "AbortError") console.error("Stream error:", e);
      } finally {
        if (currentMsg) {
          currentMsg._streaming = false;
          currentMsg._thinkingActive = false;
        }
        streaming.value = false;
        abortController = null;
        fetchThreads();
      }
    }

    function abort() {
      if (abortController) abortController.abort();
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

    async function reconnectStream(threadId) {
      // Reconnect to an active workflow's SSE buffer
      streaming.value = true;
      abortController = new AbortController();
      let currentMsg = null;
      let inThink = false, thinkBuf = "", contentBuf = "";

      try {
        const resp = await fetch("/api/threads/" + threadId + "/stream", { signal: abortController.signal });
        if (!resp.ok) { streaming.value = false; return; }

        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop();

          for (const line of lines) {
            if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
            try {
              const data = JSON.parse(line.slice(6));
              const deltaObj = data.choices?.[0]?.delta || {};

              if (deltaObj.system_prompt) {
                if (currentMsg) { currentMsg._streaming = false; currentMsg._thinkingActive = false; }
                const agentId = deltaObj.agent || "";
                // Only add if not already in messages (from DB load)
                const exists = messages.value.some(m => m.type === "prompt" && m.name === agentId);
                if (!exists) {
                  messages.value.push(reactive({
                    role: "system", name: agentId, content: deltaObj.system_prompt,
                    type: "prompt", thinking: null, _thinkOpen: false, _thinkingActive: false,
                    _promptOpen: false, _streaming: false, _timestamp: new Date(),
                  }));
                }
                inThink = false; thinkBuf = ""; contentBuf = "";
                // Find existing agent message or create new one
                const lastUserIdx = messages.value.findLastIndex(m => m.role === "user");
                const existingAgent = messages.value.findLast((m, idx) => idx > lastUserIdx && m.role === "assistant" && m.name === agentId && m.type !== "prompt");
                if (existingAgent) {
                  currentMsg = existingAgent;
                  currentMsg._streaming = true;
                } else {
                  const msg = reactive({ role: "assistant", name: agentId, content: "", prompt: "", thinking: null, _thinkOpen: false, _thinkingActive: false, _promptOpen: false, _streaming: true, _timestamp: new Date() });
                  messages.value.push(msg);
                  currentMsg = msg;
                }
                triggerRef(messages);
                scrollToBottom();
                continue;
              }

              const delta = deltaObj.content || "";
              if (!delta) continue;

              for (let i = 0; i < delta.length; i++) {
                const remaining = delta.slice(i);
                if (!inThink && remaining.startsWith("<think>")) { if (!currentMsg) { currentMsg = reactive({ role: "assistant", name: "", content: "", thinking: null, _thinkOpen: false, _thinkingActive: true, _promptOpen: false, _streaming: true, _timestamp: new Date() }); messages.value.push(currentMsg); } inThink = true; currentMsg._thinkingActive = true; i += 6; continue; }
                if (inThink && remaining.startsWith("</think>")) { inThink = false; if (currentMsg) { currentMsg._thinkingActive = false; currentMsg.thinking = thinkBuf; currentMsg._thinkOpen = false; } i += 7; continue; }
                if (inThink) { thinkBuf += delta[i]; if (currentMsg) currentMsg.thinking = thinkBuf; }
                else { if (!currentMsg) { currentMsg = reactive({ role: "assistant", name: "", content: "", thinking: null, _thinkOpen: false, _thinkingActive: false, _promptOpen: false, _streaming: true, _timestamp: new Date() }); messages.value.push(currentMsg); } contentBuf += delta[i]; currentMsg.content = contentBuf; }
              }
              scrollToBottom();
            } catch {}
          }
        }
      } catch (e) {
        if (e.name !== "AbortError") console.error("Reconnect error:", e);
      } finally {
        if (currentMsg) { currentMsg._streaming = false; currentMsg._thinkingActive = false; }
        streaming.value = false;
        abortController = null;
        fetchThreads();
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
      getEmoji, agentDisplayName, formatTime, formatThinkDuration, timeAgo, renderMd, fetchThreads, selectThread, deleteThread, startNewChat, send, abort,
    };
  }
};

// Export for use in main app
window.ChatView = ChatView;
})();
