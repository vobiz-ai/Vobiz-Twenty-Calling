# Vobiz Calling for Twenty

Agents take and place phone calls from their own Vobiz numbers in the browser, next to Twenty. Every call is logged in Twenty on the caller's person record.

- **Know who is calling.** An incoming call shows the person's name, job title and company before the agent answers.
- **Call in one click.** Clicking a phone number in Twenty brings it to the softphone, ready to call.
- **Every call logged.** Answered, missed, busy and failed calls become notes on the person's timeline, with talk time, agent and outcome. An unknown number becomes a new person. A missed call also gets a "Call back" task.
- **Recordings where you work.** A signed, expiring recording link is added to the call's note.

Twenty has no phone panel that can hold a live call, so the softphone runs in its own browser tab.

## How it fits together

| Part | Where it runs | What it does |
| --- | --- | --- |
| Softphone | `/phone`, a tab the agent keeps open | JsSIP over WSS to `registrar.vobiz.ai`, sign-in, ringing card, call controls, settings, recent calls |
| Phone-link handler | `/dial`, opened by the browser for `tel:` links | Hands the clicked number to the open softphone tab |
| Backend | One Node.js process | Twenty OAuth, Vobiz sign-in, Vobiz webhooks, Twenty writes, signed recording playback |

Audio goes straight from the browser to Vobiz. The backend only signs agents in, answers Vobiz with VobizXML, and writes to Twenty. See [docs/architecture.md](docs/architecture.md).

## What it writes to Twenty

| Event | Twenty record |
| --- | --- |
| Any call ends | One **Note** titled e.g. `Inbound call from +91XXXXXXXXXX (answered, 4m 12s)`, linked to the person (NoteTarget), so it shows on the person's timeline |
| Number matches no person | A new **Person** named `Caller +91XXXXXXXXXX` with that phone number (can be turned off) |
| Missed inbound call | A **Task** `Call back +91XXXXXXXXXX`, status To do, due in an hour, linked to the person (can be turned off) |
| Recording is ready | The same note is updated with a signed recording link |

Notes and tasks are written as the agent who handled the call, so Twenty shows them as created by that agent. A call nobody answered is written as a connected workspace administrator.

Callers are matched on the person's primary phone and every additional phone, on the full number including the country code.

## Requirements

- Node.js 20 or later (CI uses 24).
- A public HTTPS URL for the backend. Vobiz must reach `/vobiz/answer`, Twenty redirects agents back to `/twenty/oauth/callback`, and the browser needs a secure context for the microphone. For development, use a tunnel such as `cloudflared`.
- A Vobiz account with at least one active, voice-enabled number.
- Twenty Cloud, or a self-hosted Twenty recent enough to offer OAuth (it serves `/.well-known/oauth-authorization-server`). Developed and tested against the `twentycrm/twenty:latest` image built on 23 October 2026.

## Set up the backend

1. Install dependencies:

   ```bash
   npm ci --prefix backend
   ```

