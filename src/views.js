import { allTasks, getViews, saveViews, updateBlockAttrs } from "./store.js";
import { compileFilter } from "./filter.js";
import { taskItem } from "./taskitem.js";
import { withTask } from "./outline.js";
import { md, weekday, today } from "./dates.js";
import { pageLabel } from "./taskitem.js";
import { place } from "./popover.js";
import { t as tr } from "./i18n.js";
import { drag, within } from "./dragspec.js";

// Saved views over all tasks, after GitHub Projects: each view is a filter,
// a grouping and a layout (list or board).

const defaultViews = () => [
  { name: tr("views.defaults")[0], filter: "-status:done", layout: "list", group: "status" },
  { name: tr("views.defaults")[1], filter: "", layout: "board", group: "none" },
  { name: tr("views.defaults")[2], filter: "has:deadline -status:done", layout: "list", group: "deadline" },
];

const STATUS_ORDER = ["doing", "todo", "done"];
const STATUSES = ["todo", "doing", "done"]; // the board's columns
const STATUS_NAME = { todo: "TODO", doing: "DOING", done: "DONE" };

const byDeadlineThenDate = (a, b) =>
  (a.deadline ?? "9999").localeCompare(b.deadline ?? "9999") || (b.date ?? "").localeCompare(a.date ?? "");

function groups(tasks, group) {
  switch (group) {
    case "status":
      return STATUS_ORDER.map((s) => [STATUS_NAME[s], tasks.filter((t) => t.task === s)]);
    case "date": // older saved views
    case "page": {
      // journal days newest first, then named pages by title
      const pages = [...new Set(tasks.map((t) => t.page))].sort((a, b) => {
        const da = tasks.find((t) => t.page === a).date, db = tasks.find((t) => t.page === b).date;
        if (da && db) return db.localeCompare(da);
        if (da || db) return da ? -1 : 1;
        return pageLabel(a).localeCompare(pageLabel(b));
      });
      return pages.map((p) => [pageLabel(p), tasks.filter((t) => t.page === p)]);
    }
    case "deadline": {
      const ds = [...new Set(tasks.map((t) => t.deadline ?? ""))].sort((a, b) => (a || "9999").localeCompare(b || "9999"));
      return ds.map((d) => [d ? tr("views.deadlineGroup", md(d), weekday(d)) : tr("views.noDeadline"), tasks.filter((t) => (t.deadline ?? "") === d)]);
    }
    default:
      return [["", tasks]];
  }
}

function labelsFor(t) {
  if (t.deadline && t.deadline < today() && t.task !== "done") return [{ text: tr("views.overdue"), cls: "overdue" }];
  if (t.completed) return [{ text: tr("views.completedOn", md(t.completed)), cls: "completed" }];
  return [];
}

