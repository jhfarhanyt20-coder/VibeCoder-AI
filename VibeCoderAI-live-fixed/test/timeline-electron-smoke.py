"""Isolated real-Electron timeline smoke test; run in a background shell only.

Requires the already-installed Python Playwright and project Electron binary.
Example (PowerShell, start through your runner's background option):
  python test/timeline-electron-smoke.py --artifacts .vibe-scratch/timeline-smoke
Only synthetic data is rendered. No prompts or tools are sent to the backend.
Each invocation creates a unique artifact directory and retains its evidence.
--preview-dir explicitly exports closed/open/settings PNGs to that directory.
"""

import argparse
import ctypes
from ctypes import wintypes
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import traceback

from playwright.sync_api import sync_playwright


CATEGORIES = ("shell", "edits", "thinking", "subagents", "notices", "tools", "commentary")
ROOT = Path(__file__).resolve().parents[1]
ORDER = """() => [...document.querySelector('#messages').children].flatMap(
    row => row.matches('.timeline-group') ? [...row.querySelector('.used-list').children] : [row]
).map(row => row.dataset.smokeOrder)"""


def require(condition, message):
    if not condition:
        raise AssertionError(message)


def synthetic_history():
    def tool(identifier, name, inputs, output="Synthetic output", files=None):
        state = {"status": "completed", "input": inputs,
                 "content": [{"type": "text", "text": output}]}
        if files:
            state["metadata"] = {"files": files}
        return {"type": "tool", "id": identifier, "name": name, "state": state}

    def file(path):
        return {"file": path, "patch": "@@ -1 +1 @@\n-const before = 1;\n+const after = 2;",
                "additions": 1, "deletions": 1}

    return [
        {"id": "smoke-user", "type": "user", "content": {"text": "Review the synthetic timeline and its file changes."}},
        {"id": "smoke-assistant", "type": "assistant", "time": {"created": 1000, "completed": 5000},
         "content": [
             {"type": "text", "text": "I will inspect the sample before making a small change."},
             tool("smoke-read-a", "read", {"path": "src/sample.js"}, "1\tconst before = 1;"),
             {"type": "reasoning", "text": "First reasoning: retain chronological activity."},
             tool("smoke-edit", "edit", {"path": "src/sample.js"}, files=[file("src/sample.js")]),
             tool("smoke-shell", "bash", {"command": "synthetic-check --no-execution"}, "Synthetic checks passed; command was not executed."),
             {"type": "text", "text": "The first change is ready; I will inspect the second sample."},
             tool("smoke-read-b", "read", {"path": "src/second.js"}, "1\texport const ready = true;"),
             {"type": "reasoning", "text": "Second reasoning: verify independently expandable file details."},
             tool("smoke-write", "write", {"path": "src/second.js"}, files=[file("src/second.js")]),
             {"type": "text", "text": "Final answer: the synthetic timeline remains ordered and the file changes are ready."},
         ]},
    ]


class OwnedProcessTree:
    """A Windows job owns descendants even if the Electron parent exits early."""

    def __init__(self):
        self.kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        self.kernel.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
        self.kernel.CreateJobObjectW.restype = wintypes.HANDLE
        self.kernel.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
        self.kernel.AssignProcessToJobObject.restype = wintypes.BOOL
        self.kernel.TerminateJobObject.argtypes = [wintypes.HANDLE, wintypes.UINT]
        self.kernel.TerminateJobObject.restype = wintypes.BOOL
        self.kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        self.kernel.CloseHandle.restype = wintypes.BOOL
        self.handle = self.kernel.CreateJobObjectW(None, None)
        if not self.handle:
            raise ctypes.WinError(ctypes.get_last_error())

    def assign(self, process):
        if not self.kernel.AssignProcessToJobObject(self.handle, wintypes.HANDLE(process._handle)):
            raise ctypes.WinError(ctypes.get_last_error())

    def resume(self, process):
        native = ctypes.WinDLL("ntdll")
        native.NtResumeProcess.argtypes = [wintypes.HANDLE]
        native.NtResumeProcess.restype = wintypes.LONG
        status = native.NtResumeProcess(wintypes.HANDLE(process._handle))
        require(status == 0, f"Could not resume owned Electron process: NTSTATUS {status}")

    def close(self):
        if self.handle:
            try:
                if not self.kernel.TerminateJobObject(self.handle, 0):
                    raise ctypes.WinError(ctypes.get_last_error())
            finally:
                self.kernel.CloseHandle(self.handle)
                self.handle = None


