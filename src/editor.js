import { EditorState, TextSelection } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { Fragment } from "prosemirror-model";
import { keymap } from "prosemirror-keymap";
import { baseKeymap, toggleMark } from "prosemirror-commands";
import { history, undo, redo } from "prosemirror-history";
import { schema } from "./schema.js";
import { parseMath, serializeMath } from "./latex.js";
import { parseInline, parseOutline, serializeInline, serializeOutline } from "./outline-io.js";
import { horizontal, vertical, term, formula, backspace, deleteForward, exitMath, inMath, typeInMath, insertMath, navGuard, besideSpecial } from "./nav.js";
import { splitBlock, indent, outdent, joinBackward, cycleTask, selectAll, setFold, toggleFoldAt, blockIds, outlineDecorations } from "./outline.js";
import { openPalette } from "./palette.js";
import { openPicker } from "./picker.js";
import { addImage, imageURL, isImageFile } from "./images.js";
import { newId } from "./outline-io.js";
import * as Neutralino from "@neutralinojs/lib";
import { inNeutralino } from "./persist.js";
import { findPage, createPage, namedPages, pageDates, titleOf, isDate } from "./store.js";
import { openDeadlinePicker } from "./deadline.js";
import { mathDecorations } from "./decorations.js";
import { scriptStacking } from "./stack.js";
import { t } from "./i18n.js";

const T = schema.nodes;

// Formula keys first: each returns false outside a formula and falls through.
const mathKeys = keymap({
  ArrowLeft: horizontal(-1),
  ArrowRight: horizontal(1),
  "Alt-ArrowLeft": term(-1),
  "Alt-ArrowRight": term(1),
  "Mod-ArrowLeft": formula(-1),
  "Mod-ArrowRight": formula(1),
  ArrowUp: vertical(-1),
  ArrowDown: vertical(1),
  Backspace: backspace,
  Delete: deleteForward,
  Enter: exitMath,
  Escape: exitMath,
});

const outlineKeys = keymap({
  Enter: splitBlock,
  Tab: indent,
  "Shift-Tab": outdent,
  Backspace: joinBackward,
  "Mod-Enter": cycleTask,
  "Mod-a": selectAll,
  "Mod-ArrowUp": setFold(true),
  "Mod-ArrowDown": setFold(false),
  "Mod-Shift-d": (_state, _dispatch, view) => { if (view) openDeadlinePicker(view); return true; },
  "Mod-b": toggleMark(schema.marks.strong),
  "Mod-i": toggleMark(schema.marks.em),
  "Mod-e": toggleMark(schema.marks.code),
  "Mod-z": undo,
  "Mod-Shift-z": redo,
  "Mod-y": redo,
});

// Web pages open in the system browser (Neutralino) or a new tab.
export function openExternal(url) {
  if (inNeutralino) Neutralino.os.open(url);
  else window.open(url, "_blank", "noopener");
}

// Navigation out of an editor (clicking a link or a block reference).
export const hooks = { openPage: (_id) => {}, openBlock: (_id) => {} };

const insertInline = (view, node) =>
  view.dispatch(view.state.tr.replaceSelectionWith(node, false).scrollIntoView());
const insertText = (view, text) => { if (text) view.dispatch(view.state.tr.insertText(text)); };

// match quality: prefix < substring; null = no match
function rank(title, q) {
  const t = title.toLowerCase(), k = q.trim().toLowerCase();
  if (!k) return 1;
  if (t === k) return 0;
  if (t.startsWith(k)) return 1;
  return t.includes(k) ? 2 : null;
}

// [[ or #: pick a page or create one. Cancelling leaves the typed text.
function startLink(view, tag, initial = "") {
  openPicker(view, {
    placeholder: tag ? t("picker.tag") : t("picker.page"),
    initial,
    search(q) {
      const pages = [
        ...namedPages().map((p) => ({ value: p.id, label: p.title, sub: t("picker.kindPage") })),
        ...[...pageDates()].map((d) => ({ value: d, label: titleOf(d), sub: t("picker.kindJournal") })),
      ];
      const hits = pages
        .map((p) => ({ p, r: rank(p.label, q) }))
        .filter((x) => x.r !== null)
        .sort((a, b) => a.r - b.r || a.p.label.localeCompare(b.p.label))
        .slice(0, 8)
        .map((x) => x.p);
      const title = q.trim();
      if (title && !findPage(title)) hits.push({ value: null, label: t("picker.create", title), sub: t("picker.newPage") });
      if (title && isDate(title) && !hits.some((h) => h.value === title)) hits.unshift({ value: title, label: titleOf(title), sub: t("picker.kindJournal") });
      return hits;
    },
    onPick(item, q) {
      const page = item.value ?? createPage(q);
      insertInline(view, schema.nodes.link.create({ page, tag }));
    },
    // Backspace on the empty menu takes back what opened it ([[ or #)
    onCancel: (q, how) => { if (how !== "backspace") insertText(view, (tag ? "#" : "[[") + q); },
  });
}

