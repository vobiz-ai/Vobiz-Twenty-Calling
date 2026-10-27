# Architecture

## Parts

```
 Agent's browser                              Backend (one instance)                       Vobiz
 ┌───────────────────────────┐  HTTPS +       ┌──────────────────────────────┐  REST       ┌───────────┐
 │ Softphone tab (/phone)    │ ─ Bearer ────▶ │ /api/*  sessions, sign-in     │ ──────────▶ │ API       │
 │  JsSIP, caller ID, ring   │ ◀── SSE ────── │ /vobiz/* answer, dial, hangup │ ◀────────── │ webhooks  │
 │        ▲ BroadcastChannel │                │ /recordings/* signed playback │             └─────┬─────┘
 │ /dial (tel: handler)      │                │ /twenty/oauth/* connect       │                   │
 ├───────────────────────────┤                └──────────────┬───────────────┘                   │
 │ Twenty web app            │                      OAuth + REST (as the agent)                  │
 │  phone fields = tel: links│                               ▼                                   │
 └─────────────┬─────────────┘                          Twenty server                            │
               │            SIP over WSS + media (never through the backend)                     │
               └───────────────────────── wss://registrar.vobiz.ai:5063/ ────────────────────────┘
```

The backend is the Help Scout integration's design (`Vobiz-Helpscout-Calling`) with the CRM side replaced: the Vobiz modules (`vobiz.js`, `vobiz-signature.js`, `routes-vobiz.js`) are the same code with the Help Scout ids renamed.

## Sign-in

1. **Connect Twenty.** `/twenty/oauth/start?server=<origin>` accepts only origins in `TWENTY_ALLOWED_URLS`. It reads the server's `/.well-known/oauth-authorization-server`, refuses a token or registration endpoint on any other origin, and registers a public OAuth client once per server (`POST /oauth/register`, no secret). It sets a short-lived HttpOnly cookie, creates a PKCE S256 pair, and redirects to the `authorization_endpoint` from discovery (Twenty Cloud serves it on `app.twenty.com` with `?iss=`). The callback checks the cookie against `state` and the `iss` parameter against the issuer, exchanges the code with the verifier, and reads the user with `POST /metadata { currentUser { ... currentWorkspace { workspaceUrls } workspaceMember currentUserWorkspace { permissionFlags } } }`. It stores the refresh token encrypted and redirects to `/phone#link=<one-time code>`, which the page trades for a session token.
2. **Sign in to Vobiz.** The agent's key is a hash of the workspace and user, so each Twenty user gets one SIP endpoint per Vobiz account. The backend verifies the Auth ID and token with `GET /numbers`, finds or creates its application (matched on `answer_url`), finds or creates the endpoint, reads the rewritten username back, rotates its password, and binds it with `{"app_id":"<id>"}` then verifies, falling back to `{"application": <integer>}`.

There is no SIP-direct sign-in: without an account's Auth Token, callbacks about those calls could not be verified and endpoint ownership could not be proven.

A workspace is keyed by `(Twenty origin, workspace id)`. A user is an administrator when their Twenty permission flags include `WORKSPACE`.

## Calls

**Outbound.** The browser calls `sip:<number>@registrar.vobiz.ai` with `X-VH-Caller-ID` and `X-VH-Ref` headers. `/vobiz/answer` maps the SIP user to the agent, checks the caller ID belongs to that account, and returns `<Record>` then `<Dial callerId><Number>`.

**Which account a callback is about.** Every Vobiz callback is tied to one account from server state only: the call record for its `CallUUID`, else the agent's SIP user in `From`, else the signed-in account that owns the dialled `To` number. It is verified with that account's token alone, a `ParentAuthID` naming another account is refused, and each signature nonce is accepted once per URL. Fields the sender chose never pick the account, so one Vobiz customer cannot sign callbacks that write into another's CRM.

**Inbound.** `/vobiz/answer` uses that account (the owner of the dialled number) and rings every signed-in agent of that account with `<Dial callerId="<DID>" callerName="<caller>"><User>…`. It pushes an `incoming` event to those agents' tabs. If nobody is signed in, it speaks a polite message and hangs up.

**Talk time** starts at `DialAnswer` on `/vobiz/dial-events`, and uses the B-leg duration from `DialHangup` when present (`DialBLegDuration`, the actual seconds, before the billed figure). On an inbound `DialAnswer` the call moves to the answering agent's own workspace, since one Vobiz account can serve several. `/vobiz/hangup` waits `LOG_SETTLE_MS` for late dial callbacks, then logs the call once.

**Transfer** (inbound only) redirects the caller's leg with the Transfer Call API to `/vobiz/transfer-xml`, which rings the target agent's endpoint. The target is stored server side by CallUUID, never in the query string.

**Click-to-call.** Twenty renders phone fields as `tel:` links (libphonenumber `getURI()`). The softphone registers `/dial?to=%s` as the browser's `tel:` handler. `/dial` posts the number on a same-origin `BroadcastChannel`; the first signed-in, registered softphone tab answers and shows a confirm banner. Nothing dials without the agent's click.

## Logging to Twenty

One note per call, written as the agent who handled it when they are connected, else as a connected admin of that workspace, else any connected user:

- The person is found with `GET /rest/people?filter=or(phones.primaryPhoneNumber[like]:"%<last digits>%",phones.additionalPhones[like]:"%<last digits>%")`, then every hit is compared on the full E.164 number. With none, a person is created (`Caller +91…`), unless Settings turn that off. The person id is stored before the note is written, so a retry never creates a second person.
- `POST /rest/notes` with `bodyV2.markdown`, then `POST /rest/noteTargets` with `targetPersonId`. Text from callers or agent names is markdown-escaped.
- Each step's result is stored as soon as Twenty returns it (person, note, note link, task, task link), so a retry only does what is missing and never writes a second note. Every request has a 15-second deadline.
- A missed inbound call adds `POST /rest/tasks` (status `TODO`, due in an hour) and a task target.
- `RecordStop` stores the recording id with the call at once, then rewrites the note body with `PATCH /rest/notes/{id}`, adding the signed recording link. A note written after the recording arrived carries the link from the start.
- Playback streams audio found through the Vobiz Recording API. Redirects are followed by hand, and the Auth ID and Token go only to hosts in `VOBIZ_MEDIA_HOSTS`.
- 401 refreshes the token and retries once (one refresh in flight per user). 429 waits `Retry-After` (at most 10 s) and retries once. Failed writes are kept and retried for 24 hours.
- The softphone reports JsSIP `failed` and `ended` sessions. A report whose call never reached `/vobiz/answer` is logged on its own after a grace period, so no call is dropped.

## What lives where

| Data | Where | Lifetime |
| --- | --- | --- |
| Vobiz Auth Token | Memory, keyed by Auth ID | Until restart |
| SIP password | Memory, in the agent's session | Rotated each sign-in |
| Twenty access token | Memory | 30 minutes, refreshed on demand |
| Twenty refresh token | `DATA_DIR/store.json`, AES-256-GCM | 60 days, replaced on every refresh |
| Twenty OAuth client id | `DATA_DIR/store.json` | Until the redirect URL changes |
| Endpoint ids, workspaces, call records | `DATA_DIR/store.json` | Calls capped at 5000 |
