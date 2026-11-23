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

4. Open your Worker's address: it should say `OK (serves <the app's host> only)`. Then open
   `/selftest`: it should say `"ok": true`.

## Setup A: you run the app

5. In the app's **Cloudflare** streaming settings: Worker URL = your Worker's address, secret = your
   `SHARED_SECRET`, and offer both the normal and the **(Cloudflare)** streams → Save.
6. Open `/status`: `"config": "ok"`. Play a title and pick the **(Cloudflare)** stream. When it works,
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
secret → Save. For a user on your Worker, `/status/<name>` should then show `"config": "ok"`.

## Setup B: you use someone else's app

Get two things from the app's owner first: the **app's address** and **your own secret**. Your
account in the app must stream with **your own bots** (a Telegram bot and a private channel; the
app's page for your account shows how).

5. After step 4, send the owner your Worker's address. They enter it for your account.
6. Open `/status`: `"config": "ok"`.
7. On your account's page in the app, choose Cloudflare streaming → Save, then reinstall the app in
   your player. Play a title.

## Updating

When this repo gets a new version: GitHub → **your fork** → **Sync fork** → **Update branch**.
Cloudflare rebuilds and redeploys in about a minute; your settings and secrets stay.
A redeploy cuts streams that are playing at that moment, so update when nobody is watching.
Your Worker's address then shows the new version number.

## Settings

All in Cloudflare → your Worker → Settings → Variables and Secrets. Nothing personal goes in the repo.

| Name | Needed | What it is |
|---|---|---|
| `APP_URL` | yes | The app's address (https, no path). The only app this Worker serves. |
| `SHARED_SECRET` | yes | **A:** the same value as the Cloudflare secret in the app's settings. **B:** the secret the owner gave you. |
| `USER_SECRET_<NAME>` | no | **A** only: one per user you host on your Worker (see [Your users](#your-users)). |
| `SEGMENT_MB` | no | MB per Durable Object request. Default 512. Set `1` if `/selftest` fails. |
| `LOCATION_HINT` | no | Where the Durable Object is first created: `apac` (default), `weur`, `eeur`, `enam`, `wnam`, `sam`, `oc`, `afr`, `me`. Set it before the first play; it doesn't move an existing object. |

## Status pages

| Page | Shows |
|---|---|
| `/` | version and the app host it serves |
| `/selftest` | proves the Durable Object CPU budget (decrypts 128 MB in one request) |
| `/status` | the bot's login, live streams (data centre, MB sent, idle seconds), connections, last error |
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
- Split files, zip files and search results are redirected to the app, which streams them itself.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Your Worker's address says APP_URL is not set or not valid | add `APP_URL` as `https://the-app-host` (no path), then Deploy |
| 403 "Link expired or not signed" | the secrets differ, or the link is over 48 h old: open the title again |
| `/status`: "The app rejected this Worker" | **A:** `SHARED_SECRET` ≠ the app's Cloudflare secret. **B:** the owner hasn't entered your Worker yet, or your secret differs |
| `/status`: "The app returned no bot token" | **B:** your own bots are off or not verified in the app yet |
| `/status/<name>`: "The app rejected user …" | that user's secret in the app ≠ `USER_SECRET_<NAME>` |
| `/status/<name>`: "The app returned no bots for user …" | that user's own bots are off or not verified yet |
| "The bot cannot see channel …" | make that bot an admin of the channel |
| "Telegram rejected the bot login" | check BOT_TOKEN / API_ID / API_HASH in the app |
| `/selftest` fails, or error 1102 | add `SEGMENT_MB` = `1`, then Deploy |
| A stream is listed in `/status` but never starts | watch `idleSeconds`: climbing means stuck, so close the player and play again; slowly rising `mb` means a far data centre |
| Everyone's stream drops at once | a redeploy, or too many viewers for one object's memory |
| Error 1027, or failures late in the day | the daily Free allowance is used up; it resets at 00:00 UTC |
| Cloudflare opens a pull request renaming the Worker, or a build fails on a name mismatch | your Worker's name in Cloudflare isn't `telemediastream`. Don't merge that pull request (later Sync forks may then need a manual merge): delete the Worker and import your fork again with that name |

## Security

- `SHARED_SECRET` (and each `USER_SECRET_`) lets the Worker fetch bot tokens from the app. Keep them
  only in Cloudflare and the app; never put them in the repo or a chat.
- With a fork, your Worker only changes when **you** press Sync fork.
- If the app changes how it talks to Cloudflare Workers, this Worker may need an update too.

## How it works

Decrypting Telegram's MTProto (AES-256-IGE) costs about 6–7 ms of CPU per MB, and a Free-plan Worker
gets only 10 ms per request. So the front Worker only checks the signed link and passes bytes, while
SQLite-backed Durable Objects (allowed on Free, 30 s of CPU per request) log in to Telegram as the bot
over TCP, download 1 MB parts in parallel, decrypt them in WebAssembly and stream them in order.
Long ranges are served as 512 MB segments joined into one response.

## Tests

`npm ci`, then `npm test` (unit + Telegram client against a fake multi-data-centre Telegram) and
`npm run test:e2e` (the real Worker and Durable Objects in workerd with a fake app). Both check links
and signatures with the app's own Python code, so they need Python 3 and the app's source: set
`APP_SRC` to that folder. `node test/crosscheck.mjs` also compares the encryption with pyrofork
(`PYROFORK_PYTHON`).

## Support

This project is shared as is, so the issue tracker is off. The [Troubleshooting](#troubleshooting)
table and your Worker's `/status` page cover the usual problems.

## Credits and license

TL layer-223 reader and WebAssembly AES/SHA from [mtcute](https://github.com/mtcute/mtcute) (MIT,
see `src/vendor/LICENSE-mtcute`). Everything else: MIT, see `LICENSE`.
