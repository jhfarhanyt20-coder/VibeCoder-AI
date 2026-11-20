"use strict"
// VibeCoder free models: the daily-limit error says when the quota comes back,
// in the user's own clock time, and it still counts as a rate limit (fallback moves on).
const assert = require("node:assert/strict")
const { ApiError } = require("../core/llm/http")
const body = JSON.stringify({ error: { message: "Daily free limit reached (100 requests). It resets at 00:00 UTC.", type: "rate_limit_error", code: "daily_limit" } })
const e = new ApiError(429, body)
assert.equal(e.code, "FREE_DAILY_LIMIT")
assert.equal(e.status, 429, "still a rate limit, so the Fallback model fails over")
assert.match(e.message, /Today's free VibeCoder requests are used up \(100 per day\)/)
assert.match(e.message, /your time \(00:00 UTC\), in \d+h \d+m|in \d+m/)
assert.match(e.message, /Fallback model/)
// Other 429s keep their own text.
assert.match(new ApiError(429, '{"error":{"message":"slow down"}}').message, /^HTTP 429: /)
console.log("PASS free daily limit: clear local reset time, still a rate limit")
