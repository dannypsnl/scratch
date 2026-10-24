# 隨筆 (scratch)

An outliner notebook with math: a journal day for every date, named pages, tasks and deadlines, and formulas you type as structure. The desktop app built on [Neutralino](https://neutralino.js.org), with optional sync between devices.

- **Outline:** blocks nest with ⇥ / ⇧⇥, fold with ⌘↑ / ⌘↓; bold, italic, underline, strikethrough, highlight, inline code and code blocks.
- **Journal and pages:** one page per day, with a week strip and a calendar that marks days written, with an open task, or overdue; named pages linked with `[[page]]` or `#tag`, with backlinks.
- **Tasks:** ⌘↵ cycles none → TODO → DOING → DONE; ⌘⇧D sets a deadline. Agenda and Tasks tabs gather them from every page.
- **Formulas:** `$` starts one. `^`, `_`, `/` build scripts and fractions in place, `\` opens a command menu, brackets grow around tall structures, and a selection can be simplified, factored or expanded (through [Nerdamer](https://nerdamer.com)). Rendered with KaTeX.
- **Search:** ⌘K across every page and journal day.
- **Sync:** the notebook is a [Loro](https://loro.dev) CRDT, so edits from several devices merge. The relay is a Cloudflare Worker or a small self-hosted Node server, see [`sync/`](sync/README.md).
- **MCP:** an MCP server lets an agent read, search and write the notebook, see [`mcp/`](mcp/README.md).
- ⌘, for settings; ⌘/ lists every key.

## Download

Every push to `main` is built and published on the [releases page](https://github.com/dannypsnl/scratch/releases):

| file | |
|---|---|
| `scratch-mac_universal.zip` | `scratch.app`, Apple silicon and Intel |
| `scratch-linux_x64.tar.gz`, `_arm64`, `_armhf` | a single binary |
| `scratch-win_x64.zip` | a single `.exe` |

The mac app is signed ad hoc, not notarized: the first time, right-click it and choose Open, or run `xattr -dr com.apple.quarantine scratch.app`.

## Develop

Node 24 or later.

```bash
npm install
npx neu update     # the Neutralino binaries, into bin/ (not in the repository)
```

```bash
npm run dev        # in a browser, http://localhost:5178
npm run app        # in the Neutralino window, with the same dev server
npm run dist       # dist/scratch/ for every platform, and dist/scratch.app
```

In a browser the notebook is kept in the browser's storage; in the app, under the data directory (`~/Library/Application Support/scratch/` on macOS).

## Test

```bash
npm test           # outline round trip, commands, typing, MCP server
npm run test:ui    # the editor in a real browser (Playwright)
npm run test:model # the formula editor against its PureScript model (model/)
npm run test:fuzz  # random edits against the model
```

`npm test` starts the self-hosted sync server, so run `npm install` in `sync/` once first.
