// A second device, headless: pull the notebook from the sync server, print
// it, then optionally edit one block and push the change.
//   node test/client.mjs <ws-url> <token> <notebook> [find-text append-text]
import { LoroDoc } from "loro-crdt/nodejs";

const [url, token, notebook, find, append] = process.argv.slice(2);
const doc = new LoroDoc();
const ws = new WebSocket(`${url}?token=${token}&notebook=${notebook}`);
ws.binaryType = "arraybuffer";

const done = new Promise((resolve) => {
  ws.onmessage = (ev) => {
    if (typeof ev.data !== "string") {
      doc.import(new Uint8Array(ev.data, 9));
      return;
    }
    const msg = JSON.parse(ev.data);
    if (msg.type === "synced") resolve(msg.seq);
    if (msg.type === "ack") { console.log("acked as seq", msg.seq); ws.close(); }
  };
});
ws.onopen = () => ws.send(JSON.stringify({ type: "hello", since: 0 }));

const seq = await done;
const tree = doc.getTree("blocks");
console.log(`synced at seq ${seq}`);
for (const root of tree.roots()) {
  const lines = [];
  const walk = (n, depth) => {
    const line = JSON.parse(n.data.get("line") ?? "{}");
    const text = (line.content ?? []).map((c) => c.text ?? `<${c.type}>`).join("");
    lines.push("  ".repeat(depth) + "- " + (n.data.get("task") ? n.data.get("task").toUpperCase() + " " : "") + text);
    for (const c of n.children() ?? []) walk(c, depth + 1);
  };
  for (const c of root.children() ?? []) walk(c, 0);
  console.log(`# ${root.data.get("title") ?? root.data.get("page")}\n${lines.join("\n")}`);
}

if (find) {
  const node = tree.nodes().find((n) => !n.isDeleted() && (n.data.get("line") ?? "").includes(find));
  const line = JSON.parse(node.data.get("line"));
  line.content.push({ type: "text", text: append });
  doc.subscribeLocalUpdates((u) => {
    const frame = new Uint8Array(4 + u.length);
    new DataView(frame.buffer).setUint32(0, 1);
    frame.set(u, 4);
    ws.send(frame);
  });
  node.data.set("line", JSON.stringify(line));
  doc.commit();
} else ws.close();
