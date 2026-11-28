# TeleMediaStream

Stream video files from Telegram through **your own free Cloudflare Worker**. It works with a
streaming app that signs its Telegram links for a Cloudflare Worker: players load the video from your
Worker, so the app's server only answers small requests instead of sending every movie.

- Runs on the **Cloudflare Workers Free plan** (no card needed).
- Serves **one app only**: links must be signed with your secret, and the Worker gets its Telegram
  bot only from the app address you set.
- For the app's **owner**, and for the app's **users** who stream with their own Telegram bots.

## Which setup is yours?

- **You run the app** (you can open its settings): [Setup A](#setup-a-you-run-the-app).
- **You use someone else's app**: [Setup B](#setup-b-you-use-someone-elses-app).

Either way you need a [GitHub](https://github.com) account and a free
[Cloudflare](https://dash.cloudflare.com/sign-up) account, and the app's address must start with
**https**. Both setups start by deploying your Worker.

## Deploy your Worker (A and B)

Use a **fork**: updating later is then one click (see [Updating](#updating)).

1. **Fork** this repo (the Fork button at the top of this page).
2. **Cloudflare** → Workers & Pages → Create → **Import a repository** → connect GitHub if asked →
   choose your fork `TeleMediaStream` → set the Worker name to **`telemediastream`** (all lowercase;
   it must match `wrangler.toml`) → **Deploy**. Your Worker's address is
   `https://telemediastream.<your-subdomain>.workers.dev` (Workers & Pages shows your subdomain).
3. **Settings → Variables and Secrets → Add**, then **Deploy**:

   | Name | Type | Value |
   |---|---|---|
   | `APP_URL` | Text | the app's address, like `https://stream.example.com` |
   | `SHARED_SECRET` | Secret | **A:** a new random secret, 40+ letters and digits (use a password manager). **B:** the secret the app's owner gave you. |

4. Open your Worker's address in a browser: the [dashboard](#dashboard) opens and says
   **Serving links from** the app's host. Sign in with your `SHARED_SECRET` and press
   **Run self-test**: it should say **Self-test passed**.

## Setup A: you run the app

5. In the app's **Cloudflare** streaming settings: Worker URL = your Worker's address, secret = your
   `SHARED_SECRET`, and offer both the normal and the **(Cloudflare)** streams → Save.
6. Press **Sync settings now** on the dashboard: **Your bot** should show no problem. Play a title
   and pick the **(Cloudflare)** stream: it appears on the dashboard with its speed. When it works,
   switch the app to Cloudflare streams only.

### Your users

Users of your app who stream with **their own bots** can use Cloudflare too (the app's own-bots
setup, helper bots included, must be done first). Make a new random secret for each such user (never
your main one or another user's), then choose where their streams run:

- **On their own Worker** (their Cloudflare account and its free allowance): send them your app's
  address and their secret. They follow [Setup B](#setup-b-you-use-someone-elses-app) and send you
  their Worker's address.
- **On your Worker** (nothing for them to set up; shares your free allowance): add a Secret
  `USER_SECRET_<NAME>` = their secret (`<NAME>`: letters, digits, `_`) → Deploy. Deleting it cuts
  them off.

Then, in your app's settings for that user, enter the Worker's address (theirs or yours) and their
secret → Save. A user on your Worker then appears under **Telegram bots** on your dashboard, with no
problem shown.

## Setup B: you use someone else's app

Get two things from the app's owner first: the **app's address** and **your own secret**. Your
account in the app must stream with **your own bots** (a Telegram bot and a private channel; the
app's page for your account shows how).

5. After step 4, send the owner your Worker's address. They enter it for your account.
6. Press **Sync settings now** on your dashboard: **Your bot** should show no problem.
7. On your account's page in the app, choose Cloudflare streaming → Save, then reinstall the app in
   your player. Play a title.

## Updating

When this repo gets a new version: GitHub → **your fork** → **Sync fork** → **Update branch**.
Cloudflare rebuilds and redeploys in about a minute; your settings and secrets stay.
A redeploy cuts streams that are playing at that moment, so update when nobody is watching.
Your Worker's address then shows the new version number. If it doesn't, see
[Troubleshooting](#troubleshooting).

## Settings

All in Cloudflare → your Worker → Settings → Variables and Secrets. Nothing personal goes in the repo.

| Name | Needed | What it is |
|---|---|---|
| `APP_URL` | yes | The app's address (https, no path). The only app this Worker serves. |
| `SHARED_SECRET` | yes | **A:** the same value as the Cloudflare secret in the app's settings. **B:** the secret the owner gave you. |
| `USER_SECRET_<NAME>` | no | **A** only: one per user you host on your Worker (see [Your users](#your-users)). |
| `SEGMENT_MB` | no | MB per Durable Object request. Default 512. Set `1` if the self-test fails. |
| `LOCATION_HINT` | no | Where the Durable Object is first created: `apac` (default), `weur`, `eeur`, `enam`, `wnam`, `sam`, `oc`, `afr`, `me`. Set it before the first play; it doesn't move an existing object. |
| `TG_SILENT_MS`, `TG_PART_TIMEOUT_MS`, `STALL_LIMIT_MS` | no | Rarely needed. How long a Telegram connection with requests waiting may stay silent before it is replaced (10000), how long one 1 MB part may take before it is asked for again (15000), and how long a stream may wait for Telegram before it is ended so the player asks again (25000). |

## Dashboard

Open your Worker's address in a browser (it goes to `/admin`) and sign in with a secret:

- **What's playing:** each stream's file name, speed, data sent, playing time and data centre, with
  a warning when one stops getting data, and how much of the time it waited for Telegram (above 50%,
  Telegram is slower than the player: the cause of buffering). A stalled stream says which side it is
  waiting for: **waiting for Telegram for N s** (the Worker deals with it) or **the TV hasn't taken
  data for N s** (paused, or the TV's player is stuck: the Worker leaves it alone).
- **Today, in words:** how often Telegram slowed the bot down (and the longest wait), how often a
  Telegram connection went silent and was replaced, how often Telegram stayed silent long enough
  that a stream was ended for the player to ask again, how often a dropped link to the Durable
  Object was ridden out between segments, whether Telegram kept up with the player, and how long
  the Durable Object was busy against the daily Free allowance.
- **Sent today (UTC)**, with a bar for each of the last 24 hours. Cloudflare's daily Free allowance
  resets at 00:00 UTC.
- **Telegram bots:** your bot and each user you host, with its state (playing, asleep, not logged in
  yet, or the problem in plain words) and what it sent today.
- **Sync settings now** re-reads the bot settings from the app. **Run self-test** proves the Durable
  Object CPU budget.

Sign in with `SHARED_SECRET` to see every bot, or with a user's `USER_SECRET_` to see only theirs.
The page signs each request with the secret instead of sending it, and keeps it for that tab only,
or on the device if you tick **Remember on this device**. It updates every 5 seconds while something
plays and every 20 seconds otherwise, and stops while the tab is in the background.

## Status pages

For scripts and quick checks; no sign-in.

| Page | Shows |
|---|---|
| `/` | version and the app host it serves (a browser goes to the dashboard instead) |
| `/selftest` | proves the Durable Object CPU budget (decrypts 128 MB in one request) |
| `/status` | the bot's login, live streams (data centre, MB sent, idle seconds, speed, % of time waiting for Telegram), connections, the last error and what it means, and today's `health` (counts) and `summary` (the same in sentences) |
| `/status/<name>` | the same for one user you host on your Worker |

They contain no secrets, file names or viewer IPs, but they are public: use plain labels for `<NAME>`.

## Limits on the Free plan

- **About 8 viewers at the same time** per Durable Object. Each viewer holds ~9 MB of a 128 MB
  memory budget (measured); past that, Cloudflare restarts the object and its streams drop at once.
  Cloudflare may place several users' objects in one isolate that shares those 128 MB.
- **Daily allowance per Cloudflare account** (resets 00:00 UTC): 100,000 requests, and 13,000 GB-s
  of Durable Object time, roughly **29 hours of streaming in total**. Users you host on your Worker
  share yours; users with their own Worker use their own.
- One Telegram bot per object (the first token the app sends).
- The allowance figures on the dashboard and in `/status` are estimates this Worker keeps itself.
  When Cloudflare stops a Worker for a limit, the Worker's code doesn't run, so it can't record that:
  your Worker's **Metrics** and **Logs** in Cloudflare show those.
- An open dashboard makes one request every 5 seconds while something plays (every 20 otherwise),
  about 720 an hour at most: a small part of the 100,000 a day.
- Split files, zip files and search results are redirected to the app, which streams them itself.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Your Worker's address says APP_URL is not set or not valid | add `APP_URL` as `https://the-app-host` (no path), then Deploy |
| 403 "Link expired or not signed" | the secrets differ, or the link is over 48 h old: open the title again |
| Dashboard or `/status`: "The app rejected this Worker" | **A:** `SHARED_SECRET` ≠ the app's Cloudflare secret. **B:** the owner hasn't entered your Worker yet, or your secret differs |
| Dashboard or `/status`: "The app returned no bot token" | **B:** your own bots are off or not verified in the app yet |
| Dashboard or `/status/<name>`: "The app rejected user …" | that user's secret in the app ≠ `USER_SECRET_<NAME>` |
| Dashboard or `/status/<name>`: "The app returned no bots for user …" | that user's own bots are off or not verified yet |
| Dashboard sign-in says "Wrong secret" | it must equal `SHARED_SECRET` (or that user's `USER_SECRET_`) exactly |
| "The bot cannot see channel …" | make that bot an admin of the channel |
| "Telegram rejected the bot login" | check BOT_TOKEN / API_ID / API_HASH in the app |
| Self-test fails, or error 1102 | add `SEGMENT_MB` = `1`, then Deploy |
| A stream shows "no data for … s" (or a climbing `idleSeconds` in `/status`) | it is stuck: close the player and play again. A low speed that keeps going means a far data centre |
| Playback stops and only restarting the TV app helps | Look at the stream on the dashboard while it is stuck. **Waiting for Telegram**: since 2.3.0 the Worker replaces a silent Telegram connection after 10 s and, if Telegram still sends nothing, ends the stream after 25 s so the player reconnects by itself (Nuvio TV on Samsung does, after a broken connection, not after a silent one). **The TV hasn't taken data**: the TV's own player is stuck; Workers Logs show `[core] the player has not taken data for 60 s`, and the fix is in the TV app |
| **Today** says a Telegram connection went silent, or Telegram stayed silent for a whole stream | the first is handled without the player noticing; the second ended a stream so the player asks again (a short buffering). Often: note the times and check whether the TV and the Durable Object are far apart (`LOCATION_HINT`) or Telegram had an outage |
| Buffering, and "waiting for Telegram" is above 50% | Telegram sends this file slower than the player plays it (often a far data centre, or slow-downs: see **Today**). The Worker can't make Telegram faster; a lower-bitrate copy of the file can help |
| **Today** says Cloudflare dropped the link to the Durable Object | a short Cloudflare hiccup between two segments: the stream carried on from the same byte. A drop in the middle of a segment ends the stream instead and the player asks again (Workers Logs: `[front] stream ended at an unknown byte`); if that happens often, note the times and check Cloudflare's status page |
| **Today** says Telegram slowed the bot down | Telegram rations each bot. Waits up to 15 s are sat out; a longer one stops that stream and the player asks again. Several viewers on one bot make it more likely |
| Workers Logs: "Worker exceeded CPU time limit" on a `/dl` request, after minutes of playing | you're on 2.2.0, which copied the stream in JavaScript to count bytes; long plays ran out of the Free plan's CPU. **Sync fork** to 2.2.1 or later, which lets the runtime copy it |
| Everyone's stream drops at once | a redeploy, or too many viewers for one object's memory |
| Error 1027, or failures late in the day | the daily Free allowance is used up; it resets at 00:00 UTC |
| Cloudflare opens a pull request renaming the Worker, or a build fails on a name mismatch | your Worker's name in Cloudflare isn't `telemediastream`. Don't merge that pull request (later Sync forks may then need a manual merge): delete the Worker and import your fork again with that name |
| Sync fork (or a push) doesn't change the version, or Settings → Builds says "This project is disconnected from your Git account" | Cloudflare's GitHub app can't see your repo. GitHub → Settings → Applications → **Cloudflare Workers and Pages** → Configure → add your repo under **Only select repositories** → Save. Then Cloudflare → your Worker → Settings → Builds → **Disconnect** → **Connect**: pick your repo (it may preselect another one), branch `main`, deploy command `npx wrangler deploy`. Reconnecting doesn't build by itself; the next Sync fork or push does |

## Security

- `SHARED_SECRET` (and each `USER_SECRET_`) lets the Worker fetch bot tokens from the app. Keep them
  only in Cloudflare and the app; never put them in the repo or a chat.
- The dashboard shows file names. Anyone with `SHARED_SECRET` can see what's playing and press
  Sync settings now or Run self-test there; nothing more.
- With a fork, your Worker only changes when **you** press Sync fork.
- If the app changes how it talks to Cloudflare Workers, this Worker may need an update too.

## How it works

Decrypting Telegram's MTProto (AES-256-IGE) costs about 6–7 ms of CPU per MB, and a Free-plan Worker
gets only 10 ms per request. So the front Worker only checks the signed link and passes bytes, while
SQLite-backed Durable Objects (allowed on Free, 30 s of CPU per request) log in to Telegram as the bot
over TCP, download 1 MB parts in parallel, decrypt them in WebAssembly and stream them in order.
Long ranges are served as 512 MB segments joined into one response. The front Worker copies each
segment with the runtime's own `pipeTo`, so no JavaScript runs per chunk and a whole film costs it
almost no CPU (2.2.0 counted bytes in JavaScript to resume after dropped links, and long plays ran out
of the Free plan's CPU). If Cloudflare drops the link to the Durable Object ("Network connection lost")
just as the next segment is asked for, that request is tried again, up to 5 times. In the middle of a
segment nobody knows how many bytes got through, so the response ends and the player asks again.
A stream must never go silent: some TV players (Samsung's, in Nuvio TV) recover from a broken
connection but freeze on one that just stops sending. So a Telegram connection that receives nothing
for 10 s while requests wait is closed and the requests asked again on a new one, a part unanswered
for 15 s is asked again, and a stream that has waited 25 s for Telegram is ended on purpose.

## Tests

`npm ci`, then `npm test` (unit, the stream relay and health counters, and the Telegram client
against a fake multi-data-centre Telegram, including connections that go silent and lost answers) and
`npm run test:e2e` (the real Worker and Durable Objects in workerd with a fake app). Both check links
and signatures with the app's own Python code, so they need Python 3 and the app's source: set
`APP_SRC` to that folder. `node test/crosscheck.mjs` also compares the encryption with pyrofork
(`PYROFORK_PYTHON`).

## Support

This project is shared as is, so the issue tracker is off. The [Troubleshooting](#troubleshooting)
table and your Worker's dashboard cover the usual problems.

## Credits and license

TL layer-223 reader and WebAssembly AES/SHA from [mtcute](https://github.com/mtcute/mtcute) (MIT,
see `src/vendor/LICENSE-mtcute`). Everything else: MIT, see `LICENSE`.
