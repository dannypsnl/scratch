// Keys in a real WKWebView (the app's own engine, as on macOS), for
// test/keys.mjs: arrow keys sent as AppKit key events, where Playwright's
// WebKit is not the one the app runs in and moves the caret otherwise.
//
//   swiftc test/keys-webkit.swift -o keys-webkit
//   ./keys-webkit http://localhost:5187/ '[{"text": "- …", "line": 0, "keys": ["left", …]}]'
//
// Prints one line per case: where the caret is before the keys and after
// each, " ; " between them.
import AppKit
import WebKit

let url = URL(string: CommandLine.arguments[1])!
// keys: arrow names, "click" (the mouse at the right of the line, past its
// end), "type:<text>" (each character a key event), or "wait:<ms>"
// at: "start" or "end" of the line, or inside its first formula, "math-start" or "math-end"
// source: an input source for the page's text input (as "com.apple.inputmethod.TCIM.Zhuyin"),
// for this window alone
struct Case: Decodable { let text: String; let line: Int; let at: String?; let source: String?; let keys: [String] }
let cases = try! JSONDecoder().decode([Case].self, from: CommandLine.arguments[2].data(using: .utf8)!)

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
// unseen (macOS pulls a window back on screen): it only has to be key, for
// the page to have focus
let win = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 900, height: 600), styleMask: [.titled], backing: .buffered, defer: false)
win.alphaValue = 0
win.makeKeyAndOrderFront(nil)
var web = WKWebView()

@MainActor func js(_ s: String, _ args: [String: Any] = [:]) async -> Any? {
  do { return try await web.callAsyncJavaScript(s, arguments: args, in: nil, contentWorld: .page) } catch { return "JS error: \(error)" }
}
@MainActor func sleep(_ ms: UInt64) async { try? await Task.sleep(nanoseconds: ms * 1_000_000) }

// key name -> (key code, the character AppKit gives it)
let KEYS: [String: (UInt16, String)] = [
  "left": (123, "\u{F702}"), "right": (124, "\u{F703}"), "up": (126, "\u{F700}"), "down": (125, "\u{F701}"),
]
// where: "end" (right of the line) or "math-left" (just inside its formula's left edge)
@MainActor func click(line: Int, _ where: String = "end") async {
  let r = await js("""
    const el = document.querySelectorAll(".ProseMirror .pm-line")[line], l = el.getBoundingClientRect();
    if (where === "math-left") { const m = el.querySelector(".pm-math").getBoundingClientRect(); return [m.left + 2, m.top + m.height / 2]; }
    return [l.right + 40, l.top + l.height / 2];
    """, ["line": line, "where": `where`]) as? [Double] ?? [0, 0]
  // page coordinates (y down) -> the window's (y up)
  let p = web.convert(NSPoint(x: r[0], y: r[1]), to: nil)
  for type in [NSEvent.EventType.leftMouseDown, .leftMouseUp] {
    let ev = NSEvent.mouseEvent(with: type, location: p, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: win.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: 1)!
    win.sendEvent(ev)
  }
}
@MainActor func type(_ text: String) async {
  for ch in text.map(String.init) {
    for type in [NSEvent.EventType.keyDown, .keyUp] {
      let ev = NSEvent.keyEvent(with: type, location: .zero, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: win.windowNumber, context: nil, characters: ch, charactersIgnoringModifiers: ch, isARepeat: false, keyCode: ch == " " ? 49 : 0)!
      win.sendEvent(ev)
    }
    await sleep(60)
  }
}
@MainActor func press(_ name: String) {
  let (code, ch) = KEYS[name]!
  for type in [NSEvent.EventType.keyDown, .keyUp] {
    let ev = NSEvent.keyEvent(with: type, location: .zero, modifierFlags: [.numericPad, .function], timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: win.windowNumber, context: nil, characters: ch, charactersIgnoringModifiers: ch, isARepeat: false, keyCode: code)!
    win.sendEvent(ev)
  }
}

