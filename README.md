# WeightFun

Gamified weight loss. You set three weights; the app turns the gap into a
calorie-deficit target and lets you chip away at it.

> **7,700 kcal of cumulative deficit = 1 kg of body weight.**
> Want to lose 10 kg? That's 77,000 points to bank.

Dark mode, large-card layout, bottom toolbar, mobile-first. No build step, no
dependencies, no backend — it's static files and `localStorage`.

## Running it

```bash
npm start          # http://localhost:4173
npm test           # 30 unit tests over the calorie engine
```

Any static server works (`python3 -m http.server`, Netlify, GitHub Pages, S3).
ES modules can't load over `file://`, so it does need to be *served* rather than
opened directly.

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

### Whoop — a real API connection

OAuth 2.0 Authorization Code + **PKCE**, so no client secret is ever put in the
browser. Calories come from the v2 cycle endpoint, which reports energy in
kilojoules (`kcal = kJ / 4.184`). A Whoop cycle runs sleep-to-sleep rather than
midnight-to-midnight, so each cycle is attributed to the local calendar day it
started on.

To connect: register an app at [developer.whoop.com](https://developer.whoop.com),
then on the Integrations tab switch **Source** to *Whoop API*, paste your client
ID, and add the redirect URI the app shows you to your Whoop app's settings.
Scopes: `read:cycles read:workout read:profile offline`.

### Apple Health — why it needs a bridge

**HealthKit has no public web API.** Apple exposes health data only to native
code running on the device, so unlike Whoop there is no OAuth endpoint a browser
can authenticate against. This is a platform limitation, not something the app
can work around.

The supported route is to push the data out from the device. Either works:

**1. Shortcuts automation** — no native build required:

```
Shortcuts → Automation → every 2 hours
  Find Health Samples  where Type = Dietary Energy, today
  Get Contents of URL  POST → your bridge endpoint
```

**2. Native wrapper** (Capacitor / Swift `WKWebView`) — query
`HKQuantityTypeIdentifierDietaryEnergyConsumed` and hand the samples to the web
layer.

Both land on the same contract. Point **Bridge URL** at an endpoint that answers:

```http
GET /health?type=...&start=2026-08-01&end=2026-08-08
```
```json
{ "days": { "2026-08-08": 2180, "2026-08-07": 1940 } }
```

Values are kcal. Raw sample arrays are accepted too, and `kJ` units are converted
automatically:

```json
{ "samples": [{ "date": "2026-08-08T08:00:00Z", "value": 500, "unit": "kcal" }] }
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
  main.js               router, render loop, OAuth redirect handling
  state.js              localStorage store
  calc.js               deficit maths, streaks, badges, date handling
  views/                home · profile · integrations
  integrations/
    whoop.js            OAuth + PKCE, cycle fetch, kJ→kcal
    appleHealth.js      bridge client, payload normalisation
    sync.js             2-hour scheduler, merge + write
  ui/dom.js             element helpers
test/calc.test.js       engine tests
```

Views re-render wholesale on state change. They're small enough that a rebuild
beats any diffing worth hand-rolling, and it keeps what's on screen a pure
function of state.

## Data and privacy

Everything stays in `localStorage` on the device. Nothing is uploaded, and there
is no analytics or backend. Whoop tokens are held locally; clearing site data
signs you out. Use **Export** in Profile for a backup — clearing browser data
wipes your history.