2. Copy the environment template and fill it in:

   ```bash
   cp backend/.env.example backend/.env
   ```

   `backend/.env` holds deployment settings only: the public URL, the Twenty servers agents may connect, and two random secrets. It never holds a Vobiz Auth ID, Auth Token, number, SIP credential or a Twenty API key.

   | Variable | Required | Meaning |
   | --- | --- | --- |
   | `PUBLIC_BASE_URL` | yes | The public `https://` URL of this backend |
   | `TWENTY_ALLOWED_URLS` | yes | Comma-separated Twenty servers agents may connect: `https://api.twenty.com` for Twenty Cloud, or your self-hosted Twenty's `SERVER_URL`. `http://` is allowed for localhost only |
   | `SIGNING_SECRET` | yes | 32+ random bytes; signs recording links |
   | `TOKEN_ENC_KEY` | yes | 32 random bytes as 64 hex characters; encrypts stored Twenty refresh tokens |
   | `PORT` | no | Default `8096` |
   | `DATA_DIR` | no | Default `backend/data`; endpoint ids, workspaces and encrypted tokens (mode 0600) |
   | `DEFAULT_COUNTRY` | no | Default `IN`; for numbers without a country code. Each workspace can override it |
   | `RECORDING_LINK_TTL_SECONDS` | no | Default `900` |
   | `VOBIZ_WEBHOOK_SIGNATURES` | no | `require` (default), `verify` or `off`. Keep `require` in production |
   | `VOBIZ_MEDIA_HOSTS` | no | Default `*.vobiz.ai`. Hosts that may receive the Vobiz Auth ID and Token when recording audio is fetched. Any other host (for example a presigned storage URL) is fetched without credentials |

   Generate each secret with:

   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```

3. Start it:

   ```bash
   npm start
   ```

4. Run exactly one instance. Sessions and Vobiz Auth Tokens live in memory, so after a restart agents sign in again.

There is nothing to create in Twenty beforehand. The first time anyone connects, the backend registers itself with that Twenty server as an OAuth app (dynamic client registration). Twenty then shows the agent a consent page for "Vobiz Calling".

## Each agent

1. Open `<PUBLIC_BASE_URL>/phone` in its own tab and pin it. Closing the tab stops calls ringing.
2. Click **Connect Twenty** and approve. Calls are logged under your name.
3. Sign in to Vobiz with your Auth ID and Auth Token from the Vobiz Console. The backend checks them with Vobiz, finds or creates its calling application in your account, and gives you your own SIP endpoint. The token stays in server memory and is never sent back to the browser. (There is no "SIP direct" sign-in; see Limitations.)
4. Pick a caller ID. To receive calls on a number, click **Enable inbound calls**. The softphone names the application the number is on now and asks before moving it.
5. Optional: click **Use this softphone for phone links** and allow it in the browser. After that, clicking a phone number in Twenty brings it to the softphone. Twenty and the softphone must be open in the same browser profile.

## Using it

- **Incoming call:** the softphone rings and shows the caller's name, job title, company and last calls. Click **Accept** (or press Enter). With "Open the caller in Twenty on answer" on in Settings, the person opens in a new tab.
- **Outgoing call:** type a number in the softphone, or click a phone number in Twenty. The softphone always shows the number and waits for you to click **Call**, because any website can open a `tel:` link.
- **During a call:** Mute, Hold, Keypad (DTMF), and Transfer (inbound calls, to another signed-in agent).
- **After a call:** the note appears on the person's timeline. **Recent calls** in the softphone has **Play** (a freshly signed recording link) and **Open** (the person in Twenty).

## Settings

A Twenty workspace administrator (anyone with the Workspace permission) can change these in the softphone's Settings. Everyone else can read them.

| Setting | Default |
| --- | --- |
| Default country | `DEFAULT_COUNTRY` |
| Create a person for unknown numbers | On |
| Create a "Call back" task for missed calls | On |
| Open the caller in Twenty on answer | Off |
| Recording link lifetime | 15 minutes (5 minutes to 7 days) |

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| "That Twenty server is not one this calling service is set up for" | Add the server to `TWENTY_ALLOWED_URLS` and restart. |
| "Could not reach that Twenty server, or it does not offer OAuth" | The Twenty version is too old for OAuth, or the URL is wrong. Check `<twenty>/.well-known/oauth-authorization-server` returns JSON. |
| "Signed in elsewhere" | You signed in in another tab or browser. Use that one, or sign in again here. |
| Clicking a number in Twenty says no softphone is open | Open `<PUBLIC_BASE_URL>/phone` in the same browser profile, sign in, and wait for **Ready**. |
| Clicking a number opens a different app | Click **Use this softphone for phone links** again and allow it, or pick it in the browser's protocol handler settings. In Twenty, the phone field must be set to open the link, not copy it. |
| No ringing on inbound calls | Click **Enable inbound calls** for the number, and check at least one agent is signed in. |
| Registration works but outbound calls fail at once | Check `<PUBLIC_BASE_URL>/vobiz/answer` is reachable from the internet and returns XML. Endpoint `sip_registered` is not a reliable health check. |
| Calls are not logged | The softphone says "Reconnect Twenty": click Connect Twenty again. Failed writes are retried for 24 hours. |
| Recording link says expired | Use **Play** in the softphone's Recent calls for a fresh link. |

## Limitations

- No "SIP direct" sign-in (an existing endpoint's SIP username and password, without account credentials), unlike some other Vobiz CRM integrations. Without the account's Auth Token the backend cannot verify Vobiz's signed callbacks for those calls, and cannot prove the agent owns the endpoint, so anyone could claim an endpoint and have its calls logged in their workspace. Agents sign in with their Vobiz account.
- If Vobiz stores recordings on a host outside `VOBIZ_MEDIA_HOSTS` that needs the Auth Token, playback fails with a 502 until that host is added. This needs checking on a live recording.
- Recording playback streams the file but does not support seeking (HTTP Range).
- A signed Vobiz callback is accepted once per URL and nonce. The list of used nonces is kept in memory for a day, so it starts empty after a restart.
- The softphone is a separate tab. Twenty Apps can add front components to Twenty itself, but they run in a sandboxed web worker that does not document WebRTC or WebSocket support, so a live call cannot be held inside Twenty today.
- Click-to-call works through the browser's `tel:` handler: the softphone tab must be open in the same browser profile as Twenty, and the agent confirms each call.
- After a backend restart, agents sign in again, and recording links cannot play until someone on that Vobiz account signs in.
- If nobody is signed in when the backend restarts, inbound calls are refused politely and not logged, because the backend no longer holds the account's token to verify Vobiz callbacks.
- Transfer is blind and works on inbound calls only.
- Phone matching uses Twenty's `like` filter on the last digits, then compares the full number. A number stored in Twenty with spaces or dashes between digits may not be found.
- Twenty documents a limit of 100 API requests a minute. A logged call costs 2 to 6 requests. A 429 is waited out and retried once; after that the write is queued and retried.
- Calls are logged as notes. There is no dedicated "Call" object in Twenty, so calls cannot be filtered or reported on as their own records.

## Not yet proven on a live call

These are built and tested against a mock, and need one live call each before they are called verified:

- Outbound and inbound audio, answer, hang-up, mute, hold, DTMF and transfer with a real Vobiz account and the browser softphone.
- Whether `{"app_id":"<id>"}` binds the endpoint (the backend verifies and falls back), whether `ParentAuthID` on inbound calls matches the number's owner (it is only cross-checked), and in which form `X-VH-*` headers reach `/vobiz/answer` (both are accepted).
- Whether Vobiz ever resends a callback with the same nonce. A resend would now be refused as a replay.
- Talk time from `DialAnswer` / `DialHangup`, the recording callback, and recording playback through the Vobiz Recording API.
- Twenty Cloud. The OAuth discovery document at `https://api.twenty.com` was checked and matches the self-hosted one, but no Cloud workspace was connected.

