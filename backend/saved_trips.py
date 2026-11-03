"""Private immutable trip references; provider geometry stays outside persistence."""
from datetime import datetime
import re

from flask import g, request

from .auth import require_google_identity
from .saved_api import (SavedRequestError, canonical_uuid, decode_trip_cursor,
                        encode_trip_cursor, parse_stamp, place_source, private_json,
                        read_object, saved_errors, text)
from .saved_store import SavedNotFound, StoreCorrupt

MAX_BODY_BYTES = 65536
MAX_DRIVERS = 64
MAX_PASSENGERS = 256
_STOP_ID = re.compile(r"[A-Za-z0-9_-]{1,64}")
_ARRIVE_BY = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}")


class UnsupportedSnapshotVersion(ValueError):
    pass


def _fields(value, required, optional=()):
    if not isinstance(value, dict) or not set(required) <= set(value) <= set(required) | set(optional):
        raise ValueError()


def _stop_id(value):
    if not isinstance(value, str) or not _STOP_ID.fullmatch(value):
        raise ValueError()
    return value


def _arrive_by(value):
    """Wall-clock time at the destination, with no zone, so every device shows the same digits."""
    if not isinstance(value, str) or not _ARRIVE_BY.fullmatch(value):
        raise ValueError()
    moment = datetime.strptime(value, '%Y-%m-%dT%H:%M')
    if moment.strftime('%Y-%m-%dT%H:%M') != value or not 2000 <= moment.year <= 2100:
        raise ValueError()
    return value


def _point(value, driver=False, person=True):
    _fields(value, {'stop_id', 'source', 'capacity'} if driver else {'stop_id', 'source'},
            {'label', 'location_id', 'person'} if person else {'label', 'location_id'})
    result = {'stop_id': _stop_id(value['stop_id']),
              'label': text(value.get('label', ''), 1000, 1000, allow_empty=True),
              'source': place_source(value['source'])}
    if 'location_id' in value:
        # A stop picked from My locations follows that location; absent on older trips.
        result['location_id'] = canonical_uuid(value['location_id'])
    if 'person' in value:
        # Who is driven or picked up here, for this trip only; the place keeps its own label.
        result['person'] = text(value['person'], 80, 320)
    if driver:
        capacity = value['capacity']
        if type(capacity) is not int or capacity <= 0:
            raise ValueError()
        result['capacity'] = capacity
    return result


def validate_snapshot(value):
    """Return detached canonical references after linear occurrence/route checks."""
    _fields(value, {'schema_version', 'inputs', 'routes'})
    if type(value['schema_version']) is not int:
        raise ValueError()
    if value['schema_version'] != 1:
        raise UnsupportedSnapshotVersion()
    inputs = value['inputs']
    _fields(inputs, {'drivers', 'passengers', 'destination'}, {'arrive_by'})
    drivers, passengers = inputs['drivers'], inputs['passengers']
    if (not isinstance(drivers, list) or not 1 <= len(drivers) <= MAX_DRIVERS
            or not isinstance(passengers, list) or not 1 <= len(passengers) <= MAX_PASSENGERS):
        raise ValueError()
    drivers = [_point(row, driver=True) for row in drivers]
    passengers = [_point(row) for row in passengers]
    destination = _point(inputs['destination'], person=False)
    all_ids = [row['stop_id'] for row in drivers + passengers + [destination]]
    if len(set(all_ids)) != len(all_ids) or sum(row['capacity'] for row in drivers) < len(passengers):
        raise ValueError()
    routes = value['routes']
    if not isinstance(routes, list) or len(routes) != len(drivers):
        raise ValueError()
    passenger_ids = {row['stop_id'] for row in passengers}
    seen = set()
    normalized_routes = []
    for driver, route in zip(drivers, routes):
        _fields(route, {'driver_id', 'stop_ids'})
        driver_id = _stop_id(route['driver_id'])
        stops = route['stop_ids']
        if (driver_id != driver['stop_id'] or not isinstance(stops, list)
                or not 2 <= len(stops) <= MAX_PASSENGERS + 2):
            raise ValueError()
        stops = [_stop_id(stop) for stop in stops]
        if stops[0] != driver_id or stops[-1] != destination['stop_id'] or len(stops) - 2 > driver['capacity']:
            raise ValueError()
        for stop in stops[1:-1]:
            if stop not in passenger_ids or stop in seen:
                raise ValueError()
            seen.add(stop)
        normalized_routes.append({'driver_id': driver_id, 'stop_ids': stops})
    if seen != passenger_ids:
        raise ValueError()
    normalized_inputs = {'drivers': drivers, 'passengers': passengers, 'destination': destination}
    if 'arrive_by' in inputs:
        normalized_inputs['arrive_by'] = _arrive_by(inputs['arrive_by'])
    return {'schema_version': 1, 'inputs': normalized_inputs, 'routes': normalized_routes}


