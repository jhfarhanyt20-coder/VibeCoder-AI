// Read and fix backend.cjs
const fs = require('fs');
let content = fs.readFileSync('D:/v3/electron/backend.cjs', 'utf8');

// Remove everything after line 1330 (the handlers loop)
const lines = content.split('\n');
const frontendLines = lines.slice(0, 1330);

// Add proper event listeners
const newLines = [
  '  vibe.engine.on("compaction.start", (ev) => send("vibe:event", ev))',
  '  vibe.engine.on("compaction.end", (ev) => send("vibe:event", ev))',
  ''
];

const newContent = [...frontendLines, ...newLines].join('\n');
fs.writeFileSync('D:/v3/electron/backend.cjs', newContent);

console.log('Backend fixed. Now loading dev mode...');