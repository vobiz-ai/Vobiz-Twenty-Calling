// Preloaded into the backend under test (node -r). Replaces global fetch so no
// request leaves the machine, and records every attempted request to a JSONL
// file so tests can assert on what the server tried to send, and where.
//
// Vobiz: two accounts with obvious fake values. Behaviours copied from the
// real API on purpose:
//  - POST /Endpoint/ rewrites the submitted username;
//  - app ids are 17 digits and come back UNQUOTED, so a server that runs them
//    through JSON.parse/Number gets the wrong id;
//  - MA_TEST0001 binds on {"app_id":"<string>"}; MA_TEST0002 ignores that and
//    only honours {"application": <integer>}.
//
// Twenty: two servers, each behaving the way a real Twenty (built 23 Oct 2026)
// behaved when probed:
//  - discovery names the endpoints; Cloud-style servers put /authorize on
//    another host with ?iss=;
//  - dynamic registration makes a PUBLIC client (no secret), so the token
//    endpoint checks the PKCE verifier against the challenge;
//  - access tokens last 1800 s, and refresh returns a new refresh token;
//  - POST /metadata answers { currentUser { ... } };
//  - REST: { data: { people: [...] } }, filters with [like] on
//    phones.primaryPhoneNumber and phones.additionalPhones, 201 on create.
// User 102's first access token is rejected after /metadata, which exercises
// refresh-on-401.
const fs = require('node:fs');
const crypto = require('node:crypto');
const LOG = process.env.FETCH_LOG;

const ACCOUNTS = {
  MA_TEST0001: { token: 'tok-account-one', numbers: ['+910000000001', '+910000000002'], inactive: '+910000000005', noVoice: '+910000000006', appId: '43919358318796814', honoursAppId: true },
  MA_TEST0002: { token: 'tok-account-two', numbers: ['+910000000003'], inactive: '+910000000007', noVoice: '+910000000008', appId: '52000000000000017', honoursAppId: false },
  // A sub-account. Vobiz signs its call callbacks with its own token and sends
  // its main account (MA_TEST0009, never signed in here) as ParentAuthID.
  SA_TEST0003: { token: 'tok-sub-three', numbers: ['+910000000009'], inactive: '+910000000010', noVoice: '+910000000011', appId: '61000000000000023', honoursAppId: true },
};
const apps = { MA_TEST0001: [], MA_TEST0002: [], SA_TEST0003: [] };
const endpoints = {};
let nextEndpoint = 700001;
const recordings = {
  MA_TEST0001: [
    { recording_id: 'rec-1', call_uuid: 'call-in-1', recording_url: 'https://media.vobiz.test/rec-1.mp3' },
    // Served by a storage host that must never see the Auth Token, directly
    // and through a redirect from the Vobiz media host.
    { recording_id: 'rec-ext', call_uuid: 'call-ext', recording_url: 'https://storage.example.test/rec-ext.mp3?X-Signature=presigned' },
    { recording_id: 'rec-redir', call_uuid: 'call-redir', recording_url: 'https://media.vobiz.test/redirect/rec-redir.mp3' },
  ],
  MA_TEST0002: [{ recording_id: 'rec-2', call_uuid: 'call-two-1', recording_url: 'https://media.vobiz.test/rec-2.mp3' }],
  SA_TEST0003: [],
};

