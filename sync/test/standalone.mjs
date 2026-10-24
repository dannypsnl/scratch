// The self-hosted server (server.mjs) speaking the app's protocol: two
// devices with real Loro documents, a late device catching up, images, and a
// wrong token.   node test/standalone.mjs
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { LoroDoc } from "loro-crdt/nodejs";

const PORT = 18000 + Math.floor(Math.random() * 1000), TOKEN = "test-token";
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "scratch-sync-"));
const server = spawn(process.execPath, [new URL("../server.mjs", import.meta.url).pathname], {
  env: { ...process.env, SYNC_TOKEN: TOKEN, PORT: String(PORT), DATA_DIR: DATA },
  stdio: ["ignore", "pipe", "inherit"],
});
await new Promise((resolve) => server.stdout.once("data", resolve));

const fails = [];
const check = (ok, what) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) fails.push(what); };
const URL_ = (token = TOKEN, notebook = "main") => `ws://localhost:${PORT}/sync?token=${token}&notebook=${notebook}`;

// a device: a Loro document kept in step with the server
function device(notebook = "main", since = 0) {
  const doc = new LoroDoc();
  const ws = new WebSocket(URL_(TOKEN, notebook));
  ws.binaryType = "arraybuffer";
  const d = { doc, ws, seq: since, acks: [], received: 0 };
  d.synced = new Promise((resolve) => {
    ws.onmessage = (ev) => {
      if (typeof ev.data !== "string") {
        const frame = new Uint8Array(ev.data);
        d.seq = Number(new DataView(ev.data).getBigUint64(1));
        doc.import(frame.subarray(9));
        d.received++;
        return;
      }
      const msg = JSON.parse(ev.data);
      if (msg.type === "synced") resolve(msg.seq);
      if (msg.type === "ack") d.acks.push(msg);
    };
  });
  ws.onopen = () => ws.send(JSON.stringify({ type: "hello", since }));
  d.push = (id) => {
    const update = doc.export({ mode: "update" });
    const frame = new Uint8Array(4 + update.length);
    new DataView(frame.buffer).setUint32(0, id);
    frame.set(update, 4);
    ws.send(frame);
  };
  return d;
}
const until = async (cond) => { for (let k = 0; k < 100 && !cond(); k++) await new Promise((r) => setTimeout(r, 20)); return cond(); };

// two devices: an edit on one reaches the other
const a = device(), b = device();
check((await a.synced) === 0 && (await b.synced) === 0, "both devices start in sync at seq 0");
a.doc.getText("t").insert(0, "hello from a");
a.push(7);
check(await until(() => a.acks.length === 1), "the sender's update is acked");
check(a.acks[0]?.id === 7 && a.acks[0]?.seq === 1, "the ack names the update and its sequence number");
check(await until(() => b.doc.getText("t").toString() === "hello from a"), "the other device has the edit");

// and back the other way, merged by Loro
b.doc.getText("t").insert(0, "b says: ");
b.push(1);
check(await until(() => a.doc.getText("t").toString() === "b says: hello from a"), "an edit flows back and merges");

// a device that was away gets everything since its last sequence number
const c = device("main", 0);
check((await c.synced) === 2 && c.doc.getText("t").toString() === "b says: hello from a", "a new device replays the whole log");
const d = device("main", 1);
check((await d.synced) === 2 && d.received === 1, "a returning device gets only what it missed");

// notebooks never mix
const other = device("other");
check((await other.synced) === 0, "another notebook starts empty");

// images: content-addressed, hash checked
const bytes = crypto.randomBytes(1000);
const name = crypto.createHash("sha256").update(bytes).digest("hex") + ".png";
const blobURL = (n, token = TOKEN) => `http://localhost:${PORT}/blob/${n}?token=${token}&notebook=main`;
check((await fetch(blobURL(name), { method: "PUT", body: bytes })).status === 204, "an image uploads");
const got = await fetch(blobURL(name));
check(got.status === 200 && Buffer.from(await got.arrayBuffer()).equals(bytes), "and comes back byte for byte");
check((await fetch(blobURL("0".repeat(64) + ".png"), { method: "PUT", body: bytes })).status === 400, "a name that is not the hash is refused");
check((await fetch(blobURL(name, "wrong"))).status === 401, "a wrong token gets no image");

// a wrong token closes the socket with 4001, which the app reads as "token rejected"
const closed = await new Promise((resolve) => { const ws = new WebSocket(URL_("wrong")); ws.onclose = (ev) => resolve(ev.code); });
check(closed === 4001, "a wrong token is closed with 4001");

// the log survives a restart
for (const x of [a, b, c, d, other]) x.ws.close();
server.kill();
await new Promise((r) => server.once("exit", r));
const again = spawn(process.execPath, [new URL("../server.mjs", import.meta.url).pathname], {
  env: { ...process.env, SYNC_TOKEN: TOKEN, PORT: String(PORT), DATA_DIR: DATA }, stdio: ["ignore", "pipe", "inherit"],
});
await new Promise((resolve) => again.stdout.once("data", resolve));
const e = device();
check((await e.synced) === 2 && e.doc.getText("t").toString() === "b says: hello from a", "after a restart the log is still there");
e.ws.close();
again.kill();
fs.rmSync(DATA, { recursive: true, force: true });

console.log(fails.length ? `\n${fails.length} failed` : "\nall passed");
process.exitCode = fails.length ? 1 : 0;
