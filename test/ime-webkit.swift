// Composition in a real WKWebView (the app's own engine), for test/ime.mjs:
// what an input method does, through NSTextInputClient (setMarkedText while
// composing, insertText to commit). Playwright cannot compose in WebKit.
//
//   swiftc test/ime-webkit.swift -o ime-webkit
//   ./ime-webkit http://localhost:5198/ '[{"line": …, "where": …, "steps": […], "word": …}]'
//
// Prints one line per case: the line afterwards, as text and $LaTeX$.
import AppKit
import WebKit

let url = URL(string: CommandLine.arguments[1])!
struct Case: Decodable { let line: String; let `where`: String; let steps: [String]; let word: String }
let cases = try! JSONDecoder().decode([Case].self, from: CommandLine.arguments[2].data(using: .utf8)!)

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
// unseen (macOS pulls a window back on screen): it only has to be key, for
// the page to have focus
let win = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 900, height: 600), styleMask: [.titled], backing: .buffered, defer: false)
win.alphaValue = 0
win.ignoresMouseEvents = true
win.makeKeyAndOrderFront(nil)
var web = WKWebView()

@MainActor func js(_ s: String, _ args: [String: Any] = [:]) async -> Any? {
  do { return try await web.callAsyncJavaScript(s, arguments: args, in: nil, contentWorld: .page) } catch { return "JS error: \(error)" }
}
@MainActor func sleep(_ ms: UInt64) async { try? await Task.sleep(nanoseconds: ms * 1_000_000) }

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
    _ = await js("""
      const v = window.view; v.focus();
      const dt = new DataTransfer(); dt.setData("text/plain", `- ${line}`);
      v.dom.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
      """, ["line": c.line])
    await sleep(300)
    // the caret, put there by the editor (as in test/ime.mjs)
    _ = await js("""
      const v = window.view; const [kind, n] = where.split(" "); const maths = []; let text = null;
      v.state.doc.descendants((node, pos) => {
        if (node.type.name === "math") maths.push([pos, node.nodeSize]);
        if (node.type.name === "struct" && node.attrs.name === "text") text = pos + 2 + node.firstChild.content.size;
      });
      const [p, size] = maths[n] ?? [];
      const at = { in: text, after: p + size, before: p, end: p + size - 1, start: p + 1, line: v.state.selection.constructor.atEnd(v.state.doc).head }[kind];
      v.focus(); v.dispatch(v.state.tr.setSelection(v.state.selection.constructor.create(v.state.doc, at)));
      """, ["where": c.where])
    await sleep(300)
    let client = unsafeBitCast(web, to: NSTextInputClient.self)
    for s in c.steps {
      client.setMarkedText(s, selectedRange: NSRange(location: (s as NSString).length, length: 0), replacementRange: NSRange(location: NSNotFound, length: 0))
      await sleep(100)
    }
    client.insertText(c.word, replacementRange: NSRange(location: NSNotFound, length: 0))
    await sleep(400)
    let got = await js("""
      const { serializeMath } = await import("/src/latex.js"); let out = "";
      window.view.state.doc.descendants((n) => {
        if (n.type.name !== "line" || out) return !out;
        n.forEach((c) => { out += c.isText ? c.text : c.type.name === "math" ? `$${serializeMath(c.content)}$` : ""; });
        return false;
      });
      return out;
      """)
    print(got ?? "")
  }
  exit(0)
}
app.run()
