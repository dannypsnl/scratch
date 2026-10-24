import { VersionVector } from "loro-crdt/base64";
import { invalidate } from "../src/loro.js";

// The MCP server as one more device on the sync relay (sync/server.mjs, or
// the Cloudflare Worker): the same protocol as the app's src/sync.js. It says
// what its document has as a Loro version vector and gets what it lacks; the
// reply carries the server's version, and what the server lacks is sent from
// it. An update that cannot apply is answered with another hello, an ack
// saying what the server needs with that.
//
// It starts empty and takes the whole notebook from the server, so it keeps
// nothing on disk. A write is done once the server has acked it.

const b64 = (bytes) => Buffer.from(bytes).toString("base64");
const version = (s) => (s ? VersionVector.decode(Buffer.from(s, "base64")) : undefined);

export function syncClient(doc, { url, token, notebook, log = () => {} }) {
  let ws = null, retry = 0, timer = null, nextId = 1, closed = false, asking = false;
  let state = "connecting"; // connecting | synced | offline | unauthorized
  const inflight = new Set(); // ids sent and not yet acked
  const waiters = new Set(); // resolved when the server has everything

  let firstSync;
  const ready = new Promise((resolve) => { firstSync = resolve; });

  const settled = () => state === "synced" && !inflight.size && !asking;
  const caughtUp = () => {
    if (!settled()) return;
    for (const fn of waiters) fn(true);
    waiters.clear();
  };

  function send(update) {
    // before "synced" (or offline) a change waits: "synced" sends whatever
    // the server lacks
    if (!ws || ws.readyState !== WebSocket.OPEN || state !== "synced" || !update.length) return;
    const id = nextId++;
    inflight.add(id);
    const frame = new Uint8Array(4 + update.length);
    new DataView(frame.buffer).setUint32(0, id);
    frame.set(update, 4);
    ws.send(frame);
  }
  // everything this document has that one at `from` lacks (an update with
  // nothing in it is still a few bytes: compare instead)
  function sendNewer(from) {
    if (!from) return send(doc.export({ mode: "update" }));
    if (![0, -1].includes(doc.oplogVersion().compare(from))) send(doc.export({ mode: "update", from }));
  }

  function connect() {
    if (closed) return;
    const u = new URL(url);
    u.searchParams.set("token", token ?? "");
    if (notebook) u.searchParams.set("notebook", notebook);
    state = "connecting";
    const sock = new WebSocket(u);
    sock.binaryType = "arraybuffer";
    ws = sock;
    const hello = () => { asking = true; sock.send(JSON.stringify({ type: "hello", vv: b64(doc.oplogVersion().encode()) })); };
    sock.onopen = hello;
    sock.onmessage = (ev) => {
      if (typeof ev.data === "string") {
        const msg = JSON.parse(ev.data);
        if (msg.type === "synced") {
          asking = false;
          state = "synced";
          retry = 0;
          sendNewer(version(msg.vv));
          caughtUp();
          firstSync();
        } else if (msg.type === "ack") {
          inflight.delete(msg.id);
          if (msg.need) sendNewer(version(msg.need));
          caughtUp();
        }
        return;
      }
      const view = new DataView(ev.data);
      if (view.getUint8(0) !== 1) return;
      if (doc.import(new Uint8Array(ev.data, 9)).pending && !asking) hello();
      invalidate();
      caughtUp();
    };
    sock.onclose = (ev) => {
      if (ws !== sock) return;
      ws = null;
      inflight.clear();
      asking = false;
      if (ev.code === 4001) { state = "unauthorized"; log("sync: the server rejected the token"); firstSync(); return; }
      state = "offline";
      if (closed) return;
      const wait = Math.min(30000, 1000 * 2 ** retry++);
      log(`sync: offline, retrying in ${wait / 1000}s`);
      timer = setTimeout(connect, wait);
    };
    sock.onerror = () => {}; // onclose follows
  }

  const unsubscribe = doc.subscribeLocalUpdates((update) => send(update));
  connect();

  return {
    get state() { return state; },
    // the first "synced" (or a rejected token), at most `ms` from now
    ready: (ms = 15000) => Promise.race([ready, new Promise((r) => setTimeout(r, ms).unref())]).then(() => state === "synced"),
    // true once the server has acked every local change, false after `ms`
    flushed(ms = 10000) {
      if (settled()) return Promise.resolve(true);
      return new Promise((resolve) => {
        const fn = (ok) => { clearTimeout(t); resolve(ok); };
        const t = setTimeout(() => { waiters.delete(fn); resolve(false); }, ms);
        waiters.add(fn);
      });
    },
    close() {
      closed = true;
      clearTimeout(timer);
      unsubscribe();
      if (ws) { ws.onclose = null; ws.close(); ws = null; }
    },
  };
}
