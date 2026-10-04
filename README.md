# PlanTogether

A shareable, collaborative planner for a move (or anything with dates and a budget).

- **Todos with dates**: give each item a specific **day**, just a **month** ("sometime in November"), or no date. Items show on a timeline grouped by month and day.
- **Tags you make yourself**: plans start with Buy, Sell and Throw away. Add, rename, recolour or delete tags under ⚙. An item can have several tags. A tag set to **Income** (like Sell) counts prices as money coming in. Filter by tag, by "To decide", or hide done items.
- **✨ Smart quick add**: type "sälj bokhyllan" or paste a product link in the bar at the bottom. The item is filed under the best existing tag, or a new tag is created when none fits (Donate, Packing, Services, …). Links get their name, picture and price filled in.
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
| `lib/classify.js` | Smart quick add: Jev decision model, or keyword rules as fallback |
| `public/` | Plain HTML/CSS/JS frontend, no build step |
| `public/shared.js` | Price parsing and totals, shared by browser and server |

## Run it

```sh
npm start          # http://localhost:3000
npm run dev        # restarts on file changes
npm test
```

**From your phone on the same Wi‑Fi**: run `npm start` on your computer, find its local IP (for example `192.168.1.23`) and open `http://192.168.1.23:3000` on the phone.

## Smart quick add with Jev

Quick add asks [Jev](https://openrouter.ai/docs/guides/community/jev), TypeSafe's decision model, to pick a tag. It sends one `choice` question whose options are the plan's existing tags (with a few example items each) plus suggested tags the plan doesn't have yet. Jev picks; it doesn't write text, so new tags always come from that suggestion list. You can make any tag you like yourself.

Set one of these to turn it on:

| Variable | Meaning |
|---|---|
| `JEV_API_KEY` | TypeSafe key → `https://api.typesafe.ai/v1/systemone`, model `jev-latest` |
| `OPENROUTER_API_KEY` | Use Jev via OpenRouter instead → model `typesafe/jev-1.13` |
| `JEV_MODEL`, `JEV_URL` | Optional overrides |

Without a key, or if Jev is down, simple English and Swedish keyword rules are used instead. `GET /api/health` shows which is active (`"smartAdd": "jev"` or `"rules"`).

## Put it online (so everyone can reach it)

Any host that runs Docker **with a persistent disk** works. Plans are stored as files in `DATA_DIR`. Run **one** instance; plans are files, so two servers would not see each other's changes.

- **Render** (all in the browser, works from a phone): Dashboard → **New → Blueprint** → pick this repo. `render.yaml` sets up the service and a 1 GB disk (Starter plan, ~$7/month plus a little for the disk). Paste your `JEV_API_KEY` when asked.
- **Fly.io** (CLI, can run for about $2/month and sleeps when unused): see the commands at the top of `fly.toml`.
- **Your own server / Raspberry Pi**: `docker build -t plantogether . && docker run -d -p 3000:3000 -v plantogether:/data -e JEV_API_KEY=… plantogether`

Settings: `PORT` (default `3000`), `DATA_DIR` (default `./data`), plus the Jev variables above.

## How access works

There are no accounts. A plan's ID is random and unguessable, so the link alone grants **view** access. The **edit key** lives in the link's `#key=…` part. The `#` part is never sent in normal requests or logged, and the browser sends the key only as a header on API calls. Don't post the edit link publicly. Back up the `data/` folder if a plan matters to you.
