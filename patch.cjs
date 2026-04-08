const fs = require('fs');
let html = fs.readFileSync('app/index.html', 'utf8');

// 1. Add refs
html = html.replace('    const threadChain = ref([]);\n    const editDialogOpen = ref(false);', '    const threadChain = ref([]);\n    const workflowMilestones = ref([]);\n    const editDialogOpen = ref(false);');

// 2. Add stream timer
html = html.replace('    let isStreaming = false;', '    let isStreaming = false;\n    let streamRetryTimer = null;\n\n    async function fetchMilestones() {\n      try {\n        const res = await fetch("/api/workflow");\n        if (res.ok) {\n          const w = await res.json();\n          if (w.pipeline && w.pipeline.milestones) workflowMilestones.value = w.pipeline.milestones;\n        }\n      } catch (e) {}\n    }');

// 3. fetchMessages
html = html.replace(
`          const msgs = await r.json();
          // Preserve existing reactive state for messages already rendered
          const existing = new Map(messages.value.map((m, i) => [i, m]));
          messages.value = msgs.map((m, i) => {`,
`          const msgs = await r.json();
          // Build new array from checkpoint, reusing existing reactive objects where possible
          const existing = new Map(messages.value.map((m, i) => [i, m]));
          const result = msgs.map((m, i) => {`
);

html = html.replace(
`              _timestamp: m.timestamp ? new Date(m.timestamp) : new Date()
            });
          });
        }
      } catch {} finally { loading.value = false; }`,
`              _timestamp: m.timestamp ? new Date(m.timestamp) : new Date()
            });
          });
          // Append any still-streaming messages that aren't in the checkpoint yet
          for (const m of messages.value) {
            if (m._streaming && !result.includes(m)) {
              result.push(m);
            }
          }
          messages.value = result;
        }
      } catch {} finally { loading.value = false; }`
);

// 4. formatMilestoneLabel
html = html.replace(
`    function formatMilestoneLabel(status) {
      if (!status) return "";
      return status.replace(/_/g, " ").replace(/\\b\\w/g, c => c.toUpperCase());
    }

    function baseAgentName(id) {
      return (id || "").replace(/_research_phase_2_\\d+$/, "").replace(/_research_phase_2$/, "").replace(/_research$/, "").replace(/_/g, " ").replace(/\\b\\w/g, c => c.toUpperCase());
    }`,
`    function formatMilestoneLabel(status) {
      if (!status) return "";
      if (workflowMilestones.value && workflowMilestones.value.length) {
        const m = workflowMilestones.value.find(m => m.statuses && m.statuses.includes(status));
        if (m && m.name) return m.name;
      }
      return status.replace(/_/g, " ").replace(/\\b\\w/g, c => c.toUpperCase());
    }

    function baseAgentName(id) {
      return (id || "").replace(/_research_round_\\d+$/, "").replace(/_research_phase_2_\\d+$/, "").replace(/_research_phase_2$/, "").replace(/_research$/, "").replace(/_/g, " ").replace(/\\b\\w/g, c => c.toUpperCase());
    }`
);

// 5. deriveSectionLabel / boundary stuff
html = html.replace(
`      const sections = rawSections.map((s, i) => {
        const nextBoundary = i < boundaries.length ? boundaries[i] : null;
        const prevBoundary = i > 0 ? boundaries[i - 1] : null;
        const agent = nextBoundary ? (nextBoundary.milestoneAgent || "") : (s.messages.find(m => m.role === "assistant" && m.name)?.name || "");
        // Sections after a milestone boundary get a rewind target to re-trigger all agents from the fan-out point
        const rewindTarget = prevBoundary && prevBoundary._threadMsgIndex != null ? { threadId: prevBoundary._threadId || threadId, msgIndex: prevBoundary._threadMsgIndex } : null;
        return { ...s, label: deriveSectionLabel(s, nextBoundary), agent, rewindTarget };
      });`,
`      const sections = rawSections.map((s, i) => {
        const thisNextBoundary = i < boundaries.length ? boundaries[i] : null;
        const prevBoundary = i > 0 ? boundaries[i - 1] : null;
        const agent = thisNextBoundary ? (thisNextBoundary.milestoneAgent || "") : (s.messages.find(m => m.role === "assistant" && m.name)?.name || "");
        // Sections after a milestone boundary get a rewind target to re-trigger all agents from the fan-out point
        const rewindTarget = prevBoundary && prevBoundary._threadMsgIndex != null ? { threadId: prevBoundary._threadId || threadId, msgIndex: prevBoundary._threadMsgIndex } : null;
        return { ...s, label: deriveSectionLabel(s, thisNextBoundary), agent, rewindTarget };
      });`
);

