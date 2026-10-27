/**
 * Twenty CRM client: OAuth 2.0 (dynamic client registration + PKCE), the
 * signed-in user, and the REST writes calls need.
 *
 * Verified against a self-hosted Twenty built 23 Oct 2026:
 *  - /.well-known/oauth-authorization-server names every endpoint. On Twenty
 *    Cloud the authorize page lives on app.twenty.com, so it is always read
 *    from discovery, never built from the API origin.
 *  - POST /oauth/register makes a public client (no secret), so PKCE is the
 *    proof at the token endpoint. Access tokens last 30 minutes, refresh tokens
 *    60 days, and every refresh returns a new refresh token.
 *  - POST /metadata { currentUser { ... } } says who the token belongs to.
 *  - Records written with the token are attributed to that user.
 *
 * Access tokens live in memory only. Refresh tokens are stored encrypted.
 */
const crypto = require('node:crypto');
const config = require('./config');
const store = require('./store');
const { state } = require('./state');
const { log, toE164, digitsOf, sleep } = require('./util');

class TwentyError extends Error {
  constructor(code, message, status) {
    super(message);
    this.code = code;
    this.status = status || 0;
  }
}

// Every request gets a deadline: a hung request would otherwise hold a call
// in flight forever, so it is never queued or retried.
const timedFetch = (url, opts = {}) => fetch(url, { ...opts, signal: AbortSignal.timeout(15000) });

const userKey = (wsKey, userId) => `${wsKey}:${userId}`;
const wsKeyOf = (origin, workspaceId) => `w${crypto.createHash('sha256').update(`${origin}|${workspaceId}`).digest('hex').slice(0, 20)}`;
const redirectUri = () => `${config.PUBLIC_BASE_URL}/twenty/oauth/callback`;

function allowedOrigin(url) {
  let origin;
  try { origin = new URL(String(url)).origin; } catch { return null; }
  return config.TWENTY_ALLOWED_URLS.includes(origin) ? origin : null;
}

function isLocalHttp(u) {
  return u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
}

// ─── OAuth ───────────────────────────────────────────────────────────────────

const discovered = new Map();

/**
 * The server's OAuth metadata. Tokens are only ever sent to the allowlisted
 * origin itself: a token or registration endpoint on any other host is refused.
 */
async function discover(origin) {
  const hit = discovered.get(origin);
  if (hit && hit.exp > Date.now()) return hit.meta;
  const res = await timedFetch(`${origin}/.well-known/oauth-authorization-server`, { headers: { Accept: 'application/json' } });
  let meta = null;
  try { meta = await res.json(); } catch { /* not JSON */ }
  if (!res.ok || !meta || !meta.authorization_endpoint || !meta.token_endpoint || !meta.registration_endpoint) {
    throw new TwentyError('discovery', `This Twenty server does not offer OAuth (HTTP ${res.status}). It needs a recent Twenty version.`, res.status);
  }
  for (const k of ['token_endpoint', 'registration_endpoint']) {
    if (new URL(meta[k]).origin !== origin) throw new TwentyError('discovery', `Twenty's ${k} is not on ${origin}; refusing to send credentials there.`);
  }
  const auth = new URL(meta.authorization_endpoint);
  if (auth.protocol !== 'https:' && !isLocalHttp(auth)) throw new TwentyError('discovery', 'Twenty\'s authorize page is not https.');
  discovered.set(origin, { meta, exp: Date.now() + 3600 * 1000 });
  return meta;
}

