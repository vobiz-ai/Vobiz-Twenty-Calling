/**
 * Unit tests for the pieces that are easy to get subtly wrong: phone numbers,
 * Twenty phone fields, markdown in notes, Vobiz signatures, and the retry of
 * a Twenty write that failed.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'vztw-unit-'));
process.env.PUBLIC_BASE_URL = 'https://calling.example.test';
process.env.SIGNING_SECRET = 'unit-secret';
process.env.TWENTY_ALLOWED_URLS = 'https://twenty.example.test,http://localhost:3000';

const { toE164 } = require('../src/util');
const tw = require('../src/twenty');
const logger = require('../src/call-logger');
const store = require('../src/store');
const { state } = require('../src/state');
const { checkSignature } = require('../src/vobiz-signature');

test('toE164 handles trunk prefixes, bare national numbers, 00 and SIP URIs', () => {
  assert.equal(toE164('09000000011', 'IN'), '+919000000011');
  assert.equal(toE164('9000000011', 'IN'), '+919000000011');
  assert.equal(toE164('+91 90000 00011', 'IN'), '+919000000011');
  assert.equal(toE164('0091 9000000011', 'IN'), '+919000000011');
  assert.equal(toE164('sip:+919000000011@registrar.vobiz.ai', 'IN'), '+919000000011');
  assert.equal(toE164('(555) 010-0000', 'US'), '+15550100000');
  assert.equal(toE164('12', 'IN'), '');
});

test('TWENTY_ALLOWED_URLS: only listed origins; http only for localhost', () => {
  assert.equal(tw.allowedOrigin('https://twenty.example.test/some/path'), 'https://twenty.example.test');
  assert.equal(tw.allowedOrigin('http://localhost:3000'), 'http://localhost:3000');
  assert.equal(tw.allowedOrigin('https://twenty.example.test.evil.example'), null);
  assert.equal(tw.allowedOrigin('javascript:alert(1)'), null);
  const { execFileSync } = require('node:child_process');
  assert.throws(() => execFileSync(process.execPath, ['-e', "require('./src/config')"], {
    cwd: path.join(__dirname, '..'), env: { ...process.env, TWENTY_ALLOWED_URLS: 'http://crm.example.com' }, stdio: 'pipe',
  }), /must be https/);
});

test('phonesOf reads primary and additional Twenty phones, with and without calling codes', () => {
  const person = { phones: {
    primaryPhoneNumber: '90000 00011', primaryPhoneCallingCode: '+91', primaryPhoneCountryCode: 'IN',
    additionalPhones: [{ number: '5550100000', callingCode: '+1', countryCode: 'US' }, { number: '07000000001', callingCode: '' }],
  } };
  assert.deepEqual(tw.phonesOf(person, 'IN'), ['+919000000011', '+15550100000', '+917000000001']);
  assert.deepEqual(tw.phonesOf({ phones: { primaryPhoneNumber: '', additionalPhones: null } }, 'IN'), []);
});

test('splitE164 gives Twenty a calling code and national number', () => {
  assert.deepEqual(tw.splitE164('+919000000011', 'IN'), { callingCode: '+91', countryCode: 'IN', number: '9000000011' });
  assert.deepEqual(tw.splitE164('+15550100000', 'IN'), { callingCode: '+1', countryCode: 'US', number: '5550100000' });
  assert.deepEqual(tw.splitE164('+8600000000001', 'IN'), { callingCode: '', countryCode: '', number: '+8600000000001' });
});

test('note markdown: caller-controlled text cannot become a link or markup', () => {
  const md = logger.noteBody({
    direction: 'inbound', outcome: 'answered', agentName: '[click](https://evil.example) **x**', talkSeconds: 61,
    remote: '+919000000011', did: '+910000000001', startedAt: 0, callUuid: 'u-1', authId: 'MA_TEST0001',
  }, null);
  assert.doesNotMatch(md, /\]\(https:\/\/evil/);
  assert.match(md, /\*\*Agent:\*\* \\\[click\\\]\\\(https:\/\/evil\.example\\\) \\\*\\\*x\\\*\\\*/);
  assert.match(md, /\*\*Talk time:\*\* 1m 1s/);
});

