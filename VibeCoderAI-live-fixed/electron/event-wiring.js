const fs = require('fs');
const content = fs.readFileSync('D:/v3/electron/backend.cjs', 'utf8');
const lines = content.split('\n');
const insertPoint = 1330; // After the handlers loop
const newLines = [
  '  vibe.engine.on("compaction.start", (ev) => send("vibe:event", ev))',
  '  vibe.engine.on("compaction.end", (ev) => send("vibe:event", ev))',
  ''
];
const newContent = [
  ...lines.slice(0, insertPoint),
  ...newLines,
  ...lines.slice(insertPoint)
].join('\n');
fs.writeFileSync('D:/v3/electron/backend.cjs', newContent);
console.log('Event listeners added');