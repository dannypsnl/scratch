import { DOMSerializer } from "prosemirror-model";
import { backlinks, isDate, titleOf, getFields, savePageFields, setBlockProp } from "./store.js";
import { openFieldEditor, openValueEditor, displayValue } from "./fields.js";
import { place } from "./popover.js";
import { schema } from "./schema.js";
import { compileFilter } from "./filter.js";
import { taskIconHTML } from "./outline.js";
import { pageLabel } from "./taskitem.js";
import { hooks } from "./editor.js";
import { md } from "./dates.js";
import { t } from "./i18n.js";

// A named page's linked blocks as a table: every block elsewhere whose line
// links or tags this page is a row. Columns: content, page, the fields this
// page defines (editable in place), status, deadline. Headers sort, the
// filter box takes the task-view syntax. Fields are managed in the header:
// "+" at its end adds one, a field's header opens its menu.

const STATUS_ORDER = { doing: 0, todo: 1, done: 2 };
const sortState = new Map(); // page -> { key, dir }
const filterState = new Map(); // page -> filter text

const COLUMNS = [
  { key: "text", label: () => t("table.content"), cmp: (a, b) => a.text.localeCompare(b.text) },
  {
    key: "page",
    label: () => t("table.page"),
    // journal days newest first, then named pages by title
    cmp: (a, b) => (a.date && b.date ? b.date.localeCompare(a.date) : a.date ? -1 : b.date ? 1 : pageLabel(a.page).localeCompare(pageLabel(b.page))),
  },
  { key: "task", label: () => t("table.status"), cmp: (a, b) => (STATUS_ORDER[a.task] ?? 3) - (STATUS_ORDER[b.task] ?? 3) },
  { key: "deadline", label: () => t("table.deadline"), cmp: (a, b) => (a.deadline ?? "9999").localeCompare(b.deadline ?? "9999") },
];

function rowsFor(page) {
  return backlinks(page)
    .filter((b) => b.page !== page)
    .map((b) => {
      const links = [];
      b.node.firstChild.forEach((n) => { if (n.type.name === "link") links.push(titleOf(n.attrs.page)); });
      return { ...b, ...b.node.attrs, date: isDate(b.page) ? b.page : null, links };
    });
}

