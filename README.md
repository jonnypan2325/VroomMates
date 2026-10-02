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
7. Under **Authorized redirect URIs**, also add `http://localhost:3000`.
8. Copy the generated **Client ID** and paste it into `.env` as
   `REACT_APP_GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_ID`. The frontend and server must use the same web client ID. Missing `GOOGLE_CLIENT_ID` fails backend startup.

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

There are currently no authored frontend tests. Jest reports “No tests found”
and exits with code 1. To check that the runner works despite that absence, run
`CI=true npm test -- --watchAll=false --passWithNoTests`.
In PowerShell, set `$env:CI = "true"` before running the npm test command.

## Deployment

Vercel builds and deploys the React frontend only. `package.json` selects Node.js
24.x through `engines.node`, overriding the dashboard runtime setting. `.vercelignore` excludes
`app.py`, `backend/`, `requirements.txt`, and Python environment/cache files.
The Flask backend needs a separate host; this repository does not configure one.
Set `REACT_APP_FLASK_API_URL` to that backend's URL when building the frontend.
The `python app.py` command starts a debug development server.

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
