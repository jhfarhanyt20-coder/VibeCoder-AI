"use strict"
/**
 * A dependency-free npm-compatible CLI archive. The desktop release feed keeps
 * its existing installer/update metadata; this is an additional tagged asset.
 */
const fs = require("node:fs")
const path = require("node:path")
const zlib = require("node:zlib")
const crypto = require("node:crypto")

function tarEntry(name, content, mode = 0o644) {
  if (Buffer.byteLength(name) > 100 || name.includes("..") || name.startsWith("/")) throw new Error("Unsafe archive path: " + name)
  const data = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8")
  const header = Buffer.alloc(512)
  const text = (offset, value, size) => header.write(String(value).slice(0, size), offset, size, "utf8")
  const octal = (offset, value, size) => text(offset, value.toString(8).padStart(size - 1, "0") + "\0", size)
  text(0, name, 100)
  octal(100, mode, 8); octal(108, 0, 8); octal(116, 0, 8)
  octal(124, data.length, 12); octal(136, 0, 12)
  header.fill(0x20, 148, 156)
  text(156, "0", 1)
  text(257, "ustar\0", 6); text(263, "00", 2)
  const checksum = header.reduce((sum, byte) => sum + byte, 0)
  text(148, checksum.toString(8).padStart(6, "0") + "\0 ", 8)
  return Buffer.concat([header, data, Buffer.alloc((512 - data.length % 512) % 512)])
}

function buildArchive({ root = path.resolve(__dirname, ".."), output } = {}) {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"))
  const manifest = {
    name: "vibecoder-cli", version: pkg.version, description: "VibeCoder terminal agent and VibeCore SDK",
    license: pkg.license, author: pkg.author, engines: pkg.engines,
    main: "sdk/index.js", bin: { vibe: "cli/vibe.js" },
  }
  const files = new Map()
  const collect = (relative) => {
    for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isSymbolicLink() || entry.name.startsWith(".") || ["node_modules", "release", "dist", "test"].includes(entry.name)) continue
      const name = path.posix.join(relative, entry.name)
      if (entry.isDirectory()) collect(name)
      // Code and data, plus the Computer Use helper script and the agent's product guide.
      else if (entry.isFile() && (/\.(?:js|cjs|mjs|json)$/.test(entry.name) || /^core\/(?:computer\/[^/]+\.ps1|knowledge\/[^/]+\.md)$/.test(name)) && !/^(?:auth|profiles|config|registries|memories)\.json$/.test(entry.name)) files.set(name, fs.readFileSync(path.join(root, name)))
    }
  }
  for (const dir of ["core", "sdk", "cli"]) collect(dir)
  files.set("package.json", Buffer.from(JSON.stringify(manifest, null, 2)))
  files.set("README.md", Buffer.from(`# VibeCoder CLI ${pkg.version}\n\nRequires Node.js 20+.\n\nInstall the reviewed release archive with \`npm install -g ./VibeCoder-CLI-${pkg.version}.tgz\`.\nThen run \`vibe\` in your project, \`vibe help\`, or \`vibe attach\` while the desktop app is running.\n\nThe CLI and desktop use the same VIBE_HOME stores (default ~/.vibe). Attach when operating a session that is already live in the desktop app. No runtime dependency is installed by this archive.\n\nTerminal controls: Ctrl+P commands; Alt+Enter multiline; Tab file/command completion; /theme; /model; /auth; /help.\n\nBrowser tools use the real Electron host through vibe attach. Native desktop window/updater features stay in the desktop app. Do not copy your profiles, credentials, hosts or session data into this package.\n`))
  const license = path.join(root, "..", "LICENSE")
  if (fs.existsSync(license)) files.set("LICENSE", fs.readFileSync(license))
  const entries = [...files].map(([name, content]) => tarEntry("package/" + name, content, name === "cli/vibe.js" ? 0o755 : 0o644))
  const archive = zlib.gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)]), { level: 9 })
  const file = output || path.join(root, "release", `VibeCoder-CLI-${pkg.version}.tgz`)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, archive, { flag: "wx" })
  return { file, version: pkg.version, files: files.size, bytes: archive.length, sha256: crypto.createHash("sha256").update(archive).digest("hex") }
}

if (require.main === module) {
  try { console.log(JSON.stringify(buildArchive({ output: process.argv[2] }), null, 2)) }
  catch (error) { console.error(error.message); process.exitCode = 1 }
}
module.exports = { buildArchive, tarEntry }
