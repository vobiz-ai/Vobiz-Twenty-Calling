/**
 * Boots the real backend (fetch replaced by fetch-mock.cjs, so nothing leaves
 * the machine) and drives it over HTTP: Twenty connect, Vobiz sign-in, call
 * webhooks, logging to Twenty, and the security regressions earlier
 * integrations shipped.
 *
 * Vobiz callbacks are signed with the owning account's Auth Token, exactly as
 * Vobiz signs them, and signature checking is left on ("require").
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 20000 + Math.floor(Math.random() * 20000);
const BASE = `http://127.0.0.1:${PORT}`;
const PUBLIC = 'https://calling.example.test';
const TW_A = 'https://twenty.example.test';
const TW_B = 'https://api.crm.example.test';
const FETCH_LOG = path.join(os.tmpdir(), `vztw-fetch-${PORT}.jsonl`);
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'vztw-data-'));
const env = {
  PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, PORT: String(PORT), FETCH_LOG, DATA_DIR,
  PUBLIC_BASE_URL: PUBLIC, SIGNING_SECRET: 'test-signing-secret',
  TWENTY_ALLOWED_URLS: `${TW_A},${TW_B}`, VOBIZ_MEDIA_HOSTS: 'media.vobiz.test',
  LOG_SETTLE_MS: '30', PANEL_REPORT_GRACE_MS: '150',
};

const ONE = { authId: 'MA_TEST0001', authToken: 'tok-account-one', appId: '43919358318796814' };
const TWO = { authId: 'MA_TEST0002', authToken: 'tok-account-two', appId: '52000000000000017' };

let server;
let out = '';
const fetched = () => fs.readFileSync(FETCH_LOG, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
const req = (p, opts = {}) => fetch(`${BASE}${p}`, { redirect: 'manual', ...opts });
const seenBodies = [];
async function body(r) { const t = await r.text(); seenBodies.push(t); return t; }
async function json(r) { return JSON.parse(await body(r)); }
const post = (b, token) => ({ method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(b) });
const bearer = token => ({ headers: { Authorization: `Bearer ${token}` } });
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function waitFor(fn, what, ms = 3000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}\n${out.slice(-2000)}`);
    await sleep(25);
  }
}

/** A Vobiz callback, signed the way Vobiz signs: V3 over URL-without-query + "." + nonce. */
function vobizPost(p, fields, authToken) {
  const nonce = crypto.randomBytes(8).toString('hex');
  const sig = crypto.createHmac('sha256', authToken).update(`${PUBLIC}${p}.${nonce}`).digest('base64');
  return req(p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Vobiz-Signature-V3': sig, 'X-Vobiz-Signature-V3-Nonce': nonce },
    body: new URLSearchParams(fields).toString(),
  });
}

/** Start the OAuth flow; returns the authorize URL Twenty would show and the cookie. */
async function startConnect(server = TW_A) {
  const start = await req(`/twenty/oauth/start?server=${encodeURIComponent(server)}`);
  assert.equal(start.status, 302, out.slice(-1000));
  return { authorize: new URL(start.headers.get('location')), cookie: start.headers.get('set-cookie').split(';')[0] };
}

/** Plays the agent clicking Authorize on Twenty, then the redirect back. */
async function connect(userNo, server = TW_A) {
  const { authorize, cookie } = await startConnect(server);
  const code = `code-${userNo}.${authorize.searchParams.get('code_challenge')}`;
  const qs = new URLSearchParams({ code, state: authorize.searchParams.get('state'), iss: server });
  const cb = await req(`/twenty/oauth/callback?${qs}`, { headers: { Cookie: cookie } });
  assert.equal(cb.status, 302, out.slice(-1000));
  const link = new URLSearchParams(new URL(cb.headers.get('location'), BASE).hash.slice(1)).get('link');
  assert.ok(link, `no link code in ${cb.headers.get('location')}`);
  const claim = await req('/api/identity/claim', post({ code: link }));
  const c = await json(claim);
  assert.equal(claim.status, 200, JSON.stringify(c));
  return { token: c.token, session: c.session, link };
}

async function vobizLogin(token, acct = ONE) {
  const r = await req('/api/login', post({ authId: acct.authId, authToken: acct.authToken }, token));
  const b = await json(r);
  assert.equal(r.status, 200, JSON.stringify(b));
  const agent = await json(await req('/api/agent', bearer(token)));
  return { ...b, agent, sipUser: agent.sipUser.split('@')[0] };
}

/** Open the softphone event stream and collect events. */
function openStream(token) {
  const events = [];
  const ctrl = new AbortController();
  const ready = (async () => {
    const r = await fetch(`${BASE}/api/events`, { headers: { Authorization: `Bearer ${token}` }, signal: ctrl.signal });
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          const parts = buf.split('\n\n');
          buf = parts.pop();
          for (const p of parts) {
            const d = p.split('\n').find(l => l.startsWith('data: '));
            if (d) events.push(JSON.parse(d.slice(6)));
          }
        }
      } catch { /* aborted */ }
    })();
  })();
  return { events, ready, close: () => ctrl.abort() };
}

function twWrites(mark, pathEnd) {
  return fetched().slice(mark).filter(f => (f.url.startsWith(TW_A) || f.url.startsWith(TW_B)) && ['POST', 'PATCH'].includes(f.method)
    && f.url.includes('/rest/') && (!pathEnd || new URL(f.url).pathname === pathEnd || new URL(f.url).pathname.startsWith(`${pathEnd}/`)));
}

let asha; // admin of workspace Acme
let ben;  // member of workspace Acme
let cara; // admin of workspace Globex, on a Cloud-style Twenty server

before(async () => {
  fs.writeFileSync(FETCH_LOG, '');
  server = spawn(process.execPath, ['-r', path.join(__dirname, 'fetch-mock.cjs'), path.join(__dirname, '..', 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', d => { out += String(d); });
  server.stderr.on('data', d => { out += String(d); });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`backend did not start\n${out}`)), 8000);
    server.stdout.on('data', d => { if (String(d).includes('calling backend on')) { clearTimeout(t); resolve(); } });
    server.on('exit', code => reject(new Error(`backend exited ${code}\n${out}`)));
  });
});

