test("bash tool points TMP/TEMP into .vibe-scratch when it exists", async () => {
  const { byName } = require("../core/tools")
  const bash = byName("bash")
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-scratch-test-"))
  try {
    fs.mkdirSync(path.join(d, ".vibe-scratch"))
    const out = await bash.run({ command: process.platform === "win32" ? "echo $env:TEMP" : "printf %s \"$TMPDIR\"" }, { cwd: d })
    assert.ok(out.includes(".vibe-scratch"), "TEMP should point into .vibe-scratch, got: " + out)
    const out2 = await bash.run({ command: "echo hello-scratch" }, { cwd: d })
    assert.ok(out2.includes("hello-scratch"))
  } finally {
    fs.rmSync(d, { recursive: true, force: true })
  }
})

// ---------- runner ----------