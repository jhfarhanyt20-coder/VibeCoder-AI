const fs = require('fs');
let content = fs.readFileSync('D:/v3/electron/backend.cjs', 'utf8');
// Replace the escaped lines with proper single-line format
content = content.replace(
  /vibe\.engine\.on\(\\"compaction\.start\\", \(ev\) => send\(\\"vibe:event\\", ev\)\)/,
  '  vibe.engine.on("compaction.start", (ev) => send("vibe:event", ev))'
);
content = content.replace(
  /vibe\.engine\.on\(\\"compaction\.end\\", \(ev\) => send\(\\"vibe:event\\", ev\)\)/,
  '  vibe.engine.on("compaction.end", (ev) => send("vibe:event", ev))'
);
fs.writeFileSync('D:/v3/electron/backend.cjs', content);
console.log('Syntax fixed');