// ─── Twenty ──────────────────────────────────────────────────────────────────
const SERVERS = {
  'https://twenty.example.test': { authorize: 'https://twenty.example.test/authorize' },
  'https://api.crm.example.test': { authorize: 'https://app.crm.example.test/authorize?iss=https%3A%2F%2Fapi.crm.example.test' },
};
const WORKSPACES = {
  'ws-acme': { server: 'https://twenty.example.test', name: 'Acme', url: 'https://acme.twenty.example.test/' },
  'ws-globex': { server: 'https://api.crm.example.test', name: 'Globex', url: 'https://globex.crm.example.test/' },
};
const USERS = {
  101: { id: 'user-101', ws: 'ws-acme', email: 'asha@acme.test', member: 'member-101', first: 'Asha', last: 'Rao', admin: true },
  102: { id: 'user-102', ws: 'ws-acme', email: 'ben@acme.test', member: 'member-102', first: 'Ben', last: 'Ng', admin: false },
  201: { id: 'user-201', ws: 'ws-globex', email: 'cara@globex.test', member: 'member-201', first: 'Cara', last: 'Diaz', admin: true },
};
const clients = {};   // client_id -> { server, redirect_uris }
const usedCodes = new Set();
const access = {};    // access token -> user number
const refresh = {};   // refresh token -> user number
const revokedAfterMe = new Set();
let seq = 1;
let issued102 = false;
const data = {
  'ws-acme': {
    people: [
      { id: 'p-priya', name: { firstName: 'Priya', lastName: 'Shah' }, jobTitle: 'Buyer', companyId: 'c-acme', phones: { primaryPhoneNumber: '9000000011', primaryPhoneCallingCode: '+91', primaryPhoneCountryCode: 'IN', additionalPhones: [] } },
      { id: 'p-ravi', name: { firstName: 'Ravi', lastName: 'Kumar' }, jobTitle: '', companyId: null, phones: { primaryPhoneNumber: '8000000099', primaryPhoneCallingCode: '+91', primaryPhoneCountryCode: 'IN', additionalPhones: [{ number: '9000000012', callingCode: '+91', countryCode: 'IN' }] } },
      // Shares the last digits with Priya's number but not the country code.
      { id: 'p-decoy', name: { firstName: 'Decoy', lastName: 'Person' }, jobTitle: '', companyId: null, phones: { primaryPhoneNumber: '9000000011', primaryPhoneCallingCode: '+1', primaryPhoneCountryCode: 'US', additionalPhones: [] } },
    ],
    companies: [{ id: 'c-acme', name: 'Acme Traders' }],
    notes: [], noteTargets: [], tasks: [], taskTargets: [],
  },
  'ws-globex': {
    people: [{ id: 'p-other', name: { firstName: 'Other', lastName: 'Tenant' }, jobTitle: '', companyId: null, phones: { primaryPhoneNumber: '9000000011', primaryPhoneCallingCode: '+91', primaryPhoneCountryCode: 'IN', additionalPhones: [] } }],
    companies: [], notes: [], noteTargets: [], tasks: [], taskTargets: [],
  },
};

function issue(userNo) {
  const n = seq++;
  const at = `tw-at-${userNo}-${n}`;
  const rt = `tw-rt-${userNo}-${n}`;
  access[at] = userNo;
  refresh[rt] = userNo;
  if (userNo === 102 && !issued102) { issued102 = true; revokedAfterMe.add(at); }
  return { access_token: at, token_type: 'Bearer', expires_in: 1800, refresh_token: rt, scope: 'api profile' };
}


function likeMatch(value, pattern) {
  const needle = pattern.replace(/^%|%$/g, '');
  return String(value || '').includes(needle);
}

/** Enough of Twenty's filter grammar for or(a[like]:"%x%",b[like]:"%x%") and x[eq]:"y". */
function filterPeople(people, filter) {
  if (!filter) return people;
  const terms = [...filter.matchAll(/([A-Za-z.]+)\[(like|eq)\]:"([^"]*)"/g)].map(m => ({ field: m[1], op: m[2], val: m[3] }));
  return people.filter(p => terms.some(t => {
    if (t.field === 'phones.primaryPhoneNumber') return t.op === 'like' ? likeMatch(p.phones.primaryPhoneNumber, t.val) : p.phones.primaryPhoneNumber === t.val;
    if (t.field === 'phones.additionalPhones') return likeMatch(JSON.stringify(p.phones.additionalPhones), t.val);
    return false;
  }));
}

