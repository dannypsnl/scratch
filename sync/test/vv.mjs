// The relay by version vector (src/core.js), on the self-hosted server: a
// device says what its document has and gets exactly what it lacks, sends
// what the server lacks, edits made apart merge, an update the server cannot
// apply yet asks for what it needs, and snapshots plus the log come back
// after a restart.   node test/vv.mjs
// RELAY=ws://localhost:8787 TOKEN=… node test/vv.mjs runs it against a relay
// already running (the Worker under wrangler dev), without the restart.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LoroDoc, VersionVector } from "loro-crdt/nodejs";

const RELAY = process.env.RELAY;
const PORT = 18000 + Math.floor(Math.random() * 1000), TOKEN = process.env.TOKEN ?? "test-token";
const BASE = RELAY ?? `ws://localhost:${PORT}`;
const NOTEBOOK = RELAY ? `vv-test-${Date.now()}` : "main";
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "scratch-sync-vv-"));
const start = async () => {
  if (RELAY) return null;
  const p = spawn(process.execPath, [new URL("../server.mjs", import.meta.url).pathname], {
    env: { ...process.env, SYNC_TOKEN: TOKEN, PORT: String(PORT), DATA_DIR: DATA, SNAPSHOT_EVERY: "5" },
    stdio: ["ignore", "pipe", "inherit"],
  });
  await new Promise((resolve) => p.stdout.once("data", resolve));
  return p;
};
let server = await start();

const fails = [];
const check = (ok, what) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) fails.push(what); };
const until = async (cond) => { for (let k = 0; k < 150 && !cond(); k++) await new Promise((r) => setTimeout(r, 20)); return cond(); };
const b64 = (bytes) => Buffer.from(bytes).toString("base64");
const text = (d) => d.doc.getText("t").toString();

// a device as the app is: says hello with its version, sends what the
// server lacks after "synced", answers "need", says hello again when an
// update cannot apply
function device(doc = new LoroDoc()) {
  const d = { doc, received: 0, acks: [], hellos: 0, ws: null };
  let id = 1;
  const send = (update) => {
    if (!update.length) return;
    const frame = new Uint8Array(4 + update.length);
    new DataView(frame.buffer).setUint32(0, id++);
    frame.set(update, 4);
    d.ws.send(frame);
  };
  const hello = () => { d.hellos++; d.ws.send(JSON.stringify({ type: "hello", vv: b64(doc.oplogVersion().encode()) })); };
  d.connect = () => {
    d.ws = new WebSocket(`${BASE}/sync?token=${TOKEN}&notebook=${NOTEBOOK}`);
    d.ws.binaryType = "arraybuffer";
    d.synced = new Promise((resolve) => {
      d.ws.onmessage = (ev) => {
        if (typeof ev.data !== "string") {
          d.received++;
          if (doc.import(new Uint8Array(ev.data, 9)).pending) hello();
          return;
        }
        const msg = JSON.parse(ev.data);
        if (msg.type === "synced") {
          const from = VersionVector.decode(Buffer.from(msg.vv, "base64"));
          if (![0, -1].includes(doc.oplogVersion().compare(from))) send(doc.export({ mode: "update", from }));
          resolve(msg);
        }
        if (msg.type === "ack") {
          d.acks.push(msg);
          if (msg.need) send(doc.export({ mode: "update", from: VersionVector.decode(Buffer.from(msg.need, "base64")) }));
        }
      };
    });
    d.ws.onopen = hello;
    return d.synced;
  };
  d.edit = (s) => { doc.getText("t").insert(text(d).length, s); doc.commit(); send(doc.export({ mode: "update", from: d.last ?? undefined })); d.last = doc.oplogVersion(); };
  d.close = () => d.ws.close();
  return d;
}

const a = device(), b = device();
await a.connect(); await b.connect();
a.edit("a1 ");
check(await until(() => text(b) === "a1 "), "an edit reaches the other device");

// apart: both edit offline, then reconnect; the server and both converge
a.close(); b.close();
a.doc.getText("t").insert(0, "[a offline] "); a.doc.commit();
b.doc.getText("t").insert(text(b).length, "[b offline]"); b.doc.commit();
await a.connect();
await b.connect();
check(await until(() => text(a) === text(b) && text(a).includes("[a offline]") && text(a).includes("[b offline]")), "edits made apart merge into one text on both");
const c = device();
await c.connect();
check(await until(() => text(c) === text(a)), "a new device gets the whole notebook from one hello");

// a device that already has everything gets nothing back
const before = c.received;
c.close(); await c.connect();
await new Promise((r) => setTimeout(r, 200));
check(c.received === before, "a device with everything gets no update on hello");

// an update the server cannot apply yet: built on a change it never got
const x = device();
await x.connect();
x.doc.getText("t").insert(0, "base "); x.doc.commit();
const baseVV = x.doc.oplogVersion();
x.doc.getText("t").insert(0, "top "); x.doc.commit();
const top = x.doc.export({ mode: "update", from: baseVV }); // only "top", which needs "base"
const frame = new Uint8Array(4 + top.length); new DataView(frame.buffer).setUint32(0, 99); frame.set(top, 4);
x.ws.send(frame);
check(await until(() => x.acks.some((m) => m.id === 99 && m.need)), "an update waiting on a missing change is acked with what the server needs");
check(await until(() => text(a).startsWith("top base ")), "the device sends it, and the other devices get both");

// a device missing a change (its update lost) asks again when the next one cannot apply
const lost = device();
await lost.connect();
lost.ws.onmessage = ((orig) => (ev) => { if (typeof ev.data !== "string" && !lost.dropped) { lost.dropped = true; return; } orig(ev); })(lost.ws.onmessage);
a.edit("one ");
await new Promise((r) => setTimeout(r, 200));
a.edit("two ");
check(await until(() => text(lost) === text(a)) && lost.hellos >= 2, "a device that lost an update says hello again and catches up");

// restart: snapshot (every 5 updates here) and the log after it
for (const d of [a, b, c, x, lost]) d.close();
const want = text(a);
if (server) { server.kill(); await new Promise((r) => server.once("exit", r)); }
server = await start();
const after = device();
await after.connect();
check(await until(() => text(after) === want), "after a restart the notebook is the same (snapshot and log)");

// earlier devices: hello with a sequence number still replays the log
const old = new LoroDoc();
const ws = new WebSocket(`${BASE}/sync?token=${TOKEN}&notebook=${NOTEBOOK}`);
ws.binaryType = "arraybuffer";
await new Promise((resolve) => {
  ws.onmessage = (ev) => { if (typeof ev.data !== "string") old.import(new Uint8Array(ev.data, 9)); else if (JSON.parse(ev.data).type === "synced") resolve(); };
  ws.onopen = () => ws.send(JSON.stringify({ type: "hello", since: 0 }));
});
check(old.getText("t").toString() === want, "a device on the earlier protocol still gets the notebook");
ws.close(); after.close();

server?.kill();
fs.rmSync(DATA, { recursive: true, force: true });
console.log(fails.length ? `\n${fails.length} failed` : "\nall passed");
process.exitCode = fails.length ? 1 : 0;