Verified against a real self-hosted Twenty: OAuth connect through the softphone, caller lookup (primary and additional phones, company), and the call logger writing notes, note targets, new people, call-back tasks and the recording link update, all shown on the person's timeline and attributed to the connected user.

## Development

```bash
npm test                # backend behaviour and security regressions (no network)
npm run lint            # syntax-check every .js, parse every .json
npm run check:secrets   # no credentials or real numbers in the tree
npm run tunnel          # cloudflared quick tunnel to port 8096
```

The tests boot the real server with `fetch` replaced by `backend/test/fetch-mock.cjs`, which simulates two Vobiz accounts and two Twenty servers. The Twenty mock follows what a real Twenty returned when probed: public OAuth clients checked with PKCE, 30-minute access tokens, `/metadata` for the current user, and `like` filters on phone fields. Vobiz callbacks in the tests are signed the way Vobiz signs them, with signature checks on.

To try it against a local Twenty, start Twenty with its Docker Compose file, set `TWENTY_ALLOWED_URLS=http://localhost:3000`, and connect from the softphone.

## Security

- No route returns a SIP password, or lists accounts or endpoints, without a session token.
- Vobiz Auth Tokens and Twenty access tokens live in memory only. Twenty refresh tokens are stored encrypted (AES-256-GCM) in `DATA_DIR`, mode 0600.
- The backend only talks to Twenty servers in `TWENTY_ALLOWED_URLS`, and sends tokens only to that server's own origin, whatever its discovery document says.
- The OAuth flow uses PKCE, a state bound to the browser by an HttpOnly cookie, and checks the `iss` Twenty sends back.
- Vobiz callbacks are verified with the token of the one account they belong to, worked out from server state (the call already known, the agent's SIP user, or the dialled number), never from `ParentAuthID` or another field the sender chose. A `ParentAuthID` naming another account is refused, and a used signature nonce is refused.
- Recording audio is fetched with redirects checked hop by hop; the Vobiz credentials go only to `VOBIZ_MEDIA_HOSTS`.
- Recording links are HMAC-signed over the account, the call and the expiry. They never carry credentials, and the backend only fetches audio URLs that Vobiz's own Recording API returns.
- No CORS headers are sent: every browser request comes from pages this server serves. Pages cannot be framed.
