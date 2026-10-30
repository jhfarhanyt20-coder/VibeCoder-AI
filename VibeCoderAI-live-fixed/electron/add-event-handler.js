const fs = require('fs');
const content = fs.readFileSync('D:/v3/renderer/app.js', 'utf8');
const appendLines = `
/* ---------- listen to engine compaction events ---------- */
vibe.onEvent((ev) => {
  if (ev.type === "compaction.start") {
    state.compacting = true
    updateRunBadge()
    const card = document.createElement("div")
    card.className = "ctxd-card running"
    card.innerHTML = \`
      <div class="ctxd-head">
        <span class="ctxd-ic">⌁</span>
        <span class="ctxd-title">\${ev.reason === "manual" ? "Compacting context…" : "Context almost full — compacting…"}</span>
        <span class="ctxd-meta">\${ev.reason}</span>
      </div>
      <div class="ctxd-sum"></div>
    \`
    card.querySelector(".ctxd-head").onclick = () => card.classList.toggle("open")
    $("messages").appendChild(card)
    scrollChat()
    window.liveCompactEl = card
  } else if (ev.type === "compaction.end") {
    const card = window.liveCompactEl
    if (card) {
      card.classList.remove("running")
      card.classList.add("done")
      const title = card.querySelector(".ctxd-title")
      const meta = card.querySelector(".ctxd-meta")
      title.textContent = "Context compacted"
      meta.textContent = ev.reason === "auto" ? "auto" : "manual"
      card.querySelector(".ctxd-sum").textContent = \`Saved: \${ev.before} → \${ev.after} tokens\`
    }
    window.liveCompactEl = null
    if (card) card.classList.add("open")
    scrollChat()
  }
})
`;
fs.writeFileSync('D:/v3/renderer/app.js', content + appendLines);
console.log('Event handler added');