after(() => {
  if (server) server.kill();
  fs.rmSync(FETCH_LOG, { force: true });
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

// ─── boot ────────────────────────────────────────────────────────────────────
test('boot touches no Vobiz account and no Twenty server', () => {
  assert.deepEqual(fetched(), []);
});

// ─── Twenty connect ──────────────────────────────────────────────────────────
test('only allowlisted Twenty servers can be connected, and nothing is fetched for others', async () => {
  const r = await req(`/twenty/oauth/start?server=${encodeURIComponent('https://evil.example')}`);
  assert.equal(r.status, 400);
  const r2 = await req(`/twenty/oauth/start?server=${encodeURIComponent('http://169.254.169.254')}`);
  assert.equal(r2.status, 400);
  assert.deepEqual(fetched(), [], 'no request to a server outside TWENTY_ALLOWED_URLS');
  const s = await json(await req('/twenty/oauth/servers'));
  assert.deepEqual(s.servers, [TW_A, TW_B]);
});

test('connect registers one public OAuth client per server and asks for PKCE S256', async () => {
  const { authorize } = await startConnect(TW_A);
  assert.equal(authorize.origin + authorize.pathname, `${TW_A}/authorize`);
  assert.equal(authorize.searchParams.get('redirect_uri'), `${PUBLIC}/twenty/oauth/callback`);
  assert.equal(authorize.searchParams.get('code_challenge_method'), 'S256');
  assert.match(authorize.searchParams.get('code_challenge'), /^[A-Za-z0-9_-]{43}$/);
  assert.equal(authorize.searchParams.get('scope'), 'api profile');
  await startConnect(TW_A);
  const regs = fetched().filter(f => f.url === `${TW_A}/oauth/register`);
  assert.equal(regs.length, 1, 'registered once, then reused');
  const b = JSON.parse(regs[0].body);
  assert.equal(b.token_endpoint_auth_method, 'none');
  assert.deepEqual(b.redirect_uris, [`${PUBLIC}/twenty/oauth/callback`]);
});

test('Cloud-style servers: the authorize page comes from discovery and keeps its ?iss=', async () => {
  const { authorize } = await startConnect(TW_B);
  assert.equal(authorize.origin, 'https://app.crm.example.test');
  assert.equal(authorize.searchParams.get('iss'), TW_B);
  assert.ok(authorize.searchParams.get('client_id'));
});

test('OAuth callback without the browser cookie, or from the wrong issuer, is refused', async () => {
  const { authorize, cookie } = await startConnect(TW_A);
  const code = `code-101.${authorize.searchParams.get('code_challenge')}`;
  const st = authorize.searchParams.get('state');
  const noCookie = await req(`/twenty/oauth/callback?code=${code}&state=${st}`);
  assert.equal(noCookie.status, 400);
  const again = await startConnect(TW_A);
  const code2 = `code-101.${again.authorize.searchParams.get('code_challenge')}`;
  const wrongIss = await req(`/twenty/oauth/callback?code=${code2}&state=${again.authorize.searchParams.get('state')}&iss=${encodeURIComponent(TW_B)}`, { headers: { Cookie: again.cookie } });
  assert.match(wrongIss.headers.get('location'), /#error=connect$/);
  assert.ok(cookie);
  assert.ok(!fetched().some(f => f.url.endsWith('/oauth/token')), 'no code exchange for a refused callback');
});

test('connecting Twenty gives a session; the code is exchanged with the PKCE verifier; the link code works once', async () => {
  asha = await connect(101);
  assert.equal(asha.session.user.name, 'Asha Rao');
  assert.equal(asha.session.user.admin, true);
  assert.equal(asha.session.workspace.name, 'Acme');
  assert.equal(asha.session.mode, null);
  const tok = fetched().filter(f => f.url === `${TW_A}/oauth/token`).at(-1);
  const form = new URLSearchParams(tok.body);
  assert.equal(form.get('grant_type'), 'authorization_code');
  assert.match(form.get('code_verifier'), /^[A-Za-z0-9_-]{43}$/);
  assert.equal(form.get('client_secret'), null, 'public client: no secret');
  const again = await req('/api/identity/claim', post({ code: asha.link }));
  assert.equal(again.status, 401);
  ben = await connect(102);
  assert.equal(ben.session.user.admin, false);
  cara = await connect(201, TW_B);
  assert.equal(cara.session.workspace.name, 'Globex');
});

test('stored Twenty refresh tokens are encrypted at rest', () => {
  const raw = fs.readFileSync(path.join(DATA_DIR, 'store.json'), 'utf8');
  assert.doesNotMatch(raw, /tw-rt-|tw-at-/);
  const d = JSON.parse(raw);
  const u = Object.values(d.users).find(x => x.userId === 'user-101');
  assert.match(u.refreshToken, /^v1\./);
});

test('settings: everyone reads them, only workspace admins change them', async () => {
  const r = await json(await req('/api/settings', bearer(ben.token)));
  assert.equal(r.admin, false);
  assert.equal(r.settings.createUnknown, true);
  assert.equal(r.settings.missedTask, true);
  assert.equal((await req('/api/settings', post({ autoOpen: true }, ben.token))).status, 403);
  const save = await json(await req('/api/settings', post({ defaultCountry: 'IN', recordingTtlSeconds: 3600 }, asha.token)));
  assert.equal(save.settings.recordingTtlSeconds, 3600);
});

test('refresh on 401: an expired Twenty token is refreshed and the call retried', async () => {
  // Ben's first access token is rejected after /metadata by the mock.
  const r = await req('/api/lookup?number=09000000011', bearer(ben.token));
  const b = await json(r);
  assert.equal(r.status, 200, JSON.stringify(b));
  assert.equal(b.people[0].name, 'Priya Shah');
  assert.ok(fetched().some(f => f.url === `${TW_A}/oauth/token` && String(f.body).includes('grant_type=refresh_token')));
});

test('caller lookup: exact number only, additional phones count, company shown, workspaces never cross', async () => {
  const a = await json(await req('/api/lookup?number=%2B919000000011', bearer(asha.token)));
  assert.deepEqual(a.people.map(p => p.id), ['p-priya'], 'the +1 decoy with the same digits is not a match');
  assert.equal(a.people[0].company, 'Acme Traders');
  assert.equal(a.people[0].url, 'https://acme.twenty.example.test/object/person/p-priya');
  const add = await json(await req('/api/lookup?number=9000000012', bearer(asha.token)));
  assert.deepEqual(add.people.map(p => p.id), ['p-ravi'], 'found through additionalPhones');
  const theirs = await json(await req('/api/lookup?number=%2B919000000011', bearer(cara.token)));
  assert.deepEqual(theirs.people.map(p => p.id), ['p-other']);
  const filter = new URL(fetched().filter(f => f.url.startsWith(`${TW_A}/rest/people?`)).at(-1).url).searchParams.get('filter');
  assert.match(filter, /^or\(phones\.primaryPhoneNumber\[like\]:"%\d+%",phones\.additionalPhones\[like\]:"%\d+%"\)$/);
});

// ─── Vobiz sign-in ───────────────────────────────────────────────────────────
test('Vobiz sign-in needs a Twenty session', async () => {
  const r = await req('/api/login', post({ authId: ONE.authId, authToken: ONE.authToken }));
  assert.equal(r.status, 401);
});

test('a wrong Vobiz token is refused with 401 and creates nothing', async () => {
  const mark = fetched().length;
  const r = await req('/api/login', post({ authId: ONE.authId, authToken: 'wrong' }, asha.token));
  assert.equal(r.status, 401);
  const calls = fetched().slice(mark);
  assert.equal(calls.length, 1, 'only the credential check');
  assert.match(calls[0].url, /\/numbers\?page=1/);
});

test('sign-in provisions one app and an access token per agent, with the 17-digit app id intact', async () => {
  const mark = fetched().length;
  asha.v = await vobizLogin(asha.token, ONE);
  ben.v = await vobizLogin(ben.token, ONE);
  assert.equal(asha.v.appId, ONE.appId);
  assert.equal(asha.v.sipAuth, 'jwt');
  assert.notEqual(asha.v.sipUser, ben.v.sipUser, 'two agents never share an identity');
  assert.match(asha.v.sipUser, /^tw[0-9a-f]{14}_MA_TEST0001$/, 'registers as <sub>_<authId>');
  // The softphone gets a token, never a SIP password.
  assert.equal(asha.v.agent.sipPassword, undefined);
  assert.equal(asha.v.agent.sipAuth, 'jwt');
  assert.equal(asha.v.agent.accessToken.split('.').length, 3);
  assert.ok(asha.v.agent.tokenExpiresAt > Date.now() + 50 * 60 * 1000);
  const mints = fetched().slice(mark).filter(f => f.url.endsWith('/Account/MA_TEST0001/JWT/Token/'));
  assert.equal(mints.length, 2);
  const claims = JSON.parse(mints[0].body);
  assert.equal(claims.iss, ONE.authId);
  assert.match(claims.sub, /^tw[0-9a-f]{14}$/);
  assert.equal(claims.app, ONE.appId, 'the app claim is a string, never a rounded number');
  assert.match(mints[0].body, /"app":"43919358318796814"/);
  assert.deepEqual(claims.per, { voice: { incoming_allow: true, outgoing_allow: true } });
  assert.ok(claims.nbf <= Math.floor(Date.now() / 1000) - 30, 'nbf set back for clock skew');
  assert.equal(fetched().slice(mark).filter(f => f.authId === ONE.authId && /\/Endpoint\//.test(f.url)).length, 0, 'no SIP endpoint is created or bound');
  assert.deepEqual(asha.v.numbers, ['+910000000001', '+910000000002'], 'inactive and voice-disabled numbers are not offered');
  const created = fetched().filter(f => f.url.endsWith('/Application/') && f.method === 'POST');
  assert.equal(created.length, 1, 'one application for the account');
  const app = JSON.parse(created[0].body);
  assert.equal(app.app_name, 'Twenty-Calling-Vobiz');
  assert.equal(app.answer_url, `${PUBLIC}/vobiz/answer`);
  assert.equal(app.hangup_url, `${PUBLIC}/vobiz/hangup`);
  assert.equal(app.fallback_answer_url, `${PUBLIC}/vobiz/fallback`);
});

test('an account that cannot mint tokens falls back to an endpoint, bound through the {"application": <integer>} retry', async () => {
  cara.v = await vobizLogin(cara.token, TWO);
  assert.equal(cara.v.sipAuth, 'endpoint');
  assert.match(cara.v.jwtError, /HTTP 404/);
  assert.match(cara.v.sipUser, /^tw[0-9a-f]{14}x[0-9a-f]{6}1187694299$/, 'username read back after Vobiz rewrote it');
  assert.ok(cara.v.agent.sipPassword, 'an endpoint sign-in gets its rotated password');
  assert.equal(cara.v.agent.accessToken, undefined);
  assert.equal(cara.v.bound, true);
  const bodies = fetched().filter(f => f.authId === TWO.authId && f.method === 'POST' && /\/Endpoint\/\d+\/$/.test(f.url)).map(f => f.body);
  assert.ok(bodies.includes(`{"application":${TWO.appId}}`), 'integer literal, never a rounded JS number');
});

test('signing in again ends the older session of the same agent', async () => {
  const second = await connect(101);
  const stream = openStream(asha.token);
  await stream.ready;
  await sleep(50);
  second.v = await vobizLogin(second.token, ONE);
  await waitFor(() => stream.events.find(e => e.type === 'signed-out' && e.reason === 'elsewhere'), 'signed-out event');
  stream.close();
  const old = await req('/api/session', bearer(asha.token));
  assert.equal(old.status, 401);
  assert.equal(second.v.sipUser, asha.v.sipUser, 'same agent, same identity');
  asha = second;
});

test('access token renewal: behind the session, at most one mint a minute, never for an endpoint sign-in', async () => {
  assert.equal((await req('/api/token', post({}))).status, 401);
  const mark = fetched().length;
  const again = await json(await req('/api/token', post({}, asha.token)));
  assert.equal(again.accessToken, asha.v.agent.accessToken, 'just minted: the current token comes back');
  assert.equal(fetched().slice(mark).filter(f => f.url.includes('/JWT/Token/')).length, 0, 'no second mint within a minute');
  const endpointSession = await req('/api/token', post({}, cara.token));
  assert.equal(endpointSession.status, 400);
  assert.equal((await json(endpointSession)).code, 'not_jwt');
});

test('caller ID: only the account\'s own numbers', async () => {
  const bad = await req('/api/select-number', post({ number: '+910000000003' }, asha.token));
  assert.equal(bad.status, 400);
  const good = await json(await req('/api/select-number', post({ number: '+910000000002' }, asha.token)));
  assert.equal(good.from, '+910000000002');
  await req('/api/select-number', post({ number: '+910000000001' }, asha.token));
});

test('Enable inbound attaches the number with the app id as a string and names the previous app', async () => {
  const r = await json(await req('/api/setup-inbound', post({ number: '+910000000001' }, asha.token)));
  assert.equal(r.previousAppId, '20577609616603585');
  assert.equal(r.appId, ONE.appId);
  const att = fetched().filter(f => /\/numbers\/%2B910000000001\/application$/.test(f.url));
  assert.equal(att.at(-1).body, `{"application_id":"${ONE.appId}"}`);
});

// ─── webhooks: signatures and routing ────────────────────────────────────────
test('unsigned and wrongly signed Vobiz callbacks are refused', async () => {
  const unsigned = await req('/vobiz/answer', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'CallUUID=x&Direction=inbound&To=%2B910000000001' });
  assert.equal(unsigned.status, 403);
  // Signed with account TWO's token, about account ONE's number.
  const crossTenant = await vobizPost('/vobiz/answer', { CallUUID: 'x2', From: '+919000000999', To: '+910000000001', ParentAuthID: ONE.authId }, TWO.authToken);
  assert.equal(crossTenant.status, 403);
});

test('the fallback URL always answers with a polite message, signed or not', async () => {
  const r = await req('/vobiz/fallback', { method: 'POST' });
  const x = await body(r);
  assert.equal(r.status, 200);
  assert.match(x, /<Speak>[^<]+<\/Speak>\s*<Hangup\/>/);
});

test('outbound: the browser is the A leg; /answer dials the customer as the chosen caller ID', async () => {
  const r = await vobizPost('/vobiz/answer', {
    CallUUID: 'call-out-0', From: `sip:${asha.v.sipUser}@registrar.vobiz.ai`, To: '9000000012', Direction: 'outbound',
    'SIPHeader_X-VH-Caller-ID': '+910000000002',
  }, ONE.authToken);
  const x = await body(r);
  assert.equal(r.status, 200);
  assert.match(x, /<Record [^>]*recordSession="true"[^>]*\/>\s*<Dial /);
  assert.match(x, /<Dial callerId="\+910000000002"[^>]*callbackUrl="https:\/\/calling\.example\.test\/vobiz\/dial-events"/);
  assert.match(x, /<Number>\+919000000012<\/Number>/, 'local number normalised with the default country');
});

test('outbound: a caller ID the account does not own falls back to the selected one', async () => {
  const x = await body(await vobizPost('/vobiz/answer', {
    CallUUID: 'call-out-x', From: `sip:${asha.v.sipUser}@registrar.vobiz.ai`, To: '+919000000012', 'X-VH-Caller-ID': '+910000000003',
  }, ONE.authToken));
  assert.match(x, /<Dial callerId="\+910000000001"/);
});

test('outbound: an unknown SIP user is refused, and injected XML never reaches the document', async () => {
  const r = await vobizPost('/vobiz/answer', { CallUUID: 'c-x', From: 'sip:nobody@registrar.vobiz.ai', To: '+919000000012' }, ONE.authToken);
  assert.equal(r.status, 403);
  assert.doesNotMatch(await body(r), /<Dial/);
  const inj = await body(await vobizPost('/vobiz/answer', {
    CallUUID: 'c-y', From: `sip:${asha.v.sipUser}@registrar.vobiz.ai`, To: '+91900"/><Dial><Number>+15550000000</Number></Dial><x a="',
  }, ONE.authToken));
  assert.doesNotMatch(inj, /15550000000/);
  assert.match(inj, /<Hangup reason="rejected"\/>/);
});

test('inbound: ParentAuthID routes to that account and rings every signed-in agent with callerId set', async () => {
  const stream = openStream(ben.token);
  await stream.ready;
  await sleep(50);
  const x = await body(await vobizPost('/vobiz/answer', { CallUUID: 'call-in-1', From: '09000000011', To: '+910000000001', Direction: 'inbound', ParentAuthID: ONE.authId }, ONE.authToken));
  assert.match(x, /<Dial callerId="\+910000000001"[^>]*callerName="\+919000000011"/);
  assert.ok(x.includes(`<User>sip:${asha.v.sipUser}@registrar.vobiz.ai</User>`));
  assert.ok(x.includes(`<User>sip:${ben.v.sipUser}@registrar.vobiz.ai</User>`));
  assert.ok(!x.includes(cara.v.sipUser), 'another account\'s agent never rings');
  assert.match(x, /<\/Dial>\s*<Speak>/, 'a polite message if nobody answers');
  const ev = await waitFor(() => stream.events.find(e => e.type === 'incoming'), 'screen-pop event');
  assert.equal(ev.from, '+919000000011');
  stream.close();
});

test('inbound without ParentAuthID falls back to the dialled number', async () => {
  const x = await body(await vobizPost('/vobiz/answer', { CallUUID: 'call-in-np', From: '+917000000055', To: '910000000001' }, ONE.authToken));
  assert.ok(x.includes(`<User>sip:${asha.v.sipUser}@registrar.vobiz.ai</User>`));
});

// ─── logging to Twenty ───────────────────────────────────────────────────────
test('answered inbound call: one note on the caller\'s person, written as the agent who answered', async () => {
  const mark = fetched().length;
  await vobizPost('/vobiz/dial-events', { CallUUID: 'call-in-1', Event: 'DialAnswer', DialBLegTo: `sip:${ben.v.sipUser}@registrar.vobiz.ai` }, ONE.authToken);
  await vobizPost('/vobiz/dial-events', { CallUUID: 'call-in-1', Event: 'DialHangup', DialBLegDuration: '252', DialBLegBillDuration: '252' }, ONE.authToken);
  await vobizPost('/vobiz/dial-status', { CallUUID: 'call-in-1', DialStatus: 'completed', DialBLegUUID: 'b-1' }, ONE.authToken);
  await vobizPost('/vobiz/hangup', { CallUUID: 'call-in-1', Event: 'Hangup', HangupCause: 'NORMAL_CLEARING', Duration: '270', ParentAuthID: ONE.authId }, ONE.authToken);
  const note = await waitFor(() => twWrites(mark, '/rest/notes')[0], 'note write');
  const b = JSON.parse(note.body);
  assert.equal(b.title, 'Inbound call from +919000000011 (answered, 4m 12s)');
  assert.match(b.bodyV2.markdown, /\*\*Agent:\*\* Ben Ng/);
  assert.match(b.bodyV2.markdown, /\*\*Talk time:\*\* 4m 12s/, 'talk time from the B leg, not the 270 s A leg');
  assert.match(b.bodyV2.markdown, /\*\*Recording:\*\* processing/);
  assert.match(note.authorization, /^Bearer tw-at-102-/, 'written as the agent who took the call');
  const target = await waitFor(() => twWrites(mark, '/rest/noteTargets')[0], 'note target');
  assert.equal(JSON.parse(target.body).targetPersonId, 'p-priya');
  assert.equal(twWrites(mark, '/rest/people').length, 0, 'a known caller is not created again');
  assert.equal(twWrites(mark, '/rest/tasks').length, 0, 'answered calls get no call-back task');
  // A replayed hangup must not log twice.
  await vobizPost('/vobiz/hangup', { CallUUID: 'call-in-1', Event: 'Hangup', ParentAuthID: ONE.authId }, ONE.authToken);
  await sleep(150);
  assert.equal(twWrites(mark, '/rest/notes').filter(f => f.method === 'POST').length, 1);
});

let recordingLink;
test('recording: the note is updated with a signed link that plays, expires and is account-scoped', async () => {
  const mark = fetched().length;
  await vobizPost('/vobiz/recording', { CallUUID: 'call-in-1', RecordingID: 'rec-1', Event: 'RecordStop', RecordingEndReason: 'HungUp' }, ONE.authToken);
  const patch = await waitFor(() => twWrites(mark, '/rest/notes').find(f => f.method === 'PATCH'), 'note update');
  const md = JSON.parse(patch.body).bodyV2.markdown;
  assert.doesNotMatch(md, /tok-account/);
  assert.match(md, /\*\*Agent:\*\* Ben Ng/, 'the rest of the note is kept');
  recordingLink = md.match(/\[Play the recording\]\(([^)]+)\)/)[1];
  const u = new URL(recordingLink);
  assert.equal(u.origin, PUBLIC);
  const play = await req(`${u.pathname}${u.search}`);
  assert.equal(play.status, 200);
  assert.equal(await play.text(), 'AUDIO:rec-1.mp3');
  const tampered = new URL(recordingLink); tampered.searchParams.set('sig', tampered.searchParams.get('sig').replace(/.$/, c => (c === 'a' ? 'b' : 'a')));
  assert.equal((await req(`${tampered.pathname}${tampered.search}`)).status, 403);
  const otherAcct = new URL(recordingLink); otherAcct.searchParams.set('aid', TWO.authId);
  assert.equal((await req(`${otherAcct.pathname}${otherAcct.search}`)).status, 403);
  const expired = new URL(recordingLink); expired.searchParams.set('exp', '1000');
  assert.equal((await req(`${expired.pathname}${expired.search}`)).status, 403);
});

test('missed inbound call from an unknown number: one new person, one note, one call-back task', async () => {
  await vobizPost('/vobiz/answer', { CallUUID: 'call-in-2', From: '+917000000001', To: '+910000000001', ParentAuthID: ONE.authId }, ONE.authToken);
  const mark = fetched().length;
  await vobizPost('/vobiz/dial-status', { CallUUID: 'call-in-2', DialStatus: 'no-answer' }, ONE.authToken);
  await vobizPost('/vobiz/hangup', { CallUUID: 'call-in-2', Event: 'Hangup', ParentAuthID: ONE.authId }, ONE.authToken);
  const task = await waitFor(() => twWrites(mark, '/rest/tasks')[0], 'call-back task');
  const people = twWrites(mark, '/rest/people');
  assert.equal(people.length, 1);
  assert.deepEqual(JSON.parse(people[0].body), {
    name: { firstName: 'Caller', lastName: '+917000000001' },
    phones: { primaryPhoneNumber: '7000000001', primaryPhoneCallingCode: '+91', primaryPhoneCountryCode: 'IN', additionalPhones: [] },
  });
  const note = JSON.parse(twWrites(mark, '/rest/notes')[0].body);
  assert.equal(note.title, 'Inbound call from +917000000001 (missed)');
  const t = JSON.parse(task.body);
  assert.equal(t.title, 'Call back +917000000001');
  assert.equal(t.status, 'TODO');
  assert.ok(Date.parse(t.dueAt) > Date.now());
  const tt = await waitFor(() => twWrites(mark, '/rest/taskTargets')[0], 'task target');
  assert.match(JSON.parse(tt.body).targetPersonId, /^p-new-/);
  // A second call from the same number finds that person in Twenty.
  await vobizPost('/vobiz/answer', { CallUUID: 'call-in-3', From: '+917000000001', To: '+910000000001', ParentAuthID: ONE.authId }, ONE.authToken);
  const mark2 = fetched().length;
  await vobizPost('/vobiz/hangup', { CallUUID: 'call-in-3', Event: 'Hangup', ParentAuthID: ONE.authId }, ONE.authToken);
  await waitFor(() => twWrites(mark2, '/rest/notes')[0], 'second note');
  assert.equal(twWrites(mark2, '/rest/people').length, 0);
});

test('outbound answered call: logged on the dialled person as the agent who placed it', async () => {
  const stream = openStream(asha.token);
  await stream.ready;
  await sleep(50);
  const mark = fetched().length;
  await vobizPost('/vobiz/answer', { CallUUID: 'call-out-1', From: `sip:${asha.v.sipUser}@registrar.vobiz.ai`, To: '+919000000012', 'X-VH-Ref': 'abc123' }, ONE.authToken);
  await vobizPost('/vobiz/dial-events', { CallUUID: 'call-out-1', Event: 'DialAnswer' }, ONE.authToken);
  await vobizPost('/vobiz/dial-status', { CallUUID: 'call-out-1', DialStatus: 'completed' }, ONE.authToken);
  await vobizPost('/vobiz/hangup', { CallUUID: 'call-out-1', Event: 'Hangup' }, ONE.authToken);
  const note = await waitFor(() => twWrites(mark, '/rest/notes')[0], 'outbound note');
  assert.match(JSON.parse(note.body).title, /^Outbound call to \+919000000012 \(answered, /);
  assert.match(note.authorization, /^Bearer tw-at-101-/);
  const tt = await waitFor(() => twWrites(mark, '/rest/noteTargets')[0], 'note target');
  assert.equal(JSON.parse(tt.body).targetPersonId, 'p-ravi', 'matched on an additional phone');
  const ev = await waitFor(() => stream.events.find(e => e.type === 'logged' && e.callUuid === 'call-out-1'), 'logged event');
  assert.equal(ev.personUrl, 'https://acme.twenty.example.test/object/person/p-ravi');
  stream.close();
});

test('busy outbound call is logged with its outcome', async () => {
  const mark = fetched().length;
  await vobizPost('/vobiz/answer', { CallUUID: 'call-out-busy', From: `sip:${asha.v.sipUser}@registrar.vobiz.ai`, To: '+919000000011' }, ONE.authToken);
  await vobizPost('/vobiz/dial-status', { CallUUID: 'call-out-busy', DialStatus: 'busy' }, ONE.authToken);
  await vobizPost('/vobiz/hangup', { CallUUID: 'call-out-busy', Event: 'Hangup' }, ONE.authToken);
  const note = await waitFor(() => twWrites(mark, '/rest/notes')[0], 'busy note');
  assert.equal(JSON.parse(note.body).title, 'Outbound call to +919000000011 (busy)');
});

test('a call that never reached /vobiz/answer is still logged from the softphone report', async () => {
  const mark = fetched().length;
  await req('/api/call-log', post({ ref: 'neverreached01', number: '+919000000012', cause: 'Busy', startedAt: Date.now() }, asha.token));
  const note = await waitFor(() => twWrites(mark, '/rest/notes')[0], 'panel-reported call');
  assert.equal(JSON.parse(note.body).title, 'Outbound call to +919000000012 (busy)');
  // A report for a call the server saw is ignored.
  const mark2 = fetched().length;
  await req('/api/call-log', post({ ref: 'zzz', number: '+919000000012', cause: 'Ended' }, asha.token));
  await vobizPost('/vobiz/answer', { CallUUID: 'call-out-2', From: `sip:${asha.v.sipUser}@registrar.vobiz.ai`, To: '+919000000012', 'X-VH-Ref': 'zzz' }, ONE.authToken);
  await vobizPost('/vobiz/hangup', { CallUUID: 'call-out-2', Event: 'Hangup' }, ONE.authToken);
  await sleep(400);
  assert.equal(twWrites(mark2, '/rest/notes').filter(f => f.method === 'POST').length, 1, 'logged once, from the server record');
});

test('the call list gives an agent their own calls with fresh recording links, never another workspace\'s', async () => {
  const mine = await json(await req('/api/calls', bearer(ben.token)));
  const c = mine.calls.find(x => x.callUuid === 'call-in-1');
  assert.ok(c && c.recordingUrl, 'a fresh recording link');
  assert.equal(c.personName, 'Priya Shah');
  const play = new URL(c.recordingUrl);
  assert.equal((await req(`${play.pathname}${play.search}`)).status, 200);
  const theirs = await json(await req('/api/calls', bearer(cara.token)));
  assert.equal(theirs.calls.length, 0);
});

// ─── transfer ────────────────────────────────────────────────────────────────
test('transfer: redirects the inbound caller\'s leg to ring the other agent', async () => {
  await vobizPost('/vobiz/answer', { CallUUID: 'call-in-t', From: '+919000000012', To: '+910000000001', ParentAuthID: ONE.authId }, ONE.authToken);
  await vobizPost('/vobiz/dial-events', { CallUUID: 'call-in-t', Event: 'DialAnswer', DialBLegTo: `sip:${asha.v.sipUser}@registrar.vobiz.ai` }, ONE.authToken);
  const agents = await json(await req('/api/agents', bearer(asha.token)));
  assert.deepEqual(agents.agents.map(a => a.userId), ['user-102']);
  const r = await req('/api/transfer', post({ userId: 'user-102' }, asha.token));
  assert.equal(r.status, 200, await body(r));
  const t = fetched().filter(f => /\/Call\/call-in-t\/$/.test(f.url)).at(-1);
  assert.deepEqual(JSON.parse(t.body), { legs: 'aleg', aleg_url: `${PUBLIC}/vobiz/transfer-xml`, aleg_method: 'POST' });
  const x = await body(await vobizPost('/vobiz/transfer-xml', { CallUUID: 'call-in-t' }, ONE.authToken));
  assert.ok(x.includes(`<User>sip:${ben.v.sipUser}@registrar.vobiz.ai</User>`));
  assert.match(x, /callerId="\+910000000001"/);
  const mark = fetched().length;
  await vobizPost('/vobiz/dial-events', { CallUUID: 'call-in-t', Event: 'DialAnswer', DialBLegTo: `sip:${ben.v.sipUser}@registrar.vobiz.ai` }, ONE.authToken);
  await vobizPost('/vobiz/hangup', { CallUUID: 'call-in-t', Event: 'Hangup' }, ONE.authToken);
  const note = await waitFor(() => twWrites(mark, '/rest/notes')[0], 'transferred call');
  assert.match(note.authorization, /^Bearer tw-at-102-/);
  assert.match(JSON.parse(note.body).bodyV2.markdown, /\*\*Transferred from:\*\* Asha Rao/);
});

// ─── regressions from the independent review ─────────────────────────────────
test('review 1: a callback signed by another Vobiz account cannot reach this account\'s numbers or calls', async () => {
  const mark = fetched().length;
  // Account TWO signs a fake inbound call to account ONE's number, naming itself.
  const withParent = await vobizPost('/vobiz/answer', { CallUUID: 'forged-1', From: '+917000000077', To: '+910000000001', ParentAuthID: TWO.authId }, TWO.authToken);
  assert.equal(withParent.status, 403);
  const noParent = await vobizPost('/vobiz/answer', { CallUUID: 'forged-2', From: '+917000000077', To: '+910000000001' }, TWO.authToken);
  assert.equal(noParent.status, 403);
  // Correctly signed by ONE, but claiming to be about TWO.
  const mismatch = await vobizPost('/vobiz/answer', { CallUUID: 'forged-3', From: '+917000000077', To: '+910000000001', ParentAuthID: TWO.authId }, ONE.authToken);
  assert.equal(mismatch.status, 403);
  // A hangup for one of ONE's real calls, signed by TWO.
  const hangup = await vobizPost('/vobiz/hangup', { CallUUID: 'call-in-1', Event: 'Hangup', ParentAuthID: TWO.authId }, TWO.authToken);
  assert.equal(hangup.status, 403);
  await sleep(150);
  assert.equal(twWrites(mark).length, 0, 'nothing was written to Twenty');
});

test('review 2 and 3: there is no SIP-direct sign-in to claim someone else\'s endpoint', async () => {
  const r = await req('/api/login-sip', post({ sipUser: asha.v.sipUser, callerId: '+910000000001' }, ben.token));
  assert.equal(r.status, 404);
});

test('review 8: a replayed signed callback is refused', async () => {
  const p = '/vobiz/dial-events';
  const nonce = crypto.randomBytes(8).toString('hex');
  const sig = crypto.createHmac('sha256', ONE.authToken).update(`${PUBLIC}${p}.${nonce}`).digest('base64');
  const send = fields => req(p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Vobiz-Signature-V3': sig, 'X-Vobiz-Signature-V3-Nonce': nonce },
    body: new URLSearchParams(fields).toString(),
  });
  assert.equal((await send({ CallUUID: 'call-in-1', Event: 'DialHangup', DialBLegDuration: '252' })).status, 200);
  // Same headers, different body: the signature does not cover the body.
  assert.equal((await send({ CallUUID: 'call-in-1', Event: 'DialHangup', DialBLegDuration: '1' })).status, 403);
});

test('review 7: recording audio on a storage host never receives Vobiz credentials, even through a redirect', async () => {
  const link = callUuid => {
    const exp = Math.floor(Date.now() / 1000) + 600;
    const sig = crypto.createHmac('sha256', 'test-signing-secret').update(`rec|${ONE.authId}|${callUuid}|${exp}`).digest('hex');
    return `/recordings/${callUuid}?aid=${ONE.authId}&exp=${exp}&sig=${sig}`;
  };
  const mark = fetched().length;
  const direct = await req(link('call-ext'));
  assert.equal(direct.status, 200);
  assert.equal(await direct.text(), 'AUDIO:rec-ext.mp3');
  const viaRedirect = await req(link('call-redir'));
  assert.equal(viaRedirect.status, 200);
  assert.equal(await viaRedirect.text(), 'AUDIO:rec-redir.mp3');
  const storage = fetched().slice(mark).filter(f => f.url.startsWith('https://storage.example.test/'));
  assert.equal(storage.length, 2);
  for (const f of storage) assert.equal(f.authToken, null, `credentials sent to ${f.url}`);
  assert.ok(fetched().slice(mark).some(f => f.url.startsWith('https://media.vobiz.test/redirect/') && f.authToken === ONE.authToken), 'the trusted Vobiz media host still gets them');
});

// ─── security regressions from earlier integrations ──────────────────────────
test('no route hands out a SIP password without a session, and there is no /agent/:id', async () => {
  assert.equal((await req('/api/agent')).status, 401);
  assert.equal((await req('/agent/anyone')).status, 404);
  assert.equal((await req('/api/agent/anyone')).status, 404);
});

test('no open recording proxy', async () => {
  assert.equal((await req('/recording-file?url=https://example.com/')).status, 404);
  assert.equal((await req('/recordings/x?url=https://example.com/')).status, 403);
});

test('no CORS: a foreign origin gets no Access-Control-Allow-Origin', async () => {
  const r = await req('/api/session', { headers: { Origin: 'https://evil.example' } });
  assert.equal(r.headers.get('access-control-allow-origin'), null);
  const pre = await req('/api/login', { method: 'OPTIONS', headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST' } });
  assert.equal(pre.headers.get('access-control-allow-origin'), null);
});

test('no path traversal out of the static folder', async () => {
  for (const p of ['/static/../backend/.env', '/static/..%2f..%2fbackend%2f.env', '/static/%2e%2e/backend/server.js', '/static/.env']) {
    const r = await req(p);
    const t = await r.text();
    assert.notEqual(r.status, 200, p);
    assert.doesNotMatch(t, /SIGNING_SECRET|require\(/, p);
  }
});

test('the softphone and the tel: handler page are never framed and load no foreign script', async () => {
  for (const p of ['/phone', '/dial?to=tel%3A%2B919000000011']) {
    const r = await req(p);
    assert.equal(r.status, 200, p);
    assert.equal(r.headers.get('x-frame-options'), 'DENY');
    const csp = r.headers.get('content-security-policy');
    assert.match(csp, /frame-ancestors 'none'/);
    assert.match(csp, /script-src 'self'(;|$)/);
    await r.text();
  }
});

test('health reveals nothing', async () => {
  assert.deepEqual(await json(await req('/health')), { ok: true });
});

test('no Vobiz Auth Token or Twenty token ever appeared in a response body', () => {
  const all = seenBodies.join('\n');
  for (const secret of [ONE.authToken, TWO.authToken, 'tw-at-', 'tw-rt-']) {
    assert.ok(!all.includes(secret), `${secret} leaked into a response`);
  }
});

test('nothing secret was written to the data dir in clear text, and no token was sent to a non-Twenty host', () => {
  const raw = fs.readFileSync(path.join(DATA_DIR, 'store.json'), 'utf8');
  for (const secret of [ONE.authToken, TWO.authToken, 'tw-at-', 'tw-rt-']) {
    assert.ok(!raw.includes(secret), `${String(secret).slice(0, 8)} written to disk`);
  }
  for (const f of fetched()) {
    if (f.authorization && /tw-at-/.test(f.authorization)) assert.ok(f.url.startsWith(TW_A) || f.url.startsWith(TW_B), f.url);
    if (f.authToken) assert.ok(f.url.startsWith('https://api.vobiz.ai/') || f.url.startsWith('https://media.vobiz.test/'), f.url);
  }
});

test('nobody signed in for a number: polite hangup, never silence', async () => {
  assert.equal((await req('/api/logout', post({}, cara.token))).status, 200);
  const x = await body(await vobizPost('/vobiz/answer', { CallUUID: 'call-in-9', From: '+917000000002', To: '+910000000003', ParentAuthID: TWO.authId }, TWO.authToken));
  assert.doesNotMatch(x, /<Dial/);
  assert.match(x, /<Speak>[^<]+<\/Speak>\s*<Hangup\/>/);
});

test('review 6: one Vobiz account, two Twenty workspaces: the call is logged where the answering agent works', async () => {
  // Cara (workspace Globex, on the other Twenty server) also signs in with account ONE.
  const cara2 = await connect(201, TW_B);
  cara2.v = await vobizLogin(cara2.token, ONE);
  const x = await body(await vobizPost('/vobiz/answer', { CallUUID: 'call-in-mw', From: '+919000000011', To: '+910000000001', ParentAuthID: ONE.authId }, ONE.authToken));
  assert.ok(x.includes(`<User>sip:${cara2.v.sipUser}@registrar.vobiz.ai</User>`));
  const mark = fetched().length;
  await vobizPost('/vobiz/dial-events', { CallUUID: 'call-in-mw', Event: 'DialAnswer', DialBLegTo: `sip:${cara2.v.sipUser}@registrar.vobiz.ai` }, ONE.authToken);
  await vobizPost('/vobiz/hangup', { CallUUID: 'call-in-mw', Event: 'Hangup' }, ONE.authToken);
  const note = await waitFor(() => twWrites(mark, '/rest/notes')[0], 'note for the answering workspace');
  assert.ok(note.url.startsWith(TW_B), `logged on ${note.url}`);
  assert.match(note.authorization, /^Bearer tw-at-201-/);
  const tt = await waitFor(() => twWrites(mark, '/rest/noteTargets')[0], 'note target');
  assert.equal(JSON.parse(tt.body).targetPersonId, 'p-other', 'Globex\'s own person, not Acme\'s');
  assert.equal(twWrites(mark).filter(f => f.url.startsWith(TW_A)).length, 0, 'nothing written to the other workspace');
  assert.equal((await req('/api/logout', post({}, cara2.token))).status, 200);
});

test('sub-accounts: callbacks carry the main account as ParentAuthID and are accepted; a different main account is not', async () => {
  const SUB = { authId: 'SA_TEST0003', authToken: 'tok-sub-three', parent: 'MA_TEST0009' };
  const agent = await connect(201, TW_B);
  agent.v = await vobizLogin(agent.token, SUB);
  assert.equal(agent.v.sipAuth, 'jwt', 'a sub-account mints its own tokens (iss is the sub-account)');
  assert.match(agent.v.sipUser, /^tw[0-9a-f]{14}_SA_TEST0003$/);
  const from = `sip:${agent.v.sipUser}@registrar.vobiz.ai`;
  // Outbound from the sub-account's endpoint: the live failure that showed this.
  const out = await vobizPost('/vobiz/answer', { CallUUID: 'call-sub-out', From: from, To: '+919000000011', ParentAuthID: SUB.parent }, SUB.authToken);
  assert.equal(out.status, 200);
  assert.match(await body(out), /<Dial callerId="\+910000000009"[\s\S]*<Number>\+919000000011<\/Number>/);
  const dial = await vobizPost('/vobiz/dial-events', { CallUUID: 'call-sub-out', Event: 'DialAnswer', ParentAuthID: SUB.parent }, SUB.authToken);
  assert.equal(dial.status, 200);
  // Inbound to the sub-account's number.
  const inbound = await vobizPost('/vobiz/answer', { CallUUID: 'call-sub-in', From: '+917000000088', To: '+910000000009', ParentAuthID: SUB.parent }, SUB.authToken);
  assert.ok((await body(inbound)).includes(`<User>${from}</User>`));
  // Once a parent is seen on a signed callback, another main account is refused.
  const other = await vobizPost('/vobiz/answer', { CallUUID: 'call-sub-x', From: from, To: '+919000000011', ParentAuthID: 'MA_TEST0008' }, SUB.authToken);
  assert.equal(other.status, 403);
  // A main account is its own parent: naming any other is still refused.
  const main = await vobizPost('/vobiz/answer', { CallUUID: 'call-main-x', From: '+917000000088', To: '+910000000001', ParentAuthID: SUB.parent }, ONE.authToken);
  assert.equal(main.status, 403);
  // The sub-account's own token is the only one that verifies its callbacks.
  const wrongKey = await vobizPost('/vobiz/answer', { CallUUID: 'call-sub-y', From: from, To: '+919000000011', ParentAuthID: SUB.parent }, ONE.authToken);
  assert.equal(wrongKey.status, 403);
  assert.equal((await req('/api/logout', post({}, agent.token))).status, 200);
});

test('only an admin disconnects a workspace; it signs its agents out and deletes its data', async () => {
  assert.equal((await req('/api/twenty/disconnect', post({ scope: 'workspace' }, ben.token))).status, 403);
  const owner = await connect(201, TW_B);
  const r = await req('/api/twenty/disconnect', post({ scope: 'workspace' }, owner.token));
  assert.equal(r.status, 200);
  assert.equal((await req('/api/session', bearer(owner.token))).status, 401);
  const d = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'store.json'), 'utf8'));
  assert.ok(!Object.values(d.workspaces).some(w => w.name === 'Globex'));
  assert.ok(!Object.values(d.users).some(u => u.userId === 'user-201'));
  assert.ok(Object.values(d.workspaces).some(w => w.name === 'Acme'), 'the other workspace is untouched');
});
