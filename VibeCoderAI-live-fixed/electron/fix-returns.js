const fs = require('fs');
let content = fs.readFileSync('D:/v3/electron/backend.cjs', 'utf8');

// Fix: return ok: true -> return { ok: true }
content = content.replace(/return ok:/g, 'return { ok: ');
content = content.replace(/return ok: \{/g, 'return { ok: {');

// Fix: return error: something -> return { error: something }
content = content.replace(/return error:/g, 'return { error: ');
content = content.replace(/return error: \{/g, 'return { error: {');

fs.writeFileSync('D:/v3/electron/backend.cjs', content);
console.log('Fixed all return property-notated returns');