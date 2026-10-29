/**
 * Deployment settings. Nothing account-specific lives here: no Vobiz Auth ID,
 * token, number, endpoint or application id, and no Twenty API key. Agents
 * sign in from the softphone.
 */
const crypto = require('node:crypto');
const path = require('node:path');

const env = process.env;
const strip = s => String(s || '').replace(/\/+$/, '');

const SIGNING_SECRET = env.SIGNING_SECRET || '';
const signingSecret = SIGNING_SECRET || crypto.randomBytes(32).toString('hex');

/**
 * Key for encrypting Twenty refresh tokens, OAuth client secrets and webhook
 * secrets at rest. TOKEN_ENC_KEY is 32 bytes as 64 hex characters or base64.
 * Without it the key is derived from SIGNING_SECRET, which is fine for
 * development but couples two secrets; production should set both.
 */
function encKey() {
  const raw = env.TOKEN_ENC_KEY || '';
  if (/^[0-9a-f]{64}$/i.test(raw)) return Buffer.from(raw, 'hex');
  if (raw) {
    const b = Buffer.from(raw, 'base64');
    if (b.length === 32) return b;
    throw new Error('TOKEN_ENC_KEY must be 32 bytes, as 64 hex characters or base64');
  }
  return crypto.createHash('sha256').update(`enc|${signingSecret}`).digest();
}

/**
 * The Twenty servers this backend may talk to. The backend makes requests to
 * whatever Twenty URL an agent connects, so it is an explicit allowlist, never
 * "any URL typed in the softphone" (that would be an SSRF primitive).
 * http:// is accepted only for localhost, for a local Twenty in development.
 */
function twentyUrls() {
  const list = String(env.TWENTY_ALLOWED_URLS || 'https://api.twenty.com').split(',').map(s => strip(s.trim())).filter(Boolean);
  const out = [];
  for (const u of list) {
    let parsed;
    try { parsed = new URL(u); } catch { throw new Error(`TWENTY_ALLOWED_URLS: "${u}" is not a URL`); }
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
    if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && local)) {
      throw new Error(`TWENTY_ALLOWED_URLS: "${u}" must be https (http is allowed for localhost only)`);
    }
    out.push(parsed.origin);
  }
  return out;
}

const config = {
  PORT: Number(env.PORT || 8096),
  PUBLIC_BASE_URL: strip(env.PUBLIC_BASE_URL || env.PUBLIC_BASE),
  SIGNING_SECRET: signingSecret,
  SIGNING_SECRET_IS_EPHEMERAL: !SIGNING_SECRET,
  ENC_KEY: encKey(),
  DATA_DIR: env.DATA_DIR || path.join(__dirname, '..', 'data'),

  VOBIZ_API_BASE: strip(env.VOBIZ_API_BASE || 'https://api.vobiz.ai/api/v1'),
  VOBIZ_REGISTRAR: env.VOBIZ_REGISTRAR || 'registrar.vobiz.ai',
  // Hosts that may receive the Vobiz Auth ID and Token when recording audio is
  // fetched. A leading "*." matches subdomains. Any other host (a presigned
  // storage URL, say) is fetched without credentials.
  VOBIZ_MEDIA_HOSTS: String(env.VOBIZ_MEDIA_HOSTS || '*.vobiz.ai').split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
  // How the softphone registers with Vobiz:
  //   jwt (default)  a short-lived access token per agent, minted by this
  //                  backend; no SIP endpoint and no SIP password exist;
  //   endpoint       one SIP endpoint per agent with a rotated password.
  // With jwt, a sign-in whose token cannot be minted falls back to endpoint.
  VOBIZ_SIP_AUTH: (env.VOBIZ_SIP_AUTH || 'jwt').toLowerCase() === 'endpoint' ? 'endpoint' : 'jwt',
  // Access token lifetime. Vobiz accepts 3 minutes to 24 hours; the softphone
  // renews it about 90 seconds before it expires.
  JWT_TTL_SECONDS: Math.min(86000, Math.max(300, Number(env.JWT_TTL_SECONDS || 3600))),
  // require (default) | verify | off. See vobiz-signature.js.
  VOBIZ_WEBHOOK_SIGNATURES: (env.VOBIZ_WEBHOOK_SIGNATURES || 'require').toLowerCase(),

  TWENTY_ALLOWED_URLS: twentyUrls(),

  DEFAULT_COUNTRY: (env.DEFAULT_COUNTRY || 'IN').toUpperCase(),
  RECORDING_LINK_TTL_SECONDS: Number(env.RECORDING_LINK_TTL_SECONDS || 900),
  SESSION_TTL_MS: 12 * 60 * 60 * 1000,
  // Wait this long after the A leg hangs up before writing to Twenty, so the
  // dial result and dial events (which may arrive later) are in.
  LOG_SETTLE_MS: Number(env.LOG_SETTLE_MS || 3000),
  // How long the softphone's report of a call that never reached /vobiz/answer
  // waits for a server record before it is logged on its own.
  PANEL_REPORT_GRACE_MS: Number(env.PANEL_REPORT_GRACE_MS || 8000),
};

module.exports = config;
