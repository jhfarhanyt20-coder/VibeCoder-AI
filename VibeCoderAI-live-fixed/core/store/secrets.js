"use strict"
/**
 * At-rest protection for the key store (~/.vibe/auth.json).
 *
 * Windows: DPAPI CurrentUser through the .NET class Windows PowerShell already
 * ships with - zero npm dependencies. The blob is bound to the Windows account,
 * so a copied auth.json is unreadable for anyone else. Other platforms keep the
 * old behaviour (plain value, file mode 0600); encrypt() is a no-op there.
 *
 * POWERSHELL IS EXPENSIVE (~200-500ms per process). Everything here therefore
 * runs in BATCHES: one call for a whole set of keys. Callers warm a cache once
 * so the hot path (getKey on every prompt, hasKey on every profile listed)
 * never spawns a process - a per-key spawn on a 19-profile machine froze the
 * Electron main process for ~10 seconds at startup.
 */
const { execFile } = require("child_process")

const PREFIX = "vibe-dpapi-v1:"
const WIN = process.platform === "win32"

/*
 * The PowerShell scripts are CONSTANTS: they never contain a key, a blob or any
 * other data. Items travel through STDIN (one base64 line per item), so nothing
 * secret appears in the process command line or in PowerShell script-block
 * logging (event 4104 records the -Command text, readable by local users).
 * JSON/ConvertFrom-Json is deliberately NOT used: Windows PowerShell 5.1
 * flattens JSON string arrays - a plain line protocol has no such trap.
 */
const PS_HEAD =
  "$ErrorActionPreference='Stop';Add-Type -AssemblyName System.Security;" +
  "$arr=New-Object System.Collections.Generic.List[string];" +
  "while($null -ne ($l=[Console]::In.ReadLine())){$arr.Add([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($l.Trim())))};"
const UNPROTECT =
  `$out=@();foreach($v in $arr){if($null -eq $v){$out+=,'';continue};try{$b=[Convert]::FromBase64String($v);$out+=,[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Unprotect($b,$null,'CurrentUser'))}catch{$out+=,''}};[string]::Join([char]10,$out)`
const PROTECT =
  `$out=@();foreach($v in $arr){if($null -eq $v){$out+=,'';continue};try{$out+=,[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($v),$null,'CurrentUser'))}catch{$out+=,''}};[string]::Join([char]10,$out)`
const SCRIPTS = Object.freeze({ protect: PS_HEAD + PROTECT, unprotect: PS_HEAD + UNPROTECT })

/** constant script for a mode - carries no data */
function script(mode) {
  return mode === "protect" ? SCRIPTS.protect : SCRIPTS.unprotect
}

/** stdin payload: one base64(UTF-8) line per item, newline-terminated */
function stdinPayload(items) {
  return items.map((x) => Buffer.from(String(x == null ? "" : x), "utf8").toString("base64")).join("\n") + "\n"
}

/** argv handed to powershell.exe (exported for tests: it must never hold data) */
function psArgs(mode) {
  return ["-NoProfile", "-NonInteractive", "-Command", script(mode)]
}

function run(mode, items) {
  return new Promise((resolve) => {
    let child
    try {
      child = execFile(
        "powershell.exe",
        psArgs(mode),
        { windowsHide: true, timeout: 30000, maxBuffer: 8 * 1024 * 1024 },
        (err, stdout) => resolve(err ? null : String(stdout || "")),
      )
    } catch {
      resolve(null)
      return
    }
    if (!child.stdin) return resolve(null)
    child.stdin.on("error", () => {})
    child.stdin.end(stdinPayload(items), "utf8")
  })
}

/**
 * One output line per item ("" = that entry failed).
 * mode "text"    : line is base64 of UTF-8 bytes (unprotect output) -> decode
 * mode "raw-b64" : line IS the stored base64 blob (protect output) -> keep as-is.
 * Decoding a DPAPI blob as UTF-8 used to mangle every freshly encrypted key
 * into replacement characters, which later blew up as a "ByteString > 255"
 * header error at the first request.
 */
function parseLines(out, n, mode = "text") {
  if (out == null) return null
  const lines = out.replace(/\r?\n$/, "").split(/\r?\n/)
  const outArr = []
  for (let i = 0; i < n; i++) {
    if (!lines[i]) {
      outArr.push(null)
      continue
    }
    outArr.push(mode === "raw-b64" ? lines[i].trim() : Buffer.from(lines[i], "base64").toString("utf8"))
  }
  return outArr
}

/** decrypt a whole list of vibe-dpapi blobs in ONE powershell call (null per failed item) */
async function unprotectBatch(blobs) {
  if (!WIN || !blobs.length) return blobs.map(() => null)
  return parseLines(await run("unprotect", blobs.map((b) => String(b).slice(PREFIX.length))), blobs.length)
}

/** encrypt a whole list of plaintexts in ONE powershell call (null per failed item) */
async function protectBatch(plaintexts) {
  if (!WIN || !plaintexts.length) return plaintexts.map(() => null)
  const got = await run("protect", plaintexts)
  const lines = parseLines(got, plaintexts.length, "raw-b64")
  return lines ? lines.map((v) => (v ? PREFIX + v : null)) : null
}

/* in-memory plaintext cache: stored blob -> key (bounded; plaintext never hits disk) */
const cache = new Map()
const cachePut = (blob, plain) => {
  if (cache.size > 200) cache.clear()
  cache.set(blob, plain)
}

const available = () => WIN

/** single-value fast path (cold cache, one key at a time) */
function encrypt(plain) {
  const s = String(plain == null ? "" : plain)
  if (!WIN || !s || s.startsWith(PREFIX)) return s
  const lines = parseLines(runSync("protect", [s]), 1, "raw-b64")
  const v = lines && lines[0]
  if (!v) throw new Error("Could not encrypt the API key (DPAPI failed) - the key was not saved.")
  return PREFIX + v
}

function runSync(mode, items) {
  try {
    const { spawnSync } = require("child_process")
    const r = spawnSync("powershell.exe", psArgs(mode), {
      windowsHide: true,
      timeout: 30000,
      maxBuffer: 8 * 1024 * 1024,
      input: stdinPayload(items),
      stdio: ["pipe", "pipe", "ignore"],
      encoding: "utf8",
    })
    return r.status === 0 ? r.stdout : null
  } catch {
    return null
  }
}

function decrypt(stored) {
  const s = String(stored == null ? "" : stored)
  if (!s.startsWith(PREFIX)) return s // legacy plaintext value
  const hit = cache.get(s)
  if (hit !== undefined) return hit
  const lines = parseLines(runSync("unprotect", [s.slice(PREFIX.length)]), 1)
  if (!lines || !lines[0])
    throw new Error("The saved API key could not be decrypted on this Windows account - re-add it (vibe auth add <profile>).")
  cachePut(s, lines[0])
  return lines[0]
}

/** Decrypt every stored key in ONE call and fill the cache. Call at startup. */
async function warm(blobs) {
  if (!WIN || !blobs.length) return 0
  const lines = await unprotectBatch(blobs)
  if (!lines) return 0
  let n = 0
  blobs.forEach((b, i) => {
    if (lines[i] != null) {
      cachePut(b, lines[i])
      n++
    }
  })
  return n
}

module.exports = { available, encrypt, decrypt, warm, protectBatch, unprotectBatch, PREFIX, _internal: { script, psArgs, stdinPayload } }
