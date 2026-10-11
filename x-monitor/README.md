# X Monitor

Tracks the X (Twitter) accounts for each model (Hermy, Sophie) and flags the ones that need attention.
It runs entirely on Cloudflare's free plan: one Worker serves the dashboard and runs a cron every
2 minutes, and each model has its own D1 database.

## How it works

- **Sheet sync:** every 10 minutes each model's list is read from its tab of the Google Sheet
  (*TBB - updated accounts*). Usernames added to the sheet start being tracked. Usernames removed from
  the sheet show as *Removed from sheet*: they're no longer checked, but their history is kept. If a
  sync finds no usernames at all (e.g. the layout changed), nothing is removed.
- **Checks:** each account is re-checked every 30 minutes. Up to 30 accounts are checked per run, so
  about 900 checks an hour are available across both models.
- **Extras:** usernames can also be pasted in on the dashboard (tagged *manual*).

| Status | Rule |
|---|---|
| 🔴 Suspended | Profile not found on 3 checks in a row (each check retried up to 5 times) |
| 🟠 Shadowban | Possible: following up ≥ 25 in 48h while followers flat or down. Confirmed: marked by hand with **Mark SB** |
| 🟣 Lookup error | The lookup service failed; counts kept from the last good check |
| 🟡 Stalling | 7-day follower growth below 1% (or followers down over 48h for accounts tracked < 7 days) |
| ⚪ Collecting | Fewer than 7 days of data and no warning signs yet |
| 🟢 Healthy | 7-day follower growth at or above target |

Columns: followers, change over 24h / 7d / 30d, following, following change over 48h (the follow
activity), a 30-day trend line and the reason for the status. The list is sorted worst first.
The thresholds are set in `wrangler.toml`.

### Data source and limits

Counts come from FxTwitter's free public API (`api.fxtwitter.com/<username>`), with no X API key.
- It wrongly answers "not found" about 1 in 3 times, so misses are retried and an account is only
  flagged suspended after 3 failed checks in a row.
- It can't tell suspended, deactivated and renamed accounts apart.
- It can't see shadowbans. A real shadowban check needs a logged-in X search, so the tool flags the
  pattern and you confirm by hand.
- To switch source later, only `lookupOnce()` in `src/index.js` needs changing.

Free-plan budgets this is built around:
- 50 outbound requests per run.
- 100k D1 row writes per day across the account. Snapshots are written at most hourly, and daily rows
  only when the numbers change.

## Setup

The D1 databases `x-monitor-hermy` and `x-monitor-sophie` already exist (WEUR) with their tables,
and their IDs are in `wrangler.toml`.

1. **Link the sheet.** Share *TBB - updated accounts* as "Anyone with the link: Viewer". Then in
   `wrangler.toml` → `MODELS`, set `sheetId` and each model's `sheetGid` (or `sheetTab`).
   `sheetColumn` is optional.
2. **Deploy**, using either option below.
   - **Option A: Cloudflare dashboard.** Workers & Pages → Create → Import a repository →
     `fraser4u/streatfield-flooring`, with root directory `x-monitor` and deploy command
     `npx wrangler deploy`.
   - **Option B: terminal.** `cd x-monitor && npm install && npx wrangler login && npx wrangler deploy`
3. **Set the password.** In the Worker, go to Settings → Variables and Secrets and add a secret named
   `DASHBOARD_PASSWORD` (or run `npx wrangler secret put DASHBOARD_PASSWORD`). Log in with any
   username and that password.

**Adding another model:**
1. Create a D1 database and run `schema.sql` on it.
2. Add a `[[d1_databases]]` block with binding `DB_<ID>`.
3. Add an entry to `MODELS`.

## Local development
```sh
echo 'DASHBOARD_PASSWORD=test' > .dev.vars
npm install && npm run db:init:local
npm run dev        # http://localhost:8787 ; run the cron with: curl "localhost:8787/__scheduled?cron=*/2+*+*+*+*"
```
