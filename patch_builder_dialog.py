import re

with open('app/builder.js', 'r') as f:
    content = f.read()

# Add availableMilestones
content = content.replace(
    "const workflowDialog = reactive({ show: true, selected: null, newName: '', existing: [] });",
    """const workflowDialog = reactive({ show: true, selected: null, newName: '', existing: [] });
    const availableMilestones = computed(() => {
        const ms = nodes.value.filter(n => n.nodeType === 'milestone').map(m => ({ title: m.label, value: m.id }));
        ms.unshift({ title: 'Unassigned', value: '__unassigned__' });
        return ms;
    });"""
)

# Add milestoneId to editorDialog state
content = content.replace(
    "const editorDialog = reactive({ show: false, node: null, agentId: '', role: '', emoji: '\\u{1F916}', mission: '', routes: [], task: '', label: '', description: '' });",
    "const editorDialog = reactive({ show: false, node: null, agentId: '', role: '', emoji: '\\u{1F916}', mission: '', routes: [], task: '', label: '', description: '', milestoneId: '' });"
)

# Set milestoneId when opening editor
content = content.replace(
    "editorDialog.node = node;",
    "editorDialog.node = node;\n      editorDialog.milestoneId = node.milestoneId || '__unassigned__';"
)

# Export availableMilestones
content = content.replace(
    "editorDialog, addRoute,",
    "editorDialog, addRoute, availableMilestones,"
)

# In closeEditor, handle milestone mapping
close_editor_old = """    const closeEditor = () => {
      if (editorDialog.node) {
          const node = editorDialog.node;
          if (node.nodeType === 'user') {"""

close_editor_new = """    const closeEditor = () => {
      if (editorDialog.node) {
          const node = editorDialog.node;
          let selectedMs = editorDialog.milestoneId;
          if (selectedMs && selectedMs !== '__unassigned__' && node.nodeType !== 'milestone') {
              const existing = nodes.value.find(n => n.nodeType === 'milestone' && (n.id === selectedMs || n.label === selectedMs));
              if (existing) {
                  node.milestoneId = existing.id;
              } else {
                  const newId = 'vnode_' + Math.random().toString(36).substr(2, 9);
                  nodes.value.push({ id: newId, nodeType: 'milestone', label: selectedMs, description: '', routes: [], x: node.x, y: Math.max(0, node.y - 100) });
                  node.milestoneId = newId;
              }
          } else if (node.nodeType !== 'milestone') {
              node.milestoneId = null;
          }

          if (node.nodeType === 'user') {"""

content = content.replace(close_editor_old, close_editor_new)

# Add combobox to the template (before Routes sections)
user_node_template = """            <template v-if="editorDialog.node.nodeType === 'user'">
              <v-text-field v-model="editorDialog.task" label="Task / Purpose" hint="What the user does at this point (e.g. 'Clarify requirements', 'Approve design')" persistent-hint class="mb-4"></v-text-field>"""

user_node_template_new = """            <template v-if="editorDialog.node.nodeType === 'user'">
              <v-combobox v-model="editorDialog.milestoneId" :items="availableMilestones" item-title="title" item-value="value" label="Milestone" hint="Select an existing milestone or type a new one" persistent-hint class="mb-4"></v-combobox>
              <v-text-field v-model="editorDialog.task" label="Task / Purpose" hint="What the user does at this point (e.g. 'Clarify requirements', 'Approve design')" persistent-hint class="mb-4"></v-text-field>"""

content = content.replace(user_node_template, user_node_template_new)

system_node_template = """            <template v-else-if="editorDialog.node.nodeType === 'system'">
              <v-text-field v-model="editorDialog.label" label="Node Label" class="mb-4"></v-text-field>"""

system_node_template_new = """            <template v-else-if="editorDialog.node.nodeType === 'system'">
              <v-combobox v-model="editorDialog.milestoneId" :items="availableMilestones" item-title="title" item-value="value" label="Milestone" hint="Select an existing milestone or type a new one" persistent-hint class="mb-4"></v-combobox>
              <v-text-field v-model="editorDialog.label" label="Node Label" class="mb-4"></v-text-field>"""

content = content.replace(system_node_template, system_node_template_new)

agent_node_template = """            <template v-else>
              <div class="mb-4">
                <v-select"""

agent_node_template_new = """            <template v-else>
              <div class="mb-4">
              <v-combobox v-model="editorDialog.milestoneId" :items="availableMilestones" item-title="title" item-value="value" label="Milestone" hint="Select an existing milestone or type a new one" persistent-hint class="mb-4"></v-combobox>
                <v-select"""

content = content.replace(agent_node_template, agent_node_template_new)

# Task 2: builder onMounted logic to use thread_id for workflow
on_mounted_logic_old = """    onMounted(() => {
      fetchWorkflowsList();
    });"""

on_mounted_logic_new = """    onMounted(async () => {
      if (threadId.value) {
          try {
              const res = await fetch(`/api/threads/${threadId.value}/workflow`);
              if (res.ok) {
                  const data = await res.json();
                  currentWorkflow.value = data.workflow || "workflow";
                  workflowDialog.show = false;
                  await fetchWorkflow();
                  return;
              }
          } catch(e) {}
      }
      fetchWorkflowsList();
    });"""

content = content.replace(on_mounted_logic_old, on_mounted_logic_new)

with open('app/builder.js', 'w') as f:
    f.write(content)