/** One OAuth client per Twenty server, registered on first use. */
async function ensureClient(origin) {
  const d = store.load();
  const known = d.clients[origin];
  if (known && known.clientId && known.redirectUri === redirectUri()) return known.clientId;
  const meta = await discover(origin);
  const res = await timedFetch(meta.registration_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      client_name: 'Vobiz Calling',
      redirect_uris: [redirectUri()],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope: 'api profile',
    }),
  });
  let body = {};
  try { body = await res.json(); } catch { /* not JSON */ }
  if (!res.ok || !body.client_id) {
    throw new TwentyError('register', `Twenty refused to register this app (HTTP ${res.status}${body.error_description ? `: ${body.error_description}` : ''}).`, res.status);
  }
  d.clients[origin] = { clientId: String(body.client_id), redirectUri: redirectUri(), registeredAt: Date.now() };
  store.saveNow();
  log(`Twenty ${origin}: registered OAuth client ${body.client_id}`);
  return d.clients[origin].clientId;
}

function pkce() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

async function authorizeUrl(origin, stateToken, challenge) {
  const meta = await discover(origin);
  const clientId = await ensureClient(origin);
  // URL keeps any query the endpoint already has (Twenty Cloud adds ?iss=).
  const u = new URL(meta.authorization_endpoint);
  u.searchParams.set('client_id', clientId);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('redirect_uri', redirectUri());
  u.searchParams.set('scope', 'api profile');
  u.searchParams.set('state', stateToken);
  u.searchParams.set('code_challenge', challenge);
  u.searchParams.set('code_challenge_method', 'S256');
  return { url: u.toString(), issuer: meta.issuer || origin };
}

async function tokenRequest(origin, params) {
  const meta = await discover(origin);
  const clientId = await ensureClient(origin);
  const res = await timedFetch(meta.token_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ ...params, client_id: clientId }).toString(),
  });
  let body = {};
  try { body = await res.json(); } catch { /* not JSON */ }
  if (!res.ok || !body.access_token) {
    throw new TwentyError('token', `Twenty token request failed (HTTP ${res.status}${body.error ? `: ${body.error}` : ''})`, res.status);
  }
  return body;
}

const exchangeCode = (origin, code, verifier) =>
  tokenRequest(origin, { grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: redirectUri() });

async function graphqlMetadata(origin, accessToken, query) {
  const res = await timedFetch(`${origin}/metadata`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ query }),
  });
  let body = {};
  try { body = await res.json(); } catch { /* not JSON */ }
  if (!res.ok || !body.data) throw new TwentyError('me', `Could not read the Twenty user (HTTP ${res.status})`, res.status);
  return body.data;
}

/** Who the token belongs to. Admin = may change workspace settings. */
async function getMe(origin, accessToken) {
  const data = await graphqlMetadata(origin, accessToken,
    '{ currentUser { id email currentWorkspace { id displayName workspaceUrls { subdomainUrl customUrl } } ' +
    'workspaceMember { id name { firstName lastName } } currentUserWorkspace { permissionFlags } } }');
  const u = data.currentUser;
  if (!u || !u.id || !u.currentWorkspace || !u.currentWorkspace.id) throw new TwentyError('me', 'Twenty did not say which workspace this user is in');
  const member = u.workspaceMember || {};
  const name = [member.name && member.name.firstName, member.name && member.name.lastName].filter(Boolean).join(' ') || u.email || `User ${u.id}`;
  const urls = u.currentWorkspace.workspaceUrls || {};
  const flags = (u.currentUserWorkspace && u.currentUserWorkspace.permissionFlags) || [];
  return {
    userId: String(u.id), email: u.email || '', name, memberId: member.id ? String(member.id) : null,
    workspaceId: String(u.currentWorkspace.id), workspaceName: u.currentWorkspace.displayName || 'Twenty',
    appUrl: String(urls.customUrl || urls.subdomainUrl || origin).replace(/\/+$/, ''),
    admin: flags.includes('WORKSPACE'),
  };
}

function defaultSettings() {
  return {
    defaultCountry: config.DEFAULT_COUNTRY, createUnknown: true, missedTask: true,
    autoOpen: false, recordingTtlSeconds: config.RECORDING_LINK_TTL_SECONDS,
  };
}

