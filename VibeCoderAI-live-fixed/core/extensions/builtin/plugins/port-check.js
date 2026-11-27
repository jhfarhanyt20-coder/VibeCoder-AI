"use strict"
// BDCoder built-in plugin: which local dev-server ports are answering right
// now (3000, 5173, 8080...). Useful before opening the in-app browser. Read-only.
const net = require("net")

const COMMON = [3000, 3001, 4173, 4200, 5000, 5173, 5174, 5500, 8000, 8080, 8081, 8888, 9000]

function probe(port, host = "127.0.0.1", timeout = 400) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host })
    const done = (open) => { socket.destroy(); resolve(open) }
    socket.setTimeout(timeout, () => done(false))
    socket.once("connect", () => done(true))
    socket.once("error", () => done(false))
  })
}

module.exports = {
  tools: [{
    name: "ports_in_use",
    description: "Check which local ports are answering on this computer (default: common dev-server ports like 3000, 5173, 8080). Use it to find a running dev server before opening http://localhost:<port>. Read-only.",
    parameters: {
      type: "object",
      properties: { ports: { type: "array", items: { type: "number" }, description: "Ports to check instead of the common ones (at most 50)" } },
    },
    perm: () => ({ tool: "read", subject: "local ports" }),
    run: async (args = {}) => {
      const list = (Array.isArray(args.ports) && args.ports.length ? args.ports : COMMON)
        .map(Number).filter((p) => Number.isInteger(p) && p > 0 && p < 65536).slice(0, 50)
      const results = await Promise.all(list.map(async (p) => [p, await probe(p)]))
      const open = results.filter(([, ok]) => ok).map(([p]) => p)
      if (!open.length) return `No server is answering on: ${list.join(", ")}`
      return `Answering: ${open.map((p) => `http://localhost:${p}`).join("  ")}\nNot answering: ${results.filter(([, ok]) => !ok).map(([p]) => p).join(", ") || "none"}`
    },
  }],
}
