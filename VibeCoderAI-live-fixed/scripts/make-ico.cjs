// Build build/icon.ico (multi-size PNG-in-ICO) from build/icon-*.png. Run: node scripts/make-ico.cjs
const fs = require("fs")
const sizes = [16, 32, 48, 256]
const bufs = sizes.map((s) => fs.readFileSync(__dirname + "/../build/icon-" + s + ".png"))
const hdr = Buffer.alloc(6)
hdr.writeUInt16LE(0, 0) // reserved
hdr.writeUInt16LE(1, 2) // type: icon
hdr.writeUInt16LE(sizes.length, 4) // count
let off = 6 + 16 * sizes.length
const ents = sizes.map((s, i) => {
  const e = Buffer.alloc(16)
  e.writeUInt8(s % 256, 0)
  e.writeUInt8(s % 256, 1)
  e.writeUInt16LE(1, 4) // planes
  e.writeUInt16LE(32, 6) // bpp
  e.writeUInt32LE(bufs[i].length, 8)
  e.writeUInt32LE(off, 12)
  off += bufs[i].length
  return e
})
const ico = Buffer.concat([hdr, ...ents, ...bufs])
fs.writeFileSync(__dirname + "/../build/icon.ico", ico)
const ok = ico.readUInt16LE(2) === 1 && ico.slice(6 + 64, 6 + 68).toString("hex") === "89504e47"
console.log("icon.ico bytes:", ico.length, "valid:", ok)