def renderer_ready(page):
    page.wait_for_load_state("domcontentloaded")
    page.wait_for_function("""() => typeof renderHistoryMessages === 'function' &&
        typeof toolRow === 'function' && typeof state !== 'undefined' &&
        document.querySelectorAll('[data-timeline-setting]').length === 14 &&
        document.querySelector('#splash')?.hidden === true""", timeout=30000)
    page.wait_for_function("() => !!window.vibe && document.querySelector('#settings').hidden")
    page.evaluate("() => document.fonts.ready")


def render_fixture(page, history):
    page.evaluate("""history => {
        state.activeSessionID = 'isolated-timeline-smoke';
        state.running = false;
        setMainEmpty(false);
        renderHistoryMessages(history, {editable: false, usageRing: false, retryRow: false});
        const rows = [...$('messages').children].flatMap(row => row.matches('.timeline-group')
            ? [...row.querySelector('.used-list').children] : [row]);
        rows.forEach((row, index) => { row.dataset.smokeOrder = String(index); });
    }""", history)


def appearance(page):
    page.evaluate("() => openSettings()")
    page.locator('.settings-nav [data-page="appearance"]').click()
    page.locator("#timeline-preferences").wait_for(state="visible")


def set_preference(page, category, option, value):
    page.locator(f'[data-timeline-setting="{category}.{option}"]').set_checked(value)


def screenshot(page, artifacts, name):
    page.screenshot(path=str(artifacts / f"{name}.png"), full_page=False)


def verify_theme(page, theme):
    require(page.locator("html").get_attribute("data-theme") == theme, "Selected theme not applied")
    require(page.locator("#theme-select").input_value() == theme, "Theme selector drifted")
    style = page.evaluate("""() => {
        const node = document.querySelector('#composer');
        return {background: getComputedStyle(document.body).backgroundColor,
            composer: getComputedStyle(node).backgroundColor,
            obsidian: [...document.styleSheets].some(sheet => sheet.href?.endsWith('/obsidian.css')),
            persisted: localStorage.getItem('vibecoder.theme')};
    }""")
    require(style["obsidian"], "Actual Obsidian stylesheet is not loaded")
    require(style["persisted"] == theme, "Selected theme not saved")
    color = style["background"]
    require(color not in ("rgb(255, 255, 255)", "rgba(0, 0, 0, 0)"), "Dark theme body is light or transparent")
    return style