/** Store a freshly connected user and keep their access token in memory. */
function saveUser(origin, me, tokens) {
  const d = store.load();
  const wsKey = wsKeyOf(origin, me.workspaceId);
  const ws = d.workspaces[wsKey] || { wsKey, origin, workspaceId: me.workspaceId, settings: defaultSettings(), createdAt: Date.now() };
  // The app URL must stay on the workspace's own server family; it is only a
  // link target, but a link is still something an agent clicks.
  let appUrl = origin;
  try { const a = new URL(me.appUrl); if (a.protocol === 'https:' || isLocalHttp(a)) appUrl = a.origin; } catch { /* keep origin */ }
  Object.assign(ws, { name: me.workspaceName, appUrl });
  d.workspaces[wsKey] = ws;
  d.users[userKey(wsKey, me.userId)] = {
    wsKey, userId: me.userId, name: me.name, email: me.email, memberId: me.memberId, admin: !!me.admin,
    refreshToken: store.encrypt(tokens.refresh_token || ''), connectedAt: Date.now(), broken: false,
  };
  store.saveNow();
  state.twentyAccess.set(userKey(wsKey, me.userId), {
    accessToken: tokens.access_token,
    exp: Date.now() + (Number(tokens.expires_in || 1800) - 60) * 1000,
  });
  return d.users[userKey(wsKey, me.userId)];
}

const getUser = (wsKey, userId) => store.load().users[userKey(wsKey, userId)] || null;
const getWorkspace = wsKey => store.load().workspaces[String(wsKey)] || null;

// One refresh in flight per user, so two parallel writes never race to use a
// refresh token the other one already traded in.
const refreshing = new Map();

async function accessTokenFor(wsKey, userId, { force = false } = {}) {
  const key = userKey(wsKey, userId);
  const mem = state.twentyAccess.get(key);
  if (!force && mem && mem.exp > Date.now()) return mem.accessToken;
  if (refreshing.has(key)) return refreshing.get(key);
  const p = (async () => {
    const user = getUser(wsKey, userId);
    const ws = getWorkspace(wsKey);
    const refresh = user && store.decrypt(user.refreshToken);
    if (!refresh || !ws) return null;
    try {
      const tokens = await tokenRequest(ws.origin, { grant_type: 'refresh_token', refresh_token: refresh });
      user.refreshToken = store.encrypt(tokens.refresh_token || refresh);
      user.broken = false;
      store.saveNow();
      state.twentyAccess.set(key, { accessToken: tokens.access_token, exp: Date.now() + (Number(tokens.expires_in || 1800) - 60) * 1000 });
      return tokens.access_token;
    } catch (err) {
      log(`x Twenty refresh failed for user ${userId} of ${wsKey}: ${err.message}`);
      if (err.status === 400 || err.status === 401) { user.broken = true; store.save(); }
      return null;
    }
  })();
  refreshing.set(key, p);
  try { return await p; } finally { refreshing.delete(key); }
}

/**
 * The user to write as: the agent who handled the call when they are
 * connected, else a connected admin of the workspace, else any connected user.
 */
function writerFor(wsKey, preferredUserId) {
  const d = store.load();
  const users = Object.values(d.users).filter(u => u.wsKey === String(wsKey) && !u.broken && u.refreshToken);
  const pref = preferredUserId && users.find(u => u.userId === String(preferredUserId));
  if (pref) return pref.userId;
  const admin = users.find(u => u.admin);
  return (admin || users[0] || {}).userId || null;
}

/**
 * One REST call as one user. 401 refreshes the token and retries once; 429
 * (Twenty allows 100 requests a minute) waits and retries once.
 */
