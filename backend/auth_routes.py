"""The authentication probe; legacy route optimization remains public."""
import re

from flask import current_app, g, jsonify, request
from .auth import InvalidCredential, VerificationUnavailable, auth_error, require_google_identity


def register_auth_routes(app):
    @app.post("/auth/verify")
    @require_google_identity
    def verify_identity():
        if request.get_data() or request.args:
            return auth_error(400, "INVALID_AUTH_REQUEST", "Invalid authentication request.")
        principal = g.principal
        user = {"id": principal.owner_id}
        if principal.given_name is not None:
            user["given_name"] = principal.given_name
        response = jsonify(status="success", user=user, expires_at=principal.expires_at)
        response.headers["Cache-Control"] = "no-store"
        return response

    @app.post("/auth/google-code")
    def exchange_google_code():
        # Popup-mode CSRF guard per Google's code model; the origin is also the redirect_uri.
        origin = request.headers.get("Origin")
        body = request.get_json(silent=True) if request.is_json else None
        code = body.get("code") if isinstance(body, dict) and set(body) == {"code"} else None
        if (request.headers.get("X-Requested-With", "").lower() != "xmlhttprequest"
                or origin not in current_app.extensions["allowed_origins"] or request.args
                or not isinstance(code, str) or len(code) > 2048
                or not re.fullmatch(r"[A-Za-z0-9/_.~-]+", code)):
            return auth_error(400, "INVALID_AUTH_REQUEST", "Invalid authentication request.")
        try:
            credential = current_app.extensions["google_code_exchange"].exchange(code, origin)
            current_app.extensions["google_identity"].verify(credential)
        except InvalidCredential:
            return auth_error(401, "INVALID_CREDENTIAL", "Sign in again.")
        except VerificationUnavailable:
            return auth_error(503, "AUTH_UNAVAILABLE", "Sign-in verification is temporarily unavailable.")
        response = jsonify(status="success", credential=credential)
        response.headers["Cache-Control"] = "no-store"
        return response
