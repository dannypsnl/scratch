import { place } from "./popover.js";

// Search menu at the caret, shared by [[ / # (pages) and (( (blocks).
// search(q) -> [{ label, sub, value }]; onPick(item, q);
// hint(q) -> a line under the list, or null (what a half-typed query still needs);
// onCancel(q, how): how is "escape", "backspace" (on an empty query) or "blur".
export function openPicker(view, { placeholder, initial = "", search, hint = () => null, onPick, onCancel }) {
  const coords = view.coordsAtPos(view.state.selection.from);
  const box = document.createElement("div");
  box.className = "palette picker";
  place(box, coords);
  const input = document.createElement("input");
  input.placeholder = placeholder;
  input.value = initial;
  const list = document.createElement("ul");
  const note = document.createElement("div");
  note.className = "hint";
  box.append(input, list, note);
  document.body.append(box);

  let items = [], active = 0, done = false;
  const finish = (fn) => {
    if (done) return;
    done = true;
    box.remove();
    view.focus();
    fn();
  };

  function render() {
    items = search(input.value);
    active = Math.min(active, Math.max(items.length - 1, 0));
    list.replaceChildren(...items.map((it, k) => {
      const li = document.createElement("li");
      li.className = k === active ? "active" : "";
      const label = document.createElement("span");
      label.className = "cmd";
      label.textContent = it.label;
      const sub = document.createElement("span");
      sub.className = "note";
      sub.textContent = it.sub ?? "";
      li.append(label, sub);
      li.onmousedown = (ev) => { ev.preventDefault(); finish(() => onPick(it, input.value)); };
      return li;
    }));
    const h = hint(input.value);
    note.textContent = h ?? "";
    note.hidden = !h;
  }

  input.addEventListener("input", () => { active = 0; render(); });
  input.addEventListener("keydown", (ev) => {
    if (ev.isComposing) return;
    if (ev.key === "ArrowDown") { active = (active + 1) % Math.max(items.length, 1); render(); ev.preventDefault(); }
    else if (ev.key === "ArrowUp") { active = (active - 1 + items.length) % Math.max(items.length, 1); render(); ev.preventDefault(); }
    else if (ev.key === "Enter" || ev.key === "Tab") {
      ev.preventDefault();
      const it = items[active];
      if (it) finish(() => onPick(it, input.value));
    } else if (ev.key === "Escape") {
      ev.preventDefault();
      finish(() => onCancel(input.value, "escape"));
    } else if (ev.key === "Backspace" && input.value === "") {
      ev.preventDefault();
      finish(() => onCancel("", "backspace"));
    }
  });
  input.addEventListener("blur", () => setTimeout(() => {
    if (document.hasFocus() && document.activeElement !== input) finish(() => onCancel(input.value, "blur"));
  }));
  render();
  input.focus();
}
