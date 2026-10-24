import { VersionVector } from "loro-crdt/base64";
import { doc } from "./loro.js";
import { flush, importRemote, getMeta, saveMeta, saveProgress } from "./store.js";
import { flushUploads } from "./images.js";

// Client side of the sync relay (sync/src/index.js).
//
// Progress is two numbers kept in meta:
//   seq     the last server sequence received, sent in "hello" on connect
//   acked   the Loro version the server is known to have from us; on connect
//           everything newer is sent, which covers edits made offline
// Both are kept only once the snapshot holding what they count is saved
// (store.js). An update that waits on changes this device lacks means some
// were lost all the same: the whole log is asked for again, once.
//
// Live, every local Loro change is sent as it is committed and acked by id.

const statusListeners = new Set();
export const onStatus = (fn) => { statusListeners.add(fn); fn(status); return () => statusListeners.delete(fn); };
let status = { state: "off" }; // off | connecting | syncing | synced | offline | unauthorized
const setStatus = (s) => { status = s; for (const fn of statusListeners) fn(s); };

let ws = null;
let retry = 0;
let timer = null;
let nextId = 1;
const inflight = new Map(); // id -> version vector bytes at send time

const b64 = (bytes) => btoa(String.fromCharCode(...bytes));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export const config = () => getMeta().sync ?? null;

// A different server or notebook starts from scratch: everything is sent
// and everything is received.
export function configure(sync) {
  const old = config();
  const same = old && old.url === sync.url && (old.notebook ?? "main") === sync.notebook;
  saveMeta(same ? { sync } : { sync, seq: 0, acked: null });
  connect();
}

export function connect() {
  clearTimeout(timer);
  if (ws) { ws.onclose = null; ws.close(); ws = null; }
  const cfg = config();
  if (!cfg?.url) return setStatus({ state: "off" });

  const url = new URL(cfg.url);
  url.searchParams.set("token", cfg.token ?? "");
  if (cfg.notebook) url.searchParams.set("notebook", cfg.notebook);
  setStatus({ state: "connecting" });
  const sock = new WebSocket(url);
  sock.binaryType = "arraybuffer";
  ws = sock;
  // hellos not yet answered by "synced": until then the log may have a gap
  // below what arrives, so progress waits for the last "synced"
  let hellos = 0, resent = false;
  const hello = (since) => { hellos++; sock.send(JSON.stringify({ type: "hello", since })); };
  const advance = (seq) => { if (!hellos) saveProgress({ seq: Math.max(getMeta().seq ?? 0, seq) }); };

  sock.onopen = () => {
    retry = 0;
    setStatus({ state: "syncing" });
    hello(getMeta().seq ?? 0);
    // everything the server has not acknowledged from us, including offline edits
    flush();
    const acked = getMeta().acked;
    const from = acked ? VersionVector.decode(unb64(acked)) : undefined;
    if (!from || doc.oplogVersion().compare(from) !== 0) send(doc.export(from ? { mode: "update", from } : { mode: "update" }));
  };

  sock.onmessage = (ev) => {
    if (typeof ev.data === "string") {
      const msg = JSON.parse(ev.data);
      if (msg.type === "ack") {
        const vv = inflight.get(msg.id);
        inflight.delete(msg.id);
        saveProgress({ acked: vv ? b64(vv) : getMeta().acked });
        advance(msg.seq);
        if (!inflight.size && status.state === "synced") setStatus({ state: "synced" });
      } else if (msg.type === "synced") {
        hellos--;
        advance(msg.seq);
        if (hellos) return;
        setStatus({ state: "synced" });
        flushUploads();
      }
      return;
    }
    const view = new DataView(ev.data);
    if (view.getUint8(0) !== 1) return;
    const seq = Number(view.getBigUint64(1));
    if (!importRemote(new Uint8Array(ev.data, 9)) && !resent) {
      resent = true;
      saveProgress({ seq: 0 });
      hello(0);
      return;
    }
    advance(seq);
  };

  sock.onclose = (ev) => {
    if (ws !== sock) return;
    ws = null;
    inflight.clear();
    // a wrong token stays wrong: wait for a new one instead of retrying
    if (ev.code === 4001) return setStatus({ state: "unauthorized" });
    setStatus({ state: "offline" });
    timer = setTimeout(connect, Math.min(30000, 1000 * 2 ** retry++));
  };
  sock.onerror = () => {}; // onclose follows
}

// The blob routes answer 401 for the same reason.
export function unauthorized() {
  clearTimeout(timer);
  if (ws) { ws.onclose = null; ws.close(); ws = null; }
  setStatus({ state: "unauthorized" });
}

function send(update) {
  if (!ws || ws.readyState !== WebSocket.OPEN || !update.length) return;
  const id = nextId++;
  inflight.set(id, doc.oplogVersion().encode());
  const frame = new Uint8Array(4 + update.length);
  new DataView(frame.buffer).setUint32(0, id);
  frame.set(update, 4);
  ws.send(frame);
}

// Local commits go out as they happen; while offline they wait in the
// snapshot and are sent from `acked` on the next connect.
doc.subscribeLocalUpdates((update) => send(update));
