const fs = require('fs');
let js = fs.readFileSync('app/chat.js', 'utf8');

// 1. Add fetch workflows and milestones
js = js.replace(
`    const workflows = ref([
      { id: 'standard', name: 'Standard Software Development', description: 'BA -> Architect/UX -> Backend/Frontend -> QA' },
      { id: 'research', name: 'Research Only', description: 'BA -> Complete' },
      { id: 'frontend', name: 'Frontend Feature', description: 'UX -> Frontend -> QA' }
    ]);
    
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
    };`,
`    const workflows = ref([]);
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
    };`
);

// 2. formatMilestoneLabel
js = js.replace(
`    function formatMilestoneLabel(status) {
      if (!status) return "";
      return status.replace(/_/g, " ").replace(/\\b\\w/g, c => c.toUpperCase());
    }`,
`    function formatMilestoneLabel(status) {
      if (!status) return "";
      if (workflowMilestones.value && workflowMilestones.value.length) {
        const m = workflowMilestones.value.find(m => m.statuses && m.statuses.includes(status));
        if (m && m.name) return m.name;
      }
      return status.replace(/_/g, " ").replace(/\\b\\w/g, c => c.toUpperCase());
    }`
);

// 3. baseAgentName
js = js.replace(
`    function baseAgentName(id) {
      return (id || "").replace(/_research_phase_2_\\d+$/, "").replace(/_research_phase_2$/, "").replace(/_research$/, "").replace(/_/g, " ").replace(/\\b\\w/g, c => c.toUpperCase());
    }`,
`    function baseAgentName(id) {
      return (id || "").replace(/_research_round_\\d+$/, "").replace(/_research_phase_2_\\d+$/, "").replace(/_research_phase_2$/, "").replace(/_research$/, "").replace(/_/g, " ").replace(/\\b\\w/g, c => c.toUpperCase());
    }`
);

// 4. deriveSectionLabel / boundary stuff
js = js.replace(
`      const sections = rawSections.map((s, i) => {
        const nextBoundary = i < boundaries.length ? boundaries[i] : null;
        const agent = nextBoundary ? (nextBoundary.milestoneAgent || "") : (s.messages.find(m => m.role === "assistant" && m.name)?.name || "");
        return { ...s, label: deriveSectionLabel(s, nextBoundary), agent };
      });`,
`      const sections = rawSections.map((s, i) => {
        const thisNextBoundary = i < boundaries.length ? boundaries[i] : null;
        const agent = thisNextBoundary ? (thisNextBoundary.milestoneAgent || "") : (s.messages.find(m => m.role === "assistant" && m.name)?.name || "");
        return { ...s, label: deriveSectionLabel(s, thisNextBoundary), agent };
      });`
);

// 5. onMounted
js = js.replace(
`    onMounted(async () => {
      await fetchThreads();`,
`    onMounted(async () => {
      await fetchThreads();
      await fetchWorkflows();
      await fetchMilestones();`
);

// 6. Navigation Drawer
js = js.replace(
`        <template v-if="!rail" v-slot:append>
          <v-divider />
          <v-list-item prepend-icon="mdi-cog" title="Admin" @click="$router.push('/admin')" rounded nav />
        </template>`,
`        <template v-if="!rail" v-slot:append>
          <v-divider />
          <v-list-item prepend-icon="mdi-cog" title="Admin" @click="$router.push('/admin')" rounded nav />
          <v-list-item prepend-icon="mdi-hammer-wrench" title="Builder" @click="$router.push('/builder')" rounded nav />
        </template>`
);

fs.writeFileSync('app/chat.js', js);
