/**
 * Routes the softphone tab calls, and the Twenty OAuth connect flow.
 *
 * Order of sign-in: the agent connects Twenty first (that is who they are, and
 * whose name calls are logged under), then signs in to Vobiz with an account
 * (Auth ID + Auth Token) or with an existing SIP endpoint.
 *
 * Every route under /api is behind a Bearer session token. No route returns a
 * SIP password, a list of accounts, or a list of endpoints without one.
 */
const express = require('express');
const crypto = require('node:crypto');
const config = require('./config');
const store = require('./store');
const v = require('./vobiz');
const tw = require('./twenty');
const logger = require('./call-logger');
const events = require('./events');
const { state, liveSessions, sessionExpired } = require('./state');
const { log, toE164, isE164, randomToken, safeEqual } = require('./util');

const AUTH_ID_RE = /^[A-Za-z0-9_]{4,64}$/;

// ─── sessions ────────────────────────────────────────────────────────────────

function sessionFrom(req) {
  const h = String(req.headers.authorization || '');
  const token = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (!token) return null;
  const s = state.sessions.get(token);
  if (!s) return null;
  if (sessionExpired(s)) { state.sessions.delete(token); return null; }
  return { token, s };
}

function requireIdentity(req, res, next) {
  const found = sessionFrom(req);
  if (!found) return res.status(401).json({ error: 'Not signed in', code: 'signed_out' });
  req.token = found.token;
  req.sess = found.s;
  next();
}

function requireVobiz(req, res, next) {
  requireIdentity(req, res, () => {
    if (req.sess.mode !== 'account') return res.status(403).json({ error: 'Sign in with your Vobiz account to use this.', code: 'needs_account' });
    if (!state.accounts.get(req.sess.authId)) return res.status(401).json({ error: 'Session expired. Sign in again.', code: 'signed_out' });
    next();
  });
}

function requireAdmin(req, res, next) {
  requireIdentity(req, res, () => {
    const u = tw.getUser(req.sess.wsKey, req.sess.userId);
    if (!u || !u.admin) return res.status(403).json({ error: 'Only a Twenty workspace administrator can change this.' });
    next();
  });
}

// Alphanumeric, because it becomes part of a Vobiz SIP username.
const agentKeyOf = (wsKey, userId) => `tw${crypto.createHash('sha256').update(`${wsKey}|${userId}`).digest('hex').slice(0, 14)}`;

/** End a session: its stream, its SIP routing entry. */
function endSession(token, reason) {
  const s = state.sessions.get(token);
  if (!s) return;
  events.pushToSession(token, { type: 'signed-out', reason });
  events.closeSession(token);
  state.sessions.delete(token);
  if (s.sipUser && !liveSessions().some(([, o]) => o.sipUser === s.sipUser)) {
    state.sipUsers.delete(s.sipUser);
  }
}

function publicSession(s) {
  const ws = tw.getWorkspace(s.wsKey) || {};
  const user = tw.getUser(s.wsKey, s.userId) || {};
  const account = s.authId && state.accounts.get(s.authId);
  return {
    user: { name: s.name, id: s.userId, admin: !!user.admin },
    workspace: { name: ws.name || 'Twenty', appUrl: ws.appUrl || null },
    mode: s.mode || null,
    authId: s.authId || null,
    numbers: s.numbers || [],
    numberApps: account ? Object.fromEntries((s.numbers || []).map(n => [n, (account.numberApps || {})[n] || null])) : {},
    appId: (account && account.appId) || null,
    from: s.from || null,
    sipUser: s.sipUser || null,
    settings: {
      autoOpen: !!(ws.settings && ws.settings.autoOpen),
      defaultCountry: (ws.settings && ws.settings.defaultCountry) || config.DEFAULT_COUNTRY,
    },
  };
}

// ─── Twenty OAuth ────────────────────────────────────────────────────────────

const oauth = express.Router();
const COOKIE = 'vz_tw_oauth';

function readCookie(req, name) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return decodeURIComponent(rest.join('='));
  }
  return '';
}

/** Which Twenty servers the connect form may offer. Public: it is the deployment's own list. */
oauth.get('/servers', (req, res) => res.json({ servers: config.TWENTY_ALLOWED_URLS }));

