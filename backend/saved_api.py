"""Bounded request helpers shared by private saved-data endpoints."""
import base64
import functools
import json
import re
import unicodedata
import uuid
from datetime import datetime, timezone
from flask import jsonify, request
from .auth import auth_error
from .saved_store import SavedNotFound, SaveConflict, StoreCorrupt, StoreUnavailable


class SavedRequestError(Exception):
    def __init__(self, status, code, message):
        self.status, self.code, self.message = status, code, message


def _object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('duplicate JSON field')
        result[key] = value
    return result


def _constant(_):
    raise ValueError('nonfinite JSON constant')


def read_object(max_bytes, invalid_code):
    if request.mimetype != 'application/json' or request.headers.get('Content-Encoding', 'identity') != 'identity':
        raise SavedRequestError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Use an uncompressed JSON request.')
    if request.content_length is not None and request.content_length > max_bytes:
        raise SavedRequestError(413, 'PAYLOAD_TOO_LARGE', 'Request is too large.')
    raw = request.stream.read(max_bytes + 1)
    if len(raw) > max_bytes:
        raise SavedRequestError(413, 'PAYLOAD_TOO_LARGE', 'Request is too large.')
    try:
        value = json.loads(raw.decode('utf-8'), object_pairs_hook=_object, parse_constant=_constant)
        if not isinstance(value, dict):
            raise ValueError()
        def bounded_depth(item, depth=0):
            if depth > 16:
                raise ValueError()
            if isinstance(item, dict):
                for child in item.values(): bounded_depth(child, depth + 1)
            elif isinstance(item, list):
                for child in item: bounded_depth(child, depth + 1)
        bounded_depth(value)
        return value
    except (ValueError, UnicodeError, RecursionError):
        raise SavedRequestError(400, invalid_code, 'Invalid saved-data request.') from None


def canonical_uuid(value):
    if not isinstance(value, str) or len(value) != 36:
        raise ValueError()
    parsed = uuid.UUID(value)
    if parsed.version != 4 or parsed.variant != uuid.RFC_4122 or str(parsed) != value:
        raise ValueError()
    return value


def text(value, max_chars, max_bytes, allow_empty=False):
    if not isinstance(value, str):
        raise ValueError()
    if any(unicodedata.category(c).startswith('C') for c in value):
        raise ValueError()
    value = unicodedata.normalize('NFC', value).strip()
    if (not value and not allow_empty) or len(value) > max_chars:
        raise ValueError()
    if any(unicodedata.category(c).startswith('C') for c in value) or len(value.encode('utf-8')) > max_bytes:
        raise ValueError()
    return value


def place_source(value):
    if not isinstance(value, dict) or set(value) != {'kind', 'place_id'} or value['kind'] != 'google_places':
        raise ValueError()
    ident = value['place_id']
    if (not isinstance(ident, str) or not ident or len(ident.encode('utf-8')) > 4096
            or any(c.isspace() or unicodedata.category(c).startswith('C') for c in ident)):
        raise ValueError()
    return {'kind': 'google_places', 'place_id': ident}


def private_json(payload, status=200):
    response = jsonify(payload)
    response.status_code = status
    response.headers['Cache-Control'] = 'no-store'
    return response


def saved_errors(feature):
    def decorate(func):
        @functools.wraps(func)
        def wrapped(*args, **kwargs):
            try:
                return func(*args, **kwargs)
            except SavedRequestError as exc:
                return auth_error(exc.status, exc.code, exc.message)
            except SavedNotFound:
                return auth_error(404, 'TRIP_NOT_FOUND' if feature == 'trip' else 'LOCATION_NOT_FOUND', 'Saved item was not found.')
            except SaveConflict as exc:
                code = ('TRIP_CONFLICT' if feature == 'trip' else
                        {'record': 'LOCATION_EXISTS', 'label': 'LABEL_EXISTS', 'limit': 'LOCATION_LIMIT'}[exc.kind])
                payload = {'error': 'Saved item conflicts with existing data.', 'code': code}
                if feature == 'location' and exc.kind == 'label' and exc.existing_id:
                    payload['existing_location_id'] = exc.existing_id
                return private_json(payload, 409)
            except StoreCorrupt:
                return auth_error(500 if feature == 'trip' else 503,
                                  'SAVED_TRIP_UNREADABLE' if feature == 'trip' else 'STORE_UNAVAILABLE',
                                  'Saved data is temporarily unavailable.')
            except StoreUnavailable:
                return auth_error(503, 'STORE_UNAVAILABLE', 'Saved data is temporarily unavailable.')
        return wrapped
    return decorate


def _cursor_pair(pair):
    if not isinstance(pair, (tuple, list)) or len(pair) != 2 or not isinstance(pair[0], str) or len(pair[0]) > 40:
        raise ValueError()
    stamp, ident = pair
    parsed = datetime.fromisoformat(stamp.replace('Z', '+00:00'))
    if parsed.tzinfo != timezone.utc or not re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z', stamp):
        raise ValueError()
    canonical_uuid(ident)
    return stamp, ident


def encode_trip_cursor(pair):
    pair = _cursor_pair(pair)
    return base64.urlsafe_b64encode(json.dumps(pair, separators=(',', ':')).encode()).decode().rstrip('=')


def decode_trip_cursor(token):
    if not isinstance(token, str) or not token or len(token) > 512 or not re.fullmatch(r'[A-Za-z0-9_-]+', token):
        raise ValueError()
    try:
        raw = base64.b64decode(token + '=' * (-len(token) % 4), altchars=b'-_', validate=True)
        return _cursor_pair(json.loads(raw.decode('utf-8')))
    except (ValueError, UnicodeError, RecursionError):
        raise ValueError() from None
