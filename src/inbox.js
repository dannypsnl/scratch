import * as Neutralino from "@neutralinojs/lib";
import { persistence, inNeutralino } from "./persist.js";
import { importRemote, saveNow } from "./store.js";

// Changes written by another process on this computer: the MCP server, when
// the notebook is not synced (mcp/inbox.js), drops each as a Loro update
// file <data dir>/scratch/inbox/<time>-<random>.loro. They are merged like
// updates from the sync relay, at load and whenever the directory changes,
// and a file is removed once the notebook holding it is saved.

let draining = Promise.resolve(), again = false;

export async function watchInbox() {
  if (!inNeutralino) return;
  const dir = persistence.dir() + "/inbox";
  try { await Neutralino.filesystem.getStats(dir); } catch { await Neutralino.filesystem.createDirectory(dir); }
  const drain = () => {
    if (again) return draining;
    again = true;
    return (draining = draining.then(() => { again = false; return take(dir); }).catch((e) => console.error("reading the inbox failed", e)));
  };
  const id = await Neutralino.filesystem.createWatcher(dir);
  Neutralino.events.on("watchFile", (e) => { if (e.detail?.id === id) drain(); });
  await drain();
}

async function take(dir) {
  const names = (await Neutralino.filesystem.readDirectory(dir))
    .filter((e) => e.type === "FILE" && e.entry.endsWith(".loro"))
    .map((e) => e.entry)
    .sort();
  if (!names.length) return;
  const done = [];
  for (const name of names) {
    const bytes = new Uint8Array(await Neutralino.filesystem.readBinaryFile(`${dir}/${name}`));
    // one that waits on changes the notebook lacks stays until they come
    try { if (importRemote(bytes)) done.push(name); }
    catch (e) { console.error(`inbox: ${name} did not load`, e); done.push(name); }
  }
  await saveNow();
  for (const name of done) await Neutralino.filesystem.remove(`${dir}/${name}`);
}
