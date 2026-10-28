# scratch MCP server

An [MCP](https://modelcontextprotocol.io) server (stdio) so an agent such as Claude Code can read, search and write the notebook.

It joins the sync relay (`sync/`, self-hosted or the Cloudflare Worker) as one more device: it takes the whole notebook from the server, and every edit it makes is a Loro change sent like an edit from another computer. The running app merges it, and nothing the app wrote in the meantime is overwritten. A write tool answers once the server has acknowledged the change.

## Add it to Claude Code

From the repository root (Node 24 or later, after `npm install`):

```bash
claude mcp add --scope user scratch -- node "$PWD/mcp/server.mjs"
```

With no options it uses the app's own sync settings (server, token, notebook), read from the app's data directory (`~/Library/Application Support/scratch/meta.json` on macOS). To point it elsewhere:

```bash
claude mcp add --scope user scratch -e SCRATCH_SYNC_URL=ws://localhost:8787/sync -e SCRATCH_SYNC_TOKEN=dev-token -e SCRATCH_NOTEBOOK=main -- node "$PWD/mcp/server.mjs"
```

Use `node` directly, not `npm run mcp`: npm prints a banner on stdout, which is the MCP channel.

When sync is not set up, the server reads the app's local snapshot (`notebook.loro`, with the updates saved since in `notebook.log`) and refuses to write: the running app never reads that file back, and would overwrite it.

## Tools

| tool | |
|---|---|
| `list_pages` | named pages (title, id) and journal days with something written, newest first |
| `read_page` | a page, a date `YYYY-MM-DD` or `today`, as outline text |
| `search` | blocks containing every word of the query (formulas by their LaTeX, links by title), optionally only TODO / DOING / DONE; page titles that match |
| `create_page` | a named page, optionally with content; links already written to that title point at it |
| `append_blocks` | at the end of a page or journal day (default today), or as the last children of a block |
| `insert_blocks` | before / after a block, or as its first / last children |
| `replace_block` | a block and its children; empty text deletes it |
| `set_task` | `todo`, `doing`, `done` or `none`, logged with its time as in the app |
| `set_deadline` | a date, or null to clear it |

Text is the app's outline form (`src/outline-io.js`): `- ` per block, two spaces per level, `TODO`/`DOING`/`DONE` first, ` DEADLINE: <YYYY-MM-DD>` last, `$LaTeX$`, `[[page]]`, `#tag` (the block's tags: read anywhere in its line, written after it), `((block-id))`, `name:: value` property lines. Read text ends each block line with its id, ` ^id`; text written may keep or drop them. `replace_block` keeps the replaced block's id, and the ids of its old children written back.

## Test

`node test/mcp.mjs` (part of `npm test`) starts `sync/server.mjs` (run `npm install` in `sync/` once), drives every tool through an MCP client, and checks each edit in a second Loro document read with the app's own `src/loro.js`, including an edit the app makes offline at the same time.

## Not done yet

- It keeps nothing on disk, so every start downloads the whole notebook, and a change the server has not acknowledged is lost if the server process exits.
- Search is a plain word match; it can move to the app's search module once there is one.
- Images are not read or written.