// Returns false when the character should be inserted as plain text.
// `rest` is what follows ch in the same input event; menus receive it.
function typed(view, ch, rest = "") {
  const $head = view.state.selection.$head;
  // code is plain text: no formulas, links or tags
  if ($head.parent.type.spec.code || inCode($head)) return false;
  if (ch === "`" && closeInlineCode(view)) return true;
  if (!inMath($head)) {
    if (ch === "$") return insertMath(view.state, view.dispatch);
    const before = $head.nodeBefore?.isText ? $head.nodeBefore.text.slice(-1) : "";
    if (ch === "[" && before === "[") {
      view.dispatch(view.state.tr.delete($head.pos - 1, $head.pos));
      startLink(view, false, rest);
      return true;
    }
    if (ch === "#") { startLink(view, true, rest); return true; }
    // right beside a formula or an atom (tag, link, image) the DOM caret may
    // sit inside it (see navGuard), so the browser must not do the inserting
    if (besideSpecial($head)) {
      view.dispatch(view.state.tr.insertText(ch).scrollIntoView());
      return true;
    }
    return false;
  }
  if (!typeInMath(view, ch)) {
    // "\": clear any selection first, then summon the palette at the caret
    if (!view.state.selection.empty) view.dispatch(view.state.tr.deleteSelection());
    openPalette(view, rest);
  }
  return true;
}

const inCode = ($p) => $p.marks().some((m) => m.type === schema.marks.code) ||
  ($p.nodeBefore?.marks.some((m) => m.type === schema.marks.code) && $p.nodeAfter?.marks.some((m) => m.type === schema.marks.code));

// `…` closes into inline code: the text since the opening backtick (in the
// same plain run, not empty) becomes code.
function closeInlineCode(view) {
  const { $head, empty } = view.state.selection;
  const run = $head.nodeBefore;
  if (!empty || !run?.isText || run.marks.length) return false;
  const text = run.text; // nodeBefore is already cut at the caret
  const open = text.lastIndexOf("`");
  if (open < 0 || open === text.length - 1) return false;
  const from = $head.pos - (text.length - open);
  const tr = view.state.tr.replaceWith(from, $head.pos, schema.text(text.slice(open + 1), [schema.marks.code.create()]));
  view.dispatch(tr.setStoredMarks([]).scrollIntoView());
  return true;
}

// Copy writes the outline text format (lossless apart from block ids), and
// paste reads it back, so structure, formulas and task states survive.
function sliceToText(slice) {
  const first = slice.content.firstChild;
  if (!first) return "";
  if (first.type === T.block || first.type === T.line || first.type === T.codeblock) return serializeOutline(T.doc.create(null, slice.content));
  if (first.type.spec.group?.includes("mathinline") && !first.isText) return serializeMath(slice.content);
  return serializeInline(slice.content);
}

// Pasted or dropped image files: each becomes its own block.
async function insertImages(view, files) {
  const names = await Promise.all(files.map(addImage));
  const blocks = names.map((src) => T.block.create({ id: newId() }, T.line.create(null, T.image.create({ src }))));
  pasteBlocks(view, T.doc.create(null, blocks));
}

// Images load asynchronously (local store, else the server).
function imageView(node) {
  const dom = document.createElement("img");
  dom.className = "pm-image";
  dom.alt = node.attrs.alt;
  dom.draggable = false;
  imageURL(node.attrs.src).then((url) => {
    if (url) dom.src = url;
    else dom.classList.add("missing");
  });
  return { dom, ignoreMutation: () => true };
}

// Insert pasted blocks next to the caret's block (replacing it when it is an
// empty leaf), caret at the end of the last one.
function pasteBlocks(view, doc) {
  let tr = view.state.tr.deleteSelection();
  const $p = tr.selection.$from;
  let d = $p.depth;
  while (d > 0 && $p.node(d).type !== T.block) d--;
  if (d === 0) return false;
  const block = $p.node(d);
  const replace = block.childCount === 1 && block.firstChild.content.size === 0;
  const at = replace ? $p.before(d) : $p.after(d);
  tr = replace ? tr.replaceWith(at, $p.after(d), doc.content) : tr.insert(at, doc.content);
  const end = at + doc.content.size;
  tr.setSelection(TextSelection.near(tr.doc.resolve(end), -1));
  view.dispatch(tr.scrollIntoView());
  return true;
}

