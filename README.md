# VroomMates

Carpool webapp — a React + Flask application that groups passengers with drivers
heading to a shared destination and suggests an optimized route for each driver.

The repo contains both the frontend (React, in `src/` and `public/`) and the
backend (Flask, in `app.py` and `backend/`) in a single project.

## Prerequisites

You will need the following installed locally:

- **Node.js** 18 or newer — https://nodejs.org/
- **npm** (ships with Node.js) — verify with `npm --version`
- **Python** 3.10 or newer — https://www.python.org/downloads/
- **pip** (ships with Python) — verify with `pip --version`

> The repo's existing `requirements.txt` was generated against Python 3.12, so
> 3.10+ is recommended. On macOS and most Linux distros, `python` and `pip`
> may be called `python3` and `pip3` — substitute as needed.

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

It is strongly recommended to use a virtual environment so the backend's
packages don't pollute your system Python:

```bash
python -m venv .venv
# macOS / Linux:
source .venv/bin/activate
# Windows (PowerShell):
.venv\Scripts\Activate.ps1

pip install -r requirements.txt
```

The `.venv/` directory is already listed in `.gitignore`.

## 4. Install Node dependencies

```bash
npm install
```

This installs both the React app and the dev tooling (including
[`concurrently`](https://www.npmjs.com/package/concurrently), which the `dev`
script below uses to run the frontend and backend together).

## 5. Run the app

You have three options.

### Option A — run both servers together (recommended)

```bash
npm run dev
```

This uses `concurrently` to start the Flask backend (`python app.py`) and the
React dev server (`react-scripts start`) in a single terminal. Output from each
process is prefixed with `backend` or `frontend`.

### Option B — run each server in its own terminal

In one terminal, start the backend:

```bash
python app.py
```

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
at the same time** for the app to work end-to-end. If you only start one, the
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
   `REACT_APP_GOOGLE_CLIENT_ID`.

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

## Project layout

```
.
├── app.py                # Flask backend entrypoint
├── backend/              # Additional backend modules
├── public/               # Static assets and HTML shell
├── src/                  # React frontend source
├── requirements.txt      # Python dependencies
├── package.json          # Node dependencies + scripts
├── .env.example          # Template for local environment variables
└── .gitignore
```