oauth.get('/start', async (req, res) => {
  if (!config.PUBLIC_BASE_URL) return res.status(500).type('text/plain').send('This server has no PUBLIC_BASE_URL, so Twenty cannot send you back here. Ask your administrator.');
  const requested = String(req.query.server || config.TWENTY_ALLOWED_URLS[0] || '');
  const origin = tw.allowedOrigin(requested);
  if (!origin) return res.status(400).type('text/plain').send('That Twenty server is not one this calling service is set up for.');
  try {
    const st = randomToken(24);
    const { verifier, challenge } = tw.pkce();
    const { url, issuer } = await tw.authorizeUrl(origin, st, challenge);
    state.oauthStates.set(st, { origin, verifier, issuer, exp: Date.now() + 10 * 60 * 1000 });
    // The cookie binds the callback to the browser that started it.
    res.cookie(COOKIE, st, { httpOnly: true, secure: config.PUBLIC_BASE_URL.startsWith('https://'), sameSite: 'lax', maxAge: 10 * 60 * 1000, path: '/twenty/oauth' });
    return res.redirect(302, url);
  } catch (err) {
    log(`x Twenty connect start for ${origin} failed: ${err.message}`);
    return res.redirect(302, '/phone#error=server');
  }
});

oauth.get('/callback', async (req, res) => {
  const st = String(req.query.state || '');
  const code = String(req.query.code || '');
  const entry = st && state.oauthStates.get(st);
  const cookie = readCookie(req, COOKIE);
  res.clearCookie(COOKIE, { path: '/twenty/oauth' });
  if (!entry || entry.exp < Date.now() || !cookie || !safeEqual(cookie, st)) {
    return res.status(400).type('text/plain').send('This Twenty sign-in link is not valid any more. Go back to the softphone and click "Connect Twenty" again.');
  }
  state.oauthStates.delete(st);
  // RFC 9207: the response must come from the server the flow was started with.
  if (req.query.iss !== undefined && String(req.query.iss).replace(/\/+$/, '') !== String(entry.issuer).replace(/\/+$/, '')) {
    log(`x Twenty callback issuer mismatch: got ${req.query.iss}, expected ${entry.issuer}`);
    return res.redirect(302, '/phone#error=connect');
  }
  if (!code) return res.redirect(302, '/phone#error=denied');
  try {
    const tokens = await tw.exchangeCode(entry.origin, code, entry.verifier);
    const me = await tw.getMe(entry.origin, tokens.access_token);
    const user = tw.saveUser(entry.origin, me, tokens);
    const link = randomToken(24);
    state.linkCodes.set(link, { wsKey: user.wsKey, userId: user.userId, exp: Date.now() + 2 * 60 * 1000 });
    log(`Twenty connected: user ${user.userId} of workspace ${user.wsKey}${user.admin ? ' (admin)' : ''}`);
    // A fragment is never sent to any server or written to access logs.
    return res.redirect(302, `/phone#link=${encodeURIComponent(link)}`);
  } catch (err) {
    log(`x Twenty connect failed: ${err.message}`);
    return res.redirect(302, '/phone#error=connect');
  }
});

// ─── softphone API ───────────────────────────────────────────────────────────

const api = express.Router();
api.use(express.json({ limit: '32kb' }));

/** Trade the one-time link code from the OAuth redirect for a session. */
api.post('/identity/claim', (req, res) => {
  const code = String((req.body && req.body.code) || '');
  const entry = code && state.linkCodes.get(code);
  if (!entry || entry.exp < Date.now()) return res.status(401).json({ error: 'That link has expired. Connect Twenty again.' });
  state.linkCodes.delete(code);
  const user = tw.getUser(entry.wsKey, entry.userId);
  if (!user) return res.status(401).json({ error: 'Connect Twenty again.' });
  const token = randomToken(32);
  state.sessions.set(token, {
    wsKey: user.wsKey, userId: user.userId, name: user.name,
    agentKey: agentKeyOf(user.wsKey, user.userId), createdAt: Date.now(), mode: null,
  });
  res.json({ token, session: publicSession(state.sessions.get(token)) });
});

api.get('/session', requireIdentity, (req, res) => res.json(publicSession(req.sess)));

