"""Account-scoped Firestore persistence. Runtime credentials stay on the server."""
import copy
import hashlib
import json
import threading
import unicodedata
import uuid
import re
from datetime import datetime, timezone
from google.api_core.exceptions import GoogleAPICallError, RetryError
from google.auth.exceptions import GoogleAuthError
from google.cloud import firestore
from google.cloud.firestore_v1.field_path import FieldPath


class SavedNotFound(Exception): pass
class StoreUnavailable(Exception): pass
class StoreCorrupt(Exception): pass
class SaveConflict(Exception):
    def __init__(self, kind, existing_id=None):
        self.kind, self.existing_id = kind, existing_id


def _canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False, allow_nan=False)


def _stamp(value):
    if not isinstance(value, datetime) or value.tzinfo is None or value.utcoffset().total_seconds() != 0:
        raise StoreCorrupt()
    if getattr(value, 'nanosecond', value.microsecond * 1000) % 1000:
        raise StoreCorrupt()
    return value.isoformat(timespec='microseconds').replace('+00:00', 'Z')


def _label_key(label):
    return unicodedata.normalize('NFC', label).casefold()


def _reservation_key(label):
    # User labels are values, never Firestore field names (which reserve __.*__).
    return hashlib.sha256(_label_key(label).encode('utf-8')).hexdigest()


