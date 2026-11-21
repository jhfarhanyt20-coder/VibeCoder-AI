# Safe refactor

Use this to clean up or restructure code without changing what it does.

1. **Lock the behaviour first.** Run the existing tests. If the code you will touch has no test, add a small test that pins its current behaviour before you change it.
2. **Change in small steps:** rename, extract a function, remove duplication, split a big file. After each step run the tests; never stack many untested steps.
3. **Keep every public name and file path that other code or users rely on.** If something must move, leave a compatible export or alias.
4. **Do not mix in fixes or new features.** If you find a bug, note it and report it separately.
5. **Finish:** all tests green, the app still starts, and a short summary of what moved where and why it is better.