api.post('/login', requireIdentity, async (req, res) => {
  const { authId, authToken } = req.body || {};
  if (!AUTH_ID_RE.test(String(authId || '')) || typeof authToken !== 'string' || !authToken) {
    return res.status(400).json({ error: 'Enter your Vobiz Auth ID and Auth Token.' });
  }
  if (!config.PUBLIC_BASE_URL.startsWith('https://')) {
    return res.status(500).json({ error: 'This server has no public https PUBLIC_BASE_URL, so Vobiz could not reach it. Ask your administrator.' });
  }
  const candidate = { authId: String(authId), authToken };
  const list = await v.fetchAccountNumbers(candidate);
  if (!list.all) {
    log(`login refused for ${authId}: Vobiz returned ${list.status} checking the credentials`);
    return res.status(401).json({ error: 'Vobiz did not accept that Auth ID and Auth Token. Copy both from the Vobiz Console and try again.' });
  }
  const account = state.accounts.get(candidate.authId) || { authId: candidate.authId };
  account.authToken = authToken;
  account.numbers = list.all;
  account.callerIds = list.callerIds;
  account.numberApps = list.apps;
  state.accounts.set(account.authId, account);

  const s = req.sess;
  const appId = await v.ensureApplication(account);
  if (!appId) return res.status(502).json({ error: 'Could not find or create the calling application in your Vobiz account.' });
  const ep = await v.ensureEndpoint(account, s.agentKey);
  if (!ep) return res.status(502).json({ error: 'Could not set up your SIP endpoint in your Vobiz account.' });
  const bound = await v.bindEndpoint(account, ep.endpointId, appId);
  if (!bound) log(`! ${account.authId}: endpoint ${ep.endpointId} is not bound to ${appId}; outbound calls may not reach /vobiz/answer`);

  // The password just rotated, so any other session of this agent holds a dead
  // one. End it: that tab shows "signed in elsewhere" instead of looking ready.
  for (const [t, o] of liveSessions()) {
    if (t !== req.token && o.agentKey === s.agentKey && o.mode) endSession(t, 'elsewhere');
  }
  const d = store.load();
  const links = d.accountLinks[account.authId] || [];
  if (!links.includes(s.wsKey)) { d.accountLinks[account.authId] = [...links, s.wsKey]; store.saveNow(); }

  const numbers = list.callerIds;
  const from = numbers.includes(s.lastCallerId) ? s.lastCallerId : (numbers[0] || '');
  Object.assign(s, { mode: 'account', authId: account.authId, numbers, from, sipUser: ep.username, sipPassword: ep.password, endpointId: ep.endpointId });
  state.sipUsers.set(ep.username, { authId: account.authId, agentKey: s.agentKey, wsKey: s.wsKey, userId: s.userId, name: s.name, callerId: from });
  log(`login ok: ${account.authId} / ${s.agentKey} as ${ep.username}, ${numbers.length} caller ID(s)`);
  res.json({ ...publicSession(s), bound });
});

// There is no "SIP direct" sign-in (an existing endpoint's username and
// password, no account credentials). With no Auth Token the backend cannot
// verify Vobiz callbacks about those calls, and cannot prove the agent owns
// the endpoint, so anyone could claim an endpoint and have its calls logged
// into their workspace. Agents sign in with their Vobiz account.

api.post('/logout', requireIdentity, (req, res) => {
  endSession(req.token, 'logout');
  res.json({ ok: true });
});

/**
 * The SIP identity this tab registers as, with the password minted at this
 * sign-in. Behind the session on purpose: there is no /agent/:id route.
 */
api.get('/agent', requireVobiz, (req, res) => {
  const s = req.sess;
  res.set('Cache-Control', 'no-store');
  res.json({ sipUser: `${s.sipUser}@${config.VOBIZ_REGISTRAR}`, sipPassword: s.sipPassword, registrarUrl: `wss://${config.VOBIZ_REGISTRAR}:5063/`, displayName: s.name });
});

api.get('/numbers', requireVobiz, (req, res) => res.json(publicSession(req.sess)));

api.post('/select-number', requireVobiz, (req, res) => {
  const number = String((req.body && req.body.number) || '');
  const s = req.sess;
  if (!s.numbers.includes(number)) return res.status(400).json({ error: 'That number is not one of your Vobiz numbers.' });
  s.from = number;
  s.lastCallerId = number;
  const who = state.sipUsers.get(s.sipUser);
  if (who) who.callerId = number;
  res.json({ from: number });
});

/** "Enable inbound calls": moves the number onto this application. Explicit only. */
api.post('/setup-inbound', requireVobiz, async (req, res) => {
  const s = req.sess;
  const account = state.accounts.get(s.authId);
  const number = String((req.body && req.body.number) || s.from || '');
  if (!s.numbers.includes(number)) return res.status(400).json({ error: 'Pick one of your Vobiz numbers first.' });
  const appId = await v.ensureApplication(account);
  if (!appId) return res.status(502).json({ error: 'Could not find or create the calling application.' });
  const previousAppId = (account.numberApps || {})[number] || null;
  const r = await v.attachNumber(account, number, appId);
  log(`${account.authId}: attach ${number} to ${appId} (was ${previousAppId || 'none'}): HTTP ${r.status}`);
  if (!v.ok(r)) return res.status(502).json({ error: `Vobiz returned ${r.status} attaching ${number}.` });
  account.numberApps = { ...(account.numberApps || {}), [number]: appId };
  res.json({ ok: true, number, appId, previousAppId });
});

