const fs = require('fs');

const data = JSON.parse(fs.readFileSync('workflow.json', 'utf8'));

if (data.pipeline && data.pipeline.milestones) {
  const m = data.pipeline.milestones;
  for (let i = 0; i < m.length; i++) {
    m[i].previous = i === 0 ? null : m[i - 1].id;
    m[i].next = i === m.length - 1 ? null : m[i + 1].id;
  }
}

fs.writeFileSync('workflow.json', JSON.stringify(data, null, 2));
