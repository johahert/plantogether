# PlanTogether

A shareable, collaborative planner for a move (or anything with dates and a budget).

- **Todos with dates**: give each item a specific **day**, just a **month** ("sometime in November"), or no date. Items show on a timeline grouped by month and day.
- **Types**: Buy, Sell, Throw away, Task. Filter by type, by "To decide", or hide done items.
- **Links with prices and previews**: paste a product link and the server fetches its name, picture and price (OpenGraph / JSON-LD). You can always edit or enter them yourself.
- **Choices**: add 2+ links to one item (say, 4 sofas) and it becomes a pick-one. Only the chosen option counts toward the total, and undecided choices show a min–max range.
- **Totals**: what you'll spend, what sales bring in, and the net cost.
- **Sharing**: every plan has an **edit link** and a **view-only link**. Anyone with the edit link can change the plan, and changes show up live on everyone's screen.
- **Mobile first**: works in any phone browser. Use "Add to Home Screen" to open it like an app.

## Stack

As small as it gets: **Node.js (≥ 20) with zero npm dependencies**.

| Part | What |
|---|---|
| `server.js` | HTTP server: JSON API, live updates via Server-Sent Events, static files |
| `lib/store.js` | One JSON file per plan in `data/` (atomic writes) |
| `lib/preview.js` | Link previews (blocks private/internal addresses) |
| `public/` | Plain HTML/CSS/JS frontend, no build step |
| `public/shared.js` | Price parsing and totals, shared by browser and server |

## Run it

```sh
npm start          # http://localhost:3000
npm run dev        # restarts on file changes
npm test
```

**From your phone on the same Wi‑Fi**: run `npm start` on your computer, find its local IP (for example `192.168.1.23`) and open `http://192.168.1.23:3000` on the phone.

## Put it online (so everyone can reach it)

Any host that runs Node or Docker **and has a persistent disk** works. Plans are stored as files in `DATA_DIR`.

- **Fly.io**: `fly launch` (uses the Dockerfile), then `fly volumes create data --size 1` and mount it at `/data`.
- **Railway / Render**: deploy from this repo using the Dockerfile and attach a volume/disk at `/data`. (Free tiers without a disk lose data on restart.)
- **Your own server / Raspberry Pi**: `docker build -t plantogether . && docker run -d -p 3000:3000 -v plantogether:/data plantogether`

Settings: `PORT` (default `3000`) and `DATA_DIR` (default `./data`).

## How access works

There are no accounts. A plan's ID is random and unguessable, so the link alone grants **view** access. The **edit key** lives in the link's `#key=…` part. The `#` part is never sent in normal requests or logged, and the browser sends the key only as a header on API calls. Don't post the edit link publicly. Back up the `data/` folder if a plan matters to you.
