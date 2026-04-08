const fs = require('fs');
let js = fs.readFileSync('app/chat.js', 'utf8');

js = js.replace(
`    const workflows = ref([
      { id: 'standard', name: 'Standard Software Development', description: 'BA -> Architect/UX -> Backend/Frontend -> QA' },
      { id: 'research', name: 'Research Only', description: 'BA -> Complete' },
      { id: 'frontend', name: 'Frontend Feature', description: 'UX -> Frontend -> QA' }
    ]);`,
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
fs.writeFileSync('app/chat.js', js);