async function twenty(server, url, method, h, body) {
  const json = (o, status = 200) => new Response(o === null ? null : JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
  const u = new URL(url);
  const p = u.pathname;
  if (p === '/.well-known/oauth-authorization-server') {
    return json({
      issuer: server, authorization_endpoint: SERVERS[server].authorize, token_endpoint: `${server}/oauth/token`,
      registration_endpoint: `${server}/oauth/register`, scopes_supported: ['api', 'profile'], code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['client_secret_post', 'none'], authorization_response_iss_parameter_supported: true,
    });
  }
  if (p === '/oauth/register' && method === 'POST') {
    const b = JSON.parse(body);
    const id = crypto.randomUUID();
    clients[id] = { server, redirect_uris: b.redirect_uris };
    return json({ client_id: id, client_name: b.client_name, redirect_uris: b.redirect_uris, token_endpoint_auth_method: 'none', scope: 'api profile' }, 201);
  }
  if (p === '/oauth/token' && method === 'POST') {
    const b = new URLSearchParams(String(body));
    const client = clients[b.get('client_id')];
    if (!client || client.server !== server) return json({ error: 'invalid_client' }, 401);
    if (b.get('grant_type') === 'authorization_code') {
      // The test plays the browser at the authorize page: the code is
      // "code-<user>.<code_challenge>", one use only.
      const cm = String(b.get('code')).match(/^code-(\d+)\.([A-Za-z0-9_-]+)$/);
      if (!cm || usedCodes.has(b.get('code')) || !USERS[cm[1]]) return json({ error: 'invalid_grant' }, 400);
      usedCodes.add(b.get('code'));
      const c = { user: Number(cm[1]), challenge: cm[2] };
      if (!client.redirect_uris.includes(b.get('redirect_uri'))) return json({ error: 'invalid_grant', error_description: 'redirect_uri mismatch' }, 400);
      const verifier = b.get('code_verifier') || '';
      if (crypto.createHash('sha256').update(verifier).digest('base64url') !== c.challenge) return json({ error: 'invalid_grant', error_description: 'PKCE verification failed' }, 400);
      if (WORKSPACES[USERS[c.user].ws].server !== server) return json({ error: 'invalid_grant' }, 400);
      return json(issue(c.user));
    }
    if (b.get('grant_type') === 'refresh_token') {
      const userNo = refresh[b.get('refresh_token')];
      if (!userNo) return json({ error: 'invalid_grant' }, 400);
      return json(issue(userNo));
    }
    return json({ error: 'unsupported_grant_type' }, 400);
  }

  const bearer = String(h.Authorization || '').replace(/^Bearer /, '');
  const userNo = access[bearer];
  if (!userNo) return json({ statusCode: 401, messages: ['Token invalid'], error: 'UNAUTHENTICATED' }, 401);
  const user = USERS[userNo];
  const ws = WORKSPACES[user.ws];
  if (ws.server !== server) return json({ statusCode: 401, messages: ['Token invalid'] }, 401);

  if (p === '/metadata' && method === 'POST') {
    return json({ data: { currentUser: {
      id: user.id, email: user.email,
      currentWorkspace: { id: user.ws, displayName: ws.name, workspaceUrls: { subdomainUrl: ws.url, customUrl: null } },
      workspaceMember: { id: user.member, name: { firstName: user.first, lastName: user.last } },
      currentUserWorkspace: { permissionFlags: user.admin ? ['WORKSPACE', 'API_KEYS_AND_WEBHOOKS'] : ['PROFILE_INFORMATION'] },
    } } });
  }
  if (revokedAfterMe.has(bearer)) { revokedAfterMe.delete(bearer); delete access[bearer]; return json({ statusCode: 401, messages: ['Token expired'] }, 401); }

  const d = data[user.ws];
  const createdBy = { source: 'MANUAL', workspaceMemberId: user.member, name: `${user.first} ${user.last}` };
  if (p === '/rest/people' && method === 'GET') return json({ data: { people: filterPeople(d.people, u.searchParams.get('filter')) }, totalCount: 0 });
  if (p === '/rest/people' && method === 'POST') {
    const b = JSON.parse(body);
    const person = { id: `p-new-${seq++}`, name: b.name, jobTitle: '', companyId: null, phones: b.phones, createdBy };
    d.people.push(person);
    return json({ data: { createPerson: person } }, 201);
  }
  const pm = p.match(/^\/rest\/people\/([^/]+)$/);
  if (pm && method === 'GET') {
    const person = d.people.find(x => x.id === pm[1]);
    if (!person) return json({ statusCode: 404 }, 404);
    return json({ data: { person: { ...person, company: d.companies.find(c => c.id === person.companyId) || null } } });
  }
  for (const [plural, single] of [['notes', 'Note'], ['noteTargets', 'NoteTarget'], ['tasks', 'Task'], ['taskTargets', 'TaskTarget']]) {
    if (p === `/rest/${plural}` && method === 'POST') {
      const rec = { id: `${plural}-${seq++}`, ...JSON.parse(body), createdBy };
      d[plural].push(rec);
      return json({ data: { [`create${single}`]: rec } }, 201);
    }
    const m = p.match(new RegExp(`^/rest/${plural}/([^/]+)$`));
    if (m && method === 'PATCH') {
      const rec = d[plural].find(x => x.id === m[1]);
      if (!rec) return json({ statusCode: 404 }, 404);
      Object.assign(rec, JSON.parse(body));
      return json({ data: { [`update${single}`]: rec } });
    }
  }
  return json({ unexpected: url }, 404);
}

global.fetch = async (url, opts = {}) => {
  url = String(url);
  const h = opts.headers || {};
  const method = opts.method || 'GET';
  fs.appendFileSync(LOG, JSON.stringify({
    url, method,
    authorization: h.Authorization || null, authId: h['X-Auth-ID'] || null, authToken: h['X-Auth-Token'] || null,
    body: opts.body || null,
  }) + '\n');
  const json = (o, status = 200, extra = {}) => new Response(o === null ? null : JSON.stringify(o), { status, headers: { 'content-type': 'application/json', ...extra } });
  const raw = (t, status = 200) => new Response(t, { status, headers: { 'content-type': 'application/json' } });

  if (url.startsWith('https://storage.example.test/')) {
    return new Response(`AUDIO:${new URL(url).pathname.split('/').pop()}`, { status: 200, headers: { 'content-type': 'audio/mpeg' } });
  }
  if (url.startsWith('https://media.vobiz.test/')) {
    const acct = Object.entries(ACCOUNTS).find(([id, a]) => id === h['X-Auth-ID'] && a.token === h['X-Auth-Token']);
    if (!acct) return json({ error: 'unauthorized' }, 401);
    if (url.includes('/redirect/')) return new Response(null, { status: 302, headers: { location: `https://storage.example.test/${url.split('/').pop()}` } });
    return new Response(`AUDIO:${url.split('/').pop()}`, { status: 200, headers: { 'content-type': 'audio/mpeg' } });
  }

  const server = Object.keys(SERVERS).find(s => url.startsWith(`${s}/`));
  if (server) return twenty(server, url, method, h, opts.body);

  if (!url.startsWith('https://api.vobiz.ai/')) return json({ unexpected: url }, 599);
  const m = url.match(/^https:\/\/api\.vobiz\.ai\/api\/v1\/Account\/([^/]+)(\/.*)$/);
  if (!m) return json({}, 404);
  const authId = decodeURIComponent(m[1]);
  const p = m[2];
  const acct = ACCOUNTS[authId];
  if (!acct || h['X-Auth-ID'] !== authId || h['X-Auth-Token'] !== acct.token) return json({ error: 'authentication failed' }, 401);

  if (p.startsWith('/numbers?')) {
    // Two per page whatever per_page says, so the server must really paginate.
    const all = [
      ...acct.numbers.map((e164, i) => ({ e164, status: 'active', voice_enabled: true, application_id: i === 0 ? '20577609616603585' : '' })),
      { e164: acct.inactive, status: 'released', voice_enabled: true },
      { e164: acct.noVoice, status: 'active', voice_enabled: false },
    ];
    const page = Number(new URLSearchParams(p.split('?')[1]).get('page') || 1);
    return json({ items: all.slice((page - 1) * 2, page * 2), page, per_page: 2, total: all.length });
  }
  if (/^\/numbers\/[^/]+\/application$/.test(p) && method === 'POST') return json({ message: 'Number attached to application' });
  if (p.startsWith('/Application/') && method === 'GET') {
    const body = '{"objects":[' + apps[authId].map(a => `{"app_id":${a.app_id},"app_name":"${a.app_name}","answer_url":"${a.answer_url}"}`).join(',') + ']}';
    return raw(body);
  }
  if (p === '/Application/' && method === 'POST') {
    const b = JSON.parse(opts.body);
    apps[authId].push({ app_id: acct.appId, app_name: b.app_name, answer_url: b.answer_url, hangup_url: b.hangup_url });
    return raw(`{"api_id":"x","app_id":${acct.appId},"message":"created"}`, 201);
  }
  if (p.startsWith('/Endpoint/?') && method === 'GET') {
    const alias = new URLSearchParams(p.split('?')[1]).get('alias__exact');
    const list = Object.entries(endpoints).filter(([, e]) => e.authId === authId && (!alias || e.alias === alias));
    return json({ objects: list.map(([id, e]) => ({ endpoint_id: id, username: e.username, alias: e.alias })) });
  }
  if (p === '/Endpoint/' && method === 'POST') {
    const b = JSON.parse(opts.body);
    if (!/^[A-Za-z0-9]+$/.test(b.username)) return json({ error: 'invalid request parameters' }, 400);
    const id = String(nextEndpoint++);
    endpoints[id] = { authId, username: `${b.username}1187694299`, alias: b.alias, password: b.password, app: null };
    return json({ message: 'created', endpoint_id: id }, 201);
  }
  const ep = p.match(/^\/Endpoint\/(\d+)\/$/);
  if (ep) {
    const e = endpoints[ep[1]];
    if (!e || e.authId !== authId) return new Response('', { status: 404 });
    if (method === 'GET') {
      const appPart = e.app ? `{"app_id":${e.app},"app_name":"Twenty-Calling-Vobiz"}` : 'null';
      return raw(`{"endpoint_id":"${ep[1]}","username":"${e.username}","application":${appPart}}`);
    }
    const text = String(opts.body);
    const b = JSON.parse(text);
    if (b.password) e.password = b.password;
    const appLit = text.match(/"application"\s*:\s*(\d+)/);
    const appIdLit = text.match(/"app_id"\s*:\s*"(\d+)"/);
    if (appLit) e.app = appLit[1];
    if (appIdLit && acct.honoursAppId) e.app = appIdLit[1];
    return new Response('', { status: 202 });
  }
  // Access tokens, with the checks backend-apis makes (GenerateTokenHandler /
  // ValidateTokenClaims): iss must be the account in the URL, sub matches
  // ^[A-Za-z0-9_-]*$ (<= 50), exp - nbf between 3 minutes and 24 hours, per
  // booleans, app (if given) an application on the account. Account TWO plays
  // an account without access-token calling, so sign-in falls back.
  if (p === '/JWT/Token/' && method === 'POST') {
    if (authId === 'MA_TEST0002') return json({ error: 'not found' }, 404);
    const b = JSON.parse(opts.body);
    const bad = msg => json({ api_id: 'x', error: `Failed to generate JWT token. ${msg}` }, 400);
    if (b.iss !== authId) return bad('Provided iss not associated to Authorized account');
    if (typeof b.sub !== 'string' || !/^[A-Za-z0-9_-]*$/.test(b.sub) || b.sub.length > 50) return bad('Invalid sub');
    if (!Number.isInteger(b.nbf) || !Number.isInteger(b.exp) || b.exp - b.nbf < 180 || b.exp - b.nbf > 86400) return bad('Invalid expiry duration');
    const v = b.per && b.per.voice;
    if (!v || typeof v.incoming_allow !== 'boolean' || typeof v.outgoing_allow !== 'boolean') return bad('Invalid permission present in payload');
    if (b.app !== undefined && !apps[authId].some(a => String(a.app_id) === String(b.app))) return bad(`Invalid app id ${b.app}`);
    const enc = o => Buffer.from(JSON.stringify(o)).toString('base64url');
    const input = `${enc({ alg: 'HS256', typ: 'JWT', cty: 'auris;v=1' })}.${enc({ sub: b.sub, iss: authId, nbf: b.nbf, exp: b.exp, per: b.per, app: b.app })}`;
    return json({ token: `${input}.${crypto.createHmac('sha256', acct.token).update(input).digest('base64url')}` });
  }
  if (/^\/Call\/[^/]+\/$/.test(p) && method === 'POST') return json({ message: 'call transferred' }, 202);
  if (p.startsWith('/Recording/?call_uuid=')) {
    return json({ objects: [{ recording_id: 'other', call_uuid: 'someone-else', recording_url: 'https://media.vobiz.test/other.mp3' }, ...recordings[authId]] });
  }
  const rec = p.match(/^\/Recording\/([^/?]+)\/$/);
  if (rec) {
    const found = recordings[authId].find(r => r.recording_id === rec[1]);
    return found ? json(found) : json({ error: 'not found' }, 404);
  }
  return json({}, 404);
};
