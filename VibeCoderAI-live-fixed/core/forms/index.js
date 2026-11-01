"use strict"
/**
 * V-10: the `question` tool's form model.
 *
 * The tool is the agent's way to pause and ask the user a real question. The
 * desktop renderer already knows how to draw a "session form", so this module
 * is the single place that turns the model's questions into that payload and
 * turns the user's answer back into an ordered list of answers.
 *
 * Shapes:
 *   questions: [{ header, question, multiple, options: [{ label, description }] }]
 *   form:      { id, sessionID, title, fields: [...], questions }
 *   answers:   [[...], [...]]  one string array per question (empty = skipped)
 */
const MAX_QUESTIONS = 8
const MAX_OPTIONS = 50
const MAX_TEXT = 800

const text = (value, max = MAX_TEXT) => {
  const s = String(value ?? "").replace(/\s+/g, " ").trim()
  return s.length > max ? s.slice(0, max - 1) + "…" : s
}

/** Validate + normalize the model's `questions` argument. Throws on bad input. */
function normalizeQuestions(input) {
  if (!Array.isArray(input) || !input.length) throw new Error("question needs at least one question")
  if (input.length > MAX_QUESTIONS) throw new Error(`question supports at most ${MAX_QUESTIONS} questions per call`)
  return input.map((raw, i) => {
    const source = raw && typeof raw === "object" ? raw : { question: raw }
    const question = text(source.question ?? source.text ?? "")
    if (!question) throw new Error(`Question ${i + 1} has no text`)
    const header = text(source.header ?? "", 80) || `Question ${i + 1}`
    const options = (Array.isArray(source.options) ? source.options : [])
      .map((option) => {
        const value = option && typeof option === "object" ? option : { label: option }
        const label = text(value.label ?? value.value ?? "", 160)
        if (!label) return null
        const description = text(value.description ?? "", 240)
        return { label, ...(description ? { description } : {}) }
      })
      .filter(Boolean)
      .slice(0, MAX_OPTIONS)
    const multiple = source.multiple === true || source.type === "multiselect" || source.type === "multi"
    return { header, question, multiple, options }
  })
}

/** Renderer-facing form. `fields` is what the interactive card draws. */
function formPayload(sessionID, id, questions) {
  const fields = questions.map((q, i) => ({
    key: `q${i}`,
    title: q.header,
    description: q.question,
    type: q.multiple ? "multiselect" : "string",
    options: q.options.map((o) => ({ label: o.label, value: o.label, ...(o.description ? { description: o.description } : {}) })),
    // Always offer "type your own answer", like the question tool in OpenCode.
    custom: true,
  }))
  return {
    id,
    sessionID,
    title: questions.length === 1 ? questions[0].header : `Questions (${questions.length})`,
    fields,
    questions,
  }
}

/**
 * Accept the renderer's `{ q0: "..." }` object, an ordered array, or an object
 * keyed by header, and produce `answers[i] = [string, ...]`.
 */
function answerValues(questions, answer) {
  const pick = (question, i) => {
    if (Array.isArray(answer)) return answer[i]
    if (!answer || typeof answer !== "object") return undefined
    for (const key of [`q${i}`, question.header, question.question, String(i)]) {
      if (Object.prototype.hasOwnProperty.call(answer, key)) return answer[key]
    }
    return undefined
  }
  return questions.map((question, i) => {
    const raw = pick(question, i)
    const list = Array.isArray(raw) ? raw : raw === undefined || raw === null || raw === "" ? [] : [raw]
    const values = list.map((v) => text(v, 2000)).filter(Boolean)
    // A single-choice field can still receive several values from a custom
    // answer plus a picked option; keep the first for a clean transcript.
    return question.multiple ? values : values.slice(0, 1)
  })
}

/** The tool result text the model reads: compact, ordered, no UI markup. */
function resultText(questions, answers) {
  const lines = []
  questions.forEach((question, i) => {
    const values = (answers[i] || []).join(", ")
    lines.push(`${i + 1}. ${question.header} — ${values || "(no answer)"}`)
  })
  return `The user answered:\n${lines.join("\n")}`
}

module.exports = {
  MAX_QUESTIONS,
  MAX_OPTIONS,
  normalizeQuestions,
  formPayload,
  answerValues,
  resultText,
}
