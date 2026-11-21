# Security check

Use this before publishing or when asked "is this safe?". Look, report, and fix only when the user asks.

Check, in this order, and report only real findings (file:line, what, why it matters, how to fix):

1. **Secrets in the code or history:** API keys, tokens, passwords, private keys, `.env` files that are committed. Never print a secret's value in your answer; show only where it is.
2. **Input that reaches dangerous places:** user text going into shell commands, SQL, file paths, `eval`, HTML without escaping.
3. **Access checks:** routes or actions that change data without checking who the user is.
4. **Unsafe defaults:** debug mode on in production, CORS open to everyone, cookies without `HttpOnly`/`Secure`, very old dependencies with known problems (`npm audit`, `pip-audit` when available).
5. **Files and uploads:** size limits, allowed types, paths that could escape the upload folder.

End with a short priority list: what to fix first. If nothing is wrong in a category, say so in one line.
