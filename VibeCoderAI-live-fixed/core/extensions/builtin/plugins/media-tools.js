"use strict"
// VibeCoder built-in plugin: what a video project needs on this computer, and
// a free offline voice-over from the voices installed in Windows (no key, no
// internet). The audio file is written inside the project.
const fs = require("fs")
const os = require("os")
const path = require("path")
const { execFile } = require("child_process")

const run = (cmd, args, opts = {}) => new Promise((resolve) => {
  execFile(cmd, args, { windowsHide: true, timeout: opts.timeout || 20000, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, ...(opts.env || {}) } }, (error, stdout, stderr) => {
    resolve({ ok: !error, code: error && typeof error.code === "number" ? error.code : 0, stdout: String(stdout || ""), stderr: String(stderr || ""), error })
  })
})
const firstLine = (s) => String(s || "").split(/\r?\n/).find((l) => l.trim()) || ""
const PS = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command"]

// Windows voices through System.Speech. Text and paths come in through
// environment variables, never pasted into the script, so quotes are safe.
const VOICES_PS = "Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; foreach ($v in $s.GetInstalledVoices()) { if ($v.Enabled) { $i = $v.VoiceInfo; '{0}|{1}|{2}' -f $i.Name, $i.Culture.Name, $i.Gender } }"
const SPEAK_PS = [
  "$ErrorActionPreference = 'Stop'",
  "Add-Type -AssemblyName System.Speech",
  "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer",
  "if ($env:VC_VOICE) { $s.SelectVoice($env:VC_VOICE) }",
  "$s.Rate = [int]$env:VC_RATE",
  "$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(48000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)",
  "$s.SetOutputToWaveFile($env:VC_OUT, $fmt)",
  "$s.Speak([IO.File]::ReadAllText($env:VC_TEXT, [Text.Encoding]::UTF8))",
  "$s.Dispose()",
].join("; ")

async function windowsVoices() {
  if (process.platform !== "win32") return []
  const r = await run("powershell.exe", [...PS, VOICES_PS])
  return r.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => { const [name, culture, gender] = l.split("|"); return { name, culture, gender } })
}

const outPath = (args, ctx) => path.resolve((ctx && ctx.cwd) || process.cwd(), String((args && args.out) || "voice.wav"))

module.exports = {
  tools: [
    {
      name: "media_check",
      description: "Check this computer for video work: FFmpeg, ffprobe, Node.js/npm (for Remotion animation videos), Python, and the offline voices installed in Windows (language and gender). Read-only. Run it before making a video.",
      parameters: { type: "object", properties: {} },
      perm: () => ({ tool: "read", subject: "media tools" }),
      run: async () => {
        const isWin = process.platform === "win32"
        const probe = async (label, cmd, args) => {
          const r = isWin && (cmd === "npm" || cmd === "npx") ? await run("cmd.exe", ["/d", "/s", "/c", cmd, ...args]) : await run(cmd, args)
          return `${label}: ${r.ok ? firstLine(r.stdout || r.stderr).slice(0, 90) : "not found"}`
        }
        const lines = await Promise.all([
          probe("FFmpeg", "ffmpeg", ["-hide_banner", "-version"]),
          probe("ffprobe", "ffprobe", ["-hide_banner", "-version"]),
          probe("Node.js", "node", ["--version"]),
          probe("npm", "npm", ["--version"]),
          probe("Python", isWin ? "python" : "python3", ["--version"]),
        ])
        const voices = await windowsVoices()
        const tips = []
        if (/FFmpeg: not found/.test(lines[0])) tips.push("Install FFmpeg (free): winget install --id Gyan.FFmpeg -e  — then restart VibeCoder.")
        if (/Node\.js: not found/.test(lines[2])) tips.push("Install Node.js LTS (free) for Remotion animation videos: winget install OpenJS.NodeJS.LTS")
        return [
          ...lines,
          `Offline Windows voices: ${voices.length ? voices.map((v) => `${v.name} (${v.culture}, ${v.gender})`).join("; ") : isWin ? "none installed" : "only on Windows"}`,
          ...(tips.length ? ["", "Missing:", ...tips.map((t) => "  " + t)] : []),
        ].join("\n")
      },
    },
    {
      name: "voice_over",
      description: "Make a voice-over audio file (WAV, 48 kHz) from text with a voice installed in Windows. Free and offline, no API key. `voice` is a name from media_check (default: the system voice); `rate` -10 (slow) .. 10 (fast); `out` is the file to write inside the project (default voice.wav). Use one call per scene to time scenes exactly. Windows only.",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string", description: "What to say" },
          voice: { type: "string", description: "Installed voice name, e.g. Microsoft Zira Desktop" },
          rate: { type: "number", description: "-10..10, default 0" },
          out: { type: "string", description: "Output .wav path inside the project, e.g. audio/scene1.wav" },
        },
        required: ["text"],
      },
      perm: (args, ctx) => ({ tool: "write", subject: outPath(args, ctx) }),
      paths: (args, ctx) => [outPath(args, ctx)],
      run: async (args = {}, ctx = {}) => {
        if (process.platform !== "win32") throw new Error("voice_over uses the voices built into Windows; it is not available on this system.")
        const text = String(args.text || "").trim()
        if (!text) throw new Error("Give the text to speak.")
        if (text.length > 20000) throw new Error("The text is too long for one file (20,000 characters at most); split it into scenes.")
        const out = outPath(args, ctx)
        if (!/\.wav$/i.test(out)) throw new Error('"out" must end with .wav (convert to MP3/AAC with FFmpeg afterwards if needed).')
        const voices = await windowsVoices()
        if (args.voice && !voices.some((v) => v.name.toLowerCase() === String(args.voice).toLowerCase())) {
          throw new Error(`No installed voice named "${args.voice}". Installed: ${voices.map((v) => v.name).join(", ") || "none"}.`)
        }
        fs.mkdirSync(path.dirname(out), { recursive: true })
        const tmp = path.join(os.tmpdir(), `vibe-voice-${process.pid}-${Date.now()}.txt`)
        fs.writeFileSync(tmp, text, "utf8")
        try {
          const rate = Math.max(-10, Math.min(10, Math.round(Number(args.rate) || 0)))
          const voice = args.voice ? voices.find((v) => v.name.toLowerCase() === String(args.voice).toLowerCase()).name : ""
          const r = await run("powershell.exe", [...PS, SPEAK_PS], { timeout: 180000, env: { VC_TEXT: tmp, VC_OUT: out, VC_RATE: String(rate), VC_VOICE: voice } })
          if (!r.ok || !fs.existsSync(out)) throw new Error(`Windows could not make the voice-over: ${firstLine(r.stderr) || "unknown error"}`)
        } finally {
          try { fs.unlinkSync(tmp) } catch {}
        }
        const bytes = fs.statSync(out).size
        const seconds = Math.max(0, (bytes - 44) / (48000 * 2))
        return `Voice-over saved: ${path.relative((ctx && ctx.cwd) || process.cwd(), out).split(path.sep).join("/")} (${seconds.toFixed(1)} s, 48 kHz WAV${args.voice ? `, ${args.voice}` : ""}).`
      },
    },
  ],
}
