import logging
import os
import re
from urllib.parse import urlsplit

from dotenv import load_dotenv
from flask import Flask
from flask_cors import CORS

from .auth import GoogleCodeExchange, GoogleIdentityVerifier
from .auth_routes import register_auth_routes
from .routes import register_routes
from .saved_store import FirestoreSavedStore
from .saved_trips import register_saved_trip_routes
from .auth import auth_error
from flask import request
from werkzeug.exceptions import HTTPException


def _origins(value):
    origins = value.split(",") if isinstance(value, str) else value
    if not isinstance(origins, (list, tuple)) or not origins:
        raise ValueError("CORS_ALLOWED_ORIGINS must contain exact frontend origins")
    result = []
    for origin in origins:
        if not isinstance(origin, str):
            raise ValueError("CORS_ALLOWED_ORIGINS must contain exact frontend origins")
        origin = origin.strip()
        parsed = urlsplit(origin)
        if (parsed.scheme not in ("http", "https") or not parsed.hostname
                or parsed.username or parsed.password or parsed.path
                or parsed.query or parsed.fragment or "*" in origin):
            raise ValueError("CORS_ALLOWED_ORIGINS must contain exact frontend origins")
        try:
            parsed.port
        except ValueError:
            raise ValueError("CORS_ALLOWED_ORIGINS must contain exact frontend origins") from None
        result.append(origin)
    return result


def create_app(config=None):
    # Explicit injected config never opens dotenv (tests/local synthetic previews).
    if config is None:
        load_dotenv()
    app = Flask(__name__)
    app.config.from_mapping(
        GOOGLE_CLIENT_ID=os.environ.get("GOOGLE_CLIENT_ID"),
        GOOGLE_CLIENT_SECRET=os.environ.get("GOOGLE_CLIENT_SECRET"),
        FIRESTORE_PROJECT_ID=os.environ.get("FIRESTORE_PROJECT_ID"),
        FIRESTORE_DATABASE_ID=os.environ.get("FIRESTORE_DATABASE_ID", "(default)"),
        CORS_ALLOWED_ORIGINS=os.environ.get("CORS_ALLOWED_ORIGINS", "http://localhost:3000"),
    )
    if config is not None:
        app.config.update(config)
    verifier = GoogleIdentityVerifier(
        app.config["GOOGLE_CLIENT_ID"],
        certificate_request=app.config.get("GOOGLE_CERTIFICATE_REQUEST"),
        **({"clock": app.config["AUTH_CLOCK"]} if "AUTH_CLOCK" in app.config else {}),
    )
    app.extensions["google_identity"] = verifier
    app.extensions["google_code_exchange"] = GoogleCodeExchange(
        app.config["GOOGLE_CLIENT_ID"], app.config.get("GOOGLE_CLIENT_SECRET"),
        token_request=app.config.get("GOOGLE_TOKEN_REQUEST"))
    allowed_origins = _origins(app.config["CORS_ALLOWED_ORIGINS"])
    app.extensions["allowed_origins"] = allowed_origins
    CORS(app, origins=[re.compile(r"^" + re.escape(origin) + r"$") for origin in allowed_origins],
         allow_headers=["Authorization", "Content-Type", "X-Requested-With"],
         methods=["GET", "POST", "DELETE", "OPTIONS"], supports_credentials=False,
         always_send=False, vary_header=True)
    app.logger.setLevel(logging.INFO)
    register_routes(app)
    register_auth_routes(app)
    store = app.config.get('SAVED_DATA_STORE')
    if store is None:
        store = FirestoreSavedStore(project=app.config['FIRESTORE_PROJECT_ID'], database=app.config['FIRESTORE_DATABASE_ID'])
    app.extensions['saved_data_store'] = store
    register_saved_trip_routes(app, store)

    @app.after_request
    def private_no_store(response):
        if request.path == '/saved-trips' or request.path.startswith('/saved-trips/') or request.path == '/saved-locations' or request.path.startswith('/saved-locations/'):
            response.headers['Cache-Control'] = 'no-store'
        return response

    @app.errorhandler(HTTPException)
    def private_http_error(error):
        if request.path == '/saved-trips' or request.path.startswith('/saved-trips/') or request.path == '/saved-locations' or request.path.startswith('/saved-locations/'):
            codes = {400: 'INVALID_REQUEST', 404: 'SAVED_ROUTE_NOT_FOUND', 405: 'METHOD_NOT_ALLOWED', 413: 'PAYLOAD_TOO_LARGE', 415: 'UNSUPPORTED_MEDIA_TYPE'}
            response = auth_error(error.code, codes.get(error.code, 'HTTP_ERROR'), 'Invalid saved-data request.')
            if error.code == 405:
                response.headers['Allow'] = ', '.join(error.valid_methods or [])
            return response
        return error
    return app