def default_group_checks(page, artifacts, history):
    render_fixture(page, history)
    groups = page.locator("#messages > .timeline-group")
    require(groups.count() == 1, "Default history must have exactly one unified activity group")
    group = groups.first
    require("collapsed" in group.get_attribute("class"), "Unified activity must collapse by default")
    require(group.locator(":scope > .used-head").get_attribute("aria-expanded") == "false", "Collapsed ARIA state wrong")
    require(group.locator(".used-n").inner_text() == "Used 5", "Header must count tools, not commentary/reasoning")
    labels = group.locator(".used-names").inner_text().split(", ")
    require(labels == ["Read", "Edit", "Shell", "Write"], f"Titles not unique/in chronological order: {labels}")
    require(group.locator(".used-group").count() == 0, "Nested category groups must not exist")
    require(group.locator(".used-head").count() == 1, "Category headers leaked into unified activity")
    require(not group.locator(".used-list").is_visible(), "Collapsed children are visible")
    require(page.locator("#messages > .msg.user").count() == 1, "User message is not outside activity")
    final = page.locator("#messages > .msg.assistant")
    require(final.count() == 1 and final.locator('.bubble').inner_text().startswith("Final answer:"), "Final answer must remain outside activity")
    require(final.evaluate("row => row === row.parentElement.lastElementChild"), "Final answer must be last")
    expected = [str(index) for index in range(11)]
    require(page.evaluate(ORDER) == expected, "Initial chronological row count/order wrong")
    screenshot(page, artifacts, "closed")
    group.locator(":scope > .used-head").click()
    require(group.locator(".used-list").is_visible(), "Opening unified group does not show children")
    shell_style = group.locator('[data-timeline-item="shell"]').evaluate("row => ({background: getComputedStyle(row).backgroundColor, border: getComputedStyle(row).borderTopWidth})")
    require(shell_style == {"background": "rgba(0, 0, 0, 0)", "border": "0px"}, f"Shell row must not be a boxed card: {shell_style}")
    require(group.locator('[data-timeline-item="shell"] .file-row').count() == 0, "Shell must be an inline command row, not a nested file card")
    categories = group.locator(".used-list > [data-timeline-item]").evaluate_all("rows => rows.map(row => row.dataset.timelineItem)")
    require(categories == ["commentary", "tools", "thinking", "edits", "shell", "commentary", "tools", "thinking", "edits"],
            f"Activity is not chronological: {categories}")
    cards = group.locator('[data-timeline-item="edits"] .file-row')
    require(cards.count() == 2, "Synthetic edits must render actual file cards")
    require(cards.filter(has=page.locator(".fr-diff")).count() == 2, "Edit details missing")
    require("open" not in (cards.nth(0).get_attribute("class") or ""), "File details should start collapsed")
    cards.nth(0).locator(".fr-name").click()
    require("open" in cards.nth(0).get_attribute("class"), "First file details did not open")
    require("open" not in cards.nth(1).get_attribute("class"), "Opening first file changed second file")
    require("collapsed" not in group.get_attribute("class"), "Inner file toggle collapsed outer group")
    group.locator(":scope > .used-head").click()
    group.locator(":scope > .used-head").click()
    require("open" in cards.nth(0).get_attribute("class"), "Outer toggle reset independent file details")
    screenshot(page, artifacts, "open")
    cards.nth(0).locator(".fr-name").click()
    require("open" not in cards.nth(0).get_attribute("class"), "File details did not close independently")

    streaming = json.loads(json.dumps(history))
    streaming[1]["content"].pop()
    render_fixture(page, streaming)
    group = page.locator("#messages > .timeline-group")
    group.locator(":scope > .used-head").click()
    page.evaluate("""() => {
        window.__smokeOpenedGroup = document.querySelector('.timeline-group');
        addThought('Synthetic appended reasoning, without a backend run.');
        toolRow({type: 'tool', id: 'smoke-append', name: 'read', state: {
            status: 'completed', input: {path: 'src/appended.js'},
            content: [{type: 'text', text: 'Synthetic appended read'}]}});
    }""")
    require(page.evaluate("() => window.__smokeOpenedGroup === document.querySelector('.timeline-group')"), "Append replaced manually opened group")
    require("collapsed" not in group.get_attribute("class"), "Appending activity collapsed manually opened group")
    require(group.locator(".used-n").inner_text() == "Used 6", "Append tool count is wrong")
    require(group.locator(".used-names").inner_text() == "Read, Edit, Shell, Write", "Append duplicated title")
    require(group.locator(".used-list > :last-child").get_attribute("data-timeline-tool") == "Read", "Append is not chronological")
    render_fixture(page, history)
    return expected


