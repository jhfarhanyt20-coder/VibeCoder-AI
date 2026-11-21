# Project explainer

Use this when someone opens a project for the first time or asks "how does this work?".

1. **Get the shape quickly.** List the top folders and the main config files (`package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`, `*.csproj`, `Dockerfile`). If the `project_overview` plugin tool is installed, use it first.
2. **Find the entry points:** where the program starts, the main routes or screens, the background jobs.
3. **Follow one real flow end to end** (for example: a button click → the request → the handler → the database → the answer). Name the files on the way.
4. **Explain in plain words,** short and in the user's language:
   - What the project does (2-3 sentences).
   - The main parts and what each one is responsible for (a small list or table with file paths).
   - How to run it, test it and build it (the exact commands).
   - Anything surprising or risky you noticed (missing tests, secrets in files, very large files).
5. Do not change any file while explaining.
