"""Per-request Google identity; no sessions, credential persistence or decoded trust."""
import base64
import binascii
from dataclasses import dataclass
from functools import wraps
import json
import re
import time

from cachecontrol import CacheControl
from cryptography import x509
from cryptography.hazmat.primitives.asymmetric import rsa
from flask import current_app, g, jsonify, request
from google.auth import exceptions
from google.auth.transport.requests import Request
from google.oauth2 import id_token
import requests


class InvalidCredential(Exception):
    pass


class VerificationUnavailable(Exception):
    pass


@dataclass(frozen=True)
class Principal:
    provider: str
    subject: str
    expires_at: int
    given_name: str | None = None

    @property
    def owner_id(self):
        return f"{self.provider}:{self.subject}"


class BoundedCertificateRequest(Request):
    """Cache only public certificates according to their HTTP freshness."""
    def __init__(self, session=None, timeout=3.0):
        super().__init__(session=CacheControl(session or requests.Session()))
        self.certificate_timeout = timeout

    def __call__(self, url, method="GET", body=None, headers=None, timeout=None, **kwargs):
        return super().__call__(url, method=method, body=body, headers=headers,
                                timeout=self.certificate_timeout, **kwargs)


class ValidatedCertificateRequest:
    """Malformed key-service responses are infrastructure failures, never credentials."""
    def __init__(self, transport):
        self.transport = transport

    def __call__(self, *args, **kwargs):
        response = self.transport(*args, **kwargs)
        if response.status != 200:
            raise exceptions.TransportError("Certificate service unavailable")
        try:
            certificates = json.loads(response.data)
            if not isinstance(certificates, dict) or not certificates:
                raise ValueError()
            for key, value in certificates.items():
                if not isinstance(key, str) or not key or not isinstance(value, str):
                    raise ValueError()
                certificate = x509.load_pem_x509_certificate(value.encode())
                if not isinstance(certificate.public_key(), rsa.RSAPublicKey):
                    raise ValueError()
        except (ValueError, TypeError, UnicodeError):
            raise exceptions.TransportError("Certificate service unavailable") from None
        return response


def _check_jwt_structure(credential):
    """Reject malformed untrusted input cheaply; this NEVER establishes identity."""
    if (not isinstance(credential, str) or len(credential) > 16384
            or not re.fullmatch(r"[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+", credential)):
        raise InvalidCredential()

    def unique_object(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError()
            result[key] = value
        return result

    def invalid_constant(_value):
        raise ValueError()

    try:
        parts = [base64.b64decode(part + '=' * (-len(part) % 4),
                                 altchars=b'-_', validate=True)
                 for part in credential.split('.')]
        header, payload = [json.loads(part.decode('utf-8'), object_pairs_hook=unique_object,
                                      parse_constant=invalid_constant) for part in parts[:2]]
        if (not isinstance(header, dict) or not isinstance(payload, dict)
                or header.get('alg') != 'RS256' or not parts[2]
                or header.get('crit') or header.get('b64') is False):
            raise ValueError()
    except (ValueError, TypeError, UnicodeError, binascii.Error, RecursionError):
        raise InvalidCredential() from None


class GoogleIdentityVerifier:
    def __init__(self, audience, certificate_request=None, clock=time.time):
        if not isinstance(audience, str) or not audience.strip():
            raise ValueError("GOOGLE_CLIENT_ID must be configured")
        self.audience = audience
        self.certificate_request = ValidatedCertificateRequest(certificate_request or BoundedCertificateRequest())
        self.clock = clock

    def verify(self, credential):
        _check_jwt_structure(credential)
        try:
            claims = id_token.verify_oauth2_token(
                credential, self.certificate_request, audience=self.audience,
                clock_skew_in_seconds=0,
            )
        except (exceptions.TransportError, requests.RequestException):
            raise VerificationUnavailable() from None
        except (ValueError, TypeError, KeyError, exceptions.GoogleAuthError):
            raise InvalidCredential() from None
        # Library verification precedes our claim-shape and exact expiry checks.
        if not isinstance(claims, dict):
            raise InvalidCredential()
        subject = claims.get("sub")
        expiry, issued = claims.get("exp"), claims.get("iat")
        if (not isinstance(subject, str) or not subject.strip() or len(subject) > 255
                or type(expiry) is not int or type(issued) is not int
                or claims.get("aud") != self.audience
                or claims.get("iss") not in ("accounts.google.com", "https://accounts.google.com")):
            raise InvalidCredential()
        now = self.clock()
        if issued > now or expiry <= now or expiry <= issued:
            raise InvalidCredential()
        name = claims.get("given_name")
        return Principal("google", subject, expiry,
                         name if isinstance(name, str) and name.strip() else None)


def auth_error(status, code, message):
    response = jsonify(error=message, code=code)
    response.status_code = status
    response.headers["Cache-Control"] = "no-store"
    if status == 401:
        response.headers["WWW-Authenticate"] = "Bearer"
    return response


def require_google_identity(handler):
    @wraps(handler)
    def guarded(*args, **kwargs):
        authorization = request.headers.get("Authorization")
        if authorization is None:
            return auth_error(401, "AUTH_REQUIRED", "Sign in required.")
        match = re.fullmatch(r"Bearer ([A-Za-z0-9._~-]+)", authorization, re.IGNORECASE)
        if not match or len(match[1]) > 16384:
            return auth_error(401, "INVALID_CREDENTIAL", "Sign in again.")
        try:
            g.principal = current_app.extensions["google_identity"].verify(match[1])
        except InvalidCredential:
            return auth_error(401, "INVALID_CREDENTIAL", "Sign in again.")
        except VerificationUnavailable:
            return auth_error(503, "AUTH_UNAVAILABLE", "Sign-in verification is temporarily unavailable.")
        return handler(*args, **kwargs)
    return guarded
