import { VersionVector } from "loro-crdt/base64";
import { invalidate } from "../src/loro.js";

// The MCP server as one more device on the sync relay (sync/server.mjs, or
// the Cloudflare Worker): the same protocol as the app's src/sync.js.
//
//   seq     the last server sequence received, sent in "hello" on reconnect
//   acked   the Loro version the server is known to have; on reconnect
//           everything newer is sent
//
// It starts empty and takes the whole notebook from the server, so it keeps
// nothing on disk. A write is done once the server has acked it.

export function syncClient(doc, { url, token, notebook, log = () => {} }) {
  let ws = null, retry = 0, timer = null, nextId = 1, closed = false;
  let seq = 0, acked = null, pending = false;
  let state = "connecting"; // connecting | synced | offline | unauthorized
  const inflight = new Map(); // id -> version at send time
  const waiters = new Set(); // resolved when the server has everything

  let firstSync;
  const ready = new Promise((resolve) => { firstSync = resolve; });

  const settled = () => !inflight.size && !pending;
  // with nothing of ours in flight, the server has all we have
  const caughtUp = () => {
    if (!settled()) return;
    acked = doc.oplogVersion().encode();
    for (const fn of waiters) fn(true);
    waiters.clear();
  };

  function send(update) {
    if (!ws || ws.readyState !== WebSocket.OPEN || state !== "synced") { pending = true; return; }
    const id = nextId++;
    inflight.set(id, doc.oplogVersion().encode());
    const frame = new Uint8Array(4 + update.length);
    new DataView(frame.buffer).setUint32(0, id);
    frame.set(update, 4);
    ws.send(frame);
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
    sock.onopen = () => sock.send(JSON.stringify({ type: "hello", since: seq }));
    sock.onmessage = (ev) => {
      if (typeof ev.data === "string") {
        const msg = JSON.parse(ev.data);
        if (msg.type === "synced") {
          seq = Math.max(seq, msg.seq);
          state = "synced";
          retry = 0;
          // what was written while offline
          const from = acked ? VersionVector.decode(acked) : null;
          if (pending || (from && doc.oplogVersion().compare(from) !== 0)) {
            pending = false;
            const update = doc.export(from ? { mode: "update", from } : { mode: "update" });
            if (update.length) send(update);
          }
          caughtUp();
          firstSync();
        } else if (msg.type === "ack") {
          const vv = inflight.get(msg.id);
          inflight.delete(msg.id);
          seq = Math.max(seq, msg.seq);
          if (vv) acked = vv;
          caughtUp();
        }
        return;
      }
      const view = new DataView(ev.data);
      if (view.getUint8(0) !== 1) return;
      seq = Math.max(seq, Number(view.getBigUint64(1)));
      doc.import(new Uint8Array(ev.data, 9));
      invalidate();
      if (state === "synced") caughtUp();
    };
    sock.onclose = (ev) => {
      if (ws !== sock) return;
      ws = null;
      // unacked updates are sent again from `acked` on reconnect
      if (inflight.size) pending = true;
      inflight.clear();
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
      if (settled() && state === "synced") return Promise.resolve(true);
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
