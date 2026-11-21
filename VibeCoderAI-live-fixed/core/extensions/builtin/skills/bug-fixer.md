# Bug fixer

Use this when something is broken: an error message, a crash, a wrong result, a test that fails.

1. **Reproduce first.** Find the smallest way to see the bug (run the failing test, the command, or open the page). Write down the exact error text. If you cannot reproduce it, say so and ask for the missing step instead of guessing.
2. **Find the cause, not the symptom.** Read the code on the path of the error (stack trace, logs, the function that produced the wrong value). State the root cause in one sentence before changing anything.
3. **Fix the smallest thing that removes the cause.** No unrelated refactors, no style changes in the same edit. Keep existing behaviour that is not part of the bug.
4. **Prove it.** Re-run the reproduction: it must now pass. Add or update one test that fails without the fix and passes with it, in the project's existing test framework.
5. **Check nothing else broke.** Run the project's normal test command (see `package.json`, `pyproject.toml`, `Makefile`...). Fix what your change broke.
6. **Report briefly:** what was wrong, why, what you changed (file:line), and how you verified it. Mention anything you could not verify.
