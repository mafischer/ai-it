import re

with open('app/builder.js', 'r') as f:
    content = f.read()

# 1. Add route, isReadonly, threadId in setup()
content = content.replace(
    "const snackbar = reactive({ show: false, text: \"\", color: \"success\" });",
    """const snackbar = reactive({ show: false, text: "", color: "success" });
    const isReadonly = computed(() => {
      const urlParams = new URLSearchParams(window.location.search);
      return urlParams.get('readonly') === 'true' || window.location.hash.includes('readonly=true');
    });
    const threadId = computed(() => {
      const urlParams = new URLSearchParams(window.location.search);
      const t = urlParams.get('thread_id');
      if (t) return t;
      const match = window.location.hash.match(/thread_id=([^&]+)/);
      return match ? match[1] : null;
    });

    const activeAgents = ref([]);
    const activeMilestones = ref([]);
    
    // Polling logic for active state
    let pollTimer = null;
    onMounted(() => {
      if (isReadonly.value && threadId.value) {
        pollTimer = setInterval(async () => {
          try {
            const r = await fetch("/api/active");
            if (r.ok) {
              const active = await r.json();
              const threadActive = active.find(a => a.thread_id === threadId.value);
              if (threadActive) {
                 activeAgents.value = threadActive.agents || [];
                 // active milestone can be derived from agents
                 // A milestone is active if any agent inside it is active
                 const activeMs = [];
                 activeAgents.value.forEach(a => {
                    // find node
                    const n = nodes.value.find(node => node.type === 'agent' && node.id === 'agent_' + a);
                    if (n) {
                       // find which milestone contains this node
                       const ms = milestoneBoxes.value.find(b => 
                          n.x >= b.x && n.x <= b.x + b.width &&
                          n.y >= b.y && n.y <= b.y + b.height
                       );
                       if (ms && !activeMs.includes(ms.id)) activeMs.push(ms.id);
                    }
                 });
                 activeMilestones.value = activeMs;
              } else {
                 activeAgents.value = [];
                 activeMilestones.value = [];
              }
            }
          } catch(e) {}
        }, 1000);
      }
    });
    onUnmounted(() => {
      if (pollTimer) clearInterval(pollTimer);
    });

    const isActiveMilestone = (id) => activeMilestones.value.includes(id);
    const isActiveNode = (id) => {
       if (id.startsWith('agent_')) {
          const agentId = id.substring(6);
          return activeAgents.value.includes(agentId);
       }
       return false;
    };
"""
)

# 2. Add isActiveMilestone / isActiveNode to returns
content = content.replace(
    "drawingEdge, drawingEdgePath, getCanvasCoords,",
    "drawingEdge, drawingEdgePath, getCanvasCoords, isReadonly, isActiveMilestone, isActiveNode,"
)

# 3. Patch UI to hide left bar and top buttons when isReadonly
content = content.replace(
    '<v-card class="ma-2 d-flex flex-column" border style="width: 250px; flex-shrink: 0;">',
    '<v-card v-if="!isReadonly" class="ma-2 d-flex flex-column" border style="width: 250px; flex-shrink: 0;">'
)
content = content.replace(
    '<v-app-bar color="surface" border="b" density="compact">',
    '<v-app-bar v-if="!isReadonly" color="surface" border="b" density="compact">'
)
content = content.replace(
    '<v-btn-toggle v-model="viewMode"',
    '<v-btn-toggle v-if="!isReadonly" v-model="viewMode"'
)
content = content.replace(
    '<v-btn icon="mdi-refresh" size="small" @click="layoutNodes(false)" title="Auto Layout"></v-btn>',
    '<v-btn v-if="!isReadonly" icon="mdi-refresh" size="small" @click="layoutNodes(false)" title="Auto Layout"></v-btn>'
)

# 4. Patch milestones: highlight when active
content = content.replace(
    ":style=\"{ left: box.x + 'px', top: box.y + 'px', width: box.width + 'px', height: box.height + 'px', border: '2px dashed rgba(88, 166, 255, 0.3)', zIndex: 5, cursor: 'grab' }\"",
    ":style=\"{ left: box.x + 'px', top: box.y + 'px', width: box.width + 'px', height: box.height + 'px', border: isActiveMilestone(box.id) ? '2px dashed #4caf50' : '2px dashed rgba(88, 166, 255, 0.3)', zIndex: 5, cursor: isReadonly ? 'default' : 'grab' }\""
)
content = content.replace(
    '<div class="position-absolute" style="top: -20px; left: 10px; font-size: 11px; color: rgba(88, 166, 255, 0.7); font-weight: bold; text-transform: uppercase;">',
    '<div class="position-absolute" style="top: -20px; left: 10px; font-size: 11px; font-weight: bold; text-transform: uppercase;" :style="{ color: isActiveMilestone(box.id) ? \'#4caf50\' : \'rgba(88, 166, 255, 0.7)\' }">'
)
content = content.replace(
    '{{ box.label }}',
    '{{ box.label }}<v-progress-circular v-if="isActiveMilestone(box.id)" indeterminate size="10" width="1" color="success" class="ml-1"></v-progress-circular>'
)

