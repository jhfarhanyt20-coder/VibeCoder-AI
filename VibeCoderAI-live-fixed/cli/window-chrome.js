"use strict"
/**
 * BDCoder's own title bar for the console window (Windows only), like the
 * desktop app: the native caption (the blue Windows bar) is hidden and the
 * CLI's first row becomes the title bar, with minimize / maximize / close
 * buttons, drag to move and double-click to maximize. The window also gets
 * the BDCoder icon and a dark frame.
 *
 * A small helper (PowerShell, no new dependencies) shares this console and
 * stays alive while the CLI runs, so button clicks are instant. When the CLI
 * exits - normally, by error or killed - the helper sees its input close and
 * puts the window back exactly as it was (caption, icon, light frame),
 * because the console window belongs to the user's shell.
 *
 * Off in Windows Terminal (it owns its window), for pipes, and with
 * VIBE_WINDOW_CHROME=0.
 */
const { spawn } = require("node:child_process")
const fs = require("node:fs")
const path = require("node:path")

const ICON_CANDIDATES = [path.join(__dirname, "..", "build", "icon.ico"), path.join(__dirname, "assets", "vibecoder.ico")]
// #1b1d23 (theme surface) as a Windows COLORREF (0x00BBGGRR), used on Windows 11.
const CAPTION = 0x00231d1b

function script(icon) {
  const iconPath = icon ? icon.replace(/'/g, "''") : ""
  return `
$ErrorActionPreference = 'SilentlyContinue'
$sig = @'
[DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();
[DllImport("dwmapi.dll")] public static extern int DwmSetWindowAttribute(IntPtr h, int a, ref int v, int s);
[DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr h, int m, IntPtr w, IntPtr l);
[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr LoadImage(IntPtr i, string n, int t, int cx, int cy, int f);
[DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int cx, int cy, int f);
[DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int i);
[DllImport("user32.dll")] public static extern int SetWindowLong(IntPtr h, int i, int v);
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
[DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr h);
[DllImport("user32.dll")] public static extern bool ReleaseCapture();
'@
$w = Add-Type -MemberDefinition $sig -Name ConsoleChrome -Namespace BDCoder -PassThru
$h = $w::GetConsoleWindow()
if ($h -eq [IntPtr]::Zero) { 'none'; exit }
$big = $w::SendMessage($h, 0x7F, [IntPtr]1, [IntPtr]::Zero)
$small = $w::SendMessage($h, 0x7F, [IntPtr]0, [IntPtr]::Zero)
$style = $w::GetWindowLong($h, -16)
$on = 1
[void]$w::DwmSetWindowAttribute($h, 20, [ref]$on, 4)
[void]$w::DwmSetWindowAttribute($h, 19, [ref]$on, 4)
$cap = ${CAPTION}
[void]$w::DwmSetWindowAttribute($h, 35, [ref]$cap, 4)
${iconPath ? `$i1 = $w::LoadImage([IntPtr]::Zero, '${iconPath}', 1, 32, 32, 0x10)
$i0 = $w::LoadImage([IntPtr]::Zero, '${iconPath}', 1, 16, 16, 0x10)
if ($i1 -ne [IntPtr]::Zero) { [void]$w::SendMessage($h, 0x80, [IntPtr]1, $i1) }
if ($i0 -ne [IntPtr]::Zero) { [void]$w::SendMessage($h, 0x80, [IntPtr]0, $i0) }` : ""}
# Hide the native caption (keep the resize frame): the CLI draws its own title bar.
[void]$w::SetWindowLong($h, -16, ($style -band (-bnot 0x00C00000)))
[void]$w::SetWindowPos($h, [IntPtr]::Zero, 0, 0, 0, 0, 0x27)
'ready'
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($line -eq $null -or $line -eq 'restore') { break }
  if ($line -eq 'min') { [void]$w::ShowWindow($h, 6) }
  elseif ($line -eq 'max') { if ($w::IsZoomed($h)) { [void]$w::ShowWindow($h, 9) } else { [void]$w::ShowWindow($h, 3) } }
  elseif ($line -eq 'drag') { [void]$w::ReleaseCapture(); [void]$w::SendMessage($h, 0x112, [IntPtr]0xF012, [IntPtr]::Zero) }
}
# Put the window back as it was.
[void]$w::SetWindowLong($h, -16, $style)
$off = 0
[void]$w::DwmSetWindowAttribute($h, 20, [ref]$off, 4)
[void]$w::DwmSetWindowAttribute($h, 19, [ref]$off, 4)
$def = -1
[void]$w::DwmSetWindowAttribute($h, 35, [ref]$def, 4)
[void]$w::SendMessage($h, 0x80, [IntPtr]1, $big)
[void]$w::SendMessage($h, 0x80, [IntPtr]0, $small)
[void]$w::SetWindowPos($h, [IntPtr]::Zero, 0, 0, 0, 0, 0x27)
`
}

const supported = (output) =>
  process.platform === "win32" && !!output && !!output.isTTY && !process.env.WT_SESSION && process.env.VIBE_WINDOW_CHROME !== "0"

/**
 * Dress the console window. Returns restore() with .send(action) for the title
 * bar buttons ("min", "max", "drag"); onReady() runs once the own title bar is
 * active (the native caption is hidden) - the caller then shows its buttons.
 */
function applyWindowChrome({ output = process.stdout, run = spawn, onReady = () => {} } = {}) {
  const noop = () => {}
  noop.send = () => false
  noop.active = () => false
  if (!supported(output)) return noop
  const icon = ICON_CANDIDATES.find((p) => { try { return fs.statSync(p).isFile() } catch { return false } }) || ""
  let child = null
  let ready = false
  let done = false
  try {
    // Shares this console (not hidden: hiding would hide this console too).
    child = run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script(icon)], { stdio: ["pipe", "pipe", "ignore"], windowsHide: false })
    let text = ""
    child.stdout?.on("data", (d) => {
      text += d
      if (!ready && /\bready\b/.test(text)) { ready = true; try { onReady() } catch {} }
    })
    child.on?.("error", () => { done = true })
    child.on?.("close", () => { done = true; ready = false })
    child.stdin?.on?.("error", () => {})
    // Never keep the CLI alive just for this helper.
    child.unref?.(); child.stdin?.unref?.(); child.stdout?.unref?.()
  } catch { child = null }
  const send = (action) => {
    if (!child || done || !ready || !/^(min|max|drag)$/.test(String(action))) return false
    try { child.stdin.write(action + "\n"); return true } catch { return false }
  }
  function restore() {
    if (done || !child) return
    done = true
    try { child.stdin.write("restore\n"); child.stdin.end() } catch {}
  }
  restore.send = send
  restore.active = () => ready && !done
  return restore
}

module.exports = { applyWindowChrome, _script: script, supported }