/** Caller lookup for the ringing card and the in-call contact card. */
api.get('/lookup', requireIdentity, async (req, res) => {
  const s = req.sess;
  const country = tw.countryFor(s.wsKey);
  const e164 = toE164(req.query.number, country);
  if (!isE164(e164)) return res.status(400).json({ error: 'Not a phone number' });
  try {
    const people = (await tw.findPeopleByPhone(s.wsKey, s.userId, e164, country)).slice(0, 3);
    const out = [];
    for (const p of people) {
      let company = null;
      if (p.companyId) {
        try { const full = await tw.getPerson(s.wsKey, s.userId, p.id); company = full && full.company && full.company.name ? String(full.company.name) : null; } catch { /* shown without */ }
      }
      out.push({ id: String(p.id), name: tw.personName(p) || e164, company, jobTitle: p.jobTitle || '', url: tw.personUrl(s.wsKey, p.id) });
    }
    const d = store.load();
    const recent = out[0] ? Object.entries(d.calls)
      .filter(([, c]) => c.wsKey === s.wsKey && c.personId === out[0].id && c.noteId)
      .sort((a, b) => (b[1].startedAt || 0) - (a[1].startedAt || 0)).slice(0, 3)
      .map(([callUuid, c]) => ({ callUuid, direction: c.direction, outcome: c.outcome, talkSeconds: c.talkSeconds, startedAt: c.startedAt })) : [];
    res.json({ number: e164, people: out, recent });
  } catch (err) {
    res.status(err.code === 'not_connected' ? 401 : 502).json({ error: err.message, code: err.code === 'not_connected' ? 'twenty_reconnect' : err.code });
  }
});

/** Calls this agent handled, newest first, with fresh recording links. */
api.get('/calls', requireIdentity, (req, res) => {
  const s = req.sess;
  const settings = logger.settingsFor(s.wsKey);
  const d = store.load();
  const calls = Object.entries(d.calls)
    .filter(([, c]) => c.wsKey === s.wsKey && c.userId === s.userId && c.noteId)
    .sort((a, b) => (b[1].startedAt || 0) - (a[1].startedAt || 0)).slice(0, 20)
    .map(([callUuid, c]) => ({
      callUuid, direction: c.direction, outcome: c.outcome, talkSeconds: c.talkSeconds, remote: c.remote, startedAt: c.startedAt,
      personName: c.personName || '', personUrl: tw.personUrl(s.wsKey, c.personId),
      recordingUrl: c.recordingId && c.authId ? logger.recordingLink(c.authId, callUuid, settings.recordingTtlSeconds) : null,
    }));
  res.json({ calls });
});

api.get('/events', requireIdentity, (req, res) => events.attach(req.token, res));

/**
 * The softphone's report of an outbound call. Calls that reached /vobiz/answer
 * are logged from the server's own record; this only covers an INVITE that
 * never got there (JsSIP "failed" before Vobiz ran our XML), so no call is
 * ever silently dropped.
 */
