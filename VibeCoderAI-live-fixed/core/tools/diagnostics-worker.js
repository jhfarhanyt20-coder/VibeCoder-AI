"use strict"

// Isolated TypeScript diagnostic worker. The parent launches this only after
// the normal bash/Guardrails decision because requiring a project's local
// compiler executes project-installed code. No project source is executed.
const fs = require("fs")
const path = require("path")

const typescriptPath = process.argv[2]
const target = path.resolve(process.argv[3] || "")

function finish(value) {
  process.stdout.write(JSON.stringify(value))
  process.exit(0)
}

function fail(error) {
  finish({ ok: false, error: String(error?.message || error || "TypeScript diagnostics failed") })
}

try {
  if (!typescriptPath || !target || !fs.existsSync(target)) throw new Error("TypeScript worker needs an existing target file")
  const ts = require(typescriptPath)
  const configPath = ts.findConfigFile(path.dirname(target), ts.sys.fileExists, "tsconfig.json")
  let diagnostics = []
  let source = null

  if (configPath) {
    const read = ts.readConfigFile(configPath, ts.sys.readFile)
    diagnostics.push(...(read.error ? [read.error] : []))
    const parsed = ts.parseJsonConfigFileContent(read.config || {}, ts.sys, path.dirname(configPath), {
      noEmit: true,
      incremental: false,
      composite: false,
      tsBuildInfoFile: undefined,
    }, configPath)
    diagnostics.push(...(parsed.errors || []))
    const names = parsed.fileNames.some((name) => path.resolve(name).toLowerCase() === target.toLowerCase())
      ? parsed.fileNames
      : [...parsed.fileNames, target]
    if (names.length > 10000) throw new Error(`Project has ${names.length} source files; targeted diagnostics are capped at 10000`)
    const program = ts.createProgram({
      rootNames: names,
      options: parsed.options,
      projectReferences: parsed.projectReferences,
    })
    source = program.getSourceFiles().find((item) => path.resolve(item.fileName).toLowerCase() === target.toLowerCase()) || null
    if (source) {
      diagnostics.push(...program.getSyntacticDiagnostics(source))
      diagnostics.push(...program.getSemanticDiagnostics(source))
    } else {
      diagnostics.push({ category: ts.DiagnosticCategory.Error, code: 0, messageText: "The file was not included in the TypeScript program." })
    }
  } else {
    const text = fs.readFileSync(target, "utf8")
    const jsx = /\.[jt]sx$/i.test(target)
    const result = ts.transpileModule(text, {
      fileName: target,
      reportDiagnostics: true,
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
        jsx: jsx ? ts.JsxEmit.ReactJSX : undefined,
        noEmit: true,
      },
    })
    diagnostics.push(...(result.diagnostics || []))
  }

  const rows = diagnostics.slice(0, 50).map((diag) => {
    const file = diag.file?.fileName ? path.resolve(diag.file.fileName) : target
    let line = 0, column = 0
    if (diag.file && Number.isFinite(diag.start)) {
      const pos = diag.file.getLineAndCharacterOfPosition(diag.start)
      line = pos.line + 1
      column = pos.character + 1
    }
    return {
      file,
      line,
      column,
      code: Number(diag.code) || 0,
      category: String(ts.DiagnosticCategory[diag.category] || "error").toLowerCase(),
      message: ts.flattenDiagnosticMessageText(diag.messageText, "\n"),
    }
  })
  finish({ ok: true, provider: `TypeScript ${ts.version || "unknown"}`, config: configPath || null, diagnostics: rows, truncated: diagnostics.length > rows.length })
} catch (error) {
  fail(error)
}
