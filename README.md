# WeightFun

Gamified weight loss. You set three weights; the app turns the gap into a
calorie-deficit target and lets you chip away at it.

> **7,700 kcal of cumulative deficit = 1 kg of body weight.**
> Want to lose 10 kg? That's 77,000 points to bank.

Dark mode, large-card layout, bottom toolbar, mobile-first. No build step and no
dependencies — it's static files and `localStorage`. Syncing real Whoop and Apple
Health data additionally needs a small relay you deploy yourself; see below for
why that's unavoidable.

**Live:** <https://alexandersoibelman-hue.github.io/WeightFun/> — deployed from
this branch on every push. Add it to your phone's home screen and it runs
full-screen like a native app.

## Running it

```bash
npm start            # http://localhost:4173
npm test             # 42 unit tests: calorie engine + relay helpers
npm run build:single # one self-contained dist/weightfun.html
```

Any static server works (`python3 -m http.server`, Netlify, GitHub Pages, S3).
ES modules can't load over `file://`, so it does need to be *served* rather than
opened directly — or use the single-file build, which has no module imports and
opens straight off disk.

`.github/workflows/pages.yml` runs the tests, then publishes the app to GitHub
Pages. It also emits `standalone.html` next to it — the same app as one
self-contained file.

## Screens

### Home

| Element | What it does |
| --- | --- |
| **Streak counter** (top left) | Consecutive days with data from *any* source. Backfilling counts, so a week logged elsewhere rebuilds it. |
| **Hero card** | Total deficit needed for the goal, with the amount banked so far in the centre of the progress ring. |
| **To go** | Goal minus banked. Rises on surplus days. |
| **Today** | The day's net, and which way it's pushing. |
| **Day strip** | Horizontal, scrollable, one tile per day. Tap to log calories eaten and burned. |
| **Achievements** | Eight badges across streaks, kilos burnt off, and goal completion. |

Today is a **grace day** for the streak: a run built through yesterday stays
alive until midnight, and the header nudges you while it's at risk.

### Profile

The three data entry points — initial, current, and goal weight. `initial − goal`
is the weight-loss target that drives every number on the Home Screen. Integration
toggles live here too, alongside export / import / reset.

### Integrations

Apple Health and Whoop, both on a 2-hour refresh.

## How the numbers work

```
daily deficit = calories burned − calories eaten

  calories burned = Whoop "Calories" + manual entry
  calories eaten  = Apple Health "Dietary Energy" + manual entry

banked = Σ daily deficit        to go = goal − banked
```

Synced values and manual entries **add together** rather than overwrite, and the
day editor itemises every source so the arithmetic is never a mystery.

When Dietary Energy comes in higher than Whoop's Calories, the day is a surplus:
the deficit is negative, it subtracts from what's banked, and the "to go" number
climbs **up** rather than down. A sustained surplus can push it above the
original target — that's intended, not a bug.

### Manual entry window

Today and the previous **6 days** are editable (7 days total). Older days lock
to read-only; future days are never editable. This is also the window each sync
refreshes, so a late-arriving Whoop score still lands on the right day.

## Integrations, honestly

**Neither source can be reached from a browser.** Both go through a small relay
Worker you deploy yourself — see **[relay/README.md](relay/README.md)** for the
15-minute setup.

### Whoop — why a relay

Three independent blockers, any one of which is fatal to a browser-only client:

- The token exchange requires a **client secret**. Anything shipped to a web page
  is readable by whoever opens it, so the secret cannot live there.
- The token and data endpoints send **no CORS headers** — `fetch()` from a page
  fails whatever credentials you hold.
- Registered redirect URIs must be `https://` or `whoop://`, so a plain
  `http://localhost` dev server can't be the callback.

The relay holds the credentials, runs the OAuth round trip, and proxies the API.
It also does the unit conversion (`kcal = kJ / 4.184`) and maps each cycle to a
calendar day — Whoop cycles run sleep-to-sleep, so a cycle is attributed to the
day it started on **in the wearer's timezone**, taken from the `timezone_offset`
on the record rather than the server's clock.

### Apple Health — why a bridge

**HealthKit has no public web API.** Apple exposes health data only to native
code on the device, so there is no endpoint to authenticate against. This is a
platform limitation, not something the app can work around.

The data has to be pushed off the device instead. A Shortcuts automation reads
Dietary Energy and POSTs it to the relay — no native build required. A Capacitor
or Swift wrapper querying `HKQuantityTypeIdentifierDietaryEnergyConsumed` lands
on the same contract if you'd rather go that way.

One honest caveat: iOS time-of-day automations repeat **daily**, not hourly, so
"every 2 hours" means several automations rather than one. The relay README lays
out a five-automation schedule that covers the day.

Either way the app reads back the same shape:

```http
GET /health/dietary-energy?start=2026-08-01&end=2026-08-08
```
```json
{ "days": { "2026-08-08": 2180, "2026-08-07": 1940 } }
```

### Simulated mode

Both integrations default to **Simulated**, which generates plausible
deterministic data. It exists so the full pipeline — scheduling, merging,
streaks, badges — can be exercised without credentials or an iPhone. Switch
**Source** to the real option when you have them.

### Scheduling

The scheduler is catch-up based rather than a bare `setInterval`: it records
`lastSync` and fires whenever the interval has elapsed. Closing the tab or a
phone going to sleep can't silently skip a window — the next open syncs
immediately. It also re-checks on tab focus and on regaining connectivity.

## Layout

```
index.html              shell + bottom toolbar
styles/app.css          design tokens and components
src/
  main.js               router, render loop, app bootstrap
  state.js              localStorage store
  calc.js               deficit maths, streaks, badges, date handling
  views/                home · profile · integrations
  integrations/
    whoop.js            relay client + simulator
    appleHealth.js      bridge client, payload normalisation
    sync.js             2-hour scheduler, merge + write
  ui/dom.js             element helpers
relay/
  worker.js             Cloudflare Worker: Whoop OAuth + API proxy, Health ingest
  README.md             deployment and Shortcuts setup
test/                   engine + relay tests
```

Views re-render wholesale on state change. They're small enough that a rebuild
beats any diffing worth hand-rolling, and it keeps what's on screen a pure
function of state.

## Data and privacy

Everything the app itself holds stays in `localStorage` on the device, and there
is no analytics. Use **Export** in Profile for a backup — clearing browser data
wipes your history.

The relay is the one exception, and only if you deploy it: it stores your Whoop
tokens and your Dietary Energy figures in your own Cloudflare account, under your
own credentials. The Whoop client secret never reaches the browser. The relay
token does live in `localStorage`, so treat any device with the app open as
holding that credential.
