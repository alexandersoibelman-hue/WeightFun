# WeightFun relay — setup

One Cloudflare Worker feeds both integrations. Free tier covers this comfortably.

**Why it's needed:** neither source can be reached from a browser. Whoop's token
exchange requires a client secret (which can't live in a web page) and their API
sends no CORS headers. Apple's HealthKit is native-only — no web API exists at
all. The relay holds the Whoop credentials and receives what your phone pushes.

Roughly 15 minutes end to end.

---

## 1. Deploy the Worker

```bash
cd relay
npx wrangler login                        # opens a browser
npx wrangler kv namespace create STORE
```

That prints an `id`. Paste it into `wrangler.toml`, replacing
`PASTE_YOUR_KV_NAMESPACE_ID_HERE`. Then:

```bash
npx wrangler deploy
```

Note the URL it prints — something like
`https://weightfun-relay.your-name.workers.dev`. That's `<RELAY>` from here on.

## 2. Make a relay token

This is the password between the app and your relay. Generate a random one:

```bash
openssl rand -hex 32
```

Keep it somewhere you can paste from twice.

## 3. Create the Whoop app

At [developer.whoop.com](https://developer.whoop.com), create an app:

| Field | Value |
| --- | --- |
| Redirect URI | `<RELAY>/whoop/callback` |
| Scopes | `read:cycles`, `read:workout`, `read:profile`, `offline` |

`offline` is the one that matters most — without it you get no refresh token and
the connection dies after an hour.

Copy the **Client ID** and **Client Secret**.

## 4. Load the secrets

```bash
npx wrangler secret put WHOOP_CLIENT_ID       # paste, enter
npx wrangler secret put WHOOP_CLIENT_SECRET   # paste, enter
npx wrangler secret put RELAY_TOKEN           # paste the token from step 2
```

Secrets apply immediately — no redeploy. Check it's alive:

```bash
curl https://<RELAY>/
```

You should see `"configured": true` and `"connected": false`.

## 5. Connect Whoop in the app

Open the app → **Sync** tab → Whoop card:

1. **Source** → *Whoop (via relay)*
2. **Relay URL** → `<RELAY>`
3. **Relay token** → your token from step 2
4. Tap **Test relay** — it should report the relay is up
5. Tap **Connect Whoop** → log in → you'll be sent back with "Whoop connected"
6. Flip **Enabled** on

Calories start landing within a few seconds, backfilled over the last 7 days.

## 6. Push Apple Health from your phone

### Build the shortcut

Shortcuts app → **+** → name it *Send Dietary Energy*:

1. **Find Health Samples**
   - Type: **Dietary Energy**
   - Add filter: *Start Date* — **is today**
2. **Calculate Statistics**
   - Operation: **Sum**
   - Input: the Health Samples from step 1 (pick the *Value* property if asked)
3. **Format Date**
   - Date: **Current Date**
   - Format: **Custom** → `yyyy-MM-dd`
4. **Get Contents of URL**
   - URL: `<RELAY>/health/dietary-energy`
   - Method: **POST**
   - Headers:
     - `Authorization` → `Bearer <your relay token>`
     - `Content-Type` → `application/json`
   - Request Body: **JSON**
     - `date` (Text) → the Formatted Date from step 3
     - `kcal` (Number) → the Statistic from step 2

Run it once by hand. You should get back `{"ok": true, "stored": {...}}`.

### Automate it

Shortcuts → **Automation** tab → **+** → **Time of Day**, run *Send Dietary
Energy*, with **Run Immediately** on and **Notify When Run** off.

One caveat worth knowing: iOS time-of-day automations repeat **daily**, not
hourly — there's no "every 2 hours" trigger. So create several, each at a
different time. Five is plenty:

```
08:00   12:00   16:00   20:00   23:55
```

The 23:55 one matters most: it captures the day's final total before midnight.
Each run posts the day's running total and replaces the stored value, so partial
totals earlier in the day are correct rather than double-counted.

### Point the app at it

**Sync** tab → Apple Health card:

1. **Source** → *Device bridge*
2. **Bridge URL** → `<RELAY>/health/dietary-energy`
3. **Bearer token** → your relay token
4. Flip **Enabled** on

---

## Checking it works

```bash
curl https://<RELAY>/                       # status: connected? how many days stored?

curl -H "Authorization: Bearer <TOKEN>" \
  "https://<RELAY>/whoop/calories?start=2026-08-01&end=2026-08-08"

curl -H "Authorization: Bearer <TOKEN>" \
  "https://<RELAY>/health/dietary-energy?start=2026-08-01&end=2026-08-08"
```

Both return `{ "days": { "2026-08-08": 2180, ... } }` in kcal.

Live logs while you poke at it:

```bash
npx wrangler tail
```

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| `401 Unauthorized` | Relay token in the app doesn't match `RELAY_TOKEN`. |
| `428` / "Whoop is not connected" | Step 5 not finished, or the refresh token expired. Tap **Connect Whoop** again. |
| Whoop connects, then dies after an hour | The `offline` scope wasn't granted. Re-create the Whoop app with it and reconnect. |
| "This login link has expired" | The connect link is single-use and lasts 10 minutes. Start from **Connect Whoop** again. |
| Calories missing for today | Whoop only scores a cycle once it closes. Today's figure appears after your next sleep. |
| Food data stuck at one value | The automation isn't firing. Run the shortcut by hand to confirm the shortcut itself works. |
| Everything 500s | A secret is missing. `npx wrangler secret list`. |

## Security

It's a **single-user** relay: one stored Whoop token, one shared bearer token.
Deploy your own rather than sharing one — anyone holding the token can read your
Whoop data and write food entries.

The relay token is stored in the browser's `localStorage`, so treat any device
where the app is signed in as holding that credential. To revoke, run
`npx wrangler secret put RELAY_TOKEN` with a fresh value; every client stops
working until you paste the new one in.

Your Whoop client secret only ever exists as a Worker secret — it is never sent
to the browser.

## Endpoints

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `GET` | `/` | none | Status: is Whoop connected, how much food data is stored |
| `GET` | `/whoop/connect` | `?token=` | Starts the OAuth flow |
| `GET` | `/whoop/callback` | OAuth state | Whoop redirects here |
| `GET` | `/whoop/calories` | Bearer | `{ days: { 'YYYY-MM-DD': kcal } }` |
| `POST` | `/health/dietary-energy` | Bearer | Ingest from Shortcuts |
| `GET` | `/health/dietary-energy` | Bearer | `{ days: { 'YYYY-MM-DD': kcal } }` |

The ingest endpoint accepts any of these, so most HealthKit exporters work
unchanged:

```json
{ "date": "2026-08-08", "kcal": 2180 }
{ "days": { "2026-08-08": 2180 } }
{ "samples": [{ "date": "2026-08-08T08:00:00Z", "value": 500, "unit": "kcal" }] }
```

Samples are summed per day and `kJ` is converted automatically.
