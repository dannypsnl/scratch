import * as Neutralino from "@neutralinojs/lib";
import { logFrame, readLog } from "./updatelog.js";

// Local persistence: the Loro snapshot and the log of updates made since it
// (store.js), a small JSON meta record (sync settings and progress), and
// image files. Inside Neutralino these are files in the app's data
// directory; in a plain browser, IndexedDB.
//
//   load()               -> { snapshot, updates: [bytes], meta }
//   appendUpdate(bytes)  adds to the log
//   saveSnapshot(bytes)  replaces the snapshot and empties the log

export const inNeutralino = typeof window !== "undefined" && !!window.NL_PORT;

function idb() {
  const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  let db;
  const kv = (mode, store = "kv") => db.transaction(store, mode).objectStore(store);
  // log entries are keys "u:000000000001"… in the kv store, in order
  const LOG = () => IDBKeyRange.bound("u:", "u:\uffff");
  let next = 0;
  return {
    async open() {
      const open = indexedDB.open("scratch", 1);
      open.onupgradeneeded = () => {
        for (const name of ["kv", "images"]) if (!open.result.objectStoreNames.contains(name)) open.result.createObjectStore(name);
      };
      db = await req(open);
    },
    saveImage: (name, bytes) => req(kv("readwrite", "images").put(bytes, name)),
    async loadImage(name) {
      const bytes = await req(kv("readonly", "images").get(name));
      return bytes ? new Uint8Array(bytes) : null;
    },
    async load() {
      const snapshot = await req(kv("readonly").get("snapshot"));
      const meta = await req(kv("readonly").get("meta"));
      const keys = await req(kv("readonly").getAllKeys(LOG()));
      const updates = await req(kv("readonly").getAll(LOG()));
      next = keys.length ? Number(keys[keys.length - 1].slice(2)) + 1 : 0;
      return { snapshot: snapshot ? new Uint8Array(snapshot) : null, updates: updates.map((u) => new Uint8Array(u)), meta: meta ?? {} };
    },
    appendUpdate: (bytes) => req(kv("readwrite").put(bytes, "u:" + String(next++).padStart(12, "0"))),
    // in one transaction: never a new snapshot with the old log, or the reverse
    saveSnapshot(bytes) {
      const tx = db.transaction("kv", "readwrite");
      tx.objectStore("kv").put(bytes, "snapshot");
      tx.objectStore("kv").delete(LOG());
      next = 0;
      return new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
    },
    saveMeta: (meta) => kv("readwrite").put(meta, "meta"),
  };
}

function files() {
  let dir;
  const exists = async (p) => { try { await Neutralino.filesystem.getStats(p); return true; } catch { return false; } };
  return {
    async open() {
      Neutralino.init();
      dir = (await Neutralino.os.getPath("data")) + "/scratch";
      if (!(await exists(dir))) await Neutralino.filesystem.createDirectory(dir);
      if (!(await exists(dir + "/images"))) await Neutralino.filesystem.createDirectory(dir + "/images");
    },
    saveImage: (name, bytes) =>
      Neutralino.filesystem.writeBinaryFile(`${dir}/images/${name}`, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)),
    async loadImage(name) {
      const path = `${dir}/images/${name}`;
      return (await exists(path)) ? new Uint8Array(await Neutralino.filesystem.readBinaryFile(path)) : null;
    },
    async load() {
      const snapshot = (await exists(dir + "/notebook.loro"))
        ? new Uint8Array(await Neutralino.filesystem.readBinaryFile(dir + "/notebook.loro"))
        : null;
      const updates = (await exists(dir + "/notebook.log"))
        ? readLog(await Neutralino.filesystem.readBinaryFile(dir + "/notebook.log"))
        : [];
      const meta = (await exists(dir + "/meta.json"))
        ? JSON.parse(await Neutralino.filesystem.readFile(dir + "/meta.json"))
        : {};
      return { snapshot, updates, meta };
    },
    appendUpdate: (bytes) => Neutralino.filesystem.appendBinaryFile(dir + "/notebook.log", logFrame(bytes).buffer),
    // write to a temp file and rename, so a crash never leaves half a
    // snapshot; then the log goes (a crash before that leaves updates the
    // snapshot already holds, which import again as nothing)
    async saveSnapshot(bytes) {
      await Neutralino.filesystem.writeBinaryFile(dir + "/notebook.loro.tmp", bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
      await Neutralino.filesystem.move(dir + "/notebook.loro.tmp", dir + "/notebook.loro");
      if (await exists(dir + "/notebook.log")) await Neutralino.filesystem.remove(dir + "/notebook.log");
    },
    saveMeta: (meta) => Neutralino.filesystem.writeFile(dir + "/meta.json", JSON.stringify(meta)),
    dir: () => dir,
  };
}

export const persistence = inNeutralino ? files() : idb();
