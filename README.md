# VroomMates

Carpool webapp — a React + Flask application that groups passengers with drivers
heading to a shared destination and suggests an optimized route for each driver.

The repo contains both the frontend (React, in `src/` and `public/`) and the
backend (Flask, in `app.py` and `backend/`) in a single project.

## Prerequisites

You will need the following installed locally:

- **Node.js** 24.x — https://nodejs.org/
- **npm** (ships with Node.js) — verify with `npm --version`
- **Python** 3.10 or newer — https://www.python.org/downloads/
- **pip** (ships with Python) — verify with `pip --version`

> On macOS and Linux, use `python3` to create the virtual environment.
> On Windows, use `py -3`. After activation, use `python` and `python -m pip`.

## 1. Clone and enter the repo

```bash
git clone https://github.com/jonnypan2325/VroomMates.git
cd VroomMates
```

## 2. Create your `.env` file

Copy the template and fill in your own keys:

```bash
cp .env.example .env
```

Then open `.env` and replace the placeholder values. See
[Getting the Google credentials](#getting-the-google-credentials) below.

## 3. Install Python dependencies

Create and activate a virtual environment for the backend:

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
```

On Windows (PowerShell):

```powershell
py -3 -m venv .venv
.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
```

The `.venv/` directory is already listed in `.gitignore`.
Activate it in each new terminal before running backend commands or `npm run dev`.
The npm scripts use `python`, which activation resolves to the virtual environment.

## 4. Install Node dependencies

```bash
npm install
```

This installs both the React app and the dev tooling (including
[`concurrently`](https://www.npmjs.com/package/concurrently), which the `dev`
script below uses to run the frontend and backend together).

## 5. Run the app

Activate the virtual environment from step 3, then choose a startup option.

Saving trips and locations needs Firestore. For local development, start the
Firestore emulator in its own terminal first; the `.env.example` values point the
backend at it, and no Google credentials are needed. Saved data is lost when the
emulator stops. It needs the [Firebase CLI](https://firebase.google.com/docs/cli)
and Java.

```bash
firebase emulators:start --only firestore --project demo-vroommates
```

### Option A — run both servers together (recommended)

```bash
npm run dev
```

This uses `concurrently` to start the Flask backend (`python app.py`) and the
React dev server (`react-scripts start`) in a single terminal. Output from each
process is prefixed with `backend` or `frontend`.

### Option B — run each server in its own terminal

In one terminal, activate the virtual environment and start the backend:

```bash
source .venv/bin/activate
npm run backend
```

On Windows, activate with `.venv\Scripts\Activate.ps1` instead.
Running `python app.py` directly starts the same development server.

In a second terminal, start the frontend:

```bash
npm start
```

### Default ports

| Service  | URL                          |
| -------- | ---------------------------- |
| Frontend | http://localhost:3000        |
| Backend  | http://localhost:5000        |

The frontend talks to the backend over HTTP, so **both servers must be running
at the same time** for the app to work end-to-end. If you start only the frontend, the
UI will load but route optimization requests will fail.

## Getting the Google credentials

### Google OAuth Client ID (`REACT_APP_GOOGLE_CLIENT_ID`)

1. Go to the [Google Cloud Console — Credentials page](https://console.cloud.google.com/apis/credentials).
2. Create (or select) a project.
3. Click **Create Credentials → OAuth client ID**.
4. If prompted, configure the OAuth consent screen first (External, just fill in the required fields).
5. Choose **Web application** as the application type.
6. Under **Authorized JavaScript origins**, add `http://localhost:3000`.
7. The sign-in popup returns a one-time code to the page, so no redirect URI is needed; do not add the API as a Google redirect URI.
8. Copy the generated **Client ID** and paste it into `.env` as
   `REACT_APP_GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_ID`. The frontend and server must use the same web client ID. Missing `GOOGLE_CLIENT_ID` fails backend startup.
9. Copy the client's **Client secret** into `.env` as `GOOGLE_CLIENT_SECRET` (server only, never `REACT_APP_`). The API's `POST /auth/google-code` uses it to swap the popup's code for an ID token; without it, sign-in reports that it is temporarily unavailable.

### Google Maps API key (`REACT_APP_GOOGLE_MAPS_API_KEY`)

1. In the same [Credentials page](https://console.cloud.google.com/apis/credentials),
   click **Create Credentials → API key**.
2. From the [API Library](https://console.cloud.google.com/apis/library), enable
   these APIs for your project:
   - **Maps JavaScript API**
   - **Places API**
3. Copy the API key and paste it into `.env` as `REACT_APP_GOOGLE_MAPS_API_KEY`.
4. The frontend's Maps script tag in `public/index.html` reads the key via
   Create React App's `%REACT_APP_GOOGLE_MAPS_API_KEY%` HTML substitution,
   which is resolved at build time — you don't need to edit `index.html`
   yourself. (If you change `.env`, restart `npm start` for the new value to
   be picked up.)
5. It is highly recommended to add HTTP referrer restrictions to the key in
   the Google Cloud Console so it can only be used from your domains.

### Flask backend URL (`REACT_APP_FLASK_API_URL`)

The React frontend reads `REACT_APP_FLASK_API_URL` to know where the Flask
backend is running. For local development, leave the value in `.env.example`
(`http://127.0.0.1:5000`) as-is.

> **Security note:** anything prefixed with `REACT_APP_` is embedded into the
> built JavaScript bundle and is therefore visible to anyone who loads the
> site. Treat these as public keys and lock them down with origin / referrer
> restrictions in the Google Cloud Console.

## Available npm scripts

| Script           | What it does                                              |
| ---------------- | --------------------------------------------------------- |
| `npm start`      | Start the React dev server on port 3000.                  |
| `npm run backend`| Start the Flask backend (`python app.py`) on port 5000.   |
| `npm run dev`    | Start the backend and frontend together via `concurrently`.|
| `npm run build`  | Produce a production build of the frontend in `build/`.   |
| `npm test`       | Run the React test suite.                                 |

## Tests and production build

Run the backend suite from an activated virtual environment:

```bash
python -m pip install -r requirements-test.txt
python -m tests.run_tests
```

On macOS and Linux, you can also run it without activation:

```bash
.venv/bin/python -m pip install -r requirements-test.txt
.venv/bin/python -m tests.run_tests
```

The backend suite covers the HTTP contract, validation, last-result storage, optimizer invariants, and real Google verification using synthetic RSA tokens. `tests.run_tests` disables dotenv before discovery/root-app imports and injects a synthetic expected audience; it never needs real credentials or certificate network calls. It uses Python's standard-library `unittest`.

Run the frontend checks separately:

```bash
CI=true npm test -- --watchAll=false
npm run build
```

Auth lifecycle tests are pending human visual confirmation; they have not been written or run yet.
In PowerShell, set `$env:CI = "true"` before running the npm test command.

## Deployment

Two Vercel projects deploy from this repository root. The frontend project uses the
Create React App preset; `package.json` selects Node.js 24.x through `engines.node`,
overriding the dashboard runtime setting. The API project uses the Flask preset with
`app.py` as its entrypoint and installs `requirements.txt`. `.vercelignore` excludes only
Python environment/cache files, so both projects see the backend sources.
Set `REACT_APP_FLASK_API_URL` to the API project's URL when building the frontend.
The `python app.py` command starts a debug development server.

The API project reaches Firestore through Vercel OIDC and Google Workload Identity
Federation. Set `GCP_PROJECT_NUMBER`, `GCP_WORKLOAD_IDENTITY_POOL_ID`,
`GCP_WORKLOAD_IDENTITY_POOL_PROVIDER_ID` and `GCP_SERVICE_ACCOUNT_EMAIL` on it, along
with `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `CORS_ALLOWED_ORIGINS` and
`FIRESTORE_PROJECT_ID`; without the
project ID every saved-data request fails as unavailable. Vercel
sends a short-lived token in the `x-vercel-oidc-token` request header; the backend keeps
the latest one for credential refresh. Its audience stays `https://vercel.com/<team-slug>`,
so configure the pool provider's allowed audiences with that value. Disable Vercel
Deployment Protection on the API project: browser preflight cannot carry Vercel's
login cookie across origins, and protected routes already require Google proof.

## Project layout

```text
app.py                    exported Flask app and development server entry point
backend/
  __init__.py             create_app, CORS, logging, and route registration
  auth.py                 Google ID-token verification and request-local identity guard
  auth_routes.py          protected POST /auth/verify identity probe
  routes.py               HTTP handlers, JSON serialization, last-result storage
  validation.py           request parsing and validation errors
  models.py               Driver, Passenger, and coordinate type
  optimizer.py            distance, assignment, stop ordering, and route building
tests/
  __init__.py             test package marker
  test_api.py             root-app HTTP contract, storage, and validation tests
  test_optimizer.py       domain and optimizer invariant tests
  test_auth.py            synthetic crypto, auth, certificate-cache and CORS checks
  run_tests.py            dotenv-safe synthetic-config test discovery
public/                   static assets and HTML shell
src/                      React frontend source
requirements.txt          Python runtime dependencies
package.json              Node dependencies and npm scripts
.env.example              template for local environment variables
.vercelignore             frontend-only deployment exclusions
.gitignore
```

## Google account identity

The Google-rendered sign-in button supplies a signed ID token. VroomMates sends it
as explicit `Authorization: Bearer` proof to `POST /auth/verify`, with an empty body
and browser credentials omitted. Flask verifies the signature, configured audience,
Google issuer, issue time, expiry and required claims on every protected request.
Its request-local owner is `(google, verified sub)`, exposed as `google:<sub>`.
Names are optional display data; emails and client-supplied owner fields grant no authority.

The browser keeps the proof only in memory. Refreshing, opening a new tab or expiry
requires explicit sign-in again. Logout clears this tab and cancels pending requests;
it does not sign out Google or revoke a copied valid token, which remains usable
until signed expiry. Switching accounts requires logging out first. Stale callbacks
and responses cannot restore the previous account. A temporary verification outage
offers explicit retry without showing an authenticated greeting.

The probe accepts no body or query inputs. Controlled errors contain string `error`
and stable `code`: `AUTH_REQUIRED` or `INVALID_CREDENTIAL` (401),
`INVALID_AUTH_REQUEST` (400), and `AUTH_UNAVAILABLE` (503). Auth responses use
`Cache-Control: no-store`; 401 includes `WWW-Authenticate: Bearer`. Public Google
certificates follow HTTP cache freshness and outbound requests have a three-second
transport timeout. Verification infrastructure failure never trusts decoded claims.

Configure `CORS_ALLOWED_ORIGINS` with exact comma-separated frontend origins.
The development default is `http://localhost:3000`; add the exact local port if
changed. Wildcards, origin patterns and URL paths are rejected. Bearer requests omit
cookies; public OPTIONS preflight permits Authorization/Content-Type for allowed
origins. CORS is a browser boundary and never replaces proof verification.

Deployment still requires a separate HTTPS Flask host, Authorization forwarding,
OPTIONS handling, outbound Google certificate access, exact Google Authorized
JavaScript origins, compatible GIS/CSP/popup headers and safe server/proxy logging.
Do not log Authorization, proof, full claims or account data. No backend host or
real-account/deployed-origin validation is configured by this change.

Route planning remains public. The legacy process-global last-result GET and route
coordinate logging require migration in the future private saved-trip API slice.
Authentication alone does not establish saved-route durability or privacy.

## Bounded geographic optimizer

The separately implemented exact geographic optimizer supports at most **12 raw
passenger entries and 8 drivers**. Oversized HTTP requests return **400**, including
18 co-located passenger entries; shared pickup coordinates do not reduce this limit.
Coordinates must be finite and within latitude [-90, 90] and longitude [-180, 180];
valid numeric strings remain accepted. Repeated passenger waypoints are preserved.
Every listed driver travels, including a direct origin-to-destination route when no
passengers are assigned. Each driver's origin, assigned pickup multiplicity and
shared destination remain in the result, and the success JSON schema is unchanged.
Compatibility for 18 co-located stops in the standalone `order_stops` helper does
not widen the HTTP request limit.

The objective is total geographic distance, with deterministic recurrence ties and
ordinary floating-point accuracy. Correctness comparisons use a numerical tolerance;
this does not promise bit-exact real-number costs, road travel times or other modes.


### Private saved-data API (local implementation)

The saved-trip and saved-location APIs use Firestore through Flask. The target is Vercel-hosted Flask with Firestore in the existing Google project. Database/region/IAM, exact hosted origins and real two-account/device recovery need a separate hosted check.

Send the Google ID token in `Authorization: Bearer ...` for each protected request. Flask verifies it and derives ownership from Google subject, then selects the account's isolated Firestore document namespace. Browser clients do not connect directly to Firestore; no Firebase Authentication migration is needed. `FIRESTORE_PROJECT_ID` and optional `FIRESTORE_DATABASE_ID` are server-only settings. The SDK uses server Application Default Credentials; no database credential belongs in a `REACT_APP_` variable. On Vercel, the four `GCP_*` settings switch the SDK to Vercel OIDC / Google Workload Identity Federation (see Deployment); hosted verification of project/environment IAM restrictions is still pending. Never place actual credential values in this repo or its CDK record.

- `POST /saved-trips`: `{id: UUIDv4, title, snapshot: {schema_version: 1, inputs: {drivers, passengers, destination}, routes}}`. Each input point has a unique `stop_id`, optional independent user label and `{kind: "google_places", place_id}` source; drivers also have positive integer capacity. A route is `{driver_id, stop_ids: [driver, ...passengers, destination]}`. Ordered occurrence references preserve repeated pickup places. Addresses, coordinates and provider responses are rejected. Saved assignments are preserved; reopening resolves current place details and does not automatically optimize again.
- `GET /saved-trips`: owner summaries, default50/max100 with opaque `cursor`; `GET /saved-trips/<id>` loads references; `DELETE` returns204 including already missing/foreign IDs.
- `POST /saved-locations`: `{id: UUIDv4, label, source: {kind: "google_places", place_id}}`; `GET /saved-locations` lists at most100 owner locations, detail byID, `DELETE` removes one. Labels are normalized/case-insensitively unique per owner; different labels can refer to the same place. The response has `resolution_required: true`, with no retained address/geometry. No manual-coordinate or edit API in v1.

Generate one random ID per save intent. A matching existing ID/content returns the original record; different content conflicts. A new ID can intentionally copy a trip. After a timeout the save outcome is unknown: load that ID to reconcile before an explicit retry. Never automatically replay writes under a new account or after deletion; there is no permanent operation ledger or post-delete replay guarantee. Store failures return503 rather than fabricated empty results or successful writes.

The former public `GET /routeoptimizer/` is retired with410 `LAST_RESULT_REMOVED`; route POST still returns its existing success shape. No global last-result object or full coordinate logging remains.

`firestore.indexes.json` declares a collection-group exemption for `trips.snapshot_json`. This configuration is **not deployed** by these changes; without applying it, Firestore's default indexing still applies. Review it alongside any existing project indexes; do not overwrite unrelated configuration. The snapshot is encoded as bounded canonical JSON, with separate projected list metadata. Server IAM and Flask ownership checks protect server SDK access; client rules alone do not constrain the server SDK. Deny browser access to the dedicated `vroommates_accounts` namespace when configuring rules without changing unrelated project access.

Local integration tests explicitly opt into the loopback Firestore emulator with anonymous credentials and a demo project. They cannot establish hosted durability or pricing/backup retention. Run the safe backend runner, which disables dotenv before discovery:

```bash
python -B -m tests.run_tests
```

For the selected-adapter suite, start an official Firestore emulator bound to `127.0.0.1:8187` with project `demo-vroommates`, then run:

```bash
FIRESTORE_EMULATOR_HOST=127.0.0.1:8187 VROOMMATES_TEST_FIRESTORE_EMULATOR=127.0.0.1:8187 python -B -m tests.run_tests
```

The explicit test flag rejects cloud/nonloopback targets. The emulator service itself is ephemeral; the restart test creates a fresh backend process against the same running emulator. Hosted managed-Firestore recovery and two-device proof remain delivery work. Save/My Trips and saved-place picker interfaces are later slices; the API does not yet make those flows available in the browser.