export function renderPageTable(el, page, ctx) {
  const all = rowsFor(page);
  const fields = getFields(page);
  const rerender = () => renderPageTable(el, page, ctx);
  el.className = "page-table";
  el.replaceChildren();
  el.hidden = false;

  const head = document.createElement("div");
  head.className = "table-head";
  head.innerHTML = `<h3>${t("backlinks.title")}<span class="count">${all.length}</span></h3>`;
  const filter = document.createElement("input");
  filter.className = "table-filter";
  filter.placeholder = t("table.filter");
  filter.value = filterState.get(page) ?? "";
  head.append(filter);
  el.append(head);

  const table = document.createElement("table");
  el.append(table);
  const serializer = DOMSerializer.fromSchema(schema);

  const fieldColumns = fields.map((f) => ({
    key: "field:" + f.id,
    field: f,
    label: () => f.name,
    cmp: (a, b) => String(a.props?.[f.id] ?? "\uffff").localeCompare(String(b.props?.[f.id] ?? "\uffff")),
  }));
  const columns = [COLUMNS[0], COLUMNS[1], ...fieldColumns, COLUMNS[2], COLUMNS[3]];

  const draw = () => {
    const sort = sortState.get(page) ?? { key: "page", dir: 1 };
    const col = columns.find((c) => c.key === sort.key) ?? COLUMNS[1];
    const rows = all.filter(compileFilter(filter.value)).sort((a, b) => sort.dir * col.cmp(a, b));
    const thead = document.createElement("thead");
    const tr = document.createElement("tr");
    // "+" sits where a new field lands: after the user's fields, before the
    // built-in status and deadline
    const add = document.createElement("th");
    add.className = "col-add";
    add.textContent = "+";
    add.title = t("fields.add");
    add.onclick = () => openFieldEditor(add, null, { onSave: (nf) => { savePageFields(page, [...fields, nf]); rerender(); } });
    for (const c of columns) {
      if (c === COLUMNS[2]) tr.append(add);
      const th = document.createElement("th");
      th.textContent = c.label() + (c.key === sort.key ? (sort.dir > 0 ? " ↓" : " ↑") : "");
      // built-in columns sort on click; a field's header opens its menu
      th.onclick = c.field
        ? () => openColumnMenu(th, {
            sort: (dir) => { sortState.set(page, { key: c.key, dir }); draw(); },
            edit: () => openFieldEditor(th, c.field, {
              onSave: (nf) => { savePageFields(page, fields.map((x) => (x.id === nf.id ? nf : x))); rerender(); },
              onDelete: () => { savePageFields(page, fields.filter((x) => x.id !== c.field.id)); rerender(); },
            }),
            remove: () => { savePageFields(page, fields.filter((x) => x.id !== c.field.id)); rerender(); },
          })
        : () => { sortState.set(page, { key: c.key, dir: c.key === sort.key ? -sort.dir : 1 }); draw(); };
      if (c.field) th.className = "field-head";
      tr.append(th);
    }
    thead.append(tr);
    const tbody = document.createElement("tbody");
    for (const r of rows) {
      const row = document.createElement("tr");
      const content = document.createElement("td");
      content.className = "cell-content";
      content.append(serializer.serializeFragment(r.node.firstChild.content));
      // every row tags this page; showing that tag again says nothing
      for (const tag of content.querySelectorAll(`.pm-link[data-page="${page}"]`)) tag.remove();
      content.onclick = () => hooks.openBlock(r.id);
      const where = document.createElement("td");
      const chip = document.createElement("a");
      chip.href = "#";
      chip.className = "chip";
      chip.textContent = pageLabel(r.page);
      chip.onclick = (e) => { e.preventDefault(); ctx.openPage(r.page); };
      where.append(chip);
      const status = document.createElement("td");
      status.innerHTML = r.task ? taskIconHTML(r.task) : "";
      const due = document.createElement("td");
      due.className = "cell-due" + (r.deadline && r.deadline < new Date().toLocaleDateString("sv") && r.task !== "done" ? " overdue" : "");
      due.textContent = r.deadline ? md(r.deadline) : "";
      const cells = fieldColumns.map(({ field }) => {
        const td = document.createElement("td");
        td.className = "cell-field";
        const shown = displayValue(field, r.props?.[field.id]);
        td.textContent = shown ?? "";
        td.onclick = () => openValueEditor(td, field, r.props?.[field.id], (v) => { setBlockProp(r.id, field.id, v); rerender(); }, (opt) => {
          savePageFields(page, fields.map((x) => (x.id === field.id ? { ...x, options: [...(x.options ?? []), opt] } : x)));
        });
        return td;
      });
      row.append(content, where, ...cells, document.createElement("td"), status, due);
      tbody.append(row);
    }
    if (!rows.length) tbody.innerHTML = `<tr><td colspan="${columns.length + 1}" class="empty">${all.length ? t("views.empty") : t("table.none")}</td></tr>`;
    table.replaceChildren(thead, tbody);
  };
  filter.oninput = () => { filterState.set(page, filter.value); draw(); };
  draw();
}

// A field column's header menu: sort either way, edit or delete the field.
function openColumnMenu(anchor, { sort, edit, remove }) {
  document.querySelector(".view-menu")?.remove();
  const box = document.createElement("div");
  box.className = "palette view-menu";
  const items = [
    [t("table.sortAsc"), () => sort(1)],
    [t("table.sortDesc"), () => sort(-1)],
    [t("fields.edit"), edit],
    [t("fields.delete"), remove, "danger"],
  ];
  for (const [label, fn, cls] of items) {
    const b = document.createElement("button");
    b.textContent = label;
    if (cls) b.className = cls;
    b.onmousedown = (e) => { e.preventDefault(); box.remove(); fn(); };
    box.append(b);
  }
  document.body.append(box);
  place(box, anchor.getBoundingClientRect());
  const away = (e) => { if (!box.contains(e.target)) { box.remove(); document.removeEventListener("mousedown", away); } };
  setTimeout(() => document.addEventListener("mousedown", away));
}
