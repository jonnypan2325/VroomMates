import logging
import os
import re
from urllib.parse import urlsplit

from dotenv import load_dotenv
from flask import Flask
from flask_cors import CORS

from .auth import GoogleIdentityVerifier
from .auth_routes import register_auth_routes
from .routes import register_routes


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
    CORS(app, origins=[re.compile(r"^" + re.escape(origin) + r"$")
                       for origin in _origins(app.config["CORS_ALLOWED_ORIGINS"])],
         allow_headers=["Authorization", "Content-Type"],
         methods=["GET", "POST", "OPTIONS"], supports_credentials=False,
         always_send=False, vary_header=True)
    app.logger.setLevel(logging.INFO)
    register_routes(app)
    register_auth_routes(app)
    return app