test('Vobiz signature: V3 over URL + "." + nonce, V2 without the dot, never the body', () => {
  const url = 'https://calling.example.test/vobiz/answer';
  const v3 = crypto.createHmac('sha256', 'tok').update(`${url}.n1`).digest('base64');
  const v2 = crypto.createHmac('sha256', 'tok').update(`${url}n2`).digest('base64');
  assert.equal(checkSignature({ 'x-vobiz-signature-v3': v3, 'x-vobiz-signature-v3-nonce': 'n1' }, ['tok'], url), 'valid');
  assert.equal(checkSignature({ 'x-vobiz-signature-v2': v2, 'x-vobiz-signature-v2-nonce': 'n2' }, ['tok'], url), 'valid');
  assert.equal(checkSignature({ 'x-vobiz-signature-v3': v3, 'x-vobiz-signature-v3-nonce': 'n1' }, ['other'], url), 'invalid');
  assert.equal(checkSignature({}, ['tok'], url), 'absent');
});

test('a Twenty write that fails is queued, then written once by the retry', async () => {
  const origin = 'https://twenty.example.test';
  const wsKey = tw.wsKeyOf(origin, 'ws-unit');
  const d = store.load();
  d.workspaces[wsKey] = { wsKey, origin, workspaceId: 'ws-unit', name: 'Unit', appUrl: origin, settings: tw.defaultSettings() };
  d.users[`${wsKey}:u1`] = { wsKey, userId: 'u1', name: 'Unit Agent', admin: true, refreshToken: store.encrypt('rt-unit'), broken: false };
  state.twentyAccess.set(`${wsKey}:u1`, { accessToken: 'at-unit', exp: Date.now() + 600000 });

  let failNotes = true;
  const seen = [];
  global.fetch = async (url, opts = {}) => {
    const p = new URL(url).pathname;
    seen.push(`${opts.method || 'GET'} ${p}`);
    const ok = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json' } });
    if (p === '/rest/people' && (opts.method || 'GET') === 'GET') return ok({ data: { people: [] } });
    if (p === '/rest/people') return ok({ data: { createPerson: { id: 'p-1' } } }, 201);
    if (p === '/rest/notes') return failNotes ? ok({ messages: ['boom'] }, 500) : ok({ data: { createNote: { id: 'n-1' } } }, 201);
    if (p === '/rest/noteTargets') return ok({ data: { createNoteTarget: { id: 't-1' } } }, 201);
    if (p === '/rest/tasks') return ok({ data: { createTask: { id: 'k-1' } } }, 201);
    if (p === '/rest/taskTargets') return ok({ data: { createTaskTarget: { id: 'tt-1' } } }, 201);
    return ok({}, 404);
  };
  const snap = {
    callUuid: 'unit-call-1', authId: null, wsKey, userId: 'u1', agentName: 'Unit Agent', direction: 'inbound', outcome: 'missed',
    talkSeconds: 0, remote: '+917000000009', did: '+910000000001', startedAt: Date.now(), endedAt: Date.now(),
  };
  assert.equal(await logger.logCall(snap), null);
  assert.equal(store.load().pending.length, 1);
  assert.match(store.load().pending[0].lastError, /HTTP 500/);

  failNotes = false;
  store.load().pending[0].nextAt = 0;
  await logger.retryPending();
  assert.equal(store.load().pending.length, 0);
  assert.equal(store.load().calls['unit-call-1'].noteId, 'n-1');
  assert.equal(seen.filter(s => s === 'POST /rest/people').length, 1, 'the person made on the first try is reused, not created twice');
  assert.equal(seen.filter(s => s === 'POST /rest/tasks').length, 1);
  assert.equal(await logger.logCall(snap), store.load().calls['unit-call-1'], 'a logged call is never written again');
  assert.equal(seen.filter(s => s === 'POST /rest/notes').length, 2);
});

/** A fake Twenty for the logger tests below: counts requests, fails on demand. */
function fakeTwenty(fail) {
  const seen = [];
  global.fetch = async (url, opts = {}) => {
    const p = new URL(url).pathname;
    const key = `${opts.method || 'GET'} ${p}`;
    seen.push({ key, body: opts.body ? JSON.parse(opts.body) : null });
    const ok = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json' } });
    if (fail[key] > 0) { fail[key]--; return ok({ messages: ['boom'] }, 503); }
    if (key === 'GET /rest/people') return ok({ data: { people: [{ id: 'p-known', name: { firstName: 'Known', lastName: 'Caller' }, phones: { primaryPhoneNumber: '9000000099', primaryPhoneCallingCode: '+91', additionalPhones: [] } }] } });
    if (key === 'POST /rest/notes') return ok({ data: { createNote: { id: `n-${seen.length}` } } }, 201);
    if (key === 'POST /rest/noteTargets') return ok({ data: { createNoteTarget: { id: 't' } } }, 201);
    if (key.startsWith('PATCH /rest/notes/')) return ok({ data: { updateNote: { id: 'x' } } });
    return ok({}, 404);
  };
  return seen;
}

