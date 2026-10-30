const fs = require('fs');

// Read backend.cjs
const original = fs.readFileSync('D:/v3/electron/backend.cjs', 'utf8');
const lines = original.split('\n');

// Find insertion point: after line 1330 (the handlers loop)
const insertAfter = 1330;

// Lines to add
const newLines = [
  '  vibe.engine.on("compaction.start", (ev) => send("vibe:event", ev))',
  '  vibe.engine.on("compaction.end", (ev) => send("vibe:event", ev))',
  '',
];

// Build new content
const newContent = [
  ...lines.slice(0, insertAfter),
  ...newLines,
  ...lines.slice(insertAfter)
].join('\n');

// Write back
fs.writeFileSync('D:/v3/electron/backend.cjs', newContent, 'utf8');

 console.log('✓ Added event listeners to backend.cjs');
 console.log('✓ Syntax check:');

const { execSync } = require('child_process');
try {
  execSync('node -c D:/v3/electron/backend.cjs', { encoding: 'utf8' });
  console.log('✓ Syntax is valid');
} catch (e) {
  console.log('✗ Syntax error - aborting');
  process.exit(1);
}

console.log('✓ Fix complete - ready to rebuild');