def gutter_matrix(page, history, artifacts, phase):
    render_fixture(page, history)
    page.evaluate("""() => {
        for (let index = 0; index < 26; index++)
            addMsg(index % 2 ? 'assistant' : 'user', `Synthetic scroll fixture ${index}: ` + 'Timeline layout evidence. '.repeat(9));
    }""")
    evidence = []
    for width in (1360, 980):
        page.set_viewport_size({"width": width, "height": 860})
        for hidden in (False, True):
            current = page.evaluate("() => sidebarIsHidden()")
            if current != hidden:
                page.locator("#btn-sidebar-restore" if current else "#btn-sidebar-toggle").click()
            page.wait_for_function("hidden => sidebarIsHidden() === hidden", arg=hidden)
            page.evaluate("""() => new Promise(resolve => {
                const messages = $('messages');
                messages.scrollTop = 0;
                requestAnimationFrame(() => requestAnimationFrame(() => { updateJumpButton(); resolve(); }));
            })""")
            page.locator("#jump-live").wait_for(state="visible")
            box = page.evaluate("""() => {
                const rect = selector => {
                    const b = document.querySelector(selector).getBoundingClientRect();
                    return {left: b.left, top: b.top, right: b.right, bottom: b.bottom, width: b.width, height: b.height};
                };
                return {composer: rect('#composer'), jump: rect('#jump-live'), main: rect('#main'),
                    viewport: innerWidth, splashHidden: $('splash').hidden,
                    overflow: document.documentElement.scrollWidth > innerWidth};
            }""")
            composer, jump = box["composer"], box["jump"]
            require(box["splashHidden"], "Gutter inspected before actual splash hidden")
            require(jump["left"] >= composer["right"] + 1, f"Jump button overlaps composer at {phase}/{width}/{hidden}: {box}")
            require(jump["right"] <= box["viewport"] + 1, f"Jump button is clipped at {phase}/{width}/{hidden}: {box}")
            require(jump["top"] >= 0 and jump["bottom"] <= 861, "Jump button is outside viewport")
            require(abs((jump["top"] + jump["height"] / 2) - (composer["top"] + composer["height"] / 2)) <= 3,
                    "Jump button not vertically centered beside composer")
            require(not box["overflow"], "Viewport has horizontal overflow")
            box.update({"phase": phase, "width": width, "sidebarHidden": hidden})
            evidence.append(box)
            screenshot(page, artifacts, f"gutter-{phase}-{width}-{'closed' if hidden else 'open'}")
            page.locator("#jump-live").click()
            page.wait_for_function("() => nearBottom() && $('jump-live').hidden")
    page.set_viewport_size({"width": 1360, "height": 860})
    if page.evaluate("() => sidebarIsHidden()"):
        page.locator("#btn-sidebar-restore").click()
    render_fixture(page, history)
    return evidence


def queue_check(page, workspace):
    return page.evaluate("""async path => {
        const original = vibe.queuePrompt;
        const calls = [];
        const stub = async payload => { calls.push(payload); return {ok: true}; };
        let writable = false;
        try { writable = Reflect.set(vibe, 'queuePrompt', stub) && vibe.queuePrompt === stub; } catch {}
        if (!writable) return {status: 'skipped', reason: 'Secure contextBridge API is immutable; parent must cover attachment-only queue.'};
        const previous = {running: state.running, sid: state.activeSessionID, text: $('input').value};
        const previousAttachments = [...attachments];
        const previousQueue = [...queuedPrompts];
        try {
            state.running = true;
            state.activeSessionID = 'isolated-timeline-smoke';
            $('input').value = '';
            attachments.splice(0, attachments.length, {kind: 'file', path, name: 'queued-synthetic.txt', mime: 'text/plain'});
            await queuePrompt();
            const pending = document.querySelector('.pending-prompt');
            if (calls.length !== 1 || calls[0].text !== '' || calls[0].files.length !== 1 ||
                calls[0].files[0].path !== path || attachments.length !== 0 ||
                !pending?.textContent.includes('queued-synthetic.txt'))
                throw new Error('Attachment-only queue did not preserve file payload and pending bubble');
            return {status: 'passed', calls: calls.length, pending: pending.textContent};
        } finally {
            Reflect.set(vibe, 'queuePrompt', original);
            state.running = previous.running;
            state.activeSessionID = previous.sid;
            $('input').value = previous.text;
            attachments.splice(0, attachments.length, ...previousAttachments);
            queuedPrompts.splice(0, queuedPrompts.length, ...previousQueue);
            renderAttachments(); renderQueueStrip(); saveComposerDraft();
        }
    }""", str(workspace / "queued-synthetic.txt"))