// the caret: the node it is in, and what is either side of it
let WHERE = """
  const s = window.view.state.selection, b = s.$from.nodeBefore, a = s.$from.nodeAfter;
  const name = (n) => !n ? "" : n.isText ? n.text : n.type.name;
  // and the caret as drawn: left of it, the formula's left edge, or its right edge
  const c = document.querySelector(".pm-caret"), m = document.querySelector(".ProseMirror .pm-math");
  const x = c ? c.getBoundingClientRect().left : null, ml = m.getBoundingClientRect().left, mr = m.getBoundingClientRect().right;
  const drawn = x === null ? "none" : Math.abs(x - ml) < 4 ? "@math-left" : Math.abs(x - mr) < 6 ? "@math-right" : `@${Math.round(x - mr)}`;
  return `${s.$from.parent.type.name} ${name(b)}|${name(a)} ${drawn}`;
  """

Task { @MainActor in
  for c in cases {
    // a fresh page with empty storage for each
    web.removeFromSuperview()
    let conf = WKWebViewConfiguration()
    conf.websiteDataStore = .nonPersistent()
    web = WKWebView(frame: win.contentView!.bounds, configuration: conf)
    win.contentView!.addSubview(web)
    web.load(URLRequest(url: url))
    for _ in 0..<100 { await sleep(100); if (await js("return !!window.view && document.readyState === \"complete\"")) as? Bool == true { break } }
    win.makeFirstResponder(web)
    // the outline, and the caret at the end of the given line
    _ = await js("""
      const v = window.view, IO = await import("/src/outline-io.js");
      const tr = v.state.tr.replaceWith(0, v.state.doc.content.size, IO.parseOutline(text).content);
      const ends = [], starts = [], mathEnds = [], mathStarts = [];
      tr.doc.descendants((n, p) => {
        if (n.type.name === "line") { ends.push(p + n.nodeSize - 1); starts.push(p + 1); const m = n.firstChild; mathEnds.push(m?.type.name === "math" ? p + 1 + m.nodeSize - 1 : null); mathStarts.push(m?.type.name === "math" ? p + 2 : null); }
      });
      v.focus(); v.dispatch(tr.setSelection(v.state.selection.constructor.create(tr.doc, at === "math-end" ? mathEnds[line] : at === "math-start" ? mathStarts[line] : at === "start" ? starts[line] : ends[line])));
      """, ["text": c.text, "line": c.line, "at": c.at ?? "end"])
    await sleep(300)
    if let source = c.source {
      web.inputContext?.activate()
      web.inputContext?.selectedKeyboardInputSource = source
      await sleep(300)
      if ProcessInfo.processInfo.environment["KEYS_EVENTS"] != nil { FileHandle.standardError.write("source: \(web.inputContext?.selectedKeyboardInputSource ?? "none")\n".data(using: .utf8)!) }
    }
    _ = await js("window.__keys = []; document.addEventListener('keydown', (e) => window.__keys.push(`${e.key}/${e.keyCode}${e.isComposing ? '/composing' : ''}`), true);")
    var out = [await js(WHERE) as? String ?? "?"]
    for k in c.keys {
      if k.hasPrefix("wait:") { await sleep(UInt64(k.dropFirst(5)) ?? 0) } else if k == "click" { await click(line: c.line) } else if k == "click:math-left" { await click(line: c.line, "math-left") } else if k.hasPrefix("type:") { await type(String(k.dropFirst(5))) } else { press(k) }
      await sleep(250)
      out.append(await js(WHERE) as? String ?? "?")
    }
    if ProcessInfo.processInfo.environment["KEYS_EVENTS"] != nil { out.append("events: " + ((await js("return window.__keys.join(' ')") as? String) ?? "")) }
    print(out.joined(separator: " ; "))
  }
  exit(0)
}
app.run()