# 5. Patch nodes: active spinner, green border, arrows
content = content.replace(
    '<v-card elevation="4" :class="{ \'border-primary\': selectedNode === node.id }" border="thin" style="background: #1e1e2e; position: relative;" @click="selectedNode = node.id">',
    '<v-card elevation="4" :class="{ \'border-primary\': selectedNode === node.id }" :border="isActiveNode(node.id) ? \'success md\' : \'thin\'" style="background: #1e1e2e; position: relative;" @click="selectedNode = node.id">'
)

content = content.replace(
    '<div class="text-caption font-weight-bold text-truncate" :title="node.label">{{ node.label }}</div>',
    """<div class="text-caption font-weight-bold text-truncate" :style="{ color: isActiveNode(node.id) ? '#4caf50' : 'inherit' }" :title="node.label">{{ node.label }}</div>
       <v-spacer></v-spacer>
       <v-progress-circular v-if="isActiveNode(node.id)" indeterminate size="12" width="2" color="success"></v-progress-circular>"""
)

# 6. SVG edges animation
content = content.replace(
    '<svg style="position: absolute; top: 0; left: 0; width: 100%; height: 100%; pointer-events: none;" v-if="nodes.length || drawingEdge.active || milestoneEdges.length">',
    """<svg style="position: absolute; top: 0; left: 0; width: 100%; height: 100%; pointer-events: none;" v-if="nodes.length || drawingEdge.active || milestoneEdges.length">
                <defs>
                  <marker id="arrowhead" markerWidth="10" markerHeight="7" refX="9" refY="3.5" orient="auto">
                    <polygon points="0 0, 10 3.5, 0 7" fill="#58a6ff" />
                  </marker>
                  <marker id="arrowhead-active" markerWidth="10" markerHeight="7" refX="9" refY="3.5" orient="auto">
                    <polygon points="0 0, 10 3.5, 0 7" fill="#4caf50" />
                  </marker>
                </defs>"""
)
content = content.replace(
    '<defs>\n                  <marker id="arrowhead" markerWidth="10" markerHeight="7" refX="9" refY="3.5" orient="auto">\n                    <polygon points="0 0, 10 3.5, 0 7" fill="#58a6ff" />\n                  </marker>\n                </defs>',
    ''
)
content = content.replace(
    '<path :d="getEdgePath(node, target, i, (node.routes || []).length)" fill="none" stroke="#58a6ff" stroke-width="2" marker-end="url(#arrowhead)" style="pointer-events: stroke; cursor: pointer;" @click="deleteEdge(node.id, route.status, target)"/>',
    """<path :d="getEdgePath(node, target, i, (node.routes || []).length)" fill="none" :stroke="isActiveNode(node.id) ? '#4caf50' : '#58a6ff'" stroke-width="2" :marker-end="isActiveNode(node.id) ? 'url(#arrowhead-active)' : 'url(#arrowhead)'" style="pointer-events: stroke; cursor: pointer;" @click="!isReadonly ? deleteEdge(node.id, route.status, target) : null"/>
       <circle v-if="isActiveNode(node.id)" r="4" fill="#4caf50">
           <animateMotion dur="2s" repeatCount="indefinite" :path="getEdgePath(node, target, i, (node.routes || []).length)" />
       </circle>"""
)

# 7. disable drag for readonly
content = content.replace(
    "@mousedown.stop=\"startMilestoneDrag(box.id, $event)\"",
    "@mousedown.stop=\"!isReadonly ? startMilestoneDrag(box.id, $event) : null\""
)
content = content.replace(
    "@mousedown.stop=\"startDrag(node, $event)\"",
    "@mousedown.stop=\"!isReadonly ? startDrag(node, $event) : null\""
)
content = content.replace(
    "@mousedown.stop=\"startEdgeDrag(node, route.status, $event)\"",
    "@mousedown.stop=\"!isReadonly ? startEdgeDrag(node, route.status, $event) : null\""
)
content = content.replace(
    '<div class="position-absolute" style="top: 2px; right: 2px; z-index: 20;">',
    '<div v-if="!isReadonly" class="position-absolute" style="top: 2px; right: 2px; z-index: 20;">'
)

# Fix onUnmounted import
content = content.replace(
    "const { ref, reactive, computed, onMounted, nextTick, watch } = Vue;",
    "const { ref, reactive, computed, onMounted, onUnmounted, nextTick, watch } = Vue;"
)

with open('app/builder.js', 'w') as f:
    f.write(content)
print("builder.js patched successfully")