def run_checks(page, artifacts, theme):
    history = synthetic_history()
    appearance(page)
    page.locator("#theme-select").select_option(theme)
    styles = verify_theme(page, theme)
    for category in CATEGORIES:
        for option in ("group", "collapse"):
            require(page.locator(f'[data-timeline-setting="{category}.{option}"]').is_checked(), "Fresh isolated preferences must all default on")
    page.locator(".timeline-settings").scroll_into_view_if_needed()
    screenshot(page, artifacts, "settings")
    page.locator("#btn-back").click()
    expected = default_group_checks(page, artifacts, history)
    gutters = gutter_matrix(page, history, artifacts, "initial")
    attachment = queue_check(page, artifacts / "workspace")
    appearance(page)
    set_preference(page, "thinking", "group", False)
    set_preference(page, "shell", "collapse", False)
    require(page.evaluate(ORDER) == expected, "Changing preferences reordered history")
    require(page.locator('#messages > [data-timeline-item="thinking"]').count() == 2, "Group-off reasoning was not unwrapped")
    require(page.locator('[data-timeline-item="shell"]').evaluate("row => row.classList.contains('open')"), "Collapse-off shell did not open")
    require(page.locator('.timeline-group:not(.collapsed) [data-timeline-item="shell"]').count() == 1, "Collapse-off category must expand containing group")
    page.locator("#btn-back").click()
    page.reload(wait_until="domcontentloaded")
    renderer_ready(page)
    verify_theme(page, theme)
    render_fixture(page, history)
    appearance(page)
    require(not page.locator('[data-timeline-setting="thinking.group"]').is_checked(), "Group-off preference did not survive reload")
    require(not page.locator('[data-timeline-setting="shell.collapse"]').is_checked(), "Collapse-off preference did not survive reload")
    require(page.locator('#messages > [data-timeline-item="thinking"]').count() == 2, "Reload regrouped disabled reasoning")
    require(page.locator('[data-timeline-item="shell"]').evaluate("row => row.classList.contains('open')"), "Reload lost collapse-off behavior")
    require(page.evaluate(ORDER) == expected, "Reload changed chronology")
    page.locator("#btn-back").click()
    gutters.extend(gutter_matrix(page, history, artifacts, "reload"))
    appearance(page)
    for category in CATEGORIES:
        for option in ("group", "collapse"):
            set_preference(page, category, option, False)
    require(page.locator("#messages .used-group").count() == 0, "All-off preferences still render activity groups")
    require(page.evaluate(ORDER) == expected, "All-off preferences changed history order")
    require(page.locator("#messages > [data-timeline-item]").count() == 9, "All-off activity rows not unwrapped")
    page.locator("#btn-back").click()
    screenshot(page, artifacts, "all-off")
    return {"theme": theme, "styles": styles, "gutters": gutters, "attachmentQueue": attachment,
            "checks": ["unified-default", "tools-only-count", "unique-labels", "chronology", "final-outside",
                       "manual-open-append", "independent-file-details", "group-off-reload", "collapse-off-reload", "all-off-order"]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--artifacts", type=Path, default=Path(".vibe-scratch/timeline-smoke"),
                        help="Artifact parent; must be inside the invocation directory's .vibe-scratch")
    parser.add_argument("--preview-dir", type=Path, help="Explicit optional export destination for closed/open/settings PNGs")
    parser.add_argument("--theme", choices=("dark", "obsidian"), default="obsidian")
    args = parser.parse_args()
    require(sys.platform == "win32", "This canonical smoke launcher requires Windows Electron")
    scratch = (Path.cwd() / ".vibe-scratch").resolve()
    artifact_parent = args.artifacts.resolve()
    require(artifact_parent == scratch or scratch in artifact_parent.parents, "--artifacts must be inside the working .vibe-scratch")
    electron = ROOT / "node_modules/electron/dist/electron.exe"
    require(electron.is_file(), f"Installed Electron not found: {electron}")
    preview = args.preview_dir.resolve() if args.preview_dir else None
    if preview:
        for name in ("closed", "open", "settings"):
            require(not (preview / f"{name}.png").exists(), f"Refusing to overwrite existing preview: {name}.png")
    artifact_parent.mkdir(parents=True, exist_ok=True)
    artifacts = Path(tempfile.mkdtemp(prefix="run-", dir=artifact_parent))
    for name in ("home", "user-data", "workspace", "tmp"):
        (artifacts / name).mkdir()
    (artifacts / "workspace/queued-synthetic.txt").write_text("Synthetic attachment only.\n", encoding="utf-8")
    for key in ("TEMP", "TMP", "TMPDIR"):
        os.environ[key] = str(artifacts / "tmp")
    tempfile.tempdir = str(artifacts / "tmp")
    env = os.environ.copy()
    env.pop("ELECTRON_RUN_AS_NODE", None)
    env.update({"VIBE_HOME": str(artifacts / "home"), "VIBE_SERVE": "0", "VIBE_DEV": "0",
                "TEMP": str(artifacts / "tmp"), "TMP": str(artifacts / "tmp"), "TMPDIR": str(artifacts / "tmp")})
    command = [str(electron), str(ROOT), f"--user-data-dir={artifacts / 'user-data'}",
               "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0", "--no-first-run"]
    result = {"status": "failed", "artifacts": str(artifacts), "pageerrors": [], "consoleErrors": []}
    process = None
    owner = None
    page = None
    exit_code = 1
    try:
        owner = OwnedProcessTree()
        with (artifacts / "electron.log").open("w", encoding="utf-8") as log:
            process = subprocess.Popen(command, cwd=artifacts / "workspace", env=env,
                                       stdout=log, stderr=subprocess.STDOUT,
                                       creationflags=subprocess.CREATE_NEW_PROCESS_GROUP | 0x00000004)
            owner.assign(process)
            owner.resume(process)
            active_port = artifacts / "user-data/DevToolsActivePort"
            deadline = time.monotonic() + 35
            endpoint = None
            while time.monotonic() < deadline:
                require(process.poll() is None, f"Electron exited before CDP connection: {process.returncode}")
                if active_port.is_file():
                    lines = active_port.read_text(encoding="utf-8").splitlines()
                    if len(lines) >= 2 and lines[0].isdigit() and lines[1].startswith("/devtools/browser/"):
                        endpoint = f"ws://127.0.0.1:{int(lines[0])}{lines[1]}"
                        break
                time.sleep(0.1)
            require(endpoint, "Electron CDP endpoint did not become available; see electron.log")
            with sync_playwright() as playwright:
                browser = playwright.chromium.connect_over_cdp(endpoint, timeout=20000)
                deadline = time.monotonic() + 20
                while time.monotonic() < deadline:
                    pages = [candidate for context in browser.contexts for candidate in context.pages
                             if candidate.url.startswith((ROOT / "renderer/index.html").as_uri())]
                    if pages:
                        page = pages[0]
                        break
                    time.sleep(0.1)
                require(page, "Canonical renderer page not found over CDP")
                page.on("pageerror", lambda error: result["pageerrors"].append(str(error)))
                page.on("console", lambda message: result["consoleErrors"].append(message.text) if message.type == "error" else None)
                page.set_default_timeout(15000)
                page.set_viewport_size({"width": 1360, "height": 860})
                try:
                    page.reload(wait_until="domcontentloaded")
                    renderer_ready(page)
                    result.update(run_checks(page, artifacts, args.theme))
                    require(not result["pageerrors"], f"Renderer page errors: {result['pageerrors']}")
                    if preview:
                        preview.mkdir(parents=True, exist_ok=True)
                        for name in ("closed", "open", "settings"):
                            with (artifacts / f"{name}.png").open("rb") as source, (preview / f"{name}.png").open("xb") as target:
                                shutil.copyfileobj(source, target)
                        result["previews"] = str(preview)
                    result["status"] = "passed"
                    exit_code = 0
                except Exception:
                    try:
                        screenshot(page, artifacts, "failure")
                        (artifacts / "failure.html").write_text(page.content(), encoding="utf-8")
                    except Exception:
                        result["captureError"] = traceback.format_exc()
                    raise
    except Exception:
        result["error"] = traceback.format_exc()
    finally:
        try:
            if owner:
                owner.close()
        except Exception:
            result["cleanupError"] = traceback.format_exc()
            result["status"] = "failed"
            exit_code = 1
        if process:
            try:
                if process.poll() is None:
                    stopped = subprocess.run(["taskkill.exe", "/PID", str(process.pid), "/T", "/F"],
                                             capture_output=True, text=True, timeout=15)
                    result["fallbackTermination"] = {"exitCode": stopped.returncode, "stdout": stopped.stdout, "stderr": stopped.stderr}
                    require(stopped.returncode == 0 or process.poll() is not None, "Owned process-tree fallback termination failed")
                process.wait(timeout=15)
            except Exception:
                result["cleanupError"] = traceback.format_exc()
                result["status"] = "failed"
                exit_code = 1
        (artifacts / "result.json").write_text(json.dumps(result, indent=2), encoding="utf-8")
        print(json.dumps(result, indent=2), flush=True)
    return exit_code


if __name__ == "__main__":
    sys.exit(main())