def _create_record(value):
    _fields(value, {'id', 'title', 'snapshot'})
    return {'id': canonical_uuid(value['id']), 'title': text(value['title'], 200, 200),
            'snapshot': validate_snapshot(value['snapshot'])}


def _edited(value):
    """The optional last-edit time: a trip saved before edit times has none, and an edit never precedes creation."""
    if 'updated_at' not in value:
        return {}
    if parse_stamp(value['updated_at']) < parse_stamp(value['created_at']):
        raise ValueError()
    return {'updated_at': value['updated_at']}


def _public_record(value, expected_id=None):
    try:
        _fields(value, {'id', 'title', 'created_at', 'snapshot'}, {'updated_at'})
        record = _create_record({key: value[key] for key in ('id', 'title', 'snapshot')})
        encode_trip_cursor((value['created_at'], record['id']))
        if expected_id is not None and record['id'] != expected_id:
            raise ValueError()
        # Stored canonical content is never silently normalized/repaired on load.
        if record != {key: value[key] for key in ('id', 'title', 'snapshot')}:
            raise ValueError()
        return dict(record, created_at=value['created_at'], **_edited(value))
    except (ValueError, TypeError, KeyError):
        raise StoreCorrupt() from None


def _summary(value):
    try:
        _fields(value, {'id', 'title', 'created_at', 'schema_version', 'driver_count', 'passenger_count'}, {'arrive_by', 'updated_at'})
        ident = canonical_uuid(value['id'])
        if 'arrive_by' in value:
            _arrive_by(value['arrive_by'])
        title = text(value['title'], 200, 200)
        encode_trip_cursor((value['created_at'], ident))
        _edited(value)
        if (title != value['title'] or type(value['schema_version']) is not int or value['schema_version'] != 1
                or type(value['driver_count']) is not int or not 1 <= value['driver_count'] <= MAX_DRIVERS
                or type(value['passenger_count']) is not int or not 1 <= value['passenger_count'] <= MAX_PASSENGERS):
            raise ValueError()
        return {**value}
    except (ValueError, TypeError, KeyError):
        raise StoreCorrupt() from None


def _no_payload(code, allowed_query=()):
    if request.stream.read(1) or not set(request.args) <= set(allowed_query):
        raise SavedRequestError(400, code, 'Invalid saved-trip request.')
    if any(len(request.args.getlist(key)) != 1 for key in request.args):
        raise SavedRequestError(400, code, 'Invalid saved-trip request.')


