const fs = require('fs');
let content = fs.readFileSync('D:/v3/electron/backend.cjs', 'utf8');
// Find and remove duplicate compaction event lines (keep only first pair)
const lines = content.split('\n');
const kept = [];
for (let i = 0; i < lines.length; i++) {
  const line = lines[i].trim();
  if (line.includes('vibe.engine.on("compaction.start"')) {
    // Skip if we've seen it before (it's a duplicate)
    if (kept.length >= 2 && kept.some(l => l.includes('compaction.start'))) {
      continue;
    }
    kept.push(lines[i]);
  } else if (line.includes('vibe.engine.on("compaction.end"')) {
    // Skip if we've seen it before (duplicate)
    if (kept.length >= 2 && kept.some(l => l.includes('compaction.end'))) {
      continue;
    }
    kept.push(lines[i]);
  } else {
    kept.push(lines[i]);
  }
}
fs.writeFileSync('D:/v3/electron/backend.cjs', kept.join('\n'));
console.log('Duplicates removed');