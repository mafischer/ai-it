(function() {
const { ref, reactive, computed, onMounted, onUnmounted, nextTick, watch, triggerRef } = Vue;

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
            :title="rail ? '' : t.directive"
            :prepend-icon="rail ? 'mdi-message-outline' : undefined"
            rounded color="primary">
            <template v-if="!rail" v-slot:subtitle>
              <span class="text-caption">{{ t.msgCount }} msgs</span>
              <v-progress-circular v-if="activeThreadIds.includes(t.thread_id)" indeterminate size="12" width="1" color="primary" class="ml-2" />
            </template>
            <template v-if="!rail" v-slot:append>
              <v-btn icon="mdi-delete" size="x-small" variant="text" color="error"
                @click.stop="deleteThread(t.thread_id)" />
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
                    <div class="d-flex align-center cursor-pointer" @click="m._thinkOpen = !m._thinkOpen">
                      <v-icon size="small" class="mr-2">{{ m._thinkOpen ? 'mdi-chevron-down' : 'mdi-chevron-right' }}</v-icon>
                      <span class="text-caption text-medium-emphasis">Thinking</span>
                      <v-progress-circular v-if="m._thinkingActive" indeterminate size="14" width="2" color="primary" class="ml-2" />
                      <span v-else class="text-caption text-medium-emphasis ml-2">done</span>
                    </div>
                    <pre v-if="m._thinkOpen" class="msg-text mt-2 text-medium-emphasis" style="font-size:0.8rem">{{ m.thinking }}</pre>
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
    const drawer = ref(true);
    const rail = ref(false);
    const input = ref("");
    const threads = ref([]);
    const activeThreadIds = ref([]);
    const currentThreadId = ref(null);
    const currentDirective = ref("");
    const messages = ref([]);
    const streaming = ref(false);
    const messagesContainer = ref(null);
    const drafts = {};  // { threadId|"new": "draft text" }
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
        threads.value = await tr.json();
        activeThreadIds.value = (await ar.json()).map(i => i.thread_id);
      } catch {}
    }

    async function deleteThread(threadId) {
      await fetch("/api/threads/" + threadId, { method: "DELETE" });
      if (currentThreadId.value === threadId) startNewChat();
      fetchThreads();
    }

    async function selectThread(threadId, directive) {
      saveDraft();
      currentThreadId.value = threadId;
      currentDirective.value = directive || "";
      streaming.value = false;
      restoreDraft();
      try {
        const r = await fetch("/api/threads/" + threadId + "/messages");
        if (r.ok) {
          const msgs = await r.json();
          messages.value = msgs.map((m, i) => reactive({
            ...m,
            thinking: null,
            _thinkOpen: false,
            _thinkingActive: false,
            _promptOpen: false,
            _streaming: false,
            _timestamp: m.timestamp ? new Date(m.timestamp) : null,
          }));
        }
      } catch {}
      scrollToBottom();
    }

    function startNewChat() {
      saveDraft();
      currentThreadId.value = null;
      currentDirective.value = "";
      messages.value = [];
      streaming.value = false;
      restoreDraft();
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
        // New chat
        currentDirective.value = text;
        apiMessages.push({ role: "user", content: text });
      }

      streaming.value = true;
      abortController = new AbortController();

      // Current agent message being streamed
      let currentMsg = null;
      let rawBuf = "";    // full raw stream for header detection
      let inThink = false;
      let thinkBuf = "";
      let contentBuf = "";
      let promptBuf = "";
      let parsingHeader = false; // inside an orchestration header block

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
        scrollToBottom();
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
              const delta = data.choices?.[0]?.delta?.content || "";
              if (!delta) continue;

              rawBuf += delta;

              // Detect orchestration header: "\n\n---\n\n#### EMOJI AgentName Prompt\n\n> prompt text\n\n#### EMOJI AgentName Response\n\n"
              // We detect "#### " followed by "Prompt" to start header parsing,
              // and "Response\n\n" to end it and begin content streaming.

              for (let i = 0; i < delta.length; i++) {
                const c = delta[i];

                if (parsingHeader) {
                  promptBuf += c;
                  // Check if we've reached the "Response" marker
                  if (promptBuf.includes("Response\n\n") || promptBuf.includes("Response\r\n")) {
                    // Extract agent name and prompt from the header
                    const headerMatch = promptBuf.match(/####\s+\S+\s+(.+?)\s+Prompt\s*\n/);
                    const promptMatch = promptBuf.match(/Prompt\s*\n\n>\s*([\s\S]*?)\n\n####/);
                    const agentName = headerMatch ? headerMatch[1].toLowerCase().replace(/ /g, "_") : "";
                    const prompt = promptMatch ? promptMatch[1].replace(/\n>\s?/g, "\n").trim() : "";
                    newAgentMsg(agentName, prompt);
                    parsingHeader = false;
                    promptBuf = "";
                  }
                  continue;
                }

                // Detect start of header block: "---" followed by "####"
                if (!parsingHeader && rawBuf.endsWith("---\n\n####")) {
                  // Remove any trailing "---\n\n####" from current content
                  if (currentMsg) {
                    const trimmed = contentBuf.replace(/\n*---\n*$/, "").replace(/\n*-*$/, "");
                    currentMsg.content = trimmed;
                    contentBuf = trimmed;
                  }
                  parsingHeader = true;
                  promptBuf = "####";
                  continue;
                }

                // Parse <think> tags
                const remaining = delta.slice(i);
                if (!inThink && remaining.startsWith("<think>")) {
                  if (!currentMsg) newAgentMsg("", "");
                  inThink = true;
                  currentMsg._thinkingActive = true;
                  currentMsg._thinkOpen = true;
                  i += 6;
                  continue;
                }
                if (inThink && remaining.startsWith("</think>")) {
                  inThink = false;
                  currentMsg._thinkingActive = false;
                  currentMsg.thinking = thinkBuf;
                  currentMsg._thinkOpen = false;
                  i += 7;
                  continue;
                }

                if (inThink) {
                  thinkBuf += c;
                  if (currentMsg) currentMsg.thinking = thinkBuf;
                } else {
                  if (!currentMsg) newAgentMsg("", "");
                  contentBuf += c;
                  currentMsg.content = contentBuf;
                }
              }

              triggerRef(messages);
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

    function scrollToBottom() {
      nextTick(() => {
        const el = messagesContainer.value;
        if (el) el.scrollTop = el.scrollHeight;
      });
    }

    onMounted(() => {
      fetchThreads();
      pollInterval = setInterval(fetchThreads, 5000);
    });
    onUnmounted(() => clearInterval(pollInterval));

    return {
      drawer, rail, input, threads, activeThreadIds, currentThreadId, currentDirective,
      messages, displayMessages, streaming, messagesContainer,
      getEmoji, agentDisplayName, formatTime, renderMd, fetchThreads, selectThread, deleteThread, startNewChat, send, abort,
    };
  }
};

// Export for use in main app
window.ChatView = ChatView;
})();
