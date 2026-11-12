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
  // once when the drag starts from the cards on screen with the held one
  // taken out as a hole (the cards under it closing up): a gap's band runs
  // from the middle of the card above to the middle of the card below,
  // across the column. The pointer's gap is shown by the cards making room
  // for it and a faded copy of the held card in that room, all by transform
  // (nothing is laid out again, so the gaps stay true); let go, the card
  // has that status and the column that order.
  function board(tasks) {
    const columns = columnsOf(tasks);
    const live = boardOf(columns, (t) => {
      const card = taskItem(t, itemCtx, labelsFor(t));
      const handle = document.createElement("span");
      handle.className = "drag";
      handle.textContent = "⠿";
      handle.onmousedown = (e) => {
        const rest = new Map([...columns].map(([s, list]) => [s, list.filter((x) => x.id !== t.id)]));
        const state = { col: t.task, i: columns.get(t.task).indexOf(t) }; // its gap, with itself left out
        const same = (a, b) => a.col === b.col && a.i === b.i;
        let cols = null; // per column: { status, cards: [{ el, top (static), shift (closing the hole) }], ... }
        let held = null; // the held card's box and room (height with its margin)
        const shown = new Map(); // element -> the transform it has now
        const put = (el, tf) => { if (shown.get(el) !== tf) { shown.set(el, tf); el.style.transform = tf; } };
        const px = (n) => Math.round(n * 2) / 2 || 0; // to half a pixel; a hole closed and opened again is no move
        return drag(e, {
          live,
          held: card,
          state,
          same,
          zones: () => {
            const box = live.getBoundingClientRect();
            const h = card.getBoundingClientRect();
            held = { colLeft: card.closest(".column").getBoundingClientRect().left, top: h.top, room: h.height + parseFloat(getComputedStyle(card).marginBottom) };
            const out = [];
            cols = [...live.querySelectorAll(":scope > .column")].map((col) => {
              const r = col.getBoundingClientRect();
              let below = false; // past the hole, in its column
              const cards = [...col.querySelectorAll(":scope > .task-item")].flatMap((el) => {
                if (el === card) { below = true; return []; }
                const b = el.getBoundingClientRect(), shift = below ? -held.room : 0;
                return [{ el, top: b.top + shift, mid: (b.top + b.bottom) / 2 + shift, bottom: b.bottom + shift, shift }];
              });
              const c = { status: col.dataset.status, el: col, left: r.left, cards };
              const head = col.querySelector("h3").getBoundingClientRect().bottom + 3;
              for (let i = 0; i <= cards.length; i++) {
                const band = { left: r.left, right: r.right, top: i ? cards[i - 1].mid : r.top, bottom: i < cards.length ? cards[i].mid : r.bottom };
                const land = i < cards.length ? cards[i].top : cards.length ? cards[i - 1].bottom + (held.room - h.height) : head;
                out.push({ state: { col: c.status, i }, band: within(box, band), hold: within(box, { ...band, bottom: band.bottom + held.room }), col: c, i, land });
              }
              return c;
            });
            return out;
          },
          show: (z) => {
            for (const c of cols) {
              c.cards.forEach(({ el, shift }, k) => { const dy = px(z ? shift + (c === z.col && k >= z.i ? held.room : 0) : 0); put(el, dy ? `translateY(${dy}px)` : ""); });
              c.el.style.paddingBottom = z && c === z.col && c.status !== t.task ? `${held.room + 8}px` : ""; // the column grows to hold the room (its cards only move)
            }
            const dx = px(z ? z.col.left - held.colLeft : 0), dy = px(z ? z.land - held.top : 0);
            put(card, dx || dy ? `translate(${dx}px, ${dy}px)` : "");
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