// 6. saveEdit stream logic
html = html.replace(
`      // Navigate to the target thread if different from current view
      if (tid !== threadId) router.push("/admin/thread/" + tid);
      else pollAll();`,
`      // Navigate to the target thread if different from current view
      if (tid !== threadId) router.push("/admin/thread/" + tid);
      else {
        // Stop any existing stream
        if (currentStreamController) { currentStreamController.abort(); currentStreamController = null; }
        isStreaming = false;
        clearTimeout(streamRetryTimer);
        // Reload messages (checkpoint was truncated) and check active status
        await fetchMessages();
        await fetchActive();
        // Connect stream if workflow is running
        if (active.value) connectStream();
      }`
);

// 7. rewind stream logic
html = html.replace(
`        // Navigate to the target thread if different from current view
        if (tid !== threadId) router.push("/admin/thread/" + tid);
        else pollAll();`,
`        // Navigate to the target thread if different from current view
        if (tid !== threadId) router.push("/admin/thread/" + tid);
        else {
          // Stop any existing stream
          if (currentStreamController) { currentStreamController.abort(); currentStreamController = null; }
          isStreaming = false;
          clearTimeout(streamRetryTimer);
          // Reload messages (checkpoint was truncated) and check active status
          await fetchMessages();
          await fetchActive();
          // Connect stream if workflow is running
          if (active.value) connectStream();
        }`
);

// 8. rewindSection stream logic
html = html.replace(
`        if (target.threadId !== threadId) router.push("/admin/thread/" + target.threadId);
        else pollAll();`,
`        if (target.threadId !== threadId) router.push("/admin/thread/" + target.threadId);
        else {
          // Stop any existing stream
          if (currentStreamController) { currentStreamController.abort(); currentStreamController = null; }
          isStreaming = false;
          clearTimeout(streamRetryTimer);
          // Reload messages (checkpoint was truncated) and check active status
          await fetchMessages();
          await fetchActive();
          // Connect stream if workflow is running
          if (active.value) connectStream();
        }`
);

// 9. processStreamDelta
html = html.replace(
`    function processStreamDelta(deltaObj, choiceObj) {
      const agentId = deltaObj.agent || "";`,
`    function processStreamDelta(deltaObj, choiceObj, created) {
      const agentId = deltaObj.agent || "";
      const eventTime = created ? new Date(created * 1000) : new Date();`
);

html = html.replace(
`        if (!exists) {
          messages.value.push(reactive({ 
            role: "system", name: agentId, content: deltaObj.system_prompt, type: "prompt", 
            _thinking: null, _displayContent: deltaObj.system_prompt, _thinkOpen: false, _streaming: false,
            _msgOpen: true, _timestamp: new Date()
          }));
          
        }`,
`        if (!exists) {
          messages.value.push(reactive({ 
            role: "system", name: agentId, content: deltaObj.system_prompt, type: "prompt", 
            _thinking: null, _displayContent: deltaObj.system_prompt, _thinkOpen: false, _streaming: false,
            _msgOpen: true, _timestamp: eventTime
          }));
          
        }`
);

