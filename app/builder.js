(function() {
const { ref, reactive, computed, onMounted, nextTick, watch } = Vue;
const { useTheme } = Vuetify;

window.BuilderView = {
  template: `
    <v-layout class="fill-height">
      <v-app-bar color="surface" border="b" density="compact">
        <v-btn icon="mdi-arrow-left" @click="$router.push('/')"></v-btn>
        <v-app-bar-title>Workflow Builder <span v-if="currentWorkflow" class="text-caption text-medium-emphasis">({{ currentWorkflow }})</span></v-app-bar-title>
        <v-spacer></v-spacer>
        <v-btn color="primary" @click="saveWorkflow" :loading="saving" prepend-icon="mdi-content-save">Save</v-btn>
      </v-app-bar>

      <v-main class="d-flex" style="height: 100vh; overflow: hidden;">
        <!-- Left Panel: Palette -->
        <v-card class="ma-2 d-flex flex-column" border style="width: 250px; flex-shrink: 0;">
          <v-toolbar density="compact" color="surface-variant">
            <v-toolbar-title class="text-caption">Palette</v-toolbar-title>
          </v-toolbar>
          <v-list density="compact" class="flex-grow-1" style="overflow-y: auto;" bg-color="background" v-model:opened="paletteGroupsOpen">
            <div class="px-3 pt-3 pb-1 text-caption text-medium-emphasis">Drag elements onto the canvas</div>

            <v-list-item draggable="true" @dragstart="onPaletteDragStart($event, 'user')" class="cursor-move ma-2 border rounded" style="background: #1e1e2e;">
              <template v-slot:prepend><v-icon color="teal">mdi-account</v-icon></template>
              <v-list-item-title>User Node</v-list-item-title>
            </v-list-item>

            <v-list-item draggable="true" @dragstart="onPaletteDragStart($event, 'milestone')" class="cursor-move ma-2 border rounded" style="background: #1e1e2e;">
              <template v-slot:prepend><v-icon color="blue">mdi-flag-triangle</v-icon></template>
              <v-list-item-title>New Milestone</v-list-item-title>
            </v-list-item>

            <v-list-group value="agents">
              <template v-slot:activator="{ props }">
                <v-list-item v-bind="props" class="ma-2">
                  <template v-slot:prepend><v-icon>mdi-robot</v-icon></template>
                  <v-list-item-title>Agent Nodes</v-list-item-title>
                </v-list-item>
              </template>
              <v-list-item v-for="(agent, agentId) in (workflowObj.agents || {})" :key="agentId"
                draggable="true" @dragstart="onPaletteDragStart($event, 'agent_' + agentId)" class="cursor-move mx-2 mb-1 border rounded" style="background: #1e1e2e;">
                <template v-slot:prepend><span class="mr-1">{{ agent.emoji || '\u{1F916}' }}</span></template>
                <v-list-item-title class="text-caption">{{ agent.role || agentId }}</v-list-item-title>
              </v-list-item>
              <v-list-item draggable="true" @dragstart="onPaletteDragStart($event, 'agent_new')" class="cursor-move mx-2 mb-1 border rounded border-dashed" style="background: #1e1e2e;">
                <template v-slot:prepend><v-icon color="primary" size="small">mdi-plus</v-icon></template>
                <v-list-item-title class="text-caption">New Agent</v-list-item-title>
              </v-list-item>
            </v-list-group>

            <v-list-group value="system">
              <template v-slot:activator="{ props }">
                <v-list-item v-bind="props" class="ma-2">
                  <template v-slot:prepend><v-icon>mdi-cogs</v-icon></template>
                  <v-list-item-title>System Nodes</v-list-item-title>
                </v-list-item>
              </template>
              <v-list-item draggable="true" @dragstart="onPaletteDragStart($event, 'system')" class="cursor-move mx-2 mb-1 border rounded" style="background: #1e1e2e;">
                <template v-slot:prepend><v-icon color="deep-purple" size="small">mdi-cog</v-icon></template>
                <v-list-item-title class="text-caption">System Node</v-list-item-title>
              </v-list-item>
            </v-list-group>

          </v-list>
        </v-card>

        <!-- Right Panel: Visualizer & JSON Editor -->
        <v-card class="flex-grow-1 ma-2 position-relative d-flex flex-column" border style="background: #11111b; overflow: hidden;" id="canvas-container">
          <v-toolbar density="compact" color="surface-variant" style="z-index: 20;">
            <v-toolbar-title class="text-caption">Visual Flow</v-toolbar-title>
            <v-spacer></v-spacer>
            <v-btn-toggle v-model="viewMode" mandatory density="compact" class="mr-2" color="primary">
              <v-btn value="visual" size="small" prepend-icon="mdi-graph">Visual</v-btn>
              <v-btn value="json" size="small" prepend-icon="mdi-code-json">JSON</v-btn>
            </v-btn-toggle>

            <template v-if="viewMode === 'visual'">
              <v-divider vertical class="mx-2"></v-divider>
              <v-btn icon="mdi-magnify-minus" size="small" @click="zoomOut" title="Zoom Out"></v-btn>
              <span class="text-caption mx-1">{{ Math.round(zoom * 100) }}%</span>
              <v-btn icon="mdi-magnify-plus" size="small" @click="zoomIn" title="Zoom In"></v-btn>
              <v-btn icon="mdi-magnify-scan" size="small" @click="resetZoom" title="Reset Zoom"></v-btn>
              <v-divider vertical class="mx-2"></v-divider>
              <v-btn icon="mdi-refresh" size="small" @click="layoutNodes(false)" title="Auto Layout"></v-btn>
            </template>
          </v-toolbar>

          <!-- Visual View -->
          <div v-show="viewMode === 'visual'" id="canvas-content" class="position-relative flex-grow-1"
               :style="gridBackgroundStyle"
               style="overflow: auto; cursor: grab;"
               @wheel.prevent="onWheel"
               @mousedown="startDrag(null, $event)"
               @dragover.prevent
               @drop="onCanvasDrop"
               @mousemove="onCanvasMouseMove"
               @mouseup="onCanvasMouseUp">

            <div :style="{ transform: 'scale(' + zoom + ')', transformOrigin: '0 0', width: '10000px', height: '10000px', position: 'relative' }">
              <!-- Milestone Bounding Boxes (draggable) -->
              <div v-for="box in milestoneBoxes" :key="'mb-'+box.id"
                   class="position-absolute rounded"
                   :style="{ left: box.x + 'px', top: box.y + 'px', width: box.width + 'px', height: box.height + 'px', border: '2px dashed rgba(88, 166, 255, 0.3)', zIndex: 5, cursor: 'grab' }"
                   @mousedown.stop="startMilestoneDrag(box.id, $event)">
                <div class="position-absolute" style="top: -20px; left: 10px; font-size: 11px; color: rgba(88, 166, 255, 0.7); font-weight: bold; text-transform: uppercase;">
                  {{ box.label }}
                </div>
                <!-- Milestone Connection Dots (incoming top, outgoing bottom) -->
                <div class="position-absolute" style="left: 50%; transform: translateX(-50%); top: -6px; width: 12px; height: 12px; background: #1e1e2e; border: 2px solid rgba(88, 166, 255, 0.5); border-radius: 50%;"></div>
                <div class="position-absolute" style="left: 50%; transform: translateX(-50%); bottom: -6px; width: 12px; height: 12px; background: #1e1e2e; border: 2px solid rgba(88, 166, 255, 0.5); border-radius: 50%;"></div>
              </div>

              <!-- SVG Edges -->
              <svg style="position: absolute; top: 0; left: 0; width: 100%; height: 100%; pointer-events: none;" v-if="nodes.length || drawingEdge.active || milestoneEdges.length">
                <defs>
                  <marker id="arrowhead" markerWidth="10" markerHeight="7" refX="9" refY="3.5" orient="auto">
                    <polygon points="0 0, 10 3.5, 0 7" fill="#58a6ff" />
                  </marker>
                  <marker id="milestone-arrowhead" markerWidth="10" markerHeight="7" refX="9" refY="3.5" orient="auto">
                    <polygon points="0 0, 10 3.5, 0 7" fill="rgba(88, 166, 255, 0.5)" />
                  </marker>
                </defs>

                <!-- Milestone Edges -->
                <g v-for="(edge, i) in milestoneEdges" :key="'medge-'+i">
                  <path :d="edge.path" fill="none" stroke="rgba(88, 166, 255, 0.5)" stroke-width="2" stroke-dasharray="6,4" marker-end="url(#milestone-arrowhead)" opacity="0.8"/>
                </g>

                <g v-for="(edge, i) in edges" :key="'edge-'+i">
                  <path :d="edge.path" fill="none" stroke="#58a6ff" stroke-width="2" marker-end="url(#arrowhead)" opacity="0.6"/>
                </g>
                <!-- Drawing Edge -->
                <path v-if="drawingEdge.active" :d="drawingEdgePath" fill="none" stroke="#58a6ff" stroke-width="2" stroke-dasharray="5,5" marker-end="url(#arrowhead)" opacity="0.8"/>
              </svg>

              <!-- HTML Nodes -->
              <div v-for="node in nodes" :key="node.id"
                   class="position-absolute rounded"
                   :style="{ left: node.x + 'px', top: node.y + 'px', width: nodeWidth + 'px', zIndex: 10, cursor: 'move', userSelect: 'none',
                     background: '#1e1e2e',
                     border: node.nodeType === 'milestone' ? '2px dashed rgba(88, 166, 255, 0.6)' : node.nodeType === 'user' ? '1px solid #26a69a' : node.nodeType === 'system' ? '1px solid #7e57c2' : '1px solid #313244',
                     boxShadow: '0 4px 6px rgba(0,0,0,0.3)' }"
                   @mousedown.stop="startDrag(node, $event)"
                   @dblclick.stop="editNode(node)">

                <!-- Input Dot (Top Center) -->
                <div class="position-absolute" style="left: 50%; transform: translateX(-50%); top: -6px; width: 12px; height: 12px; background: #1e1e2e; border: 2px solid #58a6ff; border-radius: 50%; z-index: 20; cursor: crosshair;"
                     :class="{ 'bg-primary': drawingEdge.active && drawingEdge.targetNode === node.id }"
                     @mouseenter="drawingEdge.active ? drawingEdge.targetNode = node.id : null"
                     @mouseleave="drawingEdge.targetNode === node.id ? drawingEdge.targetNode = null : null"></div>
                <!-- Output Dot (Bottom Center) -->
                <div v-if="node.routes && node.routes.length" class="position-absolute" style="left: 50%; transform: translateX(-50%); bottom: -6px; width: 12px; height: 12px; background: #1e1e2e; border: 2px solid #58a6ff; border-radius: 50%; z-index: 20; cursor: crosshair;"
                     @mousedown.stop="startDrawingEdge(node, node.routes[0]?.status, $event)" title="Draw Connection"></div>

                <!-- Header -->
                <div class="pa-2 border-b text-caption font-weight-bold d-flex align-center"
                     :style="{ background: node.nodeType === 'milestone' ? 'rgba(88, 166, 255, 0.15)' : node.nodeType === 'user' ? 'rgba(38, 166, 154, 0.15)' : node.nodeType === 'system' ? 'rgba(126, 87, 194, 0.15)' : '#313244' }">
                  <span class="mr-2" v-if="node.nodeType === 'milestone'"><v-icon size="16" color="blue">mdi-flag-triangle</v-icon></span>
                  <span class="mr-2" v-else-if="node.nodeType === 'user'"><v-icon size="16" color="teal">mdi-account</v-icon></span>
                  <span class="mr-2" v-else-if="node.nodeType === 'system'"><v-icon size="16" color="deep-purple">mdi-cog</v-icon></span>
                  <span class="mr-2" v-else>{{ workflowObj.agents?.[node.agentId]?.emoji || '\u{1F916}' }}</span>
                  <span class="text-truncate" v-if="node.nodeType === 'milestone'">{{ node.label || 'Milestone' }}</span>
                  <span class="text-truncate" v-else-if="node.nodeType === 'user'">User: {{ node.task || 'Interaction' }}</span>
                  <span class="text-truncate" v-else-if="node.nodeType === 'system'">System: {{ node.label || 'Node' }}</span>
                  <span class="text-truncate" v-else>{{ workflowObj.agents?.[node.agentId]?.role || node.agentId || 'Unconfigured' }}</span>
                  <v-spacer></v-spacer>
                  <v-icon size="14" @click.stop="editNode(node)" class="cursor-pointer hover-opacity">mdi-cog</v-icon>
                </div>

                <!-- Body -->
                <div class="pa-2 text-caption text-medium-emphasis pb-2">

                  <!-- User Node body -->
                  <div v-if="node.nodeType === 'user'">
                    <div class="mb-1" style="font-size: 10px; opacity: 0.7;">{{ node.task || 'User interaction point' }}</div>
                    <div v-for="(route, rIdx) in (node.routes || [])" :key="rIdx" class="text-truncate d-flex align-center position-relative mb-1" style="height: 24px;" :title="route.status">
                      <v-icon size="12" color="teal" class="mr-1">mdi-arrow-right-bottom</v-icon>
                      <span style="font-size: 10px; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">{{ route.status }}</span>
                      <v-icon size="14" color="error" class="cursor-pointer ml-1" @click.stop="node.routes.splice(rIdx, 1); syncToRawJson(); updateEdges()" title="Remove Route">mdi-close-circle</v-icon>
                    </div>
                    <div class="mt-1 text-center">
                      <v-btn variant="plain" size="x-small" density="compact" @click.stop="addRoute(node)" icon="mdi-plus" title="Add Route"></v-btn>
                    </div>
                  </div>

                  <!-- System Node body -->
                  <div v-else-if="node.nodeType === 'system'">
                    <div class="mb-1" style="font-size: 10px; opacity: 0.7;">{{ node.description || 'System processing' }}</div>
                    <div v-for="(route, rIdx) in (node.routes || [])" :key="rIdx" class="text-truncate d-flex align-center position-relative mb-1" style="height: 24px;" :title="route.status">
                      <v-icon size="12" color="deep-purple" class="mr-1">mdi-arrow-right-bottom</v-icon>
                      <span style="font-size: 10px; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">{{ route.status }}</span>
                      <v-icon size="14" color="error" class="cursor-pointer ml-1" @click.stop="node.routes.splice(rIdx, 1); syncToRawJson(); updateEdges()" title="Remove Route">mdi-close-circle</v-icon>
                    </div>
                    <div class="mt-1 text-center">
                      <v-btn variant="plain" size="x-small" density="compact" @click.stop="addRoute(node)" icon="mdi-plus" title="Add Route"></v-btn>
                    </div>
                  </div>

                  <!-- Milestone Node body -->
                  <div v-else-if="node.nodeType === 'milestone'">
                    <div class="mb-1" style="font-size: 10px; opacity: 0.7;">{{ node.description || 'Milestone checkpoint' }}</div>
                    <div v-for="(route, rIdx) in (node.routes || [])" :key="rIdx" class="text-truncate d-flex align-center position-relative mb-1" style="height: 24px;" :title="route.status">
                      <v-icon size="12" color="blue" class="mr-1">mdi-arrow-right-bottom</v-icon>
                      <span style="font-size: 10px; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">{{ route.status }}</span>
                      <v-icon size="14" color="error" class="cursor-pointer ml-1" @click.stop="node.routes.splice(rIdx, 1); syncToRawJson(); updateEdges()" title="Remove Route">mdi-close-circle</v-icon>
                    </div>
                    <div class="mt-1 text-center">
                      <v-btn variant="plain" size="x-small" density="compact" @click.stop="addRoute(node)" icon="mdi-plus" title="Add Route"></v-btn>
                    </div>
                  </div>

                  <!-- Agent Node body (default) -->
                  <div v-else-if="node.routes && node.routes.length">
                    <div v-for="(route, rIdx) in node.routes" :key="rIdx" class="text-truncate d-flex align-center position-relative mb-1" style="height: 24px;" :title="route.status">
                      <v-icon size="12" color="primary" class="mr-1">mdi-arrow-right-bottom</v-icon>
                      <span style="font-size: 10px; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">{{ route.status }} <span v-if="route.targets && route.targets.length" class="opacity-50">({{route.targets.length}})</span></span>
                      <v-icon size="14" color="error" class="cursor-pointer ml-1" @click.stop="node.routes.splice(rIdx, 1); syncToRawJson(); updateEdges()" title="Remove Route">mdi-close-circle</v-icon>
                    </div>
                    <div class="mt-1 text-center">
                       <v-btn variant="plain" size="x-small" density="compact" @click.stop="addRoute(node)" icon="mdi-plus" title="Add Route"></v-btn>
                    </div>
                  </div>
                  <div v-else class="text-center opacity-50 py-1 text-xs">
                    No Routes
                    <v-btn variant="plain" size="x-small" density="compact" @click.stop="addRoute(node)" icon="mdi-plus" title="Add Route"></v-btn>
                  </div>
                </div>
              </div>

              <!-- Edge Labels (above nodes, draggable) -->
              <template v-for="(edge, i) in edges" :key="'elbl-'+i">
                <div v-if="edge.label"
                     class="position-absolute"
                     :style="{ left: (edge.textX - edge.label.length * 3.5 - 4) + 'px', top: (edge.textY - 9) + 'px', zIndex: 15, cursor: 'grab' }"
                     @mousedown.stop="startLabelDrag(edge.id, $event)">
                  <div style="background: #11111b; border: 1px solid #313244; border-radius: 3px; padding: 1px 4px; font-size: 10px; color: #cdd6f4; white-space: nowrap;">{{ edge.label }}</div>
                </div>
              </template>
            </div>
          </div>

          <!-- JSON View -->
          <v-textarea
            v-show="viewMode === 'json'"
            v-model="rawJson"
            class="flex-grow-1 ma-0"
            hide-details
            variant="solo"
            style="font-family: monospace; font-size: 13px; height: 100%; overflow-y: auto;"
            @update:model-value="parseJson"
            bg-color="background"
          ></v-textarea>
        </v-card>
      </v-main>

      <!-- Workflow Selection Dialog -->
      <v-dialog v-model="workflowDialog.show" max-width="500px" persistent>
        <v-card>
          <v-card-title>Workflow Builder</v-card-title>
          <v-card-text>
            <div class="mb-4 text-body-2">Select an existing workflow or create a new one.</div>
            <v-select
              v-model="workflowDialog.selected"
              :items="workflowDialog.existing"
              label="Open Existing Workflow"
              clearable
              variant="outlined"
              :disabled="!!workflowDialog.newName"
            ></v-select>
            <div class="my-4 text-center font-weight-bold">OR</div>
            <v-text-field
              v-model="workflowDialog.newName"
              label="Create New Workflow (Name)"
              variant="outlined"
              :disabled="!!workflowDialog.selected"
            ></v-text-field>
          </v-card-text>
          <v-card-actions>
            <v-btn text @click="$router.push('/')">Cancel</v-btn>
            <v-spacer></v-spacer>
            <v-btn color="primary" @click="confirmWorkflow" :disabled="!workflowDialog.selected && !workflowDialog.newName">Continue</v-btn>
          </v-card-actions>
        </v-card>
      </v-dialog>

      <!-- Node Editor Dialog -->
      <v-dialog v-model="editorDialog.show" max-width="650px" @update:model-value="v => !v && closeEditor()">
        <v-card v-if="editorDialog.node">
          <v-card-title>Edit Node</v-card-title>
          <v-card-text>
            <!-- User Node -->
            <template v-if="editorDialog.node.nodeType === 'user'">
              <v-text-field v-model="editorDialog.task" label="Task / Purpose" hint="What the user does at this point (e.g. 'Clarify requirements', 'Approve design')" persistent-hint class="mb-4"></v-text-field>
              <v-divider class="my-4"></v-divider>
              <div class="text-h6 mb-2 d-flex align-center">
                Outgoing Routes
                <v-spacer></v-spacer>
                <v-btn size="x-small" color="primary" @click="addRoute(editorDialog.node)">Add Route</v-btn>
              </div>
              <div v-for="(route, i) in editorDialog.routes" :key="i" class="d-flex align-center gap-2 mb-2">
                 <v-text-field v-model="route.status" label="Route Status" placeholder="e.g. APPROVED" density="compact" hide-details class="mr-2"></v-text-field>
                 <v-btn icon="mdi-delete" size="x-small" color="error" variant="text" @click="editorDialog.routes.splice(i, 1)"></v-btn>
              </div>
              <div v-if="!editorDialog.routes.length" class="text-caption text-center opacity-50 py-2">No routes defined</div>
            </template>
            <!-- System Node -->
            <template v-else-if="editorDialog.node.nodeType === 'system'">
              <v-text-field v-model="editorDialog.label" label="Node Label" class="mb-4"></v-text-field>
              <v-textarea v-model="editorDialog.description" label="Description" rows="2" class="mb-4"></v-textarea>
              <v-divider class="my-4"></v-divider>
              <div class="text-h6 mb-2 d-flex align-center">
                Outgoing Routes
                <v-spacer></v-spacer>
                <v-btn size="x-small" color="primary" @click="addRoute(editorDialog.node)">Add Route</v-btn>
              </div>
              <div v-for="(route, i) in editorDialog.routes" :key="i" class="d-flex align-center gap-2 mb-2">
                 <v-text-field v-model="route.status" label="Route Status" placeholder="e.g. ROUTED" density="compact" hide-details class="mr-2"></v-text-field>
                 <v-btn icon="mdi-delete" size="x-small" color="error" variant="text" @click="editorDialog.routes.splice(i, 1)"></v-btn>
              </div>
              <div v-if="!editorDialog.routes.length" class="text-caption text-center opacity-50 py-2">No routes defined</div>
            </template>
            <!-- Milestone Node -->
            <template v-else-if="editorDialog.node.nodeType === 'milestone'">
              <v-text-field v-model="editorDialog.label" label="Milestone Name" class="mb-4"></v-text-field>
              <v-textarea v-model="editorDialog.description" label="Description" rows="2" class="mb-4"></v-textarea>
              <v-divider class="my-4"></v-divider>
              <div class="text-h6 mb-2 d-flex align-center">
                Outgoing Routes
                <v-spacer></v-spacer>
                <v-btn size="x-small" color="primary" @click="addRoute(editorDialog.node)">Add Route</v-btn>
              </div>
              <div v-for="(route, i) in editorDialog.routes" :key="i" class="d-flex align-center gap-2 mb-2">
                 <v-text-field v-model="route.status" label="Route Status" placeholder="e.g. CHECKPOINT_PASSED" density="compact" hide-details class="mr-2"></v-text-field>
                 <v-btn icon="mdi-delete" size="x-small" color="error" variant="text" @click="editorDialog.routes.splice(i, 1)"></v-btn>
              </div>
              <div v-if="!editorDialog.routes.length" class="text-caption text-center opacity-50 py-2">No routes defined</div>
            </template>
            <!-- Agent Node (default) -->
            <template v-else>
              <div class="mb-4">
                <v-combobox
                  v-model="editorDialog.agentId"
                  :items="availableAgentIds"
                  label="Select or Create Agent ID"
                  hint="Type a new name to create a new agent"
                  persistent-hint
                ></v-combobox>
              </div>

              <div v-if="editorDialog.agentId" class="pa-4 bg-surface-variant rounded mb-4">
                <div class="text-subtitle-2 mb-2">Agent Configuration (Global)</div>
                <div class="d-flex gap-4">
                  <v-text-field v-model="editorDialog.role" label="Role Name" class="flex-grow-1 mr-2" density="compact"></v-text-field>
                  <v-text-field v-model="editorDialog.emoji" label="Emoji" style="max-width: 100px;" density="compact"></v-text-field>
                </div>
                <v-textarea v-model="editorDialog.mission" label="Mission" rows="2" density="compact"></v-textarea>
              </div>

              <v-divider class="my-4"></v-divider>
              <div class="text-h6 mb-2 d-flex align-center">
                Outgoing Routes
                <v-spacer></v-spacer>
                <v-btn size="x-small" color="primary" @click="addRoute(editorDialog.node)">Add Route</v-btn>
              </div>
              <div v-for="(route, i) in editorDialog.routes" :key="i" class="d-flex align-center gap-2 mb-2">
                 <v-text-field v-model="route.status" label="Route Status" placeholder="e.g. SUCCESS" density="compact" hide-details class="mr-2"></v-text-field>
                 <v-btn icon="mdi-delete" size="x-small" color="error" variant="text" @click="editorDialog.routes.splice(i, 1)"></v-btn>
              </div>
              <div v-if="!editorDialog.routes.length" class="text-caption text-center opacity-50 py-2">No routes defined</div>
            </template>
          </v-card-text>
          <v-card-actions>
            <v-btn color="error" @click="deleteVisualNode(editorDialog.node.id)">Delete Node</v-btn>
            <v-spacer></v-spacer>
            <v-btn @click="closeEditor">Done</v-btn>
          </v-card-actions>
        </v-card>
      </v-dialog>

      <v-snackbar v-model="snackbar.show" :color="snackbar.color" timeout="3000">
        {{ snackbar.text }}
      </v-snackbar>
    </v-layout>
  `,
  setup() {
    const theme = useTheme();
    const isDark = computed(() => theme.global.current.value.dark);
    const gridColor = computed(() => isDark.value ? 'rgba(255, 255, 255, 0.15)' : 'rgba(0, 0, 0, 0.15)');
    const gridBackgroundStyle = computed(() => ({
      backgroundImage: `radial-gradient(circle, ${gridColor.value} 1.5px, transparent 1.5px)`,
      backgroundSize: '20px 20px',
      backgroundColor: isDark.value ? '#11111b' : '#f4f4f9'
    }));

    const paletteGroupsOpen = ref(['agents']);
    const viewMode = ref('visual');
    const rawJson = ref("");
    const workflowObj = ref({});
    const saving = ref(false);
    const snackbar = reactive({ show: false, text: "", color: "success" });

    const currentWorkflow = ref("");
    const workflowDialog = reactive({ show: true, selected: null, newName: '', existing: [] });

    const zoom = ref(1);
    const zoomIn = () => { zoom.value = Math.min(zoom.value + 0.01, 3); };
    const zoomOut = () => { zoom.value = Math.max(zoom.value - 0.01, 0.2); };
    const resetZoom = () => { zoom.value = 1; };
    const onWheel = (e) => {
        const el = document.getElementById('canvas-content');
        if (!el) return;
        const rect = el.getBoundingClientRect();

        // Mouse position relative to the viewport of the scrollable container
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;

        // Canvas-space point under the cursor before zoom
        const oldZoom = zoom.value;
        const canvasX = (el.scrollLeft + mouseX) / oldZoom;
        const canvasY = (el.scrollTop + mouseY) / oldZoom;

        // Apply zoom
        if (e.deltaY < 0) zoom.value = Math.min(oldZoom + 0.01, 3);
        else zoom.value = Math.max(oldZoom - 0.01, 0.2);
        const newZoom = zoom.value;

        // Adjust scroll so the same canvas point stays under the cursor
        el.scrollLeft = Math.max(0, canvasX * newZoom - mouseX);
        el.scrollTop = Math.max(0, canvasY * newZoom - mouseY);
    };

    const nodes = ref([]);
    const edges = ref([]);
    const labelOverrides = reactive({}); // { edgeId: { x, y } } — manually positioned labels
    const nodeWidth = 220;
    const horizontalSpacing = 300;
    const verticalSpacing = 250;

    const availableAgentIds = computed(() => Object.keys(workflowObj.value?.agents || {}));
    const dragState = reactive({ active: false, node: null, milestoneId: null, labelEdgeId: null, startX: 0, startY: 0, initialX: 0, initialY: 0, initialPositions: null });

    const editorDialog = reactive({ show: false, node: null, agentId: '', role: '', emoji: '\u{1F916}', mission: '', routes: [], task: '', label: '', description: '' });

    const drawingEdge = reactive({
        active: false,
        sourceNodeId: null,
        sourceStatus: null,
        startX: 0,
        startY: 0,
        currentX: 0,
        currentY: 0,
        targetNode: null
    });

    const drawingEdgePath = computed(() => {
        if (!drawingEdge.active) return "";
        const startX = drawingEdge.startX;
        const startY = drawingEdge.startY;
        const endX = drawingEdge.currentX;
        const endY = drawingEdge.currentY;

        if (startY < endY) {
            const ctrlY1 = startY + (endY - startY) / 2;
            return `M ${startX} ${startY} C ${startX} ${ctrlY1}, ${endX} ${ctrlY1}, ${endX} ${endY}`;
        } else {
            return `M ${startX} ${startY} C ${startX} ${startY + 100}, ${endX} ${endY - 100}, ${endX} ${endY}`;
        }
    });

    const getCanvasCoords = (e) => {
        const el = document.getElementById('canvas-content');
        if (!el) return {x: 0, y: 0};
        const rect = el.getBoundingClientRect();
        return {
            x: (e.clientX - rect.left) / zoom.value,
            y: (e.clientY - rect.top) / zoom.value
        };
    };

    // ── Sync visual nodes back to workflow JSON ──────────────────────────────
    const syncToRawJson = () => {
        // Merge per-milestone agent routes back into unified routing
        const routing = {};

        nodes.value.forEach(n => {
            if (n.nodeType === 'user' || n.nodeType === 'system' || n.nodeType === 'milestone') return;
            if (!n.agentId) return;
            if (!routing[n.agentId]) routing[n.agentId] = { routes: {}, fallback: "router" };

            if (n.routes && n.routes.length > 0) {
                n.routes.forEach(route => {
                    if (route.status && route.targets && route.targets.length > 0) {
                        const targetAgentIds = route.targets.map(tId => {
                            const tn = nodes.value.find(x => x.id === tId);
                            return tn ? (tn.agentId || null) : null;
                        }).filter(x => x);

                        if (targetAgentIds.length === 1) {
                            routing[n.agentId].routes[route.status] = targetAgentIds[0];
                        } else if (targetAgentIds.length > 1) {
                            routing[n.agentId].routes[route.status] = targetAgentIds;
                        }
                    }
                });
            }
        });

        // Preserve existing approval_triggers and fallback from the original routing
        const existingRouting = workflowObj.value.routing || {};
        Object.keys(routing).forEach(agentId => {
            if (existingRouting[agentId]) {
                if (existingRouting[agentId].approval_triggers) {
                    routing[agentId].approval_triggers = existingRouting[agentId].approval_triggers;
                }
                if (existingRouting[agentId].fallback) {
                    routing[agentId].fallback = existingRouting[agentId].fallback;
                }
            }
        });

        workflowObj.value.routing = routing;

        // Determine pipeline entry from the first milestone's first agent
        const firstUserNode = nodes.value.find(n => n.nodeType === 'user' && n.routes?.length > 0);
        if (firstUserNode) {
            const firstTarget = firstUserNode.routes[0]?.targets?.[0];
            if (firstTarget) {
                const tn = nodes.value.find(x => x.id === firstTarget);
                if (tn && tn.agentId) {
                    if (!workflowObj.value.pipeline) workflowObj.value.pipeline = {};
                    workflowObj.value.pipeline.entry = tn.agentId;
                }
            }
        }

        if (!workflowObj.value.ui) workflowObj.value.ui = {};
        workflowObj.value.ui.nodes = nodes.value;

        rawJson.value = JSON.stringify(workflowObj.value, null, 2);
    };

    // ── Parse JSON into visual nodes ────────────────────────────────────────
    const parseJson = () => {
        try {
            workflowObj.value = JSON.parse(rawJson.value);

            if (workflowObj.value.ui && workflowObj.value.ui.nodes) {
                nodes.value = workflowObj.value.ui.nodes;
            } else {
                // Auto-unroll routing graph into per-milestone agent instances
                const newNodes = [];
                const milestones = workflowObj.value.pipeline?.milestones || [];
                const agents = workflowObj.value.agents || {};
                const routing = workflowObj.value.routing || {};

                // Collect all statuses across all milestones
                const allMilestoneStatuses = new Set();
                milestones.forEach(m => (m.statuses || []).forEach(s => allMilestoneStatuses.add(s)));

                // For each agent, determine which milestones it belongs to
                // An agent belongs to milestone M if any of its route statuses are in M.statuses
                const agentMilestoneMap = {}; // agentId -> [milestoneId, ...]
                Object.keys(routing).forEach(agentId => {
                    const routeStatuses = Object.keys(routing[agentId].routes || {});
                    agentMilestoneMap[agentId] = [];
                    milestones.forEach(m => {
                        if (routeStatuses.some(s => m.statuses && m.statuses.includes(s))) {
                            agentMilestoneMap[agentId].push(m.id);
                        }
                    });
                });

                // Create per-milestone agent instances
                const nodeIdLookup = {}; // `${milestoneId}/${agentId}` -> nodeId

                milestones.forEach((m, mIdx) => {
                    // Find agents in this milestone
                    const agentsHere = Object.keys(agents).filter(agentId =>
                        (agentMilestoneMap[agentId] || []).includes(m.id)
                    );

                    // Add user node to the first milestone
                    if (mIdx === 0) {
                        const userId = 'user_' + m.id;
                        newNodes.push({
                            id: userId,
                            nodeType: 'user',
                            milestoneId: m.id,
                            task: 'Prompt & Feedback',
                            routes: [{ status: 'BEGIN', targets: [] }],
                            x: 100,
                            y: 90 + mIdx * verticalSpacing
                        });
                    }

                    agentsHere.forEach((agentId, aIdx) => {
                        const fullRoutes = routing[agentId]?.routes || {};
                        // Include routes whose statuses are in this milestone
                        const relevantStatuses = Object.keys(fullRoutes).filter(s =>
                            m.statuses && m.statuses.includes(s)
                        );
                        // Also include orphan statuses (not in any milestone) on the LAST milestone instance
                        const isLastMilestone = agentMilestoneMap[agentId]?.[agentMilestoneMap[agentId].length - 1] === m.id;
                        if (isLastMilestone) {
                            Object.keys(fullRoutes).forEach(s => {
                                if (!allMilestoneStatuses.has(s) && !relevantStatuses.includes(s)) {
                                    relevantStatuses.push(s);
                                }
                            });
                        }

                        const nodeRoutes = relevantStatuses.map(status => ({
                            status,
                            targets: fullRoutes[status]
                        }));

                        const nodeId = m.id + '_' + agentId;
                        nodeIdLookup[m.id + '/' + agentId] = nodeId;

                        const xOffset = mIdx === 0 ? 1 : 0; // shift right in first milestone if user node is there
                        newNodes.push({
                            id: nodeId,
                            agentId,
                            milestoneId: m.id,
                            routes: nodeRoutes,
                            x: 100 + (aIdx + xOffset) * (nodeWidth + 80),
                            y: 90 + mIdx * verticalSpacing
                        });
                    });
                });

                // Resolve route targets: agentId -> nodeId in appropriate milestone
                newNodes.forEach(n => {
                    if (!n.routes) return;
                    const currentMilestone = milestones.find(m => m.id === n.milestoneId);

                    n.routes.forEach(route => {
                        let targets = Array.isArray(route.targets) ? route.targets : [route.targets];
                        route.targets = targets.map(target => {
                            if (target === '$self') return n.id;
                            if (target === '__end__') {
                                // Route to the user node in the same milestone (if one exists)
                                const userNode = newNodes.find(u => u.nodeType === 'user' && u.milestoneId === n.milestoneId);
                                return userNode ? userNode.id : null;
                            }
                            if (typeof target === 'object' && target != null) {
                                if (target.$previous_matching) return null;
                                if (target.default) target = target.default;
                                else return null;
                            }
                            if (typeof target !== 'string') return null;

                            // target is an agentId — find its instance
                            // Search forward through milestone chain first
                            let searchId = currentMilestone?.next;
                            while (searchId) {
                                const key = searchId + '/' + target;
                                if (nodeIdLookup[key]) return nodeIdLookup[key];
                                const searchM = milestones.find(m => m.id === searchId);
                                searchId = searchM?.next;
                            }

                            // Then check same milestone (only if not found forward)
                            const sameKey = n.milestoneId + '/' + target;
                            if (nodeIdLookup[sameKey]) return nodeIdLookup[sameKey];

                            // Search backward as last resort
                            let prevId = currentMilestone?.previous;
                            while (prevId) {
                                const key = prevId + '/' + target;
                                if (nodeIdLookup[key]) return nodeIdLookup[key];
                                const prevM = milestones.find(m => m.id === prevId);
                                prevId = prevM?.previous;
                            }

                            return null;
                        }).filter(t => t != null);
                    });
                });

                // Wire user node in first milestone to the entry agent
                const entry = workflowObj.value.pipeline?.entry;
                if (entry && milestones.length > 0) {
                    const userNode = newNodes.find(n => n.nodeType === 'user' && n.milestoneId === milestones[0].id);
                    const entryKey = milestones[0].id + '/' + entry;
                    if (userNode && nodeIdLookup[entryKey]) {
                        userNode.routes[0].targets = [nodeIdLookup[entryKey]];
                    }
                }

                nodes.value = newNodes;
                repelMilestones();
                syncToRawJson();
            }
            updateEdges();
            repelLabels();
        } catch (e) {
            // Ignore temporary malformed JSON edits
        }
    };

    const fetchWorkflowsList = async () => {
        try {
            const res = await fetch("/api/workflows");
            if (res.ok) {
                workflowDialog.existing = await res.json();
            }
        } catch(e) {
            console.error("Failed to list workflows");
        }
    };

    const confirmWorkflow = () => {
        if (workflowDialog.newName) {
            currentWorkflow.value = workflowDialog.newName;
        } else if (workflowDialog.selected) {
            currentWorkflow.value = workflowDialog.selected;
        }
        workflowDialog.show = false;
        fetchWorkflow();
    };

    const fetchWorkflow = async () => {
      try {
        const res = await fetch(`/api/workflow?name=${currentWorkflow.value}`);
        if (res.ok) {
          workflowObj.value = await res.json();
          rawJson.value = JSON.stringify(workflowObj.value, null, 2);
          parseJson();
        }
      } catch (e) {
        showError("Failed to fetch workflow");
      }
    };

    const saveWorkflow = async () => {
      try {
        saving.value = true;
        const res = await fetch(`/api/workflow?name=${currentWorkflow.value}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(workflowObj.value, null, 2)
        });
        if (res.ok) {
          snackbar.text = "Workflow saved successfully";
          snackbar.color = "success";
          snackbar.show = true;
        } else {
          throw new Error("Server returned error");
        }
      } catch (e) {
        showError("Failed to save: " + e.message);
      } finally {
        saving.value = false;
      }
    };

    const showError = (msg) => {
      snackbar.text = msg;
      snackbar.color = "error";
      snackbar.show = true;
    };

    const addRoute = (node) => {
        if (!node.routes) node.routes = [];
        node.routes.push({ status: "SUCCESS", targets: [] });
        if (editorDialog.node === node) {
            editorDialog.routes = node.routes;
        }
    };

    const getEstimatedNodeHeight = (node) => {
        const routesCount = (node.routes || []).length;
        const baseHeight = (node.nodeType === 'user' || node.nodeType === 'system' || node.nodeType === 'milestone') ? 60 : 40;
        return baseHeight + Math.max(1, routesCount) * 28 + 20;
    };

    // ── Milestone bounding boxes (computed from node positions) ─────────────
    const milestoneBoxes = computed(() => {
        const boxes = [];
        const milestones = workflowObj.value.pipeline?.milestones || [];

        const pad = MIN_EXTEND; // room for arrow curves between nodes

        if (milestones.length) {
            milestones.forEach((m, idx) => {
                const grp = nodes.value.filter(n => n.milestoneId === m.id);
                if (grp.length === 0) return;

                let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
                grp.forEach(n => {
                    if (n.x < minX) minX = n.x;
                    if (n.y < minY) minY = n.y;
                    if (n.x + nodeWidth > maxX) maxX = n.x + nodeWidth;
                    const h = getEstimatedNodeHeight(n);
                    if (n.y + h > maxY) maxY = n.y + h;
                });

                boxes.push({
                    id: m.id,
                    x: minX - pad,
                    y: minY - pad,
                    width: (maxX - minX) + pad * 2,
                    height: (maxY - minY) + pad * 2,
                    label: m.name || m.id,
                    previous: idx > 0,
                    next: m.next != null
                });
            });
        }

        // Also show a box for unassigned nodes (no milestoneId)
        const unassigned = nodes.value.filter(n => !n.milestoneId);
        if (unassigned.length > 0) {
            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
            unassigned.forEach(n => {
                if (n.x < minX) minX = n.x;
                if (n.y < minY) minY = n.y;
                if (n.x + nodeWidth > maxX) maxX = n.x + nodeWidth;
                const h = getEstimatedNodeHeight(n);
                if (n.y + h > maxY) maxY = n.y + h;
            });
            boxes.push({
                id: '__unassigned__',
                x: minX - pad,
                y: minY - pad,
                width: (maxX - minX) + pad * 2,
                height: (maxY - minY) + pad * 2,
                label: 'Unassigned',
                previous: boxes.length > 0,
                next: false
            });
        }
        return boxes;
    });

    const milestoneEdges = computed(() => {
        const mEdges = [];
        const boxes = milestoneBoxes.value;
        for (let i = 0; i < boxes.length - 1; i++) {
            const b1 = boxes[i];
            const b2 = boxes[i+1];
            if (b2.id === '__unassigned__') continue;

            // From outgoing dot (bottom-center + 6) to incoming dot (top-center - 6)
            const startX = b1.x + b1.width / 2;
            const startY = b1.y + b1.height + 6;
            const endX = b2.x + b2.width / 2;
            const endY = b2.y - 6;

            const gap = Math.max(40, endY - startY);
            const ctrlY1 = startY + gap * 0.4;
            const ctrlY2 = endY - gap * 0.4;
            const path = `M ${startX} ${startY} C ${startX} ${ctrlY1}, ${endX} ${ctrlY2}, ${endX} ${endY}`;
            mEdges.push({ path });
        }
        return mEdges;
    });

    // ── Edge / layout constants ────────────────────────────────────────────
    const MIN_EXTEND = 100;

    // ── Milestone repulsion (push overlapping boxes apart) ────────────────
    const repelMilestones = () => {
        const gap = MIN_EXTEND; // required space between box borders
        let changed = false;

        // Iterate until no overlaps remain (each pass may reveal new ones)
        for (let iter = 0; iter < 20; iter++) {
            const boxes = milestoneBoxes.value; // recompute after each shift
            if (boxes.length < 2) break;
            let anyOverlap = false;

            // Walk top-to-bottom; for each consecutive pair, push the lower one down
            for (let i = 0; i < boxes.length - 1; i++) {
                const a = boxes[i];
                const b = boxes[i + 1];

                const aBottom = a.y + a.height;
                const bTop = b.y;
                const currentGap = bTop - aBottom;

                if (currentGap < gap) {
                    const dy = gap - currentGap;
                    // Push this box and all subsequent boxes down
                    for (let k = i + 1; k < boxes.length; k++) {
                        const boxId = boxes[k].id;
                        nodes.value.forEach(n => {
                            if (n.milestoneId === boxId || (!n.milestoneId && boxId === '__unassigned__')) {
                                n.y += dy;
                            }
                        });
                    }
                    anyOverlap = true;
                    changed = true;
                    break; // restart from top after shifting
                }
            }

            if (!anyOverlap) break;
        }

        if (changed) {
            updateEdges();
            syncToRawJson();
        }
    };

    // ── Auto Layout ─────────────────────────────────────────────────────────
    const layoutNodes = (preservePositions = false) => {
        if (!preservePositions) {
            const milestones = workflowObj.value.pipeline?.milestones || [];
            let groupsToLayout = [];

            if (milestones.length) {
                milestones.forEach(m => {
                    const grp = nodes.value.filter(n => n.milestoneId === m.id);
                    if (grp.length) groupsToLayout.push(grp);
                });

                const unassigned = nodes.value.filter(n => !n.milestoneId);
                if (unassigned.length) groupsToLayout.push(unassigned);
            } else {
                // No milestones — just lay out all nodes in a single group
                if (nodes.value.length) groupsToLayout.push([...nodes.value]);
            }

            const pad = MIN_EXTEND;
            const gapBetweenBoxes = MIN_EXTEND; // space between bounding box borders

            let currentY = pad + 50; // start with enough room for top padding
            // Center horizontally based on viewport width
            const canvasEl = document.getElementById('canvas-content');
            const viewportW = canvasEl ? canvasEl.clientWidth / zoom.value : 1200;
            const centerX = viewportW / 2;

            groupsToLayout.forEach(grp => {
                const totalWidth = grp.length * nodeWidth + (grp.length - 1) * 80;
                let startX = Math.max(pad + 50, centerX - totalWidth / 2);

                let maxHeight = 0;
                grp.forEach((n, idx) => {
                    n.x = startX + idx * (nodeWidth + 80);
                    n.y = currentY;
                    const h = getEstimatedNodeHeight(n);
                    if (h > maxHeight) maxHeight = h;
                });

                // Next group starts after: node height + bottom pad + gap + top pad
                currentY += maxHeight + pad + gapBetweenBoxes + pad;
            });
        }
        repelMilestones();
        updateEdges();
        repelLabels();
        if (viewMode.value === 'visual') syncToRawJson();
    };

    // ── Edge rendering ──────────────────────────────────────────────────────

    // Simple bezier from source to target (no waypoint)
    const makeBezier = (sx, sy, ex, ey) => {
        if (ey > sy) {
            const gap = ey - sy;
            const extend = Math.max(MIN_EXTEND, gap * 0.4);
            return `M ${sx} ${sy} C ${sx} ${sy + extend}, ${ex} ${ey - extend}, ${ex} ${ey}`;
        } else {
            const midY = Math.max(sy, ey) + MIN_EXTEND + 40;
            return `M ${sx} ${sy} C ${sx} ${midY}, ${ex} ${ey - MIN_EXTEND - 40}, ${ex} ${ey}`;
        }
    };

    // Single smooth cubic bezier that passes through label point L at t=0.5.
    // B(0.5) = (P0 + 3·P1 + 3·P2 + P3) / 8 = L
    //   ⟹  P1.y + P2.y = (8·Ly - Sy - Ey) / 3
    // Keep P1.x = Sx, P2.x = Ex (vertical tangents at endpoints, smooth S-curve).
    // Split Y evenly between the two control points.
    const makeBezierThrough = (sx, sy, lx, ly, ex, ey) => {
        const ySum = (8 * ly - sy - ey) / 3;
        const cp1y = ySum / 2;
        const cp2y = ySum / 2;
        return `M ${sx} ${sy} C ${sx} ${cp1y}, ${ex} ${cp2y}, ${ex} ${ey}`;
    };

    // Compute default label position (bezier midpoint at t=0.5)
    const bezierMidpoint = (sx, sy, ex, ey) => {
        let textX, textY;
        if (ey > sy) {
            const extend = Math.max(MIN_EXTEND, (ey - sy) * 0.4);
            textX = (sx + ex) / 2;
            textY = 0.125*sy + 0.375*(sy+extend) + 0.375*(ey-extend) + 0.125*ey;
        } else {
            const midY = Math.max(sy, ey) + MIN_EXTEND + 40;
            textX = (sx + ex) / 2;
            textY = 0.125*sy + 0.375*midY + 0.375*(ey-MIN_EXTEND-40) + 0.125*ey;
        }
        return { textX, textY };
    };

    const updateEdges = () => {
      const newEdges = [];
      const nodeMap = {};
      nodes.value.forEach(n => nodeMap[n.id] = n);

      const mBoxMap = {};
      milestoneBoxes.value.forEach(b => { mBoxMap[b.id] = b; });

      nodes.value.forEach(sourceNode => {
        const routes = sourceNode.routes || [];
        if (!routes.length) return;

        const sourceH = getEstimatedNodeHeight(sourceNode);
        const startX = sourceNode.x + nodeWidth / 2;
        const startY = sourceNode.y + sourceH + 6;

        routes.forEach((route) => {
            if (!route.targets) return;

            route.targets.forEach(tId => {
                 const targetNode = nodeMap[tId];
                 if (!targetNode) return;

                 const endX = targetNode.x + nodeWidth / 2;
                 const endY = targetNode.y - 6;

                 const crossMilestone = sourceNode.milestoneId && targetNode.milestoneId
                     && sourceNode.milestoneId !== targetNode.milestoneId;

                 if (sourceNode.id === tId) {
                   // Self-loop
                   const edgeId = sourceNode.id + '-' + route.status + '-' + tId;
                   const loopX = sourceNode.x + nodeWidth + 80;
                   const defX = loopX + 10, defY = (startY + endY) / 2;
                   const ov = labelOverrides[edgeId];
                   const lx = ov ? ov.x : defX, ly = ov ? ov.y : defY;
                   const path = ov
                     ? makeBezierThrough(startX, startY, lx, ly, endX, endY)
                     : `M ${startX} ${startY} C ${startX} ${startY + MIN_EXTEND}, ${loopX} ${startY + MIN_EXTEND}, ${loopX} ${(startY + endY) / 2} S ${startX} ${endY - MIN_EXTEND}, ${endX} ${endY}`;
                   newEdges.push({ id: edgeId, path, label: route.status, textX: lx, textY: ly, defaultTextX: defX, defaultTextY: defY });

                 } else if (crossMilestone) {
                   const srcBox = mBoxMap[sourceNode.milestoneId];
                   const tgtBox = mBoxMap[targetNode.milestoneId];

                   if (srcBox && tgtBox) {
                     // Segment 1: source → milestone outgoing dot
                     const msOutX = srcBox.x + srcBox.width / 2;
                     const msOutY = srcBox.y + srcBox.height + 6;
                     const edgeId1 = sourceNode.id + '-' + route.status + '-msout-' + tId;
                     const def1 = bezierMidpoint(startX, startY, msOutX, msOutY);
                     const ov1 = labelOverrides[edgeId1];
                     const lx1 = ov1 ? ov1.x : def1.textX, ly1 = ov1 ? ov1.y : def1.textY;
                     const path1 = ov1
                       ? makeBezierThrough(startX, startY, lx1, ly1, msOutX, msOutY)
                       : makeBezier(startX, startY, msOutX, msOutY);
                     newEdges.push({ id: edgeId1, path: path1, label: route.status, textX: lx1, textY: ly1, defaultTextX: def1.textX, defaultTextY: def1.textY });

                     // Segment 2: milestone incoming dot → target
                     const msInX = tgtBox.x + tgtBox.width / 2;
                     const msInY = tgtBox.y - 6;
                     const edgeId2 = sourceNode.id + '-msin-' + route.status + '-' + tId;
                     const def2 = bezierMidpoint(msInX, msInY, endX, endY);
                     const ov2 = labelOverrides[edgeId2];
                     const lx2 = ov2 ? ov2.x : def2.textX, ly2 = ov2 ? ov2.y : def2.textY;
                     const path2 = ov2
                       ? makeBezierThrough(msInX, msInY, lx2, ly2, endX, endY)
                       : makeBezier(msInX, msInY, endX, endY);
                     newEdges.push({ id: edgeId2, path: path2, label: route.status, textX: lx2, textY: ly2, defaultTextX: def2.textX, defaultTextY: def2.textY });
                   } else {
                     const edgeId = sourceNode.id + '-' + route.status + '-' + tId;
                     const def = bezierMidpoint(startX, startY, endX, endY);
                     const ov = labelOverrides[edgeId];
                     const lx = ov ? ov.x : def.textX, ly = ov ? ov.y : def.textY;
                     const path = ov
                       ? makeBezierThrough(startX, startY, lx, ly, endX, endY)
                       : makeBezier(startX, startY, endX, endY);
                     newEdges.push({ id: edgeId, path, label: route.status, textX: lx, textY: ly, defaultTextX: def.textX, defaultTextY: def.textY });
                   }
                 } else {
                   // Same milestone or no milestone: direct edge
                   const edgeId = sourceNode.id + '-' + route.status + '-' + tId;
                   const def = bezierMidpoint(startX, startY, endX, endY);
                   const ov = labelOverrides[edgeId];
                   const lx = ov ? ov.x : def.textX, ly = ov ? ov.y : def.textY;
                   const path = ov
                     ? makeBezierThrough(startX, startY, lx, ly, endX, endY)
                     : makeBezier(startX, startY, endX, endY);
                   newEdges.push({ id: edgeId, path, label: route.status, textX: lx, textY: ly, defaultTextX: def.textX, defaultTextY: def.textY });
                 }
            });
        });
      });
      edges.value = newEdges;
    };

    // ── Label repulsion (push labels away from node rects) ──────────────────
    const repelLabels = () => {
        const labelH = 16, labelPad = 6;
        edges.value.forEach(edge => {
            if (!edge.label) return;

            const labelW = edge.label.length * 7 + 8;
            let lx = edge.textX, ly = edge.textY;
            let displaced = false;

            for (let iter = 0; iter < 10; iter++) {
                let overlap = false;
                for (const n of nodes.value) {
                    const nh = getEstimatedNodeHeight(n);
                    const nx = n.x - labelPad, ny = n.y - labelPad;
                    const nw = nodeWidth + labelPad * 2, nnh = nh + labelPad * 2;

                    // Label rect
                    const llx = lx - labelW / 2, lly = ly - labelH / 2;

                    if (llx < nx + nw && llx + labelW > nx && lly < ny + nnh && lly + labelH > ny) {
                        // Push label below the node
                        ly = ny + nnh + labelH / 2 + 4;
                        overlap = true;
                        displaced = true;
                        break;
                    }
                }
                if (!overlap) break;
            }

            if (displaced) {
                edge.textX = lx;
                edge.textY = ly;
                // Update override so the edge path routes through the repelled position
                if (labelOverrides[edge.id]) {
                    labelOverrides[edge.id] = { x: lx, y: ly };
                }
            }
        });
    };

    // ── Edge drawing ────────────────────────────────────────────────────────
    const startDrawingEdge = (node, status, e) => {
        drawingEdge.active = true;
        drawingEdge.sourceNodeId = node.id;
        drawingEdge.sourceStatus = status;

        // Origin: bottom-center dot
        const sourceH = getEstimatedNodeHeight(node);
        drawingEdge.startX = node.x + nodeWidth / 2;
        drawingEdge.startY = node.y + sourceH + 6;

        const coords = getCanvasCoords(e);
        drawingEdge.currentX = coords.x;
        drawingEdge.currentY = coords.y;
    };

    const onCanvasMouseMove = (e) => {
        if (drawingEdge.active) {
            const coords = getCanvasCoords(e);
            drawingEdge.currentX = coords.x;
            drawingEdge.currentY = coords.y;

            drawingEdge.targetNode = null;
            for (const node of nodes.value) {
                if (node.id === drawingEdge.sourceNodeId) continue;
                const targetX = node.x + nodeWidth / 2;
                const targetY = node.y - 6;
                const dist = Math.hypot(coords.x - targetX, coords.y - targetY);
                if (dist <= 30) {
                    drawingEdge.currentX = targetX;
                    drawingEdge.currentY = targetY;
                    drawingEdge.targetNode = node.id;
                    break;
                }
            }
        }
    };

    const onCanvasMouseUp = () => {
        if (drawingEdge.active) {
            if (drawingEdge.targetNode) {
                setTimeout(() => {
                    const sourceNode = nodes.value.find(n => n.id === drawingEdge.sourceNodeId);
                    if (sourceNode) {
                        const route = (sourceNode.routes || []).find(r => r.status === drawingEdge.sourceStatus);
                        if (route) {
                            if (!route.targets) route.targets = [];
                            if (!route.targets.includes(drawingEdge.targetNode)) {
                                route.targets.push(drawingEdge.targetNode);
                            }
                        }
                        syncToRawJson();
                        updateEdges();
                    }
                }, 10);
            }
            drawingEdge.active = false;
            drawingEdge.sourceNodeId = null;
            drawingEdge.sourceStatus = null;
            drawingEdge.targetNode = null;
        }
    };

    // ── Drag: single node, milestone box, or canvas pan ─────────────────────
    // Collect label overrides that belong to edges touching a set of node IDs
    const collectLabelPositions = (nodeIds) => {
        const idSet = new Set(nodeIds);
        const positions = {};
        Object.keys(labelOverrides).forEach(edgeId => {
            // Edge IDs contain source node ID at the start
            const sourceId = edges.value.find(e => e.id === edgeId);
            if (!sourceId) return;
            // Check if any node in the set is involved in this edge
            for (const nId of idSet) {
                if (edgeId.includes(nId)) {
                    positions[edgeId] = { x: labelOverrides[edgeId].x, y: labelOverrides[edgeId].y };
                    break;
                }
            }
        });
        return positions;
    };

    const startMilestoneDrag = (milestoneId, e) => {
        dragState.active = true;
        dragState.node = null;
        dragState.milestoneId = milestoneId;
        dragState.labelEdgeId = null;
        dragState.startX = e.clientX;
        dragState.startY = e.clientY;
        const msNodes = nodes.value
            .filter(n => n.milestoneId === milestoneId || (!n.milestoneId && milestoneId === '__unassigned__'));
        dragState.initialPositions = msNodes.map(n => ({ id: n.id, x: n.x, y: n.y }));
        dragState.initialLabelPositions = collectLabelPositions(msNodes.map(n => n.id));

        document.getElementById('canvas-content').style.cursor = 'grabbing';
        document.addEventListener('mousemove', onDrag);
        document.addEventListener('mouseup', stopDrag);
    };

    const startLabelDrag = (edgeId, e) => {
        const edge = edges.value.find(ed => ed.id === edgeId);
        if (!edge) return;
        dragState.active = true;
        dragState.node = null;
        dragState.milestoneId = null;
        dragState.labelEdgeId = edgeId;
        dragState.startX = e.clientX;
        dragState.startY = e.clientY;
        dragState.initialX = edge.textX;
        dragState.initialY = edge.textY;

        document.addEventListener('mousemove', onDrag);
        document.addEventListener('mouseup', stopDrag);
    };

    const startDrag = (node, e) => {
      // Background click: ensure we actually clicked the background (not a node or milestone box)
      if (!node) {
        let current = e.target;
        while (current && current.id !== 'canvas-content') {
          if (current.classList && current.classList.contains('rounded')) return;
          current = current.parentNode;
        }
      }

      dragState.active = true;
      dragState.node = node;
      dragState.milestoneId = null;
      dragState.startX = e.clientX;
      dragState.startY = e.clientY;

      if (node) {
        dragState.initialX = node.x;
        dragState.initialY = node.y;
        dragState.initialLabelPositions = collectLabelPositions([node.id]);
      } else {
        dragState.initialPositions = nodes.value.map(n => ({ id: n.id, x: n.x, y: n.y }));
        // Capture ALL label overrides for canvas pan
        dragState.initialLabelPositions = {};
        Object.keys(labelOverrides).forEach(k => {
            dragState.initialLabelPositions[k] = { x: labelOverrides[k].x, y: labelOverrides[k].y };
        });
        document.getElementById('canvas-content').style.cursor = 'grabbing';
      }

      document.addEventListener('mousemove', onDrag);
      document.addEventListener('mouseup', stopDrag);
    };

    const onDrag = (e) => {
      if (!dragState.active) return;
      const dx = (e.clientX - dragState.startX) / zoom.value;
      const dy = (e.clientY - dragState.startY) / zoom.value;

      // Helper: shift label overrides that were captured at drag start
      const shiftLabels = () => {
          if (!dragState.initialLabelPositions) return;
          for (const [edgeId, pos] of Object.entries(dragState.initialLabelPositions)) {
              labelOverrides[edgeId] = { x: pos.x + dx, y: pos.y + dy };
          }
      };

      if (dragState.labelEdgeId) {
        // Label drag — update override and recompute edge path through it
        const newX = dragState.initialX + dx;
        const newY = dragState.initialY + dy;
        labelOverrides[dragState.labelEdgeId] = { x: newX, y: newY };
        updateEdges();
      } else if (dragState.node) {
        // Single node drag
        dragState.node.x = dragState.initialX + dx;
        dragState.node.y = dragState.initialY + dy;
        shiftLabels();
        updateEdges();
      } else if (dragState.milestoneId) {
        // Milestone box drag — move all nodes in that milestone
        for (const initPos of dragState.initialPositions) {
            const n = nodes.value.find(x => x.id === initPos.id);
            if (n) {
                n.x = initPos.x + dx;
                n.y = initPos.y + dy;
            }
        }
        shiftLabels();
        updateEdges();
      } else {
        // Canvas pan — move everything
        nodes.value.forEach(n => {
            const initPos = dragState.initialPositions.find(p => p.id === n.id);
            if (initPos) {
                n.x = initPos.x + dx;
                n.y = initPos.y + dy;
            }
        });
        shiftLabels();
        updateEdges();
      }
    };

    const stopDrag = () => {
      const wasMilestoneDrag = !!dragState.milestoneId;
      const wasLabelDrag = !!dragState.labelEdgeId;
      dragState.active = false;
      dragState.node = null;
      dragState.milestoneId = null;
      dragState.labelEdgeId = null;
      const el = document.getElementById('canvas-content');
      if (el) el.style.cursor = 'grab';
      if (wasMilestoneDrag) repelMilestones();
      if (wasLabelDrag) { updateEdges(); repelLabels(); }
      if (viewMode.value === 'visual') syncToRawJson();
      document.removeEventListener('mousemove', onDrag);
      document.removeEventListener('mouseup', stopDrag);
    };

    // ── Palette drop ────────────────────────────────────────────────────────
    const onPaletteDragStart = (e, type) => {
      e.dataTransfer.setData('type', type);
    };

    const onCanvasDrop = (e) => {
      const type = e.dataTransfer.getData('type');
      if (!type) return;
      const coords = getCanvasCoords(e);
      const x = coords.x;
      const y = coords.y;

      // Determine which milestone box this drop landed in
      const dropMilestoneId = getMilestoneAtPoint(x, y);

      if (type === 'user') {
        const newId = 'vnode_' + Math.random().toString(36).substr(2, 9);
        const newNode = { id: newId, nodeType: 'user', milestoneId: dropMilestoneId, task: '', routes: [], x, y };
        nodes.value.push(newNode);
        editNode(newNode);
      } else if (type === 'milestone') {
        const newId = 'vnode_' + Math.random().toString(36).substr(2, 9);
        const newNode = { id: newId, nodeType: 'milestone', label: 'New Milestone', description: '', routes: [], x, y };
        nodes.value.push(newNode);
        editNode(newNode);
      } else if (type === 'system') {
        const newId = 'vnode_' + Math.random().toString(36).substr(2, 9);
        const newNode = { id: newId, nodeType: 'system', milestoneId: dropMilestoneId, label: 'System', description: '', routes: [], x, y };
        nodes.value.push(newNode);
        editNode(newNode);
      } else if (type.startsWith('agent_')) {
        const agentId = type.substring(6);
        const newId = 'vnode_' + Math.random().toString(36).substr(2, 9);
        if (agentId === 'new') {
          const newNode = { id: newId, agentId: '', milestoneId: dropMilestoneId, routes: [], x, y };
          nodes.value.push(newNode);
          editNode(newNode);
        } else {
          // Pre-populate with routes relevant to the drop milestone
          const rts = workflowObj.value.routing?.[agentId]?.routes || {};
          const milestone = (workflowObj.value.pipeline?.milestones || []).find(m => m.id === dropMilestoneId);
          const relevantStatuses = milestone
              ? Object.keys(rts).filter(s => milestone.statuses && milestone.statuses.includes(s))
              : Object.keys(rts);
          const nodeRoutes = relevantStatuses.map(status => ({ status, targets: [] }));
          const newNode = { id: newId, agentId, milestoneId: dropMilestoneId, routes: nodeRoutes, x, y };
          nodes.value.push(newNode);
          syncToRawJson(); updateEdges();
        }
      }
    };

    // Helper: find which milestone bounding box contains a point
    const getMilestoneAtPoint = (x, y) => {
        const boxes = milestoneBoxes.value;
        for (const box of boxes) {
            if (box.id === '__unassigned__') continue;
            if (x >= box.x && x <= box.x + box.width && y >= box.y && y <= box.y + box.height) {
                return box.id;
            }
        }
        return null;
    };

    // ── Node editing ────────────────────────────────────────────────────────
    const editNode = (node) => {
      editorDialog.node = node;
      editorDialog.agentId = node.agentId || '';
      editorDialog.routes = node.routes ? JSON.parse(JSON.stringify(node.routes)) : [];
      editorDialog.task = node.task || '';
      editorDialog.label = node.label || '';
      editorDialog.description = node.description || '';

      if (node.nodeType === 'user' || node.nodeType === 'system' || node.nodeType === 'milestone') {
          // No agent config needed
      } else if (node.agentId && workflowObj.value.agents?.[node.agentId]) {
          const ag = workflowObj.value.agents[node.agentId];
          editorDialog.role = ag.role || '';
          editorDialog.emoji = ag.emoji || '\u{1F916}';
          editorDialog.mission = ag.mission || '';
      } else {
          editorDialog.role = 'New Agent';
          editorDialog.emoji = '\u{1F916}';
          editorDialog.mission = '';
      }
      editorDialog.show = true;
    };

    // Auto-update global agent configs dynamically when selected
    watch(() => editorDialog.agentId, (newId) => {
        if (newId && workflowObj.value.agents && workflowObj.value.agents[newId]) {
            const ag = workflowObj.value.agents[newId];
            editorDialog.role = ag.role || '';
            editorDialog.emoji = ag.emoji || '\u{1F916}';
            editorDialog.mission = ag.mission || '';
        }
    });

    const closeEditor = () => {
      if (editorDialog.node) {
          const node = editorDialog.node;
          if (node.nodeType === 'user') {
              node.task = editorDialog.task;
              node.routes = editorDialog.routes;
          } else if (node.nodeType === 'system') {
              node.label = editorDialog.label;
              node.description = editorDialog.description;
              node.routes = editorDialog.routes;
          } else if (node.nodeType === 'milestone') {
              node.label = editorDialog.label;
              node.description = editorDialog.description;
              node.routes = editorDialog.routes;
          } else {
              const agId = editorDialog.agentId;
              if (agId) {
                  if (!workflowObj.value.agents) workflowObj.value.agents = {};
                  if (!workflowObj.value.agents[agId]) {
                      workflowObj.value.agents[agId] = {
                          promptId: 'main', model: 'specialist', requires: ['text'], prompts: ["main", "query", "approval"]
                      };
                  }
                  workflowObj.value.agents[agId].role = editorDialog.role;
                  workflowObj.value.agents[agId].emoji = editorDialog.emoji;
                  workflowObj.value.agents[agId].mission = editorDialog.mission;

                  node.agentId = agId;
                  node.routes = editorDialog.routes;
              }
          }
      }
      editorDialog.show = false;
      editorDialog.node = null;
      syncToRawJson();
      updateEdges();
    };

    const deleteVisualNode = (vnodeId) => {
        // Remove edge references to this node
        nodes.value.forEach(n => {
            if (n.routes) {
                n.routes.forEach(r => {
                    if (r.targets) r.targets = r.targets.filter(tId => tId !== vnodeId);
                });
            }
        });
        nodes.value = nodes.value.filter(n => n.id !== vnodeId);
        closeEditor();
    };

    onMounted(() => {
      fetchWorkflowsList();
    });

    return {
      gridBackgroundStyle, paletteGroupsOpen, zoom, zoomIn, zoomOut, resetZoom, onWheel,
      currentWorkflow, workflowDialog, confirmWorkflow,
      viewMode, rawJson, parseJson, syncToRawJson,
      workflowObj, saving, snackbar,
      nodes, edges, nodeWidth, availableAgentIds,
      saveWorkflow, layoutNodes, milestoneBoxes, milestoneEdges,
      startDrag, startMilestoneDrag, startLabelDrag, labelOverrides, formatTarget: (t) => t,
      onPaletteDragStart, onCanvasDrop,
      editorDialog, addRoute,
      editNode, closeEditor, deleteVisualNode,
      drawingEdge, drawingEdgePath, getCanvasCoords,
      startDrawingEdge, onCanvasMouseMove, onCanvasMouseUp
    };
  }
};
})();
