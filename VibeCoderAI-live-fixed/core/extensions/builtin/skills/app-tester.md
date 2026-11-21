# App tester

Use this to check an app the way a real user would, after building or changing it.

1. **Start it.** Find how the project runs (`npm run dev`, `npm start`, `python app.py`...). Start it in the background and wait until it is ready (a "listening on" line or the port answers).
2. **Open it.** Web app: open the local address in the in-app browser. Desktop app: use Computer Use to look at its window.
3. **Walk the main path like a user.** Click the real buttons, type into the real fields, submit forms, navigate between pages. After every step, look at the result (snapshot or screenshot) before the next step.
4. **Try what users get wrong:** empty fields, very long text, double clicks, going back, reloading the page, a narrow window.
5. **Watch for errors:** the browser console, the server log, error dialogs, broken layout, text that overflows, buttons that do nothing.
6. **Report as a short list:** what works, what breaks (with the exact steps to see it), and a screenshot or the error text for each problem. Fix the problems only when the user asked you to.
7. **Clean up:** stop the servers you started.