// onUpdate(view, prevState, tr) runs after every transaction.
// plugins: extra plugins that take precedence over the outline keys.
export function createEditor(mount, doc, { onUpdate, plugins = [] } = {}) {
  const state = EditorState.create({
    doc,
    plugins: [history(), mathKeys, ...plugins, outlineKeys, keymap(baseKeymap), blockIds, navGuard, mathDecorations, scriptStacking, outlineDecorations],
  });
  const view = new EditorView(mount, {
    state,
    // no macOS autocorrect / capitalisation bubbles or spell squiggles:
    // notes are full of math, names and half-sentences
    attributes: { spellcheck: "false", autocorrect: "off", autocapitalize: "off", autocomplete: "off" },
    dispatchTransaction(tr) {
      const prev = view.state;
      view.updateState(prev.apply(tr));
      onUpdate?.(view, prev, tr);
    },
    handleKeyPress(view, ev) {
      if (ev.ctrlKey || ev.metaKey || ev.altKey || ev.key.length !== 1) return false;
      return typed(view, ev.key);
    },
    handleDOMEvents: {
      // clicking a bullet folds / unfolds its children
      mousedown(view, ev) {
        const bullet = ev.target.closest?.(".pm-bullet");
        if (!bullet) return false;
        ev.preventDefault();
        const body = bullet.parentElement.querySelector(":scope > .pm-body");
        toggleFoldAt(view, view.posAtDOM(body, 0) - 1);
        return true;
      },
      // Enter belongs to the keymap (new block, code line break), always.
      // ProseMirror skips an Enter that comes right after a composition ends
      // (in Safari it may be the key that confirmed it), and WebKit then
      // splits the line natively: the copied DOM parses back as a second block
      // holding the same text. An Enter the input method did not take
      // (keyCode 229) is a real one, so run the keymap for it here.
      keydown(view, ev) {
        if (ev.key !== "Enter" || ev.isComposing || ev.keyCode === 229 || view.composing) return false;
        if (!view.someProp("handleKeyDown", (f) => f(view, ev))) return false;
        ev.preventDefault();
        return true;
      },
      // fallback for input that bypasses keypress (autocorrect, dictation)
      beforeinput(view, ev) {
        // and never a native line split (see keydown)
        if (ev.inputType === "insertParagraph" || ev.inputType === "insertLineBreak") { ev.preventDefault(); return true; }
        if (ev.inputType !== "insertText" || !ev.data) return false;
        const $h = view.state.selection.$head;
        if (!inMath($h) && !besideSpecial($h) && !/[$#[`]/.test(ev.data)) return false;
        ev.preventDefault();
        const chars = [...ev.data];
        for (let k = 0; k < chars.length; k++) {
          const rest = chars.slice(k + 1).join("");
          if (!typed(view, chars[k], rest)) view.dispatch(view.state.tr.insertText(chars[k]));
          else if (document.querySelector(".palette")) break; // a menu took the rest
        }
        return true;
      },
    },
    handlePaste(view, ev) {
      const images = [...(ev.clipboardData?.files ?? [])].filter(isImageFile);
      if (images.length && !inMath(view.state.selection.$head)) {
        insertImages(view, images);
        return true;
      }
      const text = ev.clipboardData?.getData("text/plain");
      if (!text) return false;
      const { from, to, $head } = view.state.selection;
      if ($head.parent.type === T.codeblock || inCode($head)) {
        const plain = $head.parent.type === T.codeblock ? text.replace(/\r/g, "") : text.replace(/\s*\n\s*/g, " ");
        view.dispatch(view.state.tr.insertText(plain, from, to).scrollIntoView());
        return true;
      }
      if (inMath($head)) {
        view.dispatch(view.state.tr.replaceWith(from, to, parseMath(text.replace(/^\$|\$$/g, ""))).scrollIntoView());
        return true;
      }
      // blank lines go, except inside a fenced code block
      let inFence = false;
      const lines = text.replace(/\r/g, "").split("\n").filter((l) => {
        if (/^\s*(- (TODO |DOING |DONE )?)?```/.test(l)) inFence = !inFence;
        return inFence || l.trim();
      });
      if (lines.length === 1 && !/^\s*- /.test(lines[0])) {
        view.dispatch(view.state.tr.replaceWith(from, to, Fragment.fromArray(parseInline(lines[0]))).scrollIntoView());
        return true;
      }
      // several lines (or one whole block): outline text; plain lines become blocks
      const outline = lines.every((l) => /^\s*- /.test(l)) ? lines.join("\n") : lines.map((l) => "- " + l.trim()).join("\n");
      return pasteBlocks(view, parseOutline(outline));
    },
    clipboardTextSerializer: sliceToText,
    nodeViews: { image: imageView },
    handleDrop(view, ev) {
      const images = [...(ev.dataTransfer?.files ?? [])].filter(isImageFile);
      if (!images.length) return false;
      ev.preventDefault();
      const at = view.posAtCoords({ left: ev.clientX, top: ev.clientY });
      if (at) view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(at.pos))));
      insertImages(view, images);
      return true;
    },
    handleClick(_view, _pos, event) {
      const a = event.target.closest?.("a.web-link");
      if (!a || !(event.metaKey || event.ctrlKey)) return false;
      openExternal(a.dataset.href);
      return true;
    },
    handleClickOn(_view, _pos, node) {
      if (node.type === T.link) { hooks.openPage(node.attrs.page); return true; }
      if (node.type === T.ref) { hooks.openBlock(node.attrs.block); return true; }
      return false;
    },
  });
  return view;
}