const CAUSE_OUTCOME = { Busy: 'busy', Canceled: 'cancelled', 'No Answer': 'no-answer', 'Request Timeout': 'no-answer', Rejected: 'declined' };
api.post('/call-log', requireIdentity, (req, res) => {
  const s = req.sess;
  const b = req.body || {};
  const ref = String(b.ref || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
  const number = toE164(b.number, tw.countryFor(s.wsKey));
  if (!ref || !isE164(number)) return res.status(400).json({ error: 'ref and number are required' });
  const prior = state.refs.get(ref) || {};
  state.refs.set(ref, { ...prior, report: { cause: String(b.cause || '') }, at: prior.at || Date.now() });
  res.json({ ok: true });
  const t = setTimeout(() => {
    const r = state.refs.get(ref);
    if (!r || r.callUuid || r.panelLogged) return;
    r.panelLogged = true;
    const startedAt = Number(b.startedAt) || Date.now();
    logger.logCall({
      callUuid: `panel-${ref}`, authId: s.authId || null, wsKey: s.wsKey, userId: s.userId, agentName: s.name,
      direction: 'outbound', outcome: CAUSE_OUTCOME[b.cause] || 'failed', talkSeconds: 0, remote: number, did: s.from || '',
      startedAt, endedAt: Date.now(), recordingId: null, hangupCause: String(b.cause || ''),
    });
  }, config.PANEL_REPORT_GRACE_MS);
  if (t.unref) t.unref();
});

/** Other agents of this workspace and Vobiz account who can take a transfer. */
api.get('/agents', requireVobiz, (req, res) => {
  const s = req.sess;
  const seen = new Set();
  const agents = [];
  for (const [, o] of liveSessions()) {
    if (o.wsKey !== s.wsKey || o.authId !== s.authId || o.mode !== 'account' || o.userId === s.userId || seen.has(o.userId)) continue;
    seen.add(o.userId);
    agents.push({ userId: o.userId, name: o.name });
  }
  res.json({ agents });
});

/** Blind transfer of an inbound caller to another signed-in agent. */
api.post('/transfer', requireVobiz, async (req, res) => {
  const s = req.sess;
  const target = String((req.body && req.body.userId) || '');
  const call = [...state.calls.values()].find(c => c.agentSipUser === s.sipUser && c.answeredAt && !c.endedAt);
  if (!call) return res.status(404).json({ error: 'No answered call to transfer.' });
  if (call.direction !== 'inbound') return res.status(400).json({ error: 'Transfer is available on inbound calls.' });
  const t = liveSessions().map(([, o]) => o).find(o => o.wsKey === s.wsKey && o.authId === s.authId && o.userId === target && o.mode === 'account' && o.sipUser);
  if (!t) return res.status(404).json({ error: 'That agent is not signed in.' });
  const account = state.accounts.get(s.authId);
  state.transfers.set(call.callUuid, { authId: s.authId, targetSipUser: t.sipUser, callerId: call.did, callerName: call.remote, exp: Date.now() + 60 * 1000 });
  const r = await v.transferLeg(account, call.callUuid, 'aleg', `${config.PUBLIC_BASE_URL}/vobiz/transfer-xml`);
  log(`transfer ${call.callUuid} from ${s.agentKey} to ${t.agentKey}: HTTP ${r.status}`);
  if (!v.ok(r)) { state.transfers.delete(call.callUuid); return res.status(502).json({ error: `Vobiz returned ${r.status} for the transfer.` }); }
  events.pushToUser(t.wsKey, t.userId, { type: 'transfer-incoming', callUuid: call.callUuid, from: call.remote, fromAgent: s.name });
  res.json({ ok: true });
});

// ─── settings (per Twenty workspace) ─────────────────────────────────────────

api.get('/settings', requireIdentity, (req, res) => {
  const s = req.sess;
  const ws = tw.getWorkspace(s.wsKey) || {};
  const u = tw.getUser(s.wsKey, s.userId) || {};
  res.json({ admin: !!u.admin, workspace: ws.name || 'Twenty', settings: logger.settingsFor(s.wsKey) });
});

api.post('/settings', requireAdmin, (req, res) => {
  const ws = tw.getWorkspace(req.sess.wsKey);
  if (!ws) return res.status(404).json({ error: 'Connect Twenty again.' });
  const b = req.body || {};
  const next = { ...tw.defaultSettings(), ...(ws.settings || {}) };
  if (b.defaultCountry !== undefined && /^[A-Z]{2}$/.test(String(b.defaultCountry))) next.defaultCountry = String(b.defaultCountry);
  if (b.createUnknown !== undefined) next.createUnknown = !!b.createUnknown;
  if (b.missedTask !== undefined) next.missedTask = !!b.missedTask;
  if (b.autoOpen !== undefined) next.autoOpen = !!b.autoOpen;
  if (b.recordingTtlSeconds !== undefined) next.recordingTtlSeconds = Math.min(7 * 86400, Math.max(300, Number(b.recordingTtlSeconds) || config.RECORDING_LINK_TTL_SECONDS));
  ws.settings = next;
  store.saveNow();
  res.json({ settings: next });
});

/** Disconnect: "me" forgets this user's token; "workspace" (admins) forgets the whole workspace's data. */
api.post('/twenty/disconnect', requireIdentity, (req, res) => {
  const s = req.sess;
  const scope = (req.body && req.body.scope) === 'workspace' ? 'workspace' : 'me';
  const u = tw.getUser(s.wsKey, s.userId);
  if (scope === 'workspace' && !(u && u.admin)) return res.status(403).json({ error: 'Only a Twenty workspace administrator can disconnect the whole workspace.' });
  for (const [t, o] of liveSessions()) {
    if (o.wsKey === s.wsKey && (scope === 'workspace' || o.userId === s.userId)) endSession(t, 'disconnected');
  }
  if (scope === 'workspace') tw.disconnectWorkspace(s.wsKey); else tw.disconnectUser(s.wsKey, s.userId);
  log(`Twenty disconnected: ${scope} ${s.wsKey}${scope === 'me' ? `/${s.userId}` : ''}`);
  res.json({ ok: true });
});

module.exports = { api, oauth, requireIdentity };
