"""The authentication probe; legacy route optimization remains public."""
from flask import g, jsonify, request
from .auth import auth_error, require_google_identity


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