async function api(wsKey, userId, method, apiPath, body) {
  const ws = getWorkspace(wsKey);
  if (!ws) throw new TwentyError('not_connected', 'This Twenty workspace is not connected.');
  let token = await accessTokenFor(wsKey, userId);
  if (!token) throw new TwentyError('not_connected', 'Reconnect Twenty: the connection has expired.');
  for (let attempt = 0; ; attempt++) {
    const res = await timedFetch(`${ws.origin}${apiPath}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
    if (res.status === 401 && attempt === 0) {
      token = await accessTokenFor(wsKey, userId, { force: true });
      if (!token) throw new TwentyError('not_connected', 'Reconnect Twenty: the connection has expired.', 401);
      continue;
    }
    if (res.status === 429 && attempt === 0) {
      const wait = Math.min(10, Number(res.headers.get('retry-after')) || 2);
      await sleep(wait * 1000);
      continue;
    }
    if (res.status < 200 || res.status >= 300) {
      const msg = parsed && (parsed.messages || parsed.message || parsed.error);
      throw new TwentyError('api', `Twenty ${method} ${apiPath.split('?')[0]} failed (HTTP ${res.status}${msg ? `: ${String(msg).slice(0, 200)}` : ''})`, res.status);
    }
    return parsed;
  }
}

// ─── people ──────────────────────────────────────────────────────────────────

/** Every number on a Twenty person, as E.164. */
function phonesOf(person, country) {
  const p = person && person.phones;
  if (!p) return [];
  const list = [{ number: p.primaryPhoneNumber, callingCode: p.primaryPhoneCallingCode }, ...(Array.isArray(p.additionalPhones) ? p.additionalPhones : [])];
  const out = [];
  for (const x of list) {
    if (!x || !x.number) continue;
    const e = x.callingCode ? toE164(`+${digitsOf(x.callingCode)}${digitsOf(x.number)}`, 'XX') : toE164(x.number, country);
    if (e && !out.includes(e)) out.push(e);
  }
  return out;
}

const personName = p => {
  const n = (p && p.name) || {};
  return [n.firstName, n.lastName].filter(Boolean).join(' ');
};

/**
 * People with this number, primary or additional. Twenty filters composite
 * phone fields with "like"; every hit is then checked against the full
 * number, so a partial match on the last digits never links the wrong person.
 */
async function findPeopleByPhone(wsKey, userId, e164, country) {
  const digits = digitsOf(e164);
  const tail = digits.slice(-Math.min(10, Math.max(6, digits.length - 1)));
  const filter = `or(phones.primaryPhoneNumber[like]:"%${tail}%",phones.additionalPhones[like]:"%${tail}%")`;
  const r = await api(wsKey, userId, 'GET', `/rest/people?limit=20&filter=${encodeURIComponent(filter)}`);
  const people = (r && r.data && r.data.people) || [];
  return people.filter(p => phonesOf(p, country).includes(e164));
}

async function getPerson(wsKey, userId, personId) {
  const r = await api(wsKey, userId, 'GET', `/rest/people/${encodeURIComponent(personId)}?depth=1`);
  return (r && r.data && r.data.person) || null;
}

const CALLING_CODES = { IN: '91', US: '1', CA: '1', GB: '44', AE: '971', SG: '65', AU: '61', DE: '49', FR: '33' };

/** Split +<cc><national> using the default country first, then the known codes. */
function splitE164(e164, country) {
  const d = digitsOf(e164);
  const order = [country, ...Object.keys(CALLING_CODES).filter(c => c !== country)];
  for (const c of order) {
    const cc = CALLING_CODES[c];
    if (cc && d.startsWith(cc) && d.length - cc.length >= 6) return { callingCode: `+${cc}`, countryCode: c, number: d.slice(cc.length) };
  }
  return { callingCode: '', countryCode: '', number: `+${d}` };
}

/** An unknown caller becomes a person, so the call is never dropped. */
async function createPerson(wsKey, userId, e164, country) {
  const s = splitE164(e164, country);
  const r = await api(wsKey, userId, 'POST', '/rest/people', {
    name: { firstName: 'Caller', lastName: e164 },
    phones: { primaryPhoneNumber: s.number, primaryPhoneCallingCode: s.callingCode, primaryPhoneCountryCode: s.countryCode, additionalPhones: [] },
  });
  const id = r && r.data && r.data.createPerson && r.data.createPerson.id;
  if (!id) throw new TwentyError('api', 'Twenty did not return the new person');
  return String(id);
}

// ─── notes and tasks ─────────────────────────────────────────────────────────

// A note and its link to the person are two requests. They are separate
// functions so the caller can record the note id before linking it, and a
// retry after a failed link never creates a second note.
async function createNote(wsKey, userId, { title, markdown }) {
  const r = await api(wsKey, userId, 'POST', '/rest/notes', { title, bodyV2: { markdown } });
  const noteId = r && r.data && r.data.createNote && r.data.createNote.id;
  if (!noteId) throw new TwentyError('api', 'Twenty did not return the new note');
  return String(noteId);
}

async function linkNote(wsKey, userId, noteId, personId) {
  await api(wsKey, userId, 'POST', '/rest/noteTargets', { noteId, targetPersonId: personId });
}

async function updateNote(wsKey, userId, noteId, markdown) {
  await api(wsKey, userId, 'PATCH', `/rest/notes/${encodeURIComponent(noteId)}`, { bodyV2: { markdown } });
}

async function createTask(wsKey, userId, { title, markdown, assigneeId, dueAt }) {
  const body = { title, status: 'TODO', bodyV2: { markdown } };
  if (assigneeId) body.assigneeId = assigneeId;
  if (dueAt) body.dueAt = dueAt;
  const r = await api(wsKey, userId, 'POST', '/rest/tasks', body);
  const taskId = r && r.data && r.data.createTask && r.data.createTask.id;
  if (!taskId) throw new TwentyError('api', 'Twenty did not return the new task');
  return String(taskId);
}

async function linkTask(wsKey, userId, taskId, personId) {
  await api(wsKey, userId, 'POST', '/rest/taskTargets', { taskId, targetPersonId: personId });
}

const personUrl = (wsKey, personId) => {
  const ws = getWorkspace(wsKey);
  return ws && personId ? `${ws.appUrl}/object/person/${encodeURIComponent(personId)}` : null;
};

const countryFor = wsKey => ((getWorkspace(wsKey) || {}).settings || {}).defaultCountry || config.DEFAULT_COUNTRY;

// ─── disconnect ──────────────────────────────────────────────────────────────

function disconnectUser(wsKey, userId) {
  const d = store.load();
  delete d.users[userKey(wsKey, userId)];
  state.twentyAccess.delete(userKey(wsKey, userId));
  store.saveNow();
}

function disconnectWorkspace(wsKey) {
  const d = store.load();
  for (const k of Object.keys(d.users)) if (k.startsWith(`${wsKey}:`)) { delete d.users[k]; state.twentyAccess.delete(k); }
  delete d.workspaces[wsKey];
  for (const [authId, links] of Object.entries(d.accountLinks)) {
    d.accountLinks[authId] = links.filter(w => w !== wsKey);
    if (!d.accountLinks[authId].length) delete d.accountLinks[authId];
  }
  for (const [uuid, c] of Object.entries(d.calls)) if (c.wsKey === wsKey) delete d.calls[uuid];
  d.pending = d.pending.filter(p => p.wsKey !== wsKey);
  store.saveNow();
}

module.exports = {
  TwentyError, allowedOrigin, discover, ensureClient, pkce, authorizeUrl, exchangeCode, getMe, saveUser,
  getUser, getWorkspace, accessTokenFor, writerFor, api, phonesOf, personName, findPeopleByPhone, getPerson,
  splitE164, createPerson, createNote, linkNote, updateNote, createTask, linkTask, personUrl, countryFor, disconnectUser,
  disconnectWorkspace, wsKeyOf, defaultSettings, redirectUri,
};
