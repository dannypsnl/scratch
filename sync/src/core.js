// The relay's notebook, shared by the Cloudflare Worker (index.js) and the
// self-hosted server (../server.mjs): a Loro document of its own, kept from
// a log of every update received.
//
// A device says what it has as a Loro version vector, which comes from its
// document and so can never claim more than the document holds; the reply is
// exactly what it lacks, and the server's own version, from which the device
// sends what the server lacks. Nothing about progress is kept on either side.
//
// Wire format
//   client -> server  text   {"type":"hello","vv":<base64 version vector>}
//                     binary [u32 id][loro update]          (acked by id)
//   server -> client  binary [u8 1][u64 seq][loro update]
//                     text   {"type":"synced","seq":<n>,"vv":<base64>}
//                     text   {"type":"ack","id":<id>,"seq":<n>[,"need":<base64>]}
// "need" (the server's version) when the update waits on changes the server
// lacks: the device sends everything newer than it. A device that receives
// an update it cannot apply says hello again.
//
// Earlier devices say {"type":"hello","since":<seq>} and get the log after
// that sequence number, as before.
//
// store: rows(after) -> iterable of { seq, data }; append(data) -> seq;
// snapshot() -> { seq, data } | null; saveSnapshot(seq, data).

const b64 = (bytes) => { let s = ""; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s); };
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export function updateFrame(seq, update) {
  const bytes = new Uint8Array(update);
  const frame = new Uint8Array(9 + bytes.length);
  const view = new DataView(frame.buffer);
  view.setUint8(0, 1);
  view.setBigUint64(1, BigInt(seq));
  frame.set(bytes, 9);
  return frame;
}

export function notebook({ LoroDoc, VersionVector, decodeImportBlobMeta }, store, { snapshotEvery = 500 } = {}) {
  const doc = new LoroDoc();
  let snapSeq = 0, seq = 0;
  // ends of updates that waited on missing changes: no snapshot until they
  // are in, since a snapshot leaves out what still waits
  let waiting = [];
  const has = (end) => { const c = doc.oplogVersion().compare(end); return c === 0 || c === 1; };

  function load() {
    const snap = store.snapshot();
    if (snap) { doc.import(new Uint8Array(snap.data)); snapSeq = seq = snap.seq; }
    for (const row of store.rows(snapSeq)) take(new Uint8Array(row.data)), (seq = row.seq);
  }
  function take(update) {
    const { pending } = doc.import(update);
    if (pending) waiting.push(decodeImportBlobMeta(update, false).partialEndVersionVector);
    return !pending;
  }
  const version = () => b64(doc.oplogVersion().encode());

  load();

  return {
    // -> messages for the device saying hello
    hello(msg) {
      if (msg.vv === undefined) {
        const out = [];
        let last = Number(msg.since) || 0;
        for (const row of store.rows(last)) { out.push(updateFrame(row.seq, row.data)); last = row.seq; }
        out.push(JSON.stringify({ type: "synced", seq: last }));
        return out;
      }
      const from = msg.vv ? VersionVector.decode(unb64(msg.vv)) : undefined;
      // an update with nothing in it is still a few bytes: compare instead
      const behind = !from || ![0, -1].includes(doc.oplogVersion().compare(from));
      const out = behind ? [updateFrame(seq, doc.export(from ? { mode: "update", from } : { mode: "update" }))] : [];
      out.push(JSON.stringify({ type: "synced", seq, vv: version() }));
      return out;
    },
    // -> { frame for the other devices, ack for the sender }
    update(id, data) {
      const update = new Uint8Array(data);
      const complete = take(update);
      seq = store.append(update);
      if (seq - snapSeq >= snapshotEvery) {
        waiting = waiting.filter((end) => !has(end));
        if (!waiting.length) { store.saveSnapshot(seq, doc.export({ mode: "snapshot" })); snapSeq = seq; }
      }
      const ack = { type: "ack", id, seq };
      if (!complete) ack.need = version();
      return { frame: updateFrame(seq, update), ack: JSON.stringify(ack) };
    },
  };
}
