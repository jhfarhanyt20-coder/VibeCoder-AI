# VibeCoder Computer Use helper (Windows).
# Long-running: reads one JSON request per line on stdin and writes one JSON
# reply per line on stdout. Uses only what ships with Windows (PowerShell 5.1,
# .NET Framework, Win32, UI Automation). Started by core/computer/index.js.
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)

$refs = 'System.Drawing', 'System.Windows.Forms', 'UIAutomationClient', 'UIAutomationTypes', 'WindowsBase', 'System.Web.Extensions' |
  ForEach-Object { [Reflection.Assembly]::LoadWithPartialName($_).Location }

$source = @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Automation;

public static class VcComputer {
  // ---------------- Win32 ----------------
  [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)] struct InputUnion { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public InputUnion U; }
  [StructLayout(LayoutKind.Sequential)] struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] struct POINT { public int X, Y; }
  delegate bool EnumProc(IntPtr h, IntPtr l);

  [DllImport("user32.dll")] static extern uint SendInput(uint n, INPUT[] inputs, int size);
  [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int max);
  [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc fn, IntPtr l);
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr h, uint flags);
  [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] static extern int GetSystemMetrics(int i);
  [DllImport("user32.dll")] static extern short VkKeyScan(char c);
  [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int i);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr v);
  [DllImport("user32.dll")] static extern bool RegisterHotKey(IntPtr h, int id, uint mods, uint vk);
  [DllImport("user32.dll")] static extern bool SetWindowDisplayAffinity(IntPtr h, uint affinity);

  // ---------------- output (one writer for replies and events) ----------------
  static readonly object outLock = new object();
  public static void Emit(string line) { lock (outLock) { Console.Out.WriteLine(line); Console.Out.Flush(); } }

  // ---------------- badge + Ctrl+Alt+Esc (used when no desktop app hosts the agent) ----------------
  class Badge : System.Windows.Forms.Form {
    public bool HotkeyOn;
    public Badge() {
      FormBorderStyle = System.Windows.Forms.FormBorderStyle.None; ShowInTaskbar = false; TopMost = true;
      StartPosition = System.Windows.Forms.FormStartPosition.Manual; BackColor = Color.FromArgb(18, 20, 26); Opacity = 0.93;
      var wa = System.Windows.Forms.Screen.PrimaryScreen.WorkingArea;
      Size = new Size(470, 34); Location = new Point(wa.X + (wa.Width - 470) / 2, wa.Y + 6);
      var label = new System.Windows.Forms.Label {
        Dock = System.Windows.Forms.DockStyle.Fill, ForeColor = Color.FromArgb(243, 244, 248), Font = new Font("Segoe UI", 9.5f, FontStyle.Bold),
        TextAlign = ContentAlignment.MiddleCenter, Text = "●  VibeCoder is using your computer  ·  Press Ctrl+Alt+Esc to stop"
      };
      label.Paint += (s, e) => { using (var b = new SolidBrush(Color.FromArgb(255, 79, 123))) e.Graphics.FillEllipse(b, 10, 12, 10, 10); };
      Controls.Add(label);
    }
    protected override bool ShowWithoutActivation { get { return true; } }
    protected override System.Windows.Forms.CreateParams CreateParams {
      get { var cp = base.CreateParams; cp.ExStyle |= 0x8 | 0x80 | 0x20 | 0x80000 | 0x08000000; return cp; } // topmost, tool, click-through, layered, no-activate
    }
    protected override void OnHandleCreated(EventArgs e) { base.OnHandleCreated(e); try { SetWindowDisplayAffinity(Handle, 0x11); } catch { } } // not in screenshots
    protected override void WndProc(ref System.Windows.Forms.Message m) {
      if (m.Msg == 0x0312) Emit("{\"event\":\"kill\"}"); // WM_HOTKEY
      base.WndProc(ref m);
    }
  }
  static Badge badge;
  static Dictionary<string, object> Overlay(Dictionary<string, object> a) {
    if (badge == null) {
      var ready = new ManualResetEvent(false);
      var t = new Thread(() => { badge = new Badge(); var h = badge.Handle; ready.Set(); System.Windows.Forms.Application.Run(); });
      t.IsBackground = true; t.SetApartmentState(ApartmentState.STA); t.Start();
      ready.WaitOne(5000);
    }
    bool show = Bool(a, "show"), hotkey = Bool(a, "hotkey");
    badge.Invoke((Action)(() => {
      if (hotkey && !badge.HotkeyOn) badge.HotkeyOn = RegisterHotKey(badge.Handle, 1, 0x1 | 0x2 | 0x4000, 0x1B); // Ctrl+Alt+Esc, no repeat
      if (show) badge.Show(); else badge.Hide();
    }));
    return new Dictionary<string, object> { { "shown", show }, { "hotkey", badge.HotkeyOn } };
  }

  [StructLayout(LayoutKind.Sequential)] struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
  [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref LASTINPUTINFO li);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int attr, out RECT r, int size);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int attr, out int v, int size);

  const uint INPUT_MOUSE = 0, INPUT_KEYBOARD = 1;
  const uint KEYUP = 0x2, UNICODE = 0x4, EXTENDED = 0x1;
  static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = int.MaxValue, RecursionLimit = 64 };
  static List<AutomationElement> lastElements = new List<AutomationElement>();
  static List<Rectangle> lastRects = new List<Rectangle>();
  static string dpiMode = "unknown";

  public static void Init() {
    try { if (SetProcessDpiAwarenessContext(new IntPtr(-4))) { dpiMode = "per-monitor-v2"; return; } } catch (EntryPointNotFoundException) { }
    try { SetProcessDPIAware(); dpiMode = "system"; } catch { }
  }

  // ---------------- request dispatch ----------------
  public static string Handle(string line) {
    var reply = new Dictionary<string, object>();
    object id = null;
    try {
      var req = Json.Deserialize<Dictionary<string, object>>(line);
      id = req.ContainsKey("id") ? req["id"] : null;
      var a = req.ContainsKey("args") && req["args"] is Dictionary<string, object> ? (Dictionary<string, object>)req["args"] : new Dictionary<string, object>();
      reply["result"] = Run(Str(req, "cmd"), a);
      reply["ok"] = true;
    } catch (Exception e) {
      reply["ok"] = false;
      reply["error"] = e.InnerException != null ? e.InnerException.Message : e.Message;
    }
    reply["id"] = id;
    return Json.Serialize(reply);
  }

  static object Run(string cmd, Dictionary<string, object> a) {
    switch (cmd) {
      case "init": return new Dictionary<string, object> { { "dpi", dpiMode }, { "screen", VirtualScreen() } };
      case "screenshot": return Screenshot(a);
      case "scan": return Scan(Hwnd(a), true);
      case "element": return ElementInfo(Int(a, "id", 0));
      case "point_info": return PointInfo(Int(a, "x", 0), Int(a, "y", 0));
      case "click": Click(Int(a, "x", 0), Int(a, "y", 0), Str(a, "button") ?? "left", Bool(a, "double")); return "ok";
      case "move": SetCursorPos(Int(a, "x", 0), Int(a, "y", 0)); return "ok";
      case "drag": Drag(Int(a, "x1", 0), Int(a, "y1", 0), Int(a, "x2", 0), Int(a, "y2", 0), Math.Max(4, Int(a, "steps", 12))); return "ok";
      case "scroll": Scroll(Int(a, "x", 0), Int(a, "y", 0), Int(a, "notches", 0)); return "ok";
      case "type": TypeText(Str(a, "text") ?? ""); return "ok";
      case "keys": Keys(Str(a, "keys") ?? ""); return "ok";
      case "release_all": ReleaseAll(); return "ok";
      case "windows": return Windows();
      case "foreground": return Info(GetForegroundWindow());
      case "focus": return Focus(Hwnd(a));
      case "launch": return Launch(Str(a, "file"), Str(a, "args"));
      case "cursor": { POINT p; GetCursorPos(out p); return new Dictionary<string, object> { { "x", p.X }, { "y", p.Y } }; }
      case "focused_password": return FocusedIsPassword();
      case "input_state": {
        // Last keyboard/mouse input time (any source) and the current tick, so the
        // caller can tell whether the user used the computer since the agent's action.
        var li = new LASTINPUTINFO { cbSize = (uint)Marshal.SizeOf(typeof(LASTINPUTINFO)) };
        GetLastInputInfo(ref li);
        POINT p; GetCursorPos(out p);
        return new Dictionary<string, object> { { "lastInput", (long)li.dwTime }, { "now", (long)(uint)Environment.TickCount }, { "x", p.X }, { "y", p.Y } };
      }
      case "root_at": return Info(WindowFromPoint(new POINT { X = Int(a, "x", 0), Y = Int(a, "y", 0) }));
      case "focus_element": return FocusElement(Int(a, "id", 0));
      case "ping": return "pong";
      case "overlay": return Overlay(a);
      default: throw new Exception("Unknown command: " + cmd);
    }
  }

  // ---------------- small helpers ----------------
  static string Str(Dictionary<string, object> a, string k) { return a != null && a.ContainsKey(k) && a[k] != null ? Convert.ToString(a[k]) : null; }
  static int Int(Dictionary<string, object> a, string k, int d) { try { return a != null && a.ContainsKey(k) && a[k] != null ? (int)Math.Round(Convert.ToDouble(a[k])) : d; } catch { return d; } }
  static bool Bool(Dictionary<string, object> a, string k) { return a != null && a.ContainsKey(k) && a[k] is bool && (bool)a[k]; }
  static IntPtr Hwnd(Dictionary<string, object> a) { var s = Str(a, "hwnd"); long v; return !string.IsNullOrEmpty(s) && long.TryParse(s, out v) ? new IntPtr(v) : IntPtr.Zero; }
  static Dictionary<string, object> Rect(Rectangle r) { return new Dictionary<string, object> { { "x", r.X }, { "y", r.Y }, { "w", r.Width }, { "h", r.Height } }; }
  static Rectangle VirtualScreenRect() { return new Rectangle(GetSystemMetrics(76), GetSystemMetrics(77), GetSystemMetrics(78), GetSystemMetrics(79)); }
  static Dictionary<string, object> VirtualScreen() { return Rect(VirtualScreenRect()); }

  static string Title(IntPtr h) { int n = GetWindowTextLength(h); var sb = new StringBuilder(n + 1); GetWindowText(h, sb, sb.Capacity); return sb.ToString(); }
  static Rectangle WinRect(IntPtr h) {
    RECT r;
    if (DwmGetWindowAttribute(h, 9, out r, Marshal.SizeOf(typeof(RECT))) == 0 && r.Right > r.Left) return Rectangle.FromLTRB(r.Left, r.Top, r.Right, r.Bottom);
    GetWindowRect(h, out r); return Rectangle.FromLTRB(r.Left, r.Top, r.Right, r.Bottom);
  }
  static bool Cloaked(IntPtr h) { int v; return DwmGetWindowAttribute(h, 14, out v, 4) == 0 && v != 0; }
  static Dictionary<string, object> Info(IntPtr h) {
    if (h == IntPtr.Zero || !IsWindow(h)) return null;
    IntPtr root = GetAncestor(h, 2); if (root != IntPtr.Zero) h = root;
    uint pid; GetWindowThreadProcessId(h, out pid);
    string proc = ""; try { proc = Process.GetProcessById((int)pid).ProcessName; } catch { }
    return new Dictionary<string, object> {
      { "hwnd", h.ToInt64().ToString() }, { "title", Title(h) }, { "pid", (int)pid }, { "process", proc },
      { "rect", Rect(WinRect(h)) }, { "minimized", IsIconic(h) }, { "foreground", GetAncestor(GetForegroundWindow(), 2) == h }
    };
  }

  // ---------------- windows ----------------
  static List<Dictionary<string, object>> Windows() {
    var list = new List<Dictionary<string, object>>();
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h) || GetWindowTextLength(h) == 0 || Cloaked(h)) return true;
      if ((GetWindowLong(h, -20) & 0x80) != 0) return true; // WS_EX_TOOLWINDOW
      var i = Info(h); if (i != null) list.Add(i);
      return true;
    }, IntPtr.Zero);
    return list;
  }

  static Dictionary<string, object> Focus(IntPtr h) {
    if (h == IntPtr.Zero || !IsWindow(h)) throw new Exception("That window no longer exists. Call computer_windows to get a fresh list.");
    if (IsIconic(h)) { ShowWindow(h, 9); Thread.Sleep(250); }
    for (int attempt = 0; attempt < 3 && GetAncestor(GetForegroundWindow(), 2) != h; attempt++) {
      // A short Alt tap lets this process take the foreground (Windows foreground lock).
      SendKey(0x12, false); SendKey(0x12, true);
      if (!SetForegroundWindow(h)) {
        uint pid; uint fg = GetWindowThreadProcessId(GetForegroundWindow(), out pid);
        uint me = GetCurrentThreadId();
        AttachThreadInput(me, fg, true); BringWindowToTop(h); SetForegroundWindow(h); AttachThreadInput(me, fg, false);
      }
      Thread.Sleep(200);
    }
    var info = Info(h);
    info["focused"] = GetAncestor(GetForegroundWindow(), 2) == h;
    return info;
  }

  static Dictionary<string, object> Launch(string file, string args) {
    if (string.IsNullOrEmpty(file)) throw new Exception("Give the program path or name to start.");
    var before = new HashSet<string>();
    foreach (var w in Windows()) before.Add((string)w["hwnd"]);
    var psi = new ProcessStartInfo(file, args ?? "") { UseShellExecute = true };
    Process p = Process.Start(psi);
    int pid = 0; try { if (p != null) pid = p.Id; } catch { }
    var sw = Stopwatch.StartNew();
    Dictionary<string, object> found = null;
    while (sw.ElapsedMilliseconds < 12000 && found == null) {
      Thread.Sleep(300);
      foreach (var w in Windows()) {
        bool mine = pid != 0 && (int)w["pid"] == pid;
        bool fresh = !before.Contains((string)w["hwnd"]);
        if (mine || (fresh && sw.ElapsedMilliseconds > 600)) { found = w; break; }
      }
    }
    return new Dictionary<string, object> { { "pid", pid }, { "window", found }, { "ms", sw.ElapsedMilliseconds } };
  }

  // ---------------- mouse ----------------
  static INPUT Mouse(uint flags, uint data) { var i = new INPUT { type = INPUT_MOUSE }; i.U.mi.dwFlags = flags; i.U.mi.mouseData = data; return i; }
  static void SendMouse(uint flags, uint data) { SendInput(1, new[] { Mouse(flags, data) }, Marshal.SizeOf(typeof(INPUT))); }
  static void Click(int x, int y, string button, bool dbl) {
    SetCursorPos(x, y); Thread.Sleep(60);
    uint down = 0x2, up = 0x4;
    if (button == "right") { down = 0x8; up = 0x10; } else if (button == "middle") { down = 0x20; up = 0x40; }
    for (int i = 0; i < (dbl ? 2 : 1); i++) { SendMouse(down, 0); Thread.Sleep(90); SendMouse(up, 0); Thread.Sleep(dbl ? 70 : 30); }
  }
  static void Drag(int x1, int y1, int x2, int y2, int steps) {
    SetCursorPos(x1, y1); Thread.Sleep(80); SendMouse(0x2, 0); Thread.Sleep(120);
    for (int i = 1; i <= steps; i++) { SetCursorPos(x1 + (x2 - x1) * i / steps, y1 + (y2 - y1) * i / steps); Thread.Sleep(30); }
    Thread.Sleep(100); SendMouse(0x4, 0);
  }
  static void Scroll(int x, int y, int notches) {
    SetCursorPos(x, y); Thread.Sleep(60);
    SendMouse(0x800, unchecked((uint)(notches * 120)));
  }

  // ---------------- keyboard ----------------
  static readonly HashSet<ushort> Extended = new HashSet<ushort> { 0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, 0x2D, 0x2E, 0x5B, 0x5C, 0x5D, 0x6F, 0x90 };
  static void SendKey(ushort vk, bool up) {
    var i = new INPUT { type = INPUT_KEYBOARD };
    i.U.ki.wVk = vk; i.U.ki.dwFlags = (up ? KEYUP : 0) | (Extended.Contains(vk) ? EXTENDED : 0);
    SendInput(1, new[] { i }, Marshal.SizeOf(typeof(INPUT)));
  }
  static void SendUnicode(char c) {
    var d = new INPUT { type = INPUT_KEYBOARD }; d.U.ki.wScan = c; d.U.ki.dwFlags = UNICODE;
    var u = new INPUT { type = INPUT_KEYBOARD }; u.U.ki.wScan = c; u.U.ki.dwFlags = UNICODE | KEYUP;
    SendInput(2, new[] { d, u }, Marshal.SizeOf(typeof(INPUT)));
  }
  static void TypeText(string text) {
    int n = 0;
    foreach (char c in text) {
      if (c == '\r') continue;
      if (c == '\n') { SendKey(0x0D, false); SendKey(0x0D, true); }
      else if (c == '\t') { SendKey(0x09, false); SendKey(0x09, true); }
      else SendUnicode(c);
      if (++n % 20 == 0) Thread.Sleep(15); else Thread.Sleep(4);
    }
  }
  static ushort Vk(string name) {
    switch (name) {
      case "ctrl": case "control": return 0x11;
      case "shift": return 0x10;
      case "alt": return 0x12;
      case "win": case "windows": case "meta": case "super": case "cmd": return 0x5B;
      case "enter": case "return": return 0x0D;
      case "tab": return 0x09;
      case "esc": case "escape": return 0x1B;
      case "space": return 0x20;
      case "backspace": return 0x08;
      case "delete": case "del": return 0x2E;
      case "insert": case "ins": return 0x2D;
      case "home": return 0x24;
      case "end": return 0x23;
      case "pageup": case "pgup": return 0x21;
      case "pagedown": case "pgdn": return 0x22;
      case "up": return 0x26;
      case "down": return 0x28;
      case "left": return 0x25;
      case "right": return 0x27;
      case "printscreen": return 0x2C;
      case "capslock": return 0x14;
      case "menu": case "apps": return 0x5D;
      case "plus": return 0xBB;
      case "minus": return 0xBD;
    }
    if (name.Length > 1 && name[0] == 'f') { int f; if (int.TryParse(name.Substring(1), out f) && f >= 1 && f <= 24) return (ushort)(0x6F + f); }
    if (name.Length == 1) {
      char c = char.ToUpperInvariant(name[0]);
      if ((c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')) return c;
      short s = VkKeyScan(name[0]); if (s != -1) return (ushort)(s & 0xFF);
    }
    throw new Exception("Unknown key \"" + name + "\". Use names like ctrl, shift, alt, win, enter, tab, esc, space, backspace, delete, up, down, left, right, home, end, pageup, pagedown, f1-f12, or a single letter/digit.");
  }
  // "ctrl+s", "alt+f4", "ctrl+shift+esc". Several combos can be separated by spaces: "ctrl+a delete".
  static void Keys(string spec) {
    foreach (var combo in spec.Trim().ToLowerInvariant().Split(new[] { ' ' }, StringSplitOptions.RemoveEmptyEntries)) {
      var parts = combo.Split('+');
      var vks = new List<ushort>();
      foreach (var p in parts) if (p.Length > 0) vks.Add(Vk(p));
      foreach (var v in vks) { SendKey(v, false); Thread.Sleep(25); }
      Thread.Sleep(40);
      for (int i = vks.Count - 1; i >= 0; i--) { SendKey(vks[i], true); Thread.Sleep(20); }
      Thread.Sleep(60);
    }
  }
  static void ReleaseAll() {
    foreach (ushort v in new ushort[] { 0x10, 0x11, 0x12, 0x5B, 0xA0, 0xA1, 0xA2, 0xA3, 0xA4, 0xA5 }) SendKey(v, true);
    SendMouse(0x4, 0); SendMouse(0x10, 0); SendMouse(0x40, 0);
  }

  // ---------------- UI Automation (numbered elements) ----------------
  static readonly HashSet<ControlType> Interactive = new HashSet<ControlType> {
    ControlType.Button, ControlType.CheckBox, ControlType.ComboBox, ControlType.Edit, ControlType.Hyperlink,
    ControlType.ListItem, ControlType.MenuItem, ControlType.RadioButton, ControlType.Slider, ControlType.Spinner,
    ControlType.SplitButton, ControlType.TabItem, ControlType.TreeItem, ControlType.DataItem, ControlType.Document, ControlType.Menu,
    // Visible text (labels, status lines) so any model, even without vision, can
    // read results such as "Count: 3" after an action.
    ControlType.Text
  };
  static string Kind(ControlType t) {
    string n = t.ProgrammaticName; int dot = n.LastIndexOf('.'); return dot >= 0 ? n.Substring(dot + 1) : n;
  }
  static Dictionary<string, object> Scan(IntPtr h, bool store) {
    if (h == IntPtr.Zero) h = GetForegroundWindow();
    IntPtr root = GetAncestor(h, 2); if (root != IntPtr.Zero) h = root;
    var win = Info(h);
    var items = new List<Dictionary<string, object>>();
    var els = new List<AutomationElement>(); var rects = new List<Rectangle>();
    if (win != null) {
      var bounds = WinRect(h);
      var sw = Stopwatch.StartNew();
      try {
        var walker = TreeWalker.ControlViewWalker;
        var queue = new Queue<AutomationElement>();
        queue.Enqueue(AutomationElement.FromHandle(h));
        int visited = 0;
        while (queue.Count > 0 && visited < 2500 && els.Count < 150 && sw.ElapsedMilliseconds < 4000) {
          var el = queue.Dequeue(); visited++;
          AutomationElement child = null;
          try { child = walker.GetFirstChild(el); } catch { }
          while (child != null) { queue.Enqueue(child); try { child = walker.GetNextSibling(child); } catch { child = null; } }
          if (visited == 1) continue;
          AutomationElement.AutomationElementInformation cur;
          try { cur = el.Current; } catch { continue; }
          if (cur.IsOffscreen || !Interactive.Contains(cur.ControlType)) continue;
          var br = cur.BoundingRectangle;
          if (br.IsEmpty || br.Width < 4 || br.Height < 4) continue;
          var r = new Rectangle((int)br.X, (int)br.Y, (int)br.Width, (int)br.Height);
          if (!r.IntersectsWith(bounds)) continue;
          string name = (cur.Name ?? "").Trim(); if (name.Length > 60) name = name.Substring(0, 60) + "…";
          if (cur.ControlType == ControlType.Text && name.Length == 0) continue; // empty text adds nothing
          var item = new Dictionary<string, object> { { "id", els.Count + 1 }, { "type", Kind(cur.ControlType) }, { "name", name }, { "rect", Rect(r) }, { "enabled", cur.IsEnabled } };
          if (cur.ControlType == ControlType.Edit || cur.ControlType == ControlType.Document) {
            bool pw = false; try { pw = cur.IsPassword; } catch { }
            item["password"] = pw;
            if (!pw) { try { object vp; if (el.TryGetCurrentPattern(ValuePattern.Pattern, out vp)) { string v = ((ValuePattern)vp).Current.Value ?? ""; if (v.Length > 60) v = v.Substring(0, 60) + "…"; item["value"] = v; } } catch { } }
          }
          try { object sp; if (el.TryGetCurrentPattern(SelectionItemPattern.Pattern, out sp) && ((SelectionItemPattern)sp).Current.IsSelected) item["selected"] = true; } catch { }
          try { object tp; if (el.TryGetCurrentPattern(TogglePattern.Pattern, out tp)) item["checked"] = ((TogglePattern)tp).Current.ToggleState == ToggleState.On; } catch { }
          els.Add(el); rects.Add(r); items.Add(item);
        }
      } catch { }
      MarkHidden(h, els, rects, items);
    }
    if (store) { lastElements = els; lastRects = rects; }
    return new Dictionary<string, object> { { "window", win }, { "elements", items } };
  }
  // The accessibility tree also lists controls that exist but are not drawn
  // where they claim (behind another control, under another window, outside
  // the screen). Hit-test each centre so the model is told, instead of
  // believing a button is there because the list says so.
  static bool IsSameOrInside(AutomationElement hit, AutomationElement el, int depth) {
    var walker = TreeWalker.ControlViewWalker;
    var cur = hit;
    for (int i = 0; cur != null && i < depth; i++) {
      try { if (Automation.Compare(cur, el)) return true; } catch { return false; }
      try { cur = walker.GetParent(cur); } catch { cur = null; }
    }
    return false;
  }
  static void MarkHidden(IntPtr h, List<AutomationElement> els, List<Rectangle> rects, List<Dictionary<string, object>> items) {
    var screen = VirtualScreenRect();
    var sw = Stopwatch.StartNew();
    for (int i = 0; i < els.Count; i++) {
      if (sw.ElapsedMilliseconds > 1500) break; // big windows: the rest stay unchecked
      var r = rects[i];
      var c = new System.Drawing.Point(r.X + r.Width / 2, r.Y + r.Height / 2);
      if (!screen.Contains(c)) { items[i]["hidden"] = "outside the screen"; continue; }
      try {
        IntPtr top = WindowFromPoint(new POINT { X = c.X, Y = c.Y });
        IntPtr topRoot = GetAncestor(top, 2); if (topRoot != IntPtr.Zero) top = topRoot;
        if (top != h) { items[i]["hidden"] = "covered by another window"; continue; }
        var hit = AutomationElement.FromPoint(new System.Windows.Point(c.X, c.Y));
        if (hit == null || IsSameOrInside(hit, els[i], 10)) continue;
        // The point may land on a parent of the element (text that is not hit-testable): not proof.
        if (IsSameOrInside(els[i], hit, 6)) continue;
        items[i]["hidden"] = "covered by another control";
      } catch { }
    }
  }
  static Dictionary<string, object> ElementInfo(int id) {
    if (id < 1 || id > lastRects.Count) throw new Exception("Element " + id + " is not in the latest list. Take a new computer_screenshot (or computer_ui) and use a number from it.");
    var r = lastRects[id - 1];
    string name = "", type = ""; bool pw = false, enabled = true;
    try { var c = lastElements[id - 1].Current; name = c.Name ?? ""; type = Kind(c.ControlType); pw = c.IsPassword; enabled = c.IsEnabled; r = new Rectangle((int)c.BoundingRectangle.X, (int)c.BoundingRectangle.Y, (int)c.BoundingRectangle.Width, (int)c.BoundingRectangle.Height); } catch { }
    return new Dictionary<string, object> { { "id", id }, { "name", name }, { "type", type }, { "password", pw }, { "enabled", enabled }, { "rect", Rect(r) }, { "cx", r.X + r.Width / 2 }, { "cy", r.Y + r.Height / 2 } };
  }
  static bool FocusElement(int id) {
    if (id < 1 || id > lastElements.Count) return false;
    try { lastElements[id - 1].SetFocus(); return true; } catch { return false; }
  }
  static Dictionary<string, object> PointInfo(int x, int y) {
    var d = new Dictionary<string, object>();
    try { var e = AutomationElement.FromPoint(new System.Windows.Point(x, y)); var c = e.Current; d["name"] = c.Name ?? ""; d["type"] = Kind(c.ControlType); d["password"] = c.IsPassword; } catch { }
    d["window"] = Info(WindowFromPoint(new POINT { X = x, Y = y }));
    return d;
  }
  static bool FocusedIsPassword() { try { return AutomationElement.FocusedElement.Current.IsPassword; } catch { return false; } }

  // ---------------- screenshot ----------------
  static Dictionary<string, object> Screenshot(Dictionary<string, object> a) {
    IntPtr h = Hwnd(a);
    Rectangle area = h != IntPtr.Zero && IsWindow(h) ? Rectangle.Intersect(WinRect(h), VirtualScreenRect()) : VirtualScreenRect();
    bool zoom = a.ContainsKey("rw");
    if (zoom) area = Rectangle.Intersect(new Rectangle(Int(a, "rx", 0), Int(a, "ry", 0), Math.Max(8, Int(a, "rw", 0)), Math.Max(8, Int(a, "rh", 0))), VirtualScreenRect());
    if (area.Width < 1 || area.Height < 1) throw new Exception(zoom ? "That area is outside the screen." : "That window is minimized or off-screen. Call computer_focus first.");
    int maxW = Int(a, "maxW", 1280), maxH = Int(a, "maxH", 800);
    double scale = Math.Max(1.0, Math.Max((double)area.Width / maxW, (double)area.Height / maxH));
    // Zoom: a small area is enlarged (up to 3x) so small text becomes readable.
    if (zoom) scale = Math.Max(1.0 / 3.0, Math.Max((double)area.Width / maxW, (double)area.Height / maxH));
    int sw = (int)Math.Round(area.Width / scale), sh = (int)Math.Round(area.Height / scale);
    List<Dictionary<string, object>> marks = new List<Dictionary<string, object>>();
    Dictionary<string, object> scanned = null;
    if (Bool(a, "marks")) { scanned = Scan(h, true); marks = (List<Dictionary<string, object>>)scanned["elements"]; }
    using (var full = new Bitmap(area.Width, area.Height, PixelFormat.Format24bppRgb)) {
      using (var g = Graphics.FromImage(full)) g.CopyFromScreen(area.X, area.Y, 0, 0, area.Size, CopyPixelOperation.SourceCopy);
      using (var small = new Bitmap(sw, sh, PixelFormat.Format24bppRgb))
      using (var g = Graphics.FromImage(small)) {
        g.InterpolationMode = InterpolationMode.HighQualityBicubic; g.SmoothingMode = SmoothingMode.HighQuality;
        g.DrawImage(full, 0, 0, sw, sh);
        // "draw": false keeps the picture clean (the numbers still come back as a list).
        if (marks.Count > 0 && !(a != null && a.ContainsKey("draw") && a["draw"] is bool && !(bool)a["draw"])) {
          using (var pen = new Pen(Color.FromArgb(230, 255, 0, 90), 2f))
          using (var font = new Font("Segoe UI", 9f, FontStyle.Bold, GraphicsUnit.Pixel))
          using (var bg = new SolidBrush(Color.FromArgb(235, 255, 0, 90)))
          using (var fg = new SolidBrush(Color.White)) {
            foreach (var m in marks) {
              var r = (Dictionary<string, object>)m["rect"];
              float x = (float)(((int)r["x"] - area.X) / scale), y = (float)(((int)r["y"] - area.Y) / scale);
              float w = (float)((int)r["w"] / scale), hh = (float)((int)r["h"] / scale);
              g.DrawRectangle(pen, x, y, w, hh);
              string label = Convert.ToString(m["id"]);
              var size = g.MeasureString(label, font);
              float lx = Math.Max(0, x - 1), ly = Math.Max(0, y - size.Height + 1);
              g.FillRectangle(bg, lx, ly, size.Width + 2, size.Height);
              g.DrawString(label, font, fg, lx + 1, ly);
            }
          }
        }
        var codec = Array.Find(ImageCodecInfo.GetImageEncoders(), c => c.MimeType == "image/jpeg");
        var ps = new EncoderParameters(1); ps.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, (long)Int(a, "quality", 80));
        using (var ms = new MemoryStream()) {
          small.Save(ms, codec, ps);
          var d = new Dictionary<string, object> {
            { "data", Convert.ToBase64String(ms.ToArray()) }, { "mime", "image/jpeg" },
            { "x", area.X }, { "y", area.Y }, { "w", area.Width }, { "h", area.Height },
            { "sentW", sw }, { "sentH", sh }, { "scale", scale }, { "foreground", Info(GetForegroundWindow()) }
          };
          if (scanned != null) { d["window"] = scanned["window"]; d["elements"] = marks; }
          return d;
        }
      }
    }
  }
}
'@

Add-Type -TypeDefinition $source -ReferencedAssemblies $refs -Language CSharp
[VcComputer]::Init()
[VcComputer]::Emit('{"ready":true}')
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if ($line.Trim().Length -eq 0) { continue }
  [VcComputer]::Emit([VcComputer]::Handle($line))
}