export function renderTasks(root, ctx) {
  const views = getViews() ?? defaultViews();
  let active = Math.min(ctx.state.activeView ?? 0, views.length - 1);
  const v = views[active];
  const persist = () => saveViews(views);

  root.innerHTML = `
    <div class="tasks">
      <nav class="view-tabs"></nav>
      <div class="view-bar">
        <label class="vfilter-wrap"><span class="icon">⌕</span><input class="vfilter" placeholder="${tr("views.filter")}" spellcheck="false"></label>
        <div class="seg">
          <button data-layout="list">${tr("views.list")}</button><button data-layout="board">${tr("views.board")}</button>
        </div>
        <select class="vgroup"><option value="status">${tr("views.byStatus")}</option><option value="page">${tr("views.byPage")}</option><option value="deadline">${tr("views.byDeadline")}</option><option value="none">${tr("views.noGroup")}</option></select>
      </div>
      <div class="view-body"></div>
    </div>`;

  // ---- view tabs: the active one has a ⋯ menu; double-click renames ----
  const tabs = root.querySelector(".view-tabs");
  const rename = (tab) => {
    const input = document.createElement("input");
    input.className = "vrename";
    input.value = v.name;
    tab.replaceWith(input);
    input.focus();
    input.select();
    const done = (keep) => { if (keep) { v.name = input.value.trim() || tr("page.untitled"); persist(); } ctx.render(); };
    input.onkeydown = (e) => { if (e.key === "Enter") done(true); else if (e.key === "Escape") done(false); };
    input.onblur = () => done(true);
  };
  views.forEach((view, i) => {
    const tab = document.createElement("div");
    tab.className = "vtab" + (i === active ? " active" : "");
    const b = document.createElement("button");
    b.textContent = view.name;
    b.onclick = () => { if (i !== active) { ctx.state.activeView = i; ctx.render(); } };
    if (i === active) b.ondblclick = () => rename(tab);
    tab.append(b);
    if (i === active) {
      const more = document.createElement("button");
      more.className = "vmore";
      more.textContent = "⋯";
      more.onclick = () => openViewMenu(more, {
        rename: () => rename(tab),
        duplicate: () => { views.splice(active + 1, 0, { ...v, name: tr("views.copy", v.name) }); persist(); ctx.state.activeView = active + 1; ctx.render(); },
        remove: views.length > 1 ? () => { views.splice(active, 1); persist(); ctx.state.activeView = Math.max(0, active - 1); ctx.render(); } : null,
      });
      tab.append(more);
    }
    tabs.append(tab);
  });
  const add = document.createElement("button");
  add.className = "vadd";
  add.textContent = "+";
  add.title = tr("views.new");
  add.onclick = () => {
    views.push({ name: tr("views.newName"), filter: "-status:done", layout: "list", group: "status" });
    persist();
    ctx.state.activeView = views.length - 1;
    ctx.render();
  };
  tabs.append(add);

  // ---- toolbar ----
  const filter = root.querySelector(".vfilter");
  const group = root.querySelector(".vgroup");
  filter.value = v.filter;
  group.value = v.group;
  group.hidden = v.layout === "board";
  filter.oninput = () => { v.filter = filter.value; persist(); body(); };
  group.onchange = () => { v.group = group.value; persist(); body(); };
  for (const b of root.querySelectorAll(".seg button")) {
    b.classList.toggle("active", b.dataset.layout === v.layout);
    b.onclick = () => { if (v.layout !== b.dataset.layout) { v.layout = b.dataset.layout; persist(); ctx.render(); } };
  }

  const bodyEl = root.querySelector(".view-body");
  const itemCtx = {
    ...ctx,
    rerender(focusId) {
      body();
      bodyEl.querySelector(`.task-item[data-id="${focusId}"]`)?.focusEditor();
    },
  };

  function body() {
    ctx.untrack();
    bodyEl.replaceChildren();
    const pred = compileFilter(v.filter);
    const tasks = allTasks().filter(pred).sort(byDeadlineThenDate);
    if (v.layout === "board") return board(tasks);
    for (const [title, list] of groups(tasks, v.group)) {
      if (!list.length) continue;
      const sec = document.createElement("section");
      sec.className = "group";
      if (title) sec.innerHTML = `<h3>${title}<span class="count">${list.length}</span></h3>`;
      for (const t of list) sec.append(taskItem(t, itemCtx, labelsFor(t)));
      bodyEl.append(sec);
    }
    if (!tasks.length) bodyEl.innerHTML = `<p class="empty">${tr("views.empty")}</p>`;
  }

  // The board: a column per status, each a vertical list of cards, drawn
  // by `card`. columns: status -> its tasks, in order.
  function boardOf(columns, card) {
    const cols = document.createElement("div");
    cols.className = "board";
    for (const s of STATUSES) {
      const col = document.createElement("section");
      col.className = `column col-${s}`;
      col.dataset.status = s;
      const list = columns.get(s);
      col.innerHTML = `<h3>${STATUS_NAME[s]}<span class="count">${list.length}</span></h3>`;
      for (const t of list) col.append(card(t));
      cols.append(col);
    }
    return cols;
  }

  // A column's order is the view's own, kept as it is dragged into
  // (v.order[status]: ids); tasks not placed yet follow, by deadline.
  const columnsOf = (tasks) => new Map(STATUSES.map((s) => {
    const rank = new Map((v.order?.[s] ?? []).map((id, k) => [id, k]));
    const at = (t) => rank.get(t.id) ?? rank.size;
    return [s, tasks.filter((t) => t.task === s).sort((a, b) => at(a) - at(b) || byDeadlineThenDate(a, b))];
  }));

  // A card dragged by its handle goes anywhere on the board (dragspec.js):
  // the places are the gaps of every column (status, index), worked out
  // once when the drag starts, from the cards on screen with the held one
  // left out: a gap's band runs from the middle of the card above to the
  // middle of the card below, across the column. The pointer's gap is drawn
  // as a line between the cards; let go, the card has that status and the
  // column that order.
  function board(tasks) {
    const columns = columnsOf(tasks);
    let line = null;
    const live = boardOf(columns, (t) => {
      const card = taskItem(t, itemCtx, labelsFor(t));
      const handle = document.createElement("span");
      handle.className = "drag";
      handle.textContent = "⠿";
      handle.onmousedown = (e) => {
        const rest = new Map([...columns].map(([s, list]) => [s, list.filter((x) => x.id !== t.id)]));
        const state = { col: t.task, i: columns.get(t.task).indexOf(t) }; // its gap, with itself left out
        const same = (a, b) => a.col === b.col && a.i === b.i;
        return drag(e, {
          live,
          held: card,
          state,
          same,
          zones: () => {
            const box = live.getBoundingClientRect();
            const out = [];
            for (const col of live.querySelectorAll(":scope > .column")) {
              const r = col.getBoundingClientRect();
              const cards = [...col.querySelectorAll(":scope > .task-item")].filter((c) => c !== card).map((c) => c.getBoundingClientRect());
              const mid = (c) => (c.top + c.bottom) / 2;
              for (let i = 0; i <= cards.length; i++) {
                const band = { left: r.left, right: r.right, top: i ? mid(cards[i - 1]) : r.top, bottom: i < cards.length ? mid(cards[i]) : r.bottom };
                const y = i < cards.length ? cards[i].top - 5 : cards.length ? cards[i - 1].bottom + 3 : col.querySelector("h3").getBoundingClientRect().bottom + 3;
                out.push({ state: { col: col.dataset.status, i }, band: within(box, band), line: { left: r.left + 8 - box.left, top: y - box.top, width: r.width - 16 } });
              }
            }
            return out;
          },
          show: (z) => {
            if (!z || same(z.state, state)) { line?.remove(); line = null; return; }
            line ??= document.body.appendChild(Object.assign(document.createElement("span"), { className: "drag-line" }));
            const box = live.getBoundingClientRect();
            Object.assign(line.style, { left: `${box.left + z.line.left}px`, top: `${box.top + z.line.top}px`, width: `${z.line.width}px` });
          },
          onDrop: ({ col, i }) => {
            const order = { ...(v.order ?? {}) };
            for (const s of STATUSES) if (order[s]) order[s] = order[s].filter((id) => id !== t.id);
            const list = rest.get(col);
            order[col] = [...list.slice(0, i), t, ...list.slice(i)].map((x) => x.id);
            v.order = order;
            persist();
            if (col !== t.task) updateBlockAttrs(t.id, (a) => withTask(a, col));
            body();
          },
        });
      };
      card.prepend(handle);
      return card;
    });
    bodyEl.append(live);
  }

  body();
}

// Small menu under a view's ⋯: rename, duplicate, delete (not the last view).
function openViewMenu(anchor, actions) {
  document.querySelector(".view-menu")?.remove();
  const box = document.createElement("div");
  box.className = "palette view-menu";
  const items = [["views.rename", actions.rename], ["views.duplicate", actions.duplicate], ["views.delete", actions.remove]];
  for (const [key, fn] of items) {
    if (!fn) continue;
    const b = document.createElement("button");
    b.textContent = tr(key);
    if (key === "views.delete") b.className = "danger";
    b.onmousedown = (e) => { e.preventDefault(); box.remove(); fn(); };
    box.append(b);
  }
  document.body.append(box);
  place(box, anchor.getBoundingClientRect());
  const away = (e) => { if (!box.contains(e.target)) { box.remove(); document.removeEventListener("mousedown", away); } };
  setTimeout(() => document.addEventListener("mousedown", away));
}