class FirestoreSavedStore:
    """Injected SDK clients enable emulator tests without opening ADC credentials."""
    def __init__(self, client=None, project=None, database='(default)', clock=None, credentials=None):
        self._client = client
        self.project, self.database, self.credentials = project, database, credentials
        self.clock = clock or (lambda: datetime.now(timezone.utc))
        self._lock = threading.Lock()

    @property
    def client(self):
        if self._client is None:
            if not self.project:
                raise StoreUnavailable()
            with self._lock:
                if self._client is None:
                    try:
                        self._client = firestore.Client(project=self.project, database=self.database, credentials=self.credentials)
                    except (GoogleAuthError, GoogleAPICallError, ValueError):
                        raise StoreUnavailable() from None
        return self._client

    def _account(self, owner):
        if not isinstance(owner, str) or not owner.startswith('google:') or not owner[7:]:
            raise ValueError('verified owner is required')
        key = hashlib.sha256(owner.encode('utf-8')).hexdigest()
        return self.client.collection('vroommates_accounts').document(key)

    def _call(self, action):
        try:
            return action()
        except (SavedNotFound, StoreCorrupt, SaveConflict, StoreUnavailable):
            raise
        except (GoogleAPICallError, RetryError, GoogleAuthError):
            raise StoreUnavailable() from None
        except ValueError as exc:
            # SDK's transaction wrapper raises ValueError after bounded contention retries.
            if isinstance(exc.__cause__, GoogleAPICallError):
                raise StoreUnavailable() from None
            raise

    def _transaction(self, callback):
        return self._call(lambda: firestore.transactional(callback)(self.client.transaction(max_attempts=5)))

    @staticmethod
    def _get(ref, transaction=None):
        return ref.get(transaction=transaction, retry=None, timeout=5)

    @staticmethod
    def _trip(snapshot):
        if not snapshot.exists:
            raise SavedNotFound()
        raw = snapshot.to_dict()
        try:
            if raw['schema_version'] != 1 or type(raw['schema_version']) is not int:
                raise ValueError()
            decoded = json.loads(raw['snapshot_json'])
            if not isinstance(decoded, dict): raise ValueError()
            return {'id': snapshot.id, 'title': raw['title'], 'created_at': _stamp(raw['created_at']), 'snapshot': decoded}
        except (KeyError, TypeError, ValueError, RecursionError):
            raise StoreCorrupt() from None

    @staticmethod
    def _location(snapshot):
        if not snapshot.exists:
            raise SavedNotFound()
        raw = snapshot.to_dict()
        try:
            if set(raw) != {'label', 'source', 'schema_version', 'created_at', 'updated_at'} or raw['schema_version'] != 1 or type(raw['schema_version']) is not int:
                raise ValueError()
            label, source = raw['label'], raw['source']
            if (not isinstance(label, str) or not label or label != unicodedata.normalize('NFC', label).strip()
                    or len(label) > 80 or len(label.encode('utf-8')) > 320
                    or any(unicodedata.category(c).startswith('C') for c in label)):
                raise ValueError()
            if not isinstance(source, dict) or set(source) != {'kind', 'place_id'} or source['kind'] != 'google_places':
                raise ValueError()
            place_id = source['place_id']
            if (not isinstance(place_id, str) or not place_id or len(place_id.encode('utf-8')) > 4096
                    or any(c.isspace() or unicodedata.category(c).startswith('C') for c in place_id)):
                raise ValueError()
            if raw['updated_at'] < raw['created_at']:
                raise ValueError()
            return {'id': snapshot.id, 'label': raw['label'], 'source': copy.deepcopy(raw['source']), 'schema_version': 1,
                    'created_at': _stamp(raw['created_at']), 'updated_at': _stamp(raw['updated_at'])}
        except (KeyError, TypeError, ValueError):
            raise StoreCorrupt() from None

    def create_trip(self, owner, record):
        record = copy.deepcopy(record)
        ref = self._account(owner).collection('trips').document(record['id'])
        stamp = self.clock()
        encoded = _canonical(record['snapshot'])
        def create(tx):
            found = self._get(ref, tx)
            if found.exists:
                existing = self._trip(found)
                if _canonical({k: existing[k] for k in ('id', 'title', 'snapshot')}) != _canonical(record):
                    raise SaveConflict('record')
                return existing, False
            inputs = record['snapshot']['inputs']
            raw = {'title': record['title'], 'created_at': stamp, 'snapshot_json': encoded, 'schema_version': 1,
                   'driver_count': len(inputs['drivers']), 'passenger_count': len(inputs['passengers'])}
            tx.create(ref, raw)
            return dict(record, created_at=_stamp(stamp)), True
        return self._transaction(create)

    def update_trip(self, owner, ident, changes):
        changes = copy.deepcopy(changes)
        ref = self._account(owner).collection('trips').document(ident)
        def update(tx):
            existing = self._trip(self._get(ref, tx))
            raw = {}
            if 'title' in changes:
                raw['title'] = changes['title']
            if 'snapshot' in changes:
                inputs = changes['snapshot']['inputs']
                raw.update(snapshot_json=_canonical(changes['snapshot']), driver_count=len(inputs['drivers']),
                           passenger_count=len(inputs['passengers']))
            tx.update(ref, raw)
            return dict(existing, **changes)
        return self._transaction(update)

    def get_trip(self, owner, ident):
        ref = self._account(owner).collection('trips').document(ident)
        return self._call(lambda: self._trip(self._get(ref)))

    def list_trips(self, owner, limit, cursor=None):
        collection = self._account(owner).collection('trips')
        query = collection.select(['title', 'created_at', 'schema_version', 'driver_count', 'passenger_count'])
        query = query.order_by('created_at', direction=firestore.Query.DESCENDING).order_by(FieldPath.document_id(), direction=firestore.Query.DESCENDING)
        if cursor:
            stamp, ident = cursor
            query = query.start_after({'created_at': datetime.fromisoformat(stamp.replace('Z', '+00:00')), '__name__': collection.document(ident)})
        def read():
            rows = list(query.limit(limit + 1).stream(retry=None, timeout=5))
            result = []
            for row in rows[:limit]:
                raw = row.to_dict()
                try:
                    summary = {k: raw[k] for k in ('title', 'schema_version', 'driver_count', 'passenger_count')}
                    if type(summary['schema_version']) is not int or summary['schema_version'] != 1: raise ValueError()
                    summary.update(id=row.id, created_at=_stamp(raw['created_at']))
                except (KeyError, TypeError, ValueError):
                    raise StoreCorrupt() from None
                result.append(summary)
            next_cursor = (result[-1]['created_at'], result[-1]['id']) if len(rows) > limit and result else None
            return result, next_cursor
        return self._call(read)

    def delete_trip(self, owner, ident):
        ref = self._account(owner).collection('trips').document(ident)
        def delete(tx):
            exists = self._get(ref, tx).exists
            if exists: tx.delete(ref)
            return exists
        return self._transaction(delete)

    @staticmethod
    def _metadata(snapshot):
        raw = snapshot.to_dict() if snapshot.exists else {'schema_version': 1, 'location_labels': {}, 'location_count': 0}
        try:
            labels, count = raw['location_labels'], raw['location_count']
            if type(raw['schema_version']) is not int or raw['schema_version'] != 1 or not isinstance(labels, dict) or type(count) is not int or not 0 <= count <= 100 or count != len(labels):
                raise ValueError()
            if not all(isinstance(k, str) and isinstance(v, str) for k, v in labels.items()): raise ValueError()
            for key, ident in labels.items():
                parsed = uuid.UUID(ident)
                if parsed.version != 4 or parsed.variant != uuid.RFC_4122 or str(parsed) != ident:
                    raise ValueError()
                if not re.fullmatch(r'[0-9a-f]{64}', key):
                    raise ValueError()
            return labels, count
        except (KeyError, TypeError, ValueError):
            raise StoreCorrupt() from None

    def create_location(self, owner, record):
        record = copy.deepcopy(record)
        account = self._account(owner)
        ref = account.collection('locations').document(record['id'])
        stamp, key = self.clock(), _reservation_key(record['label'])
        def create(tx):
            found = self._get(ref, tx)
            if found.exists:
                existing = self._location(found)
                if _canonical({k: existing[k] for k in ('id', 'label', 'source')}) != _canonical(record):
                    raise SaveConflict('record')
                return existing, False
            labels, count = self._metadata(self._get(account, tx))
            if key in labels: raise SaveConflict('label', labels[key])
            if count >= 100: raise SaveConflict('limit')
            labels[key] = record['id']
            raw = {'label': record['label'], 'source': record['source'], 'schema_version': 1, 'created_at': stamp, 'updated_at': stamp}
            tx.create(ref, raw)
            tx.set(account, {'schema_version': 1, 'location_labels': labels, 'location_count': count + 1}, merge=['schema_version', 'location_labels', 'location_count'])
            return dict(record, schema_version=1, created_at=_stamp(stamp), updated_at=_stamp(stamp)), True
        return self._transaction(create)

    def update_location(self, owner, ident, changes):
        changes = copy.deepcopy(changes)
        account = self._account(owner)
        ref = account.collection('locations').document(ident)
        now = self.clock()
        def update(tx):
            found = self._get(ref, tx)
            record = self._location(found)
            old_key = _reservation_key(record['label'])
            new_key = _reservation_key(changes.get('label', record['label']))
            labels = None
            if new_key != old_key:
                labels, count = self._metadata(self._get(account, tx))
                if labels.get(old_key) != ident: raise StoreCorrupt()
                if new_key in labels: raise SaveConflict('label', labels[new_key])
                del labels[old_key]
                labels[new_key] = ident
            # Never record an edit as earlier than the creation or the last edit, even if clocks disagree.
            stored = found.to_dict()
            stamp = max(now, stored['created_at'], stored['updated_at'])
            tx.update(ref, dict(changes, updated_at=stamp))
            if labels is not None:
                tx.set(account, {'schema_version': 1, 'location_labels': labels, 'location_count': count},
                       merge=['schema_version', 'location_labels', 'location_count'])
            return dict(record, **changes, updated_at=_stamp(stamp))
        return self._transaction(update)

    def get_location(self, owner, ident):
        ref = self._account(owner).collection('locations').document(ident)
        return self._call(lambda: self._location(self._get(ref)))

    def list_locations(self, owner):
        collection = self._account(owner).collection('locations')
        def read():
            rows = list(collection.limit(101).stream(retry=None, timeout=5))
            if len(rows) > 100: raise StoreCorrupt()
            result = [self._location(row) for row in rows]
            try:
                return sorted(result, key=lambda row: (_label_key(row['label']), row['id']))
            except (KeyError, TypeError):
                raise StoreCorrupt() from None
        return self._call(read)

    def delete_location(self, owner, ident):
        account = self._account(owner)
        ref = account.collection('locations').document(ident)
        def delete(tx):
            found = self._get(ref, tx)
            if not found.exists: return False
            record = self._location(found)
            labels, count = self._metadata(self._get(account, tx))
            key = _reservation_key(record['label'])
            if count <= 0 or labels.get(key) != ident: raise StoreCorrupt()
            del labels[key]
            tx.delete(ref)
            tx.set(account, {'schema_version': 1, 'location_labels': labels, 'location_count': count - 1}, merge=['schema_version', 'location_labels', 'location_count'])
            return True
        return self._transaction(delete)
