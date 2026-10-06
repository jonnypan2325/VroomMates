"""Private reusable Google place references; provider geometry is never stored."""
from datetime import datetime, timezone
import re

from flask import g, request

from .auth import require_google_identity
from .saved_api import (SavedRequestError, canonical_uuid, place_source, private_json,
                        read_object, saved_errors, text)
from .saved_store import SavedNotFound, StoreCorrupt

MAX_BODY_BYTES = 16 * 1024
MAX_LOCATIONS = 100
_RECORD_FIELDS = {'id', 'label', 'source', 'schema_version', 'created_at', 'updated_at'}
_TIMESTAMP = re.compile(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z')


def _create_record(value):
    if set(value) != {'id', 'label', 'source'}:
        code = ('PROVIDER_DATA_NOT_STORABLE' if any(
            key in value for key in ('address', 'coordinates', 'geometry')) else 'INVALID_LOCATION')
        raise SavedRequestError(400, code, 'Invalid saved location.')
    try:
        return {'id': canonical_uuid(value['id']),
                'label': text(value['label'], 80, 320),
                'source': place_source(value['source'])}
    except (ValueError, TypeError):
        raise SavedRequestError(400, 'INVALID_LOCATION', 'Invalid saved location.') from None


def _public_record(value, expected_id=None):
    """Validate persisted shape before exposing it; never silently repair storage."""
    try:
        if not isinstance(value, dict) or set(value) != _RECORD_FIELDS:
            raise ValueError()
        ident = canonical_uuid(value['id'])
        label = text(value['label'], 80, 320)
        source = place_source(value['source'])
        if (label != value['label'] or source != value['source']
                or type(value['schema_version']) is not int or value['schema_version'] != 1
                or (expected_id is not None and ident != expected_id)):
            raise ValueError()
        stamp = value['created_at']
        if (not isinstance(stamp, str) or not _TIMESTAMP.fullmatch(stamp)
                or value['updated_at'] != stamp
                or datetime.fromisoformat(stamp.replace('Z', '+00:00')).tzinfo != timezone.utc):
            raise ValueError()
        return {'id': ident, 'label': label, 'source': source, 'schema_version': 1,
                'created_at': stamp, 'updated_at': stamp, 'resolution_required': True}
    except (ValueError, TypeError, KeyError):
        raise StoreCorrupt() from None


def _no_arguments(code='INVALID_LOCATION'):
    if request.query_string:
        raise SavedRequestError(400, 'INVALID_QUERY', 'Invalid saved-location query.')
    if request.content_length or request.stream.read(1):
        raise SavedRequestError(400, code, 'This request must not have a body.')


def _path_id(value):
    try:
        return canonical_uuid(value)
    except ValueError:
        raise SavedNotFound() from None


def register_saved_location_routes(app, store):
    """Register the scoped API with an explicit coordinator-owned store."""
    @app.after_request
    def location_no_store(response):
        if request.path == '/saved-locations' or request.path.startswith('/saved-locations/'):
            response.headers['Cache-Control'] = 'no-store'
        return response

    @app.post('/saved-locations')
    @require_google_identity
    @saved_errors('location')
    def create_saved_location():
        if request.query_string:
            raise SavedRequestError(400, 'INVALID_QUERY', 'Invalid saved-location query.')
        record = _create_record(read_object(MAX_BODY_BYTES, 'INVALID_LOCATION'))
        stored, created = store.create_location(g.principal.owner_id, record)
        if type(created) is not bool:
            raise StoreCorrupt()
        public = _public_record(stored, record['id'])
        if {key: public[key] for key in ('id', 'label', 'source')} != record:
            raise StoreCorrupt()
        response = private_json({'status': 'success', 'location': public}, 201 if created else 200)
        if created:
            response.headers['Location'] = '/saved-locations/' + public['id']
        return response

    @app.get('/saved-locations')
    @require_google_identity
    @saved_errors('location')
    def list_saved_locations():
        _no_arguments()
        rows = store.list_locations(g.principal.owner_id)
        if not isinstance(rows, list) or len(rows) > MAX_LOCATIONS:
            raise StoreCorrupt()
        locations = [_public_record(row) for row in rows]
        if (len({row['id'] for row in locations}) != len(locations)
                or len({row['label'].casefold() for row in locations}) != len(locations)):
            raise StoreCorrupt()
        locations.sort(key=lambda row: (row['label'].casefold(), row['id']))
        return private_json({'status': 'success', 'locations': locations})

    @app.get('/saved-locations/<ident>')
    @require_google_identity
    @saved_errors('location')
    def get_saved_location(ident):
        _no_arguments()
        ident = _path_id(ident)
        stored = store.get_location(g.principal.owner_id, ident)
        return private_json({'status': 'success', 'location': _public_record(stored, ident)})

    @app.delete('/saved-locations/<ident>')
    @require_google_identity
    @saved_errors('location')
    def delete_saved_location(ident):
        _no_arguments('INVALID_DELETE_REQUEST')
        ident = _path_id(ident)
        removed = store.delete_location(g.principal.owner_id, ident)
        if type(removed) is not bool:
            raise StoreCorrupt()
        if not removed:
            raise SavedNotFound()
        return private_json({}, 204)
