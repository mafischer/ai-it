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

function extractStatus(content) {
  const matches = [...(content || "").matchAll(/STATUS:\s*([A-Z_]+)/g)];
  return matches.length ? matches[matches.length - 1][1] : "";
}

function statusColor(status) {
  if (!status) return "grey";
  if (status.includes("COMPLETE") || status.includes("PASSED") || status.includes("APPROVED") || status.includes("DRAFTED") || status.includes("CLEAR")) return "success";
  if (status.includes("AMBIGUOUS")) return "warning";
  return "error";
}

function agentDisplayName(id) {
  if (typeof id !== 'string') id = String(id || "");
  return id.replace(/_research_round_\d+$/, "").replace(/_research_phase_2_\d+$/, "").replace(/_research_phase_2$/, "").replace(/_research$/, "").replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
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
          <v-list-item prepend-icon="mdi-hammer-wrench" title="Builder" @click="$router.push('/builder')" rounded nav />
        </template>
      </v-navigation-drawer>

      <!-- Main Chat Area -->
      <v-main class="d-flex flex-column" style="height:100vh">
        <!-- Empty state -->
        <div v-if="!messages.length && !streaming" class="d-flex flex-column align-center justify-center flex-grow-1 pa-4">
          <v-icon size="64" color="primary" class="mb-4">mdi-brain</v-icon>
          <h2 class="text-h5 font-weight-bold mb-2" style="color:#cdd6f4">AI-IT</h2>
          <p class="text-body-1 text-medium-emphasis mb-6">Multi-agent <s style="text-decoration: line-through;">software engineering</s> anything</p>
          <div style="width:100%;max-width:700px">
            <v-select
              v-model="selectedWorkflow"
              :items="workflows"
              item-title="name"
              item-value="id"
              label="Workflow"
              variant="outlined"
              class="mb-4"
              hide-details
            >
              <template v-slot:item="{ props, item }">
                <v-list-item v-bind="props" :subtitle="item.raw.description"></v-list-item>
              </template>
            </v-select>
            <v-textarea v-model="input" placeholder="Describe what you want to build..."
              variant="outlined" rows="3" auto-grow hide-details
              @keydown.enter.exact.prevent="send"
              :disabled="streaming || !selectedWorkflow" />
            <div class="d-flex justify-end mt-2">
              <v-btn color="primary" :disabled="!input.trim() || streaming || !selectedWorkflow" @click="send"
                prepend-icon="mdi-send">Send</v-btn>
            </div>
          </div>
        </div>

        <!-- Messages -->
        <div v-else class="flex-grow-1 pa-4" ref="messagesContainer" style="max-width:900px;margin:0 auto;width:100%;overflow-y:scroll">
          <div v-for="(section, si) in (hasMilestones ? milestoneSections : [{messages: displayMessages, active: streaming}])" :key="'s'+si" :class="hasMilestones ? 'mb-3' : ''">
            <!-- Milestone section header -->
            <div v-if="hasMilestones" class="d-flex align-center cursor-pointer pa-2 rounded mb-3"
              style="background: rgba(255,255,255,0.04); border-left: 3px solid; min-height: 32px;"
              :style="{ borderColor: section.active ? '#89b4fa' : 'rgba(255,255,255,0.15)' }"
              @click="toggleSection(si)">
              <v-icon size="small" class="mr-2" :color="section.active ? 'primary' : 'medium-emphasis'">
                {{ isSectionOpen(si) ? 'mdi-chevron-down' : 'mdi-chevron-right' }}
              </v-icon>
              <span v-if="section.agent" class="mr-2">{{ getEmoji(section.agent) }}</span>
              <span class="text-body-2 font-weight-medium" :class="section.active ? 'text-primary' : 'text-medium-emphasis'">
                {{ section.label || 'Start' }}
              </span>
              <v-chip size="x-small" variant="tonal" class="ml-3">{{ section.messages.length }}</v-chip>
              <v-progress-circular v-if="section.active" indeterminate size="14" width="2" color="primary" class="ml-2" />
            </div>

            <div v-show="!hasMilestones || isSectionOpen(si)">
          <div v-for="(m, mi) in section.messages" :key="'m'+si+'-'+mi" class="mb-4">
            <div :class="m.role === 'user' ? 'text-right' : 'text-left'" class="mb-1">
              <span class="text-caption text-medium-emphasis">{{ formatTime(m._timestamp) }}</span>
            </div>

            <!-- User message -->
            <div v-if="m.role === 'user'" class="d-flex justify-end">
              <v-card color="primary" variant="tonal" max-width="80%" rounded="lg" 
                class="cursor-pointer" @click="toggleMessage(m)">
                <div class="d-flex align-center justify-space-between pa-1 border-b opacity-70" style="background: rgba(0,0,0,0.05); z-index: 20;">
                  <div class="d-flex align-center ml-1">
                    <v-chip size="x-small" color="primary" variant="flat" class="mr-2">
                      <v-icon start size="x-small">mdi-account</v-icon>
                      User
                    </v-chip>
                  </div>
                  <div class="d-flex align-center ga-1">
                    <v-btn icon size="x-small" variant="text" @click.stop="copyToClipboard(m.content)" title="Copy text">
                      <v-icon size="x-small">mdi-content-copy</v-icon>
                    </v-btn>
                    <v-btn icon size="x-small" variant="text" @click.stop="cloneAt(chatMsgIndex(m))" title="Clone from here">
                      <v-icon size="x-small">mdi-source-fork</v-icon>
                    </v-btn>
                    <v-icon size="x-small" class="mr-1">
                      {{ m._msgOpen === false ? 'mdi-chevron-left' : 'mdi-chevron-up' }}
                    </v-icon>
                  </div>
                </div>
                <div class="pa-3">
                  <div v-show="m._msgOpen !== false" class="md-content" v-html="renderMd(m.content)"></div>
                  <div v-show="m._msgOpen === false" class="md-content opacity-70">
                    {{ m.content.slice(0, 100) }}{{ m.content.length > 100 ? '...' : '' }}
                  </div>
                </div>
              </v-card>
            </div>

            <!-- System prompt message (directed at an agent) -->
            <div v-else-if="m.type === 'prompt'" class="d-flex justify-start">
              <div style="max-width:90%;width:100%">
                <v-card variant="outlined" color="surface-variant" rounded="lg" 
                  class="cursor-pointer" @click="toggleMessage(m)">
                  <div class="d-flex align-center justify-space-between pa-1 border-b opacity-70" style="background: rgba(0,0,0,0.05); z-index: 20;">
                    <div class="d-flex align-center ml-1">
                      <v-chip size="x-small" variant="tonal" color="warning" class="mr-2">
                        <v-icon start size="x-small">mdi-arrow-right</v-icon>
                        System prompt to {{ agentDisplayName(m.name) }}
                      </v-chip>
                    </div>
                    <div class="d-flex align-center ga-1">
                      <v-btn icon size="x-small" variant="text" @click.stop="copyToClipboard(m.content)" title="Copy text">
                        <v-icon size="x-small">mdi-content-copy</v-icon>
                      </v-btn>
                      <v-btn icon size="x-small" variant="text" @click.stop="cloneAt(chatMsgIndex(m))" title="Clone from here">
                        <v-icon size="x-small">mdi-source-fork</v-icon>
                      </v-btn>
                      <v-icon size="x-small" class="mr-1">
                        {{ m._msgOpen === false ? 'mdi-chevron-right' : 'mdi-chevron-up' }}
                      </v-icon>
                    </div>
                  </div>
                  <v-card-text class="pa-3">
                    <div v-show="m._msgOpen !== false" class="md-content text-medium-emphasis" style="font-size:0.85rem" v-html="renderMd(m.content)"></div>
                    <div v-show="m._msgOpen === false" class="md-content text-medium-emphasis opacity-70" style="font-size:0.85rem">
                      {{ m.content.slice(0, 100) }}{{ m.content.length > 100 ? '...' : '' }}
                    </div>
                  </v-card-text>
                </v-card>
              </div>
            </div>

            <!-- Agent message -->
            <div v-else class="d-flex justify-start">
              <div style="max-width:90%;width:100%">
                <v-card elevation="2" rounded="lg" class="cursor-pointer" @click="toggleMessage(m)">
                  <div class="d-flex align-center justify-space-between pa-1 border-b opacity-70" style="background: rgba(0,0,0,0.05); z-index: 20;">
                    <div class="d-flex align-center ml-1">
                      <v-chip size="x-small" color="primary" variant="flat" class="mr-2">
                        {{ getEmoji(m.name) }} {{ agentDisplayName(m.name || 'assistant') }}
                      </v-chip>
                      <v-progress-circular v-if="m._streaming" indeterminate size="12" width="1.5" color="primary"></v-progress-circular>
                      <v-chip v-if="extractStatus(m.content)" :color="statusColor(extractStatus(m.content))" size="x-small" variant="tonal" class="ml-2">
                        {{ extractStatus(m.content) }}
                      </v-chip>
                    </div>
                    <div class="d-flex align-center ga-1">
                      <v-btn icon size="x-small" variant="text" @click.stop="copyToClipboard(m.content)" title="Copy text">
                        <v-icon size="x-small">mdi-content-copy</v-icon>
                      </v-btn>
                      <v-btn icon size="x-small" variant="text" @click.stop="cloneAt(chatMsgIndex(m))" title="Clone from here">
                        <v-icon size="x-small">mdi-source-fork</v-icon>
                      </v-btn>
                      <v-icon size="x-small" class="mr-1">
                        {{ m._msgOpen === false ? 'mdi-chevron-right' : 'mdi-chevron-up' }}
                      </v-icon>
                    </div>
                  </div>

                  <div class="pa-3">
                    <div v-show="m._msgOpen !== false">
                      <!-- Agent prompt section -->
                      <v-card v-if="m.prompt" variant="outlined" color="surface-variant" class="mb-2" rounded="lg" @click.stop>
                        <v-card-text class="pa-2">
                          <div class="d-flex align-center cursor-pointer" @click.stop="m._promptOpen = !m._promptOpen">
                            <v-icon size="small" class="mr-2">{{ m._promptOpen ? 'mdi-chevron-down' : 'mdi-chevron-right' }}</v-icon>
                            <span class="text-caption text-medium-emphasis">Prompt</span>
                          </div>
                          <pre v-if="m._promptOpen" class="msg-text mt-2 text-medium-emphasis" style="font-size:0.8rem">{{ m.prompt }}</pre>
                        </v-card-text>
                      </v-card>

                      <!-- Thinking / Research section -->
                      <v-card v-if="m.thinking || (m._toolActivities && m._toolActivities.length)" variant="outlined" class="mb-2" rounded="lg" @click.stop>
                        <v-card-text class="pa-2">
                          <div class="d-flex align-center cursor-pointer" @click.stop="m._thinkOpen = !m._thinkOpen; m._userToggledThink = true">
                            <v-icon size="small" class="mr-2">{{ m._thinkOpen ? 'mdi-chevron-down' : 'mdi-chevron-right' }}</v-icon>
                            <span class="text-caption text-medium-emphasis">
                              <template v-if="m._thinkingActive">Thinking</template>
                              <template v-else-if="m._toolActivities && m._toolActivities.some(a => a.status === 'running')">Researching</template>
                              <template v-else>{{ formatThinkDuration(m) ? 'Thought for ' + formatThinkDuration(m) : (m.thinking ? 'Thought' : 'Research') }}</template>
                            </span>
                            <v-progress-circular v-if="m._thinkingActive || (m._toolActivities && m._toolActivities.some(a => a.status === 'running'))" indeterminate size="14" width="2" color="primary" class="ml-2" />
                          </div>
                          <div v-if="m._thinkOpen">
                            <div v-if="m._toolActivities && m._toolActivities.length" class="mt-2">
                              <div v-if="m._toolActivities.some(a => a.type === 'search')" class="mb-2">
                                <div class="text-caption text-medium-emphasis font-weight-bold mb-1" style="font-size:0.7rem;text-transform:uppercase;letter-spacing:0.05em">
                                  <v-icon size="12" class="mr-1">mdi-magnify</v-icon>Searches
                                </div>
                                <div v-for="(ta, ti) in m._toolActivities.filter(a => a.type === 'search')" :key="'s'+ti" class="d-flex align-center mb-1" style="font-size:0.8rem">
                                  <a :href="'https://duckduckgo.com/?q=' + encodeURIComponent(ta.query)" target="_blank" rel="noopener" class="text-medium-emphasis tool-link" @click.stop>{{ ta.query }}</a>
                                  <v-progress-circular v-if="ta.status === 'running'" indeterminate size="12" width="1" color="primary" class="ml-2" />
                                  <v-chip v-if="ta.status === 'complete' && ta.results" size="x-small" variant="tonal" class="ml-2">{{ ta.results.length }} results</v-chip>
                                </div>
                              </div>
                              <div v-if="m._toolActivities.some(a => a.type === 'fetch')" class="mb-2">
                                <div class="text-caption text-medium-emphasis font-weight-bold mb-1" style="font-size:0.7rem;text-transform:uppercase;letter-spacing:0.05em">
                                  <v-icon size="12" class="mr-1">mdi-web</v-icon>Pages
                                </div>
                                <div v-for="(ta, ti) in m._toolActivities.filter(a => a.type === 'fetch')" :key="'f'+ti" class="d-flex align-center mb-1" style="font-size:0.8rem">
                                  <img v-if="ta.favicon" :src="ta.favicon" width="16" height="16" class="mr-2" style="border-radius:2px" />
                                  <v-icon v-else size="14" class="mr-2" :color="ta.status === 'running' ? 'primary' : 'success'">mdi-web</v-icon>
                                  <a :href="ta.url" target="_blank" rel="noopener" class="text-medium-emphasis tool-link" :title="ta.url" @click.stop>{{ ta.title || ta.domain || ta.url }}</a>
                                  <v-progress-circular v-if="ta.status === 'running'" indeterminate size="12" width="1" color="primary" class="ml-2" />
                                  <v-icon v-if="ta.status === 'complete'" size="14" color="success" class="ml-1">mdi-check</v-icon>
                                </div>
                              </div>
                            </div>
                            <div v-if="m.thinking" class="md-content mt-2 text-medium-emphasis" style="font-size:0.8rem" v-html="renderMd(m.thinking)"></div>
                          </div>
                        </v-card-text>
                      </v-card>

                      <!-- Response content -->
                      <div v-if="m.content" class="md-content" v-html="renderMd(m.content)"></div>

                      <!-- Streaming placeholder -->
                      <v-skeleton-loader v-if="m._streaming && !m.content" type="paragraph" />
                    </div>

                    <div v-show="m._msgOpen === false" class="md-content opacity-70">
                      {{ m.content.slice(0, 100) }}{{ m.content.length > 100 ? '...' : '' }}
                    </div>
                  </div>
                </v-card>
              </div>
            </div>
          </div>
            </div>
          </div>
        </div>

        <!-- Bottom input area -->
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
            <v-btn v-if="currentThreadId && currentThreadId !== '_pending' && streaming" size="small" variant="tonal" color="error" class="ml-2"
              prepend-icon="mdi-stop"
              @click="stopThread(currentThreadId)">
              Abort
            </v-btn>
            <v-btn v-if="currentThreadId && currentThreadId !== '_pending'" size="small" variant="tonal" color="medium-emphasis" class="ml-2"
              :prepend-icon="pausing ? 'mdi-timer-sand' : (streaming ? 'mdi-pause' : 'mdi-play')"
              :disabled="pausing"
              :loading="pausing"
              @click="streaming ? pauseThread() : resumeThread()">
              {{ pausing ? 'Pausing...' : (streaming ? 'Pause' : 'Resume') }}
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
    const workflows = ref([]);
    const workflowMilestones = ref([]);
    
    const fetchWorkflows = async () => {
      try {
        const res = await fetch("/api/workflows");
        if (res.ok) {
          const files = await res.json();
          workflows.value = files.map(f => ({ id: f, name: f, description: f + " workflow" }));
        }
      } catch (e) {
        console.error("Failed to load workflows");
      }
    };

    const fetchMilestones = async () => {
      try {
        const res = await fetch("/api/workflow");
        if (res.ok) {
          const w = await res.json();
          if (w.pipeline && w.pipeline.milestones) workflowMilestones.value = w.pipeline.milestones;
        }
      } catch (e) {}
    };
    const selectedWorkflow = ref(null);
    const threads = ref([]);
    const activeThreadIds = ref([]);
    const currentThreadId = ref(route.query.t || null);
    const currentDirective = ref("");
    const messages = ref([]);
    const streaming = ref(false);
    const messagesContainer = ref(null);
    const drafts = {};
    const now = ref(Date.now());
    let nowInterval = null;
    let pollInterval = null;
    let currentStreamController = null;
    let scrollTimeout = null;

    const activeStreamStates = {};

    function saveDraft() {
      const key = currentThreadId.value || "_new";
      drafts[key] = input.value;
    }

    function restoreDraft() {
      const key = currentThreadId.value || "_new";
      input.value = drafts[key] || "";
    }

    const displayMessages = computed(() => messages.value.filter(m => m.type !== "boundary"));
    const allExpanded = computed(() => messages.value.length > 0 && messages.value.filter(m => m.type !== "boundary").every(m => m._msgOpen !== false));

    function formatMilestoneLabel(status) {
      if (!status) return "";
      if (workflowMilestones.value && workflowMilestones.value.length) {
        const m = workflowMilestones.value.find(m => m.statuses && m.statuses.includes(status));
        if (m && m.name) return m.name;
      }
      return status.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
    }

    function baseAgentName(id) {
      return (id || "").replace(/_research_round_\d+$/, "").replace(/_research_phase_2_\d+$/, "").replace(/_research_phase_2$/, "").replace(/_research$/, "").replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
    }

    function deriveSectionLabel(section, nextBoundary) {
      if (nextBoundary) return formatMilestoneLabel(nextBoundary.milestoneStatus);
      const agents = [...new Set(section.messages
        .filter(m => m.role === "assistant" && m.name)
        .map(m => m.name.replace(/_research.*$/, "")))];
      if (agents.length) return agents.map(a => baseAgentName(a)).join(", ");
      const promptAgents = [...new Set(section.messages
        .filter(m => m.type === "prompt" && m.name)
        .map(m => m.name))];
      if (promptAgents.length) return promptAgents.map(a => baseAgentName(a)).join(", ");
      return "Processing";
    }

    const chatSectionOverrides = reactive({});
    let chatPrevSectionCount = 0;

    const milestoneSections = computed(() => {
      const milestones = workflowMilestones.value || [];
      if (!milestones.length) {
        const rawSections = [];
        const boundaries = [];
        let current = { messages: [], active: false };
        rawSections.push(current);
        for (const m of messages.value) {
          if (m.type === "boundary") {
            boundaries.push({ milestoneStatus: m.milestoneStatus, milestoneAgent: m.milestoneAgent });
            current = { messages: [], active: false };
            rawSections.push(current);
          } else {
            current.messages.push(m);
          }
        }
        const sections = rawSections.map((s, i) => {
          const thisNextBoundary = i < boundaries.length ? boundaries[i] : null;
          const agent = thisNextBoundary ? (thisNextBoundary.milestoneAgent || "") : (s.messages.find(m => m.role === "assistant" && m.name)?.name || "");
          return { ...s, label: deriveSectionLabel(s, thisNextBoundary), agent };
        });
        const labelCounts = {};
        sections.forEach(s => { labelCounts[s.label] = (labelCounts[s.label] || 0) + 1; });
        const labelCounters = {};
        sections.forEach(s => {
          if (labelCounts[s.label] > 1) {
            labelCounters[s.label] = (labelCounters[s.label] || 0) + 1;
            s.label = s.label + " (Round " + labelCounters[s.label] + ")";
          }
        });
        if (sections.length && streaming.value) {
          sections[sections.length - 1].active = true;
        }
        sections.forEach(s => {
          if (s.messages.some(m => m._streaming)) s.active = true;
        });
        if (sections.length !== chatPrevSectionCount) {
          Object.keys(chatSectionOverrides).forEach(k => delete chatSectionOverrides[k]);
          chatPrevSectionCount = sections.length;
        }
        return sections;
      }

      const sectionsMap = new Map();
      const sections = milestones.map(m => {
        const s = { id: m.id, label: m.name, messages: [], active: false, agent: "", statuses: m.statuses || [] };
        sectionsMap.set(m.id, s);
        return s;
      });

      let currentMilestoneIndex = 0;
      for (const m of messages.value) {
        if (m.type === "boundary") {
          const mIdx = milestones.findIndex(ms => ms.statuses && ms.statuses.includes(m.milestoneStatus));
          if (mIdx !== -1) {
            currentMilestoneIndex = mIdx;
          }
          if (mIdx !== -1 && mIdx + 1 < milestones.length) {
            currentMilestoneIndex = mIdx + 1;
          }
        } else {
          sections[currentMilestoneIndex].messages.push(m);
          if (m.role === "assistant" && m.name) {
            sections[currentMilestoneIndex].agent = m.name;
          }
        }
      }

      if (streaming.value) {
        sections[currentMilestoneIndex].active = true;
      }
      sections.forEach(s => {
        if (s.messages.some(m => m._streaming)) s.active = true;
      });

      if (sections.length !== chatPrevSectionCount) {
        Object.keys(chatSectionOverrides).forEach(k => delete chatSectionOverrides[k]);
        chatPrevSectionCount = sections.length;
      }
      return sections;
    });

    const hasMilestones = computed(() => milestoneSections.value.length > 1);

    function isSectionOpen(si) {
      if (si in chatSectionOverrides) return chatSectionOverrides[si];
      const sections = milestoneSections.value;
      if (sections.length <= 1) return true;
      const section = sections[si];
      return section.active || si === sections.length - 1;
    }

    function toggleSection(si) {
      chatSectionOverrides[si] = !isSectionOpen(si);
    }

    function chatMsgIndex(m) {
      return messages.value.indexOf(m);
    }

    function toggleMessage(m) {
      if (window.getSelection().toString()) return;
      m._msgOpen = !m._msgOpen;
    }

    function toggleAllMessages() {
      const targetState = !allExpanded.value;
      messages.value.forEach(m => {
        m._msgOpen = targetState;
        if (!targetState) { m._promptOpen = false; m._thinkOpen = false; }
      });
      
    }

    function getEmoji(name) { return EMOJIS[name] || "\u{1F916}"; }

    function renderMd(text) {
      if (!text) return "";
      try { return marked.parse(text, { breaks: true }); }
      catch { return text; }
    }

    async function copyToClipboard(text) {
      try {
        await navigator.clipboard.writeText(text || "");
      } catch (err) {
        console.error('Failed to copy: ', err);
      }
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
      if (!m._thinkStart) return "";
      const end = m._thinkEnd || Date.now();
      const sec = Math.round((end - m._thinkStart) / 1000);
      if (sec < 60) return sec + "s";
      return Math.round(sec / 60) + "m";
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
      if (!confirm("Delete conversation?")) return;
      await fetch("/api/threads/" + threadId, { method: "DELETE" });
      if (currentThreadId.value === threadId) startNewChat();
      fetchThreads();
    }

    async function cloneAt(i) {
      if (!confirm("Clone conversation up to this point into a new chat?")) return;
      try {
        const r = await fetch("/api/threads/" + currentThreadId.value + "/clone", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ messageIndex: i })
        });
        const d = await r.json();
        if (d.thread_id) {
          selectThread(d.thread_id, currentDirective.value);
        } else {
          alert(d.error || "Clone failed");
        }
      } catch (e) {
        console.error("Clone failed", e);
      }
    }

    async function stopThread(threadId) {
      if (currentThreadId.value === threadId && currentStreamController) currentStreamController.abort();
      await fetch("/api/threads/" + threadId + "/abort", { method: "POST" });
      fetchThreads();
    }

    async function exportThread(threadId) {
      try {
        const r = await fetch("/api/threads/" + threadId + "/messages");
        if (!r.ok) return;
        const msgs = await r.json();
        const t = threads.value.find(th => th.thread_id === threadId);
        const name = (t?.title || t?.directive || threadId).slice(0, 50).replace(/[^a-z0-9]/gi, '_').toLowerCase();
        const blob = new Blob([JSON.stringify(msgs, null, 2)], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `chat_${name}.json`;
        a.click();
      } catch {}
    }

    function scrollToBottom(force = false) {
      if (scrollTimeout && !force) return;
      scrollTimeout = setTimeout(() => {
        scrollTimeout = null;
        const el = messagesContainer.value;
        if (!el) return;
        const threshold = 100;
        const isAtBottom = (el.scrollHeight - el.scrollTop - el.clientHeight) < threshold;
        if (force || isAtBottom) {
          el.scrollTop = el.scrollHeight;
        }
      }, force ? 0 : 150);
    }

    async function selectThread(threadId, directive) {
      if (currentStreamController) currentStreamController.abort();
      streaming.value = false;
      saveDraft();
      currentThreadId.value = threadId;
      currentDirective.value = directive || "";
      restoreDraft();
      router.replace({ query: { t: threadId } });
      try {
        const r = await fetch("/api/threads/" + threadId + "/messages?chain=true");
        const msgs = await r.json();
        messages.value = msgs.map(m => reactive({
          ...m,
          content: m.content || "",
          thinking: null,
          _msgOpen: m.type === "boundary" ? false : false,
          _timestamp: m.timestamp ? new Date(m.timestamp) : new Date()
        }));
        // Parse existing content for <think> blocks (greedy: first <think> to last </think>)
        messages.value.forEach(m => {
          const content = m.content || "";
          const closedMatch = content.match(/^([\s\S]*?)<think>([\s\S]*)<\/think>([\s\S]*)$/);
          if (closedMatch) {
            m.thinking = closedMatch[2].replace(/<\/?think>/g, "").trim();
            m.content = (closedMatch[1] + closedMatch[3]).replace(/<\/?think>/g, "").trim();
            m._thinkClosed = true;
          } else {
            const openMatch = content.match(/^([\s\S]*?)<think>([\s\S]*)$/);
            if (openMatch) {
              m.thinking = openMatch[2].replace(/<\/?think>/g, "").trim();
              m.content = openMatch[1].replace(/<\/?think>/g, "").trim();
              m._thinkClosed = false; // Think block still open — model still streaming thinking
              m._thinkingActive = true;
              m._thinkOpen = true;
            }
          }
        });
      } catch {}
      scrollToBottom(true);
      if (activeThreadIds.value.includes(threadId)) reconnectStream(threadId);
    }

    function startNewChat() {
      if (currentStreamController) currentStreamController.abort();
      currentThreadId.value = null;
      currentDirective.value = "";
      messages.value = [];
      streaming.value = false;
      for (const key in activeStreamStates) delete activeStreamStates[key];
      restoreDraft();
      router.replace({ query: {} });
    }

    function getStreamState(agentId, forceNew = false) {
      if (!activeStreamStates[agentId]) {
        const lastUserIdx = messages.value.findLastIndex(m => m.role === "user");
        let target = forceNew ? null : messages.value.findLast((m, idx) => idx > lastUserIdx && m.role === "assistant" && m.name === agentId && m.type !== "prompt");
        if (!target) {
          target = reactive({ role: "assistant", name: agentId, content: "", thinking: null, _streaming: true, _msgOpen: true, _timestamp: new Date() });
          messages.value.push(target);
        } else {
          // Expand existing message when reconnecting to active stream
          target._msgOpen = true;
        }
        activeStreamStates[agentId] = {
          msg: target,
          // Reconstruct buffer: keep think block open if it was still open (model still streaming thinking)
          fullBuf: target.thinking
            ? ("<think>" + target.thinking + (target._thinkClosed !== false ? "</think>" : "")) + (target.content || "")
            : (target.content || "")
        };
      }
      return activeStreamStates[agentId];
    }

    function processStreamDelta(deltaObj, choiceObj) {
      const agentId = deltaObj.agent || "";
      // Thread transition: update internal tracking, keep streaming seamlessly
      if (deltaObj.thread_transition) {
        const tt = deltaObj.thread_transition;
        console.log(`[THREAD] Transition: ${tt.from} → ${tt.to} (${tt.milestone} by ${tt.agent})`);
        if (!window._threadChain) window._threadChain = [currentThreadId.value];
        window._threadChain.push(tt.to);
        // Insert a boundary marker for milestone sections
        messages.value.push(reactive({
          role: "system", name: "__boundary__", type: "boundary",
          content: `── Thread transition: ${tt.milestone || "milestone"} ──`,
          milestoneStatus: tt.milestone || "", milestoneAgent: tt.agent || "",
          _msgOpen: false, _timestamp: new Date()
        }));
        return;
      }
      if (deltaObj.system_prompt) {
        if (activeStreamStates[agentId]) {
          const oldMsg = activeStreamStates[agentId].msg;
          oldMsg._streaming = false;
          // Remove the empty placeholder bubble created by "agent started" signal
          if (!oldMsg.content && !oldMsg.thinking) {
            const idx = messages.value.indexOf(oldMsg);
            if (idx !== -1) messages.value.splice(idx, 1);
          }
          delete activeStreamStates[agentId];
        }
        
        const exists = messages.value.some(m => m.type === "prompt" && m.name === agentId && m.content === deltaObj.system_prompt);
        if (!exists) {
          messages.value.push(reactive({ role: "system", name: agentId, content: deltaObj.system_prompt, type: "prompt", _msgOpen: true, _timestamp: new Date() }));
        }
        getStreamState(agentId, !exists);
        
        return;
      }
      if (deltaObj.tool_activity) {
        const state = getStreamState(agentId);
        state.msg._streaming = true;
        if (!state.msg._toolActivities) state.msg._toolActivities = [];
        const ta = deltaObj.tool_activity;
        if (ta.status === "running") {
          state.msg._toolActivities.push(reactive({ ...ta }));
        } else {
          // Update the matching running entry
          const match = [...state.msg._toolActivities].reverse().find(a => a.type === ta.type && a.status === "running");
          if (match) Object.assign(match, ta);
          else state.msg._toolActivities.push(reactive({ ...ta }));
        }
        state.msg._streaming = true;
        if (!state.msg._thinkOpen && !state.msg._userToggledThink) state.msg._thinkOpen = true;
        
        scrollToBottom();
        return;
      }
      if (choiceObj?.finish_reason === "stop" && agentId) {
        if (activeStreamStates[agentId]) activeStreamStates[agentId].msg._streaming = false;
        delete activeStreamStates[agentId];
        
        return;
      }
      const delta = deltaObj.content || "";
      if (!delta) {
        // Empty content with agent ID = "agent started" signal — create message with spinner
        if (agentId) {
          const state = getStreamState(agentId);
          state.msg._streaming = true;
          state.msg._msgOpen = true;
        }
        return;
      }
      const state = getStreamState(agentId);
      state.msg._streaming = true;
      
      
      state.fullBuf = (state.fullBuf || "") + delta;
      
      let thinking = "";
      let content = state.fullBuf;

      // 1. Extract closed think region (greedy: first <think> to LAST </think>)
      //    Models produce one contiguous thinking region; greedy prevents
      //    premature close if the model outputs </think>...<think> mid-thought.
      const closedMatch = content.match(/^([\s\S]*?)<think>([\s\S]*)<\/think>([\s\S]*)$/);
      if (closedMatch) {
        thinking = closedMatch[2].replace(/<\/?think>/g, "");
        content = (closedMatch[1] + closedMatch[3]).trim();
        if (!state.msg._userToggledThink && !state.msg._thinkingActive) state.msg._thinkOpen = false;
        state.msg._thinkingActive = false;
      } else {
        // 2. Handle an open think block (no closing tag yet — still streaming)
        const openMatch = content.match(/^([\s\S]*?)<think>([\s\S]*)$/);
        if (openMatch) {
          thinking = openMatch[2].replace(/<\/?think>/g, "");
          content = openMatch[1].trim();
          if (!state.msg._userToggledThink) state.msg._thinkOpen = true;
          state.msg._thinkingActive = true;
        }
      }

      state.msg.thinking = thinking;
      state.msg._thinking = thinking; 
      state.msg.content = content.trim();
      state.msg._displayContent = content.trim(); 
    
      
      scrollToBottom();
    }

    async function send() {
      const text = input.value.trim();
      if (!text || streaming.value) return;
      input.value = "";
      messages.value.push(reactive({ role: "user", content: text, _msgOpen: true, _timestamp: new Date() }));
      const apiMessages = messages.value.map(m => ({ role: m.role === "user" ? "user" : "assistant", content: m.content || "" }));
      streaming.value = true;
      currentStreamController = new AbortController();
      try {
        const resp = await fetch("/v1/chat/completions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: "ai-it-org", messages: apiMessages, stream: true }), signal: currentStreamController.signal });
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
              if (data.choices?.[0]) processStreamDelta(data.choices[0].delta, data.choices[0]);
            } catch {}
          }
        }
      } catch {} finally {
        for (const key in activeStreamStates) { activeStreamStates[key].msg._streaming = false; delete activeStreamStates[key]; }
        streaming.value = false; currentStreamController = null; fetchThreads();
      }
    }

    const pausing = ref(false);

    async function resumeThread() {
      if (!currentThreadId.value || streaming.value) return;
      try {
        pausing.value = false;
        const r = await fetch("/api/threads/" + currentThreadId.value + "/resume", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: "{}"
        });
        const d = await r.json();
        if (d.error) { alert(d.error); return; }
        fetchThreads();
      } catch (e) {
        alert("Resume failed: " + e.message);
      }
    }

    async function pauseThread() {
      if (!currentThreadId.value) return;
      try {
        const r = await fetch("/api/threads/" + currentThreadId.value + "/pause", { method: "POST" });
        const d = await r.json();
        if (d.error) { alert(d.error); return; }
        pausing.value = true;
      } catch (e) {
        alert("Pause failed: " + e.message);
      }
    }

    async function reconnectStream(threadId) {
      if (streaming.value) return;
      streaming.value = true;
      currentStreamController = new AbortController();
      try {
        const resp = await fetch("/api/threads/" + threadId + "/stream", { signal: currentStreamController.signal });
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
              if (data.choices?.[0]) processStreamDelta(data.choices[0].delta, data.choices[0]);
            } catch {}
          }
        }
      } catch {} finally {
        for (const key in activeStreamStates) { activeStreamStates[key].msg._streaming = false; delete activeStreamStates[key]; }
        streaming.value = false; currentStreamController = null;
      }
    }

    onMounted(async () => {
      await fetchThreads();
      await fetchWorkflows();
      await fetchMilestones();
      // Restore thread from URL query if present
      if (currentThreadId.value) {
        const t = threads.value.find(th => th.thread_id === currentThreadId.value);
        if (t) {
          await selectThread(t.thread_id, t.directive);
        }
      }
      pollInterval = setInterval(fetchThreads, 5000);
      nowInterval = setInterval(() => { now.value = Date.now(); }, 30000);
    });

    // Auto-connect to stream when the current thread becomes active
    watch(activeThreadIds, (newActive) => {
      if (currentThreadId.value && !streaming.value && newActive.includes(currentThreadId.value)) {
        reconnectStream(currentThreadId.value);
      }
    });
    // Clear pausing state when streaming ends
    watch(streaming, (nowStreaming) => {
      if (!nowStreaming) pausing.value = false;
    });
    onUnmounted(() => { clearInterval(pollInterval); clearInterval(nowInterval); if (currentStreamController) currentStreamController.abort(); });

    return { drawer, rail, input, workflows, selectedWorkflow, threads, activeThreadIds, currentThreadId, messages, displayMessages, streaming, pausing, messagesContainer, getEmoji, agentDisplayName, extractStatus, statusColor, formatTime, formatThinkDuration, timeAgo, renderMd, fetchThreads, selectThread, deleteThread, stopThread, exportThread, startNewChat, send, resumeThread, pauseThread, allExpanded, toggleAllMessages, copyToClipboard, cloneAt, toggleMessage, milestoneSections, hasMilestones, isSectionOpen, toggleSection, chatMsgIndex };
  }
};

window.ChatView = ChatView;
})();