// 10. connectStream
html = html.replace(
`    async function connectStream() {
      if (isStreaming && currentStreamController) return;
      isStreaming = true;
      
      if (currentStreamController) currentStreamController.abort();
      currentStreamController = new AbortController();
      const signal = currentStreamController.signal;

      try {
        const resp = await fetch("/api/threads/" + threadId + "/stream", { signal });
        if (!resp.ok) { isStreaming = false; return; }
        const reader = resp.body.getReader();
        const dec = new TextDecoder();
        let buffer = "";

        while (true) {
          if (signal.aborted) break;
          const { done, value } = await reader.read();
          if (done) break;
          buffer += dec.decode(value, { stream: true });
          const lines = buffer.split("\\n");
          buffer = lines.pop();

          for (const line of lines) {
            if (signal.aborted) break;
            if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
            try {
              const data = JSON.parse(line.slice(6));
              if (data.choices?.[0]) processStreamDelta(data.choices[0].delta, data.choices[0]);
            } catch {}
          }
        }
      } catch (e) {
        if (e.name !== "AbortError") console.error("Connect error:", e);
      } finally {
        isStreaming = false;
        currentStreamController = null;
        // Finalize any streaming messages
        messages.value.forEach(m => { if (m._streaming) m._streaming = false; m._thinkingActive = false; });
        for (const key in activeStreamStates) delete activeStreamStates[key];
        if (!signal.aborted) fetchMessages(); // Load final state from DB
      }
    }`,
`    async function connectStream() {
      if (isStreaming && currentStreamController) return;
      isStreaming = true;
      clearTimeout(streamRetryTimer);

      if (currentStreamController) currentStreamController.abort();
      currentStreamController = new AbortController();
      const signal = currentStreamController.signal;

      try {
        const resp = await fetch("/api/threads/" + threadId + "/stream", { signal });
        if (!resp.ok) {
          isStreaming = false;
          // Stream not available yet (404 = no active workflow). Retry if thread is active.
          if (!signal.aborted && active.value) {
            streamRetryTimer = setTimeout(() => connectStream(), 1000);
          }
          return;
        }
        const reader = resp.body.getReader();
        const dec = new TextDecoder();
        let buffer = "";

        while (true) {
          if (signal.aborted) break;
          const { done, value } = await reader.read();
          if (done) break;
          buffer += dec.decode(value, { stream: true });
          const lines = buffer.split("\\n");
          buffer = lines.pop();

          for (const line of lines) {
            if (signal.aborted) break;
            if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
            try {
              const data = JSON.parse(line.slice(6));
              if (data.choices?.[0]) processStreamDelta(data.choices[0].delta, data.choices[0], data.created);
            } catch {}
          }
        }
      } catch (e) {
        if (e.name !== "AbortError") console.error("Connect error:", e);
      } finally {
        isStreaming = false;
        currentStreamController = null;
        // Finalize any streaming messages
        messages.value.forEach(m => { if (m._streaming) m._streaming = false; m._thinkingActive = false; });
        for (const key in activeStreamStates) delete activeStreamStates[key];
        if (!signal.aborted) {
          await fetchMessages(); // Load final state from DB
          // If thread is still active, reconnect after a short delay
          await fetchActive();
          if (active.value) {
            streamRetryTimer = setTimeout(() => connectStream(), 500);
          }
        }
      }
    }`
);

// 11. onMounted
html = html.replace(
`    onMounted(async () => {
      fetchTitle();
      fetchChain();
      await pollAll();
      if (active.value) connectStream();
      poll = setInterval(pollAll, 2000);
    });
    onUnmounted(() => {
      clearInterval(poll);
      if (currentStreamController) currentStreamController.abort();
    });`,
`    onMounted(async () => {
      fetchMilestones();
      fetchTitle();
      fetchChain();
      await pollAll();
      if (active.value) connectStream();
      poll = setInterval(pollAll, 2000);
    });
    onUnmounted(() => {
      clearInterval(poll);
      clearTimeout(streamRetryTimer);
      if (currentStreamController) currentStreamController.abort();
    });`
);

fs.writeFileSync('app/index.html', html);