def register_saved_trip_routes(app, store):
    """Register with an injected owner-scoped store; no client/credential discovery."""
    @app.post('/saved-trips')
    @require_google_identity
    @saved_errors('trip')
    def create_saved_trip():
        if request.args:
            raise SavedRequestError(400, 'INVALID_SAVE_REQUEST', 'Invalid saved-trip request.')
        value = read_object(MAX_BODY_BYTES, 'INVALID_SAVE_REQUEST')
        try:
            _fields(value, {'id', 'title', 'snapshot'})
            ident = canonical_uuid(value['id'])
            title = text(value['title'], 200, 200)
        except ValueError:
            raise SavedRequestError(400, 'INVALID_SAVE_REQUEST', 'Invalid saved-trip request.') from None
        try:
            snapshot = validate_snapshot(value['snapshot'])
        except UnsupportedSnapshotVersion:
            raise SavedRequestError(400, 'UNSUPPORTED_SNAPSHOT_VERSION', 'Unsupported trip snapshot version.') from None
        except ValueError:
            raise SavedRequestError(400, 'INVALID_SNAPSHOT', 'Invalid trip snapshot.') from None
        record, created = store.create_trip(g.principal.owner_id, {'id': ident, 'title': title, 'snapshot': snapshot})
        if type(created) is not bool:
            raise StoreCorrupt()
        public = _public_record(record, ident)
        if public['title'] != title or public['snapshot'] != snapshot:
            raise StoreCorrupt()
        return private_json({'trip': public}, 201 if created else 200)

    @app.get('/saved-trips')
    @require_google_identity
    @saved_errors('trip')
    def list_saved_trips():
        _no_payload('INVALID_LIST_REQUEST', {'limit', 'cursor'})
        try:
            raw_limit = request.args.get('limit', '50')
            if not re.fullmatch(r'[1-9][0-9]{0,2}', raw_limit):
                raise ValueError()
            limit = int(raw_limit)
            if limit > 100:
                raise ValueError()
            cursor = decode_trip_cursor(request.args['cursor']) if 'cursor' in request.args else None
        except ValueError:
            raise SavedRequestError(400, 'INVALID_LIST_REQUEST', 'Invalid saved-trip list request.') from None
        rows, next_cursor = store.list_trips(g.principal.owner_id, limit, cursor)
        if not isinstance(rows, list) or len(rows) > limit:
            raise StoreCorrupt()
        summaries = [_summary(row) for row in rows]
        try:
            if next_cursor is not None:
                if not summaries or tuple(next_cursor) != (summaries[-1]['created_at'], summaries[-1]['id']):
                    raise ValueError()
                next_cursor = encode_trip_cursor(next_cursor)
        except (ValueError, TypeError):
            raise StoreCorrupt() from None
        return private_json({'trips': summaries, 'next_cursor': next_cursor})

    @app.get('/saved-trips/<ident>')
    @require_google_identity
    @saved_errors('trip')
    def load_saved_trip(ident):
        _no_payload('INVALID_SAVE_REQUEST')
        try:
            canonical_uuid(ident)
        except ValueError:
            raise SavedNotFound() from None
        return private_json({'trip': _public_record(store.get_trip(g.principal.owner_id, ident), ident)})

    @app.patch('/saved-trips/<ident>')
    @require_google_identity
    @saved_errors('trip')
    def update_saved_trip(ident):
        if request.args:
            raise SavedRequestError(400, 'INVALID_SAVE_REQUEST', 'Invalid saved-trip request.')
        value = read_object(MAX_BODY_BYTES, 'INVALID_SAVE_REQUEST')
        changes = {}
        try:
            if not value or not set(value) <= {'title', 'snapshot'}:
                raise ValueError()
            if 'title' in value:
                changes['title'] = text(value['title'], 200, 200)
        except ValueError:
            raise SavedRequestError(400, 'INVALID_SAVE_REQUEST', 'Invalid saved-trip request.') from None
        if 'snapshot' in value:
            try:
                changes['snapshot'] = validate_snapshot(value['snapshot'])
            except UnsupportedSnapshotVersion:
                raise SavedRequestError(400, 'UNSUPPORTED_SNAPSHOT_VERSION', 'Unsupported trip snapshot version.') from None
            except ValueError:
                raise SavedRequestError(400, 'INVALID_SNAPSHOT', 'Invalid trip snapshot.') from None
        try:
            canonical_uuid(ident)
        except ValueError:
            raise SavedNotFound() from None
        # The later write wins: there is no revision check, and a repeated PATCH yields the same trip.
        public = _public_record(store.update_trip(g.principal.owner_id, ident, changes), ident)
        if any(public[key] != value for key, value in changes.items()):
            raise StoreCorrupt()
        return private_json({'trip': public})

    @app.delete('/saved-trips/<ident>')
    @require_google_identity
    @saved_errors('trip')
    def delete_saved_trip(ident):
        _no_payload('INVALID_SAVE_REQUEST')
        try:
            canonical_uuid(ident)
        except ValueError:
            return private_json(None, 204)
        removed = store.delete_trip(g.principal.owner_id, ident)
        if type(removed) is not bool:
            raise StoreCorrupt()
        return private_json(None, 204)