function unitWorkspace(name) {
  const origin = 'https://twenty.example.test';
  const wsKey = tw.wsKeyOf(origin, name);
  const d = store.load();
  d.workspaces[wsKey] = { wsKey, origin, workspaceId: name, name, appUrl: origin, settings: tw.defaultSettings() };
  d.users[`${wsKey}:u1`] = { wsKey, userId: 'u1', name: 'Unit Agent', admin: true, refreshToken: store.encrypt('rt-unit'), broken: false };
  state.twentyAccess.set(`${wsKey}:u1`, { accessToken: 'at-unit', exp: Date.now() + 600000 });
  return wsKey;
}

test('review 4: a failed person link is retried on its own; the note is never written twice', async () => {
  const wsKey = unitWorkspace('ws-dup');
  const seen = fakeTwenty({ 'POST /rest/noteTargets': 1 });
  const snap = {
    callUuid: 'unit-dup-1', authId: null, wsKey, userId: 'u1', agentName: 'Unit Agent', direction: 'outbound', outcome: 'answered',
    talkSeconds: 30, remote: '+919000000099', did: '+910000000001', startedAt: Date.now(), endedAt: Date.now(),
  };
  assert.equal(await logger.logCall(snap), null, 'the link failed, so the call is not done');
  assert.ok(store.load().calls['unit-dup-1'].noteId, 'but the note id is already saved');
  store.load().pending.find(p => p.callUuid === 'unit-dup-1').nextAt = 0;
  await logger.retryPending();
  assert.equal(store.load().calls['unit-dup-1'].logged, true);
  assert.equal(seen.filter(s => s.key === 'POST /rest/notes').length, 1, 'one note');
  assert.equal(seen.filter(s => s.key === 'POST /rest/noteTargets').length, 2, 'the link alone was retried');
  assert.equal(seen.filter(s => s.key === 'GET /rest/people').length, 1, 'the person was not looked up again');
});

test('review 5: a log written after the recording arrived keeps the recording', async () => {
  const wsKey = unitWorkspace('ws-rec');
  const seen = fakeTwenty({});
  // What /vobiz/recording stores when the file is ready before the call is logged.
  store.putCall('unit-rec-1', { recordingId: 'rec-early', authId: 'MA_TEST0001', wsKey });
  const snap = {
    callUuid: 'unit-rec-1', authId: 'MA_TEST0001', wsKey, userId: 'u1', agentName: 'Unit Agent', direction: 'inbound', outcome: 'answered',
    talkSeconds: 30, remote: '+919000000099', did: '+910000000001', startedAt: Date.now(), endedAt: Date.now(), recordingId: null,
  };
  const saved = await logger.logCall(snap);
  assert.equal(saved.recordingId, 'rec-early', 'not overwritten with the snapshot\'s null');
  assert.equal(saved.recordingNoted, true);
  const note = seen.find(s => s.key === 'POST /rest/notes').body;
  assert.match(note.bodyV2.markdown, /\[Play the recording\]\(https:\/\/calling\.example\.test\/recordings\/unit-rec-1\?aid=MA_TEST0001&/);
  assert.equal(seen.filter(s => s.key.startsWith('PATCH')).length, 0, 'the link went in with the note, no extra update');
});

test('review 8 (unit): the verifier accepts a nonce once per URL', () => {
  const { makeVerifier } = require('../src/vobiz-signature');
  const verify = makeVerifier({ mode: 'require', publicBaseUrl: 'https://calling.example.test' });
  const sign = (p, nonce) => crypto.createHmac('sha256', 'tok').update(`https://calling.example.test${p}.${nonce}`).digest('base64');
  const reqFor = (p, nonce) => ({ headers: { 'x-vobiz-signature-v3': sign(p, nonce), 'x-vobiz-signature-v3-nonce': nonce } });
  assert.equal(verify(reqFor('/vobiz/answer', 'n-1'), '/vobiz/answer', ['tok']), true);
  assert.equal(verify(reqFor('/vobiz/answer', 'n-1'), '/vobiz/answer', ['tok']), false, 'replay');
  assert.equal(verify(reqFor('/vobiz/hangup', 'n-1'), '/vobiz/hangup', ['tok']), true, 'same nonce on another URL is another signature');
});
