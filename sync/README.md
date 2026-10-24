# scratch sync

The sync server for scratch, in two forms that speak the same protocol, so the app needs only a URL and a token:

- **Cloudflare:** a Worker with one Durable Object per notebook (`src/index.js`), images in R2.
- **Self-hosted:** a plain Node server (`server.mjs`) for a machine of your own: updates in one SQLite file, images as files. No Cloudflare account needed. See [Self-hosted](#self-hosted).

The server never looks inside the data. It:

- numbers every Loro update a device sends and stores it in the Durable Object's SQLite,
- forwards each update to the other connected devices,
- keeps images in R2 (`PUT` / `GET /blob/<sha256>.<ext>`). The file name is the hash of the content, so an image is stored once and never overwritten.

A device that reconnects sends the last sequence number it has seen, and the server replays everything after it. Merging is done by Loro on each device.

## Local development

```bash
npm install
npm run dev        # ws://localhost:8787/sync, token in .dev.vars (dev-token)
```

In the app, open the sync status button at the bottom of the sidebar and enter:

- Server: `ws://localhost:8787/sync`
- Token: `dev-token`

### Node as a second device

```bash
node test/client.mjs ws://localhost:8787/sync dev-token main                    # print the whole notebook
node test/client.mjs ws://localhost:8787/sync dev-token main "some text" "more"  # edit one block and push it
```

## Deploy

```bash
npx wrangler login
npx wrangler r2 bucket create scratch-images
npx wrangler secret put SYNC_TOKEN   # a long random string of your own
npm run deploy
```

Then, in the app:

- Server: `wss://scratch-sync.<account>.workers.dev/sync`
- Token: the `SYNC_TOKEN` you just set

## Self-hosted

Node 24 or later (it uses the built-in `node:sqlite`).

```bash
npm install
SYNC_TOKEN=<a long random string> PORT=8787 DATA_DIR=./data npm run serve
```

Everything it keeps is under `DATA_DIR`: `updates.sqlite` (the update log of every notebook) and `blobs/<notebook>/` (images, named by their SHA-256). Back that directory up and you have backed up the server.

Or with Docker:

```bash
docker build -t scratch-sync .
docker run -d -p 8787:8787 -e SYNC_TOKEN=<token> -v scratch-sync:/data scratch-sync
```

In the app:

- Server: `ws://<host>:8787/sync`, or `wss://…` behind a reverse proxy that adds TLS (Caddy: `reverse_proxy localhost:8787`). Use TLS for anything off your own network: the token travels in the URL.
- Token: the `SYNC_TOKEN` you started it with

To rotate the token, restart the server with the new one; devices holding the old one see "Token rejected", as with Cloudflare.

`npm test` runs the self-hosted server through the protocol: two devices with real Loro documents, a device catching up, images, a wrong token, a restart.

## Rotating the token

```bash
npx wrangler secret put SYNC_TOKEN   # the new token
```

Devices still holding the old token are refused on their next connect (WebSocket close code 4001). The app then shows "Token rejected" at the bottom of the sidebar and stops retrying; click it, paste the new token, and connect.

## Not done yet

- **Log compaction:** updates accumulate forever. A client could upload a snapshot to replace the old log.
