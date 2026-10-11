import DASHBOARD_HTML from './dashboard.html';

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const USERNAME_RE = /^[A-Za-z0-9_]{1,15}$/;

// Lower number = more urgent; the dashboard sorts by this.
const SEVERITY = { suspended: 0, shadowban: 1, error: 2, stalling: 3, new: 4, healthy: 5 };

// Each model has its own D1 database, bound as DB_<ID> (e.g. DB_HERMY), and
// its own Google Sheet source. Configured by the MODELS var in wrangler.toml.
export function getModels(env) {
  let list = env.MODELS;
  if (typeof list === 'string') {
    try { list = JSON.parse(list); } catch { list = []; }
  }
  return (Array.isArray(list) ? list : [])
    .filter((m) => m && m.id && env[`DB_${String(m.id).toUpperCase()}`])
    .map((m) => ({ ...m, id: String(m.id).toLowerCase(), db: env[`DB_${String(m.id).toUpperCase()}`] }));
}

export default {
  async fetch(request, env, ctx) {
    const authFail = checkAuth(request, env);
    if (authFail) return authFail;

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    try {
      if (request.method === 'GET' && path === '/') {
        return new Response(DASHBOARD_HTML, {
          headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
        });
      }
      const models = getModels(env);
      if (request.method === 'GET' && path === '/api/models') {
        return json(models.map((m) => ({ id: m.id, name: m.name || m.id, sheetLinked: !!sheetUrl(m) })));
      }

      const mm = path.match(/^\/api\/m\/([a-z0-9_-]+)(\/.*)?$/);
      if (!mm) return json({ error: 'Not found' }, 404);
      const model = models.find((m) => m.id === mm[1]);
      if (!model) return json({ error: 'Unknown model' }, 404);
      const db = model.db;
      const rest = mm[2] || '';

      if (request.method === 'GET' && rest === '/accounts') return json(await listAccounts(env, model));
      if (request.method === 'POST' && rest === '/accounts') return json(await addAccounts(request, env, ctx, model));
      if (request.method === 'POST' && rest === '/sync') return json(await syncSheet(env, model, { left: 1 }));

      const m = rest.match(/^\/accounts\/([A-Za-z0-9_]{1,15})(\/[a-z]+)?$/);
      if (m) {
        const username = m[1].toLowerCase();
        const action = m[2] || '';
        if (request.method === 'DELETE' && !action) {
          await db.batch([
            db.prepare('DELETE FROM accounts WHERE username = ?').bind(username),
            db.prepare('DELETE FROM snapshots WHERE username = ?').bind(username),
            db.prepare('DELETE FROM daily WHERE username = ?').bind(username),
          ]);
          return json({ ok: true });
        }
        if (request.method === 'POST' && action === '/check') {
          const row = await db.prepare('SELECT * FROM accounts WHERE username = ?').bind(username).first();
          if (!row) return json({ error: 'Not tracked' }, 404);
          await checkAccount(env, db, row, { left: 5 });
          return json({ ok: true });
        }
        if (request.method === 'POST' && action === '/shadowban') {
          const body = await request.json().catch(() => ({}));
          await db.prepare('UPDATE accounts SET shadowban_confirmed = ? WHERE username = ?')
            .bind(body.confirmed ? 1 : 0, username).run();
          const row = await db.prepare('SELECT * FROM accounts WHERE username = ?').bind(username).first();
          if (row) {
            const { status, reason } = assess(row, await loadHistory(db, username), env);
            await db.prepare('UPDATE accounts SET status = ?, reason = ? WHERE username = ?').bind(status, reason, username).run();
          }
          return json({ ok: true });
        }
        if (request.method === 'POST' && action === '/client') {
          const body = await request.json().catch(() => ({}));
          await db.prepare('UPDATE accounts SET client = ? WHERE username = ?')
            .bind(cleanClient(body.client), username).run();
          return json({ ok: true });
        }
      }
      return json({ error: 'Not found' }, 404);
    } catch (err) {
      return json({ error: String(err && err.message || err) }, 500);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runScheduled(env));
  },
};

// ---------- auth ----------

function checkAuth(request, env) {
  const password = env.DASHBOARD_PASSWORD;
  if (!password) {
    return new Response('Set the DASHBOARD_PASSWORD secret first: npx wrangler secret put DASHBOARD_PASSWORD', { status: 503 });
  }
  const header = request.headers.get('authorization') || '';
  if (header.startsWith('Basic ')) {
    let decoded = '';
    try { decoded = atob(header.slice(6)); } catch {}
    const given = decoded.slice(decoded.indexOf(':') + 1);
    if (safeEqual(given, password)) return null;
  }
  return new Response('Login required', {
    status: 401,
    headers: { 'www-authenticate': 'Basic realm="X Monitor", charset="UTF-8"' },
  });
}

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ---------- adding accounts ----------

// Accepts "@name", "name", "x.com/name", "https://twitter.com/name/status/1",
// separated by newlines, commas or spaces.
export function parseUsernames(text) {
  const out = new Set();
  const invalid = [];
  for (let token of String(text || '').split(/[\s,;]+/)) {
    token = token.trim();
    if (!token) continue;
    const urlMatch = token.match(/(?:x|twitter)\.com\/@?([^/?#]+)/i);
    let name = (urlMatch ? urlMatch[1] : token).replace(/^@/, '');
    if (USERNAME_RE.test(name)) out.add(name.toLowerCase());
    else invalid.push(token);
  }
  return { usernames: [...out], invalid };
}

function cleanClient(client) {
  const c = String(client || '').trim().slice(0, 60);
  return c || null;
}


async function addAccounts(request, env, ctx, model) {
  const db = model.db;
  const body = await request.json().catch(() => ({}));
  const { usernames, invalid } = parseUsernames(body.usernames);
  const client = cleanClient(body.client);
  const now = Date.now();
  if (usernames.length) {
    await db.batch(usernames.map((u) =>
      db.prepare(
        `INSERT INTO accounts (username, client, source, in_sheet, added_at) VALUES (?, ?, 'manual', 1, ?)
         ON CONFLICT(username) DO UPDATE SET in_sheet = 1`
      ).bind(u, client, now)
    ));
  }
  // Check the new ones straight away so they don't sit empty until the next cron run.
  const placeholders = usernames.map(() => '?').join(',');
  const fresh = usernames.length
    ? (await db.prepare(`SELECT * FROM accounts WHERE last_checked IS NULL AND username IN (${placeholders})`)
        .bind(...usernames).all()).results
    : [];
  ctx.waitUntil(checkMany(env, fresh.slice(0, 30).map((row) => ({ db, row })), { left: 45 }));
  return { added: fresh.length, alreadyTracked: usernames.length - fresh.length, invalid };
}

// ---------- Google Sheets sync ----------

// The sheet must be shared as "Anyone with the link: Viewer" (or published);
// it is read as CSV, no Google API key needed.
export function sheetUrl(model) {
  if (model.csvUrl) return model.csvUrl;   // e.g. a File > Share > Publish to web CSV link
  if (!model.sheetId) return null;
  const base = `https://docs.google.com/spreadsheets/d/${encodeURIComponent(model.sheetId)}`;
  if (model.sheetGid != null && model.sheetGid !== '') return `${base}/export?format=csv&gid=${encodeURIComponent(model.sheetGid)}`;
  const tab = model.sheetTab ? `&sheet=${encodeURIComponent(model.sheetTab)}` : '';
  return `${base}/gviz/tq?tqx=out:csv${tab}`;
}

export function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

const HEADER_RE = /^(user ?names?|handles?|accounts?|x|twitter|x handles?|x accounts?|twitter handles?|@|x\.com|links?)$/i;
const HANDLE_RE = /^\s*@|(?:x|twitter)\.com\//i;

// Returns [columnIndex, headerRowIndex] for a configured column letter or
// header text, or -1s.
function findColumn(rows, column) {
  if (column == null || column === '') return [-1, -1];
  if (/^[A-Z]{1,2}$/i.test(column)) {
    const col = column.toUpperCase().split('').reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
    // Treat the first filled cell as a header unless it is itself a handle.
    const first = rows.findIndex((r) => (r[col] || '').trim());
    return [col, first >= 0 && !HANDLE_RE.test(rows[first][col]) ? first : -1];
  }
  for (let i = 0; i < Math.min(rows.length, 5); i++) {
    const c = rows[i].findIndex((v) => v.trim().toLowerCase() === String(column).trim().toLowerCase());
    if (c >= 0) return [c, i];
  }
  return [-1, -1];
}

// Picks the username column (configured letter/header, or a header such as
// "Username" / "Handle" / "Account"); without one, takes any cell that is an
// @handle or an x.com / twitter.com link.
export function usernamesFromSheet(rows, column) {
  let [col, headerRow] = findColumn(rows, column);
  if (col < 0) {
    for (let i = 0; i < Math.min(rows.length, 5) && col < 0; i++) {
      const c = rows[i].findIndex((v) => HEADER_RE.test(v.trim()));
      if (c >= 0) { col = c; headerRow = i; }
    }
  }
  const out = new Set();
  rows.forEach((r, i) => {
    if (i <= headerRow) return;
    const cells = col >= 0 ? [r[col] || ''] : r.filter((c) => HANDLE_RE.test(c));
    for (const cell of cells) {
      // One account per cell: the first token.
      const { usernames } = parseUsernames(cell.trim().split(/[\s,;]+/)[0]);
      usernames.forEach((u) => out.add(u));
    }
  });
  return [...out];
}

async function getMeta(db) {
  const { results } = await db.prepare('SELECT key, value FROM meta').all();
  return Object.fromEntries(results.map((r) => [r.key, r.value]));
}

async function setMeta(db, values) {
  await db.batch(Object.entries(values).map(([k, v]) =>
    db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').bind(k, v == null ? null : String(v))
  ));
}

export async function syncSheet(env, model, budget) {
  const db = model.db;
  const url = sheetUrl(model);
  if (!url) return { ok: false, error: 'No sheet linked for this model' };
  if (budget.left <= 0) return { ok: false, error: 'No request budget left this run' };
  budget.left--;
  const now = Date.now();
  let usernames;
  try {
    const res = await fetch(url, { redirect: 'follow' });
    const text = await res.text();
    if (!res.ok || /^\s*<!DOCTYPE html|<html/i.test(text)) {
      throw new Error(res.ok ? 'Sheet is not shared as "Anyone with the link can view"' : `Sheet fetch failed (HTTP ${res.status})`);
    }
    usernames = usernamesFromSheet(parseCsv(text), model.sheetColumn);
  } catch (e) {
    await setMeta(db, { last_sync: now, last_sync_error: e.message });
    return { ok: false, error: e.message };
  }
  // An empty result almost always means the sheet layout changed; don't untrack everything.
  if (!usernames.length) {
    await setMeta(db, { last_sync: now, last_sync_error: 'No usernames found in the sheet' });
    return { ok: false, error: 'No usernames found in the sheet' };
  }
  const before = new Set((await db.prepare(
    "SELECT username FROM accounts WHERE source = 'sheet' AND in_sheet = 1"
  ).all()).results.map((r) => r.username));
  const stmts = [db.prepare("UPDATE accounts SET in_sheet = 0 WHERE source = 'sheet'")];
  for (const u of usernames) {
    stmts.push(db.prepare(
      `INSERT INTO accounts (username, source, in_sheet, added_at) VALUES (?, 'sheet', 1, ?)
       ON CONFLICT(username) DO UPDATE SET in_sheet = 1, source = 'sheet'`
    ).bind(u, now));
  }
  await db.batch(stmts);
  const added = usernames.filter((u) => !before.has(u)).length;
  const removed = [...before].filter((u) => !usernames.includes(u)).length;
  await setMeta(db, { last_sync: now, last_sync_count: usernames.length, last_sync_error: null });
  return { ok: true, total: usernames.length, added, removed };
}

// ---------- checking ----------

async function runScheduled(env) {
  const models = getModels(env);
  const now = Date.now();
  // Free plan: 50 outbound requests per run. Keep a little headroom.
  const budget = { left: 47 };
  const syncEvery = (Number(env.SHEET_SYNC_MINUTES) || 10) * MINUTE;
  const recheck = (Number(env.RECHECK_MINUTES) || 30) * MINUTE;
  const perRun = Math.min(Number(env.MAX_PER_RUN) || 30, 45);

  for (const model of models) {
    if (!sheetUrl(model)) continue;
    const meta = await getMeta(model.db);
    if (!meta.last_sync || now - Number(meta.last_sync) >= syncEvery) {
      await syncSheet(env, model, budget).catch((e) => console.log('sync failed', model.id, e));
    }
  }

  // The accounts due a check across all models, longest-waiting first.
  let due = [];
  for (const model of models) {
    const { results } = await model.db.prepare(
      `SELECT * FROM accounts WHERE in_sheet = 1 AND (last_checked IS NULL OR last_checked < ?)
       ORDER BY last_checked IS NOT NULL, last_checked ASC LIMIT ?`
    ).bind(now - recheck, perRun).all();
    due.push(...results.map((row) => ({ db: model.db, row })));
  }
  due.sort((a, b) => (a.row.last_checked || 0) - (b.row.last_checked || 0));
  await checkMany(env, due.slice(0, perRun), budget);

  // Housekeeping once an hour.
  if (new Date(now).getUTCMinutes() < 2) {
    for (const model of models) {
      await model.db.batch([
        model.db.prepare('DELETE FROM snapshots WHERE ts < ?').bind(now - 3 * DAY),
        model.db.prepare('DELETE FROM daily WHERE day < ?').bind(dayKey(now - 120 * DAY)),
      ]);
    }
  }
}

async function checkMany(env, items, budget) {
  // Small concurrency so the lookup service isn't hammered.
  const queue = [...items];
  const workers = Array.from({ length: 5 }, async () => {
    while (queue.length) {
      const { db, row } = queue.shift();
      if (budget.left <= 0) return;
      try { await checkAccount(env, db, row, budget); } catch (e) { console.log('check failed', row.username, e); }
    }
  });
  await Promise.all(workers);
}

// FxTwitter intermittently answers "User not found" for accounts that exist
// (roughly 1 in 3 calls in testing), so a miss is retried before it counts.
// `budget.left` caps outbound requests per invocation (free plan: 50).
export async function lookupProfile(username, budget = { left: 5 }) {
  let result = { kind: 'error', message: 'Skipped: request budget for this run used up' };
  let tries = 0;
  for (let attempt = 0; attempt < 5 && budget.left > 0; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 300 * attempt));
    budget.left--;
    result = await lookupOnce(username);
    if (result.kind === 'ok') return result;
    tries++;
  }
  // A miss only counts if every retry missed.
  if (result.kind === 'missing' && tries < 5) return { kind: 'error', message: 'Not found, retries cut short; will recheck' };
  return result;
}

// Profile lookup through FxTwitter's free public API. Returns
// { kind: 'ok', followers, following, tweets, protected, name } | { kind: 'missing' } | { kind: 'error', message }.
// To switch data source later, only this function needs changing.
async function lookupOnce(username) {
  let res;
  try {
    res = await fetch(`https://api.fxtwitter.com/${encodeURIComponent(username)}`, {
      headers: { 'user-agent': 'x-monitor/1.0 (account health dashboard)' },
    });
  } catch (e) {
    return { kind: 'error', message: 'Network error' };
  }
  let data = null;
  try { data = await res.json(); } catch {}
  if (data && data.code === 200 && data.user) {
    const u = data.user;
    return {
      kind: 'ok',
      followers: Number(u.followers) || 0,
      following: Number(u.following) || 0,
      tweets: Number(u.tweets) || 0,
      protected: u.protected ? 1 : 0,
      name: u.name || null,
    };
  }
  if (res.status === 404 || (data && data.code === 404)) return { kind: 'missing' };
  return { kind: 'error', message: `Lookup failed (HTTP ${res.status})` };
}

async function checkAccount(env, db, row, budget) {
  const now = Date.now();
  const result = await lookupProfile(row.username, budget);
  const hist = await loadHistory(db, row.username);
  const writes = [];

  if (result.kind === 'ok') {
    Object.assign(row, {
      followers: result.followers, following: result.following, tweets: result.tweets,
      protected: result.protected, display_name: result.name, not_found_streak: 0,
    });
    // Keep at most one snapshot every ~55 minutes and only rewrite today's
    // daily row when the numbers move: D1's free plan allows 100k writes/day.
    const lastSnap = hist.snaps[hist.snaps.length - 1];
    if (!lastSnap || now - lastSnap.ts >= 55 * MINUTE) {
      const snap = { ts: now, followers: result.followers, following: result.following };
      hist.snaps.push(snap);
      writes.push(db.prepare('INSERT OR REPLACE INTO snapshots (username, ts, followers, following) VALUES (?, ?, ?, ?)')
        .bind(row.username, now, result.followers, result.following));
    }
    const today = dayKey(now);
    const lastDay = hist.days[hist.days.length - 1];
    if (!lastDay || lastDay.day !== today || lastDay.followers !== result.followers || lastDay.following !== result.following) {
      if (lastDay && lastDay.day === today) Object.assign(lastDay, { followers: result.followers, following: result.following });
      else hist.days.push({ day: today, followers: result.followers, following: result.following });
      writes.push(db.prepare('INSERT OR REPLACE INTO daily (username, day, followers, following) VALUES (?, ?, ?, ?)')
        .bind(row.username, today, result.followers, result.following));
    }
  } else if (result.kind === 'missing') {
    row.not_found_streak = (row.not_found_streak || 0) + 1;
  } else {
    row.lookup_error = result.message;
  }
  row.last_checked = now;

  const { status, reason } = assess(row, hist, env);
  writes.unshift(db.prepare(
    `UPDATE accounts SET last_checked = ?, followers = ?, following = ?, tweets = ?, protected = ?,
     display_name = ?, not_found_streak = ?, status = ?, reason = ? WHERE username = ?`
  ).bind(now, row.followers, row.following, row.tweets, row.protected || 0, row.display_name || null,
    row.not_found_streak || 0, status, reason, row.username));
  await db.batch(writes);
}

// ---------- health rules ----------

export function computeMetrics(row, hist) {
  const now = Date.now();
  const snaps = hist ? hist.snaps : [];   // ascending by ts
  const days = hist ? hist.days : [];     // ascending by day
  const f = row.followers;

  const snapAtOrBefore = (ts) => {
    let best = null;
    for (const s of snaps) { if (s.ts <= ts) best = s; else break; }
    return best;
  };
  const dayAtOrBefore = (key) => {
    let best = null;
    for (const d of days) { if (d.day <= key) best = d; else break; }
    return best;
  };

  const s24 = snapAtOrBefore(now - 24 * HOUR);
  const s48 = snapAtOrBefore(now - 48 * HOUR);
  const d7 = dayAtOrBefore(dayKey(now - 7 * DAY));
  const d30 = dayAtOrBefore(dayKey(now - 30 * DAY));
  const first = days[0] || null;

  const pct = (base) => (base && base.followers > 0 ? ((f - base.followers) / base.followers) * 100 : null);
  return {
    followers24h: s24 && f != null ? f - s24.followers : null,
    followers48h: s48 && f != null ? f - s48.followers : null,
    following48h: s48 && row.following != null ? row.following - s48.following : null,
    followers7d: d7 && f != null ? f - d7.followers : null,
    followers7dPct: d7 && f != null ? pct(d7) : null,
    followers30d: d30 && f != null ? f - d30.followers : null,
    // Growth since tracking started, for accounts younger than 7 days.
    sinceStart: first && f != null ? f - first.followers : null,
    trackedDays: first ? Math.round((now - Date.parse(first.day + 'T00:00:00Z')) / DAY) : 0,
    trend: days.slice(-30).map((d) => d.followers),
  };
}

export function assess(row, hist, env) {
  const target = Number(env.GROWTH_TARGET_PCT ?? 1);
  const sbMin = Number(env.SHADOWBAN_FOLLOWING_MIN ?? 25);

  if ((row.not_found_streak || 0) >= 3) {
    return { status: 'suspended', reason: `Profile not found on ${row.not_found_streak} checks in a row: suspended, deactivated or renamed` };
  }
  if (row.shadowban_confirmed) {
    return { status: 'shadowban', reason: 'Shadowban confirmed by hand' };
  }
  if (row.followers == null) {
    if (row.lookup_error) return { status: 'error', reason: row.lookup_error };
    if (row.not_found_streak) return { status: 'new', reason: `Not found ${row.not_found_streak}x; rechecking before flagging` };
    return { status: 'new', reason: 'Waiting for first check' };
  }

  const m = computeMetrics(row, hist);

  if (m.following48h != null && m.followers48h != null && m.following48h >= sbMin && m.followers48h <= 0) {
    return {
      status: 'shadowban',
      reason: `Possible shadowban: following +${m.following48h} in 48h, followers ${signed(m.followers48h)}. Confirm with a search check.`,
    };
  }

  if (m.followers7dPct != null) {
    if (m.followers7dPct < target) {
      return {
        status: 'stalling',
        reason: `7d growth ${m.followers7dPct.toFixed(2)}% (${signed(m.followers7d)}), target ${target}%`,
      };
    }
    return { status: 'healthy', reason: `7d growth ${m.followers7dPct.toFixed(2)}% (${signed(m.followers7d)})` };
  }

  // Under 7 days of data: judge on the 48h trend if we have it.
  if (m.followers48h != null && m.followers48h < 0) {
    return { status: 'stalling', reason: `Followers ${signed(m.followers48h)} in 48h` };
  }
  return { status: 'new', reason: `Collecting data (${m.trackedDays}d tracked)` };
}

// ---------- history ----------

async function loadHistory(db, username) {
  const now = Date.now();
  const [snaps, days] = await db.batch([
    db.prepare('SELECT ts, followers, following FROM snapshots WHERE username = ? AND ts >= ? ORDER BY ts')
      .bind(username, now - 3 * DAY),
    db.prepare('SELECT day, followers, following FROM daily WHERE username = ? AND day >= ? ORDER BY day')
      .bind(username, dayKey(now - 35 * DAY)),
  ]);
  return { snaps: snaps.results, days: days.results };
}

// For the list view, only the snapshots at the 24h and 48h marks are needed.
async function loadAllHistory(db) {
  const now = Date.now();
  const atOrBefore = (ts) => db.prepare(
    `SELECT s.username, s.ts, s.followers, s.following FROM snapshots s
     WHERE s.ts = (SELECT MAX(ts) FROM snapshots WHERE username = s.username AND ts <= ?)`
  ).bind(ts);
  const [s48, s24, days] = await db.batch([
    atOrBefore(now - 48 * HOUR),
    atOrBefore(now - 24 * HOUR),
    db.prepare('SELECT username, day, followers, following FROM daily WHERE day >= ? ORDER BY day')
      .bind(dayKey(now - 35 * DAY)),
  ]);
  const map = new Map();
  const get = (u) => {
    if (!map.has(u)) map.set(u, { snaps: [], days: [] });
    return map.get(u);
  };
  for (const s of s48.results) get(s.username).snaps.push(s);
  for (const s of s24.results) {
    const h = get(s.username);
    if (!h.snaps.length || h.snaps[0].ts !== s.ts) h.snaps.push(s);
  }
  for (const d of days.results) get(d.username).days.push(d);
  return map;
}

async function listAccounts(env, model) {
  const db = model.db;
  const [{ results }, history, meta] = await Promise.all([
    db.prepare('SELECT * FROM accounts').all(),
    loadAllHistory(db),
    getMeta(db),
  ]);
  const accounts = results.map((row) => ({
    username: row.username,
    displayName: row.display_name,
    client: row.client,
    source: row.source,
    inSheet: !!row.in_sheet,
    addedAt: row.added_at,
    lastChecked: row.last_checked,
    followers: row.followers,
    following: row.following,
    tweets: row.tweets,
    protected: !!row.protected,
    shadowbanConfirmed: !!row.shadowban_confirmed,
    status: row.in_sheet ? (row.status || 'new') : 'removed',
    reason: row.in_sheet ? row.reason : 'Removed from the sheet; no longer checked',
    severity: row.in_sheet ? (SEVERITY[row.status] ?? 9) : 10,
    ...computeMetrics(row, history.get(row.username)),
  }));
  return {
    model: { id: model.id, name: model.name || model.id },
    accounts,
    sync: {
      linked: !!sheetUrl(model),
      lastSync: meta.last_sync ? Number(meta.last_sync) : null,
      count: meta.last_sync_count ? Number(meta.last_sync_count) : null,
      error: meta.last_sync_error || null,
    },
    settings: {
      growthTargetPct: Number(env.GROWTH_TARGET_PCT ?? 1),
      shadowbanFollowingMin: Number(env.SHADOWBAN_FOLLOWING_MIN ?? 25),
      recheckMinutes: Number(env.RECHECK_MINUTES) || 30,
    },
    now: Date.now(),
  };
}

// ---------- helpers ----------

function dayKey(ts) {
  return new Date(ts).toISOString().slice(0, 10);
}

function signed(n) {
  const str = Math.abs(n).toLocaleString('en-GB');
  return n > 0 ? `+${str}` : n < 0 ? `-${str}` : '0';
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}
