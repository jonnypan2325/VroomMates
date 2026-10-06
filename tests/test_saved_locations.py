"""Synthetic real-RSA HTTP contract proof; the fixture store is NOT durability proof."""
import copy
import json
import unittest
import uuid
from datetime import datetime, timezone
from unittest.mock import patch

# Patch dotenv before importing backend or any helper that imports it.
with patch('dotenv.load_dotenv', return_value=False):
    from backend import create_app
    from backend.saved_store import SaveConflict, SavedNotFound, StoreCorrupt, StoreUnavailable
    from tests import test_auth as auth_fixture

STAMP = '2030-03-17T17:46:40.000000Z'
A = 'google:synthetic-account-a'
B = 'google:synthetic-account-b'


def record(ident=None, label='Friend pickup', place_id='synthetic-place-id-1'):
    return {'id': ident or str(uuid.uuid4()), 'label': label,
            'source': {'kind': 'google_places', 'place_id': place_id}}


class FixtureStore:
    """Request-local owner assertions and injected outcomes, no provider/DB connection."""
    def __init__(self):
        self.rows = {}
        self.calls = []
        self.error = None

    def call(self, operation, owner):
        self.calls.append((operation, owner))
        if self.error:
            raise self.error

    def create_location(self, owner, value):
        self.call('create', owner)
        key = (owner, value['id'])
        if key in self.rows:
            found = self.rows[key]
            if {k: found[k] for k in ('id', 'label', 'source')} != value:
                raise SaveConflict('record')
            return copy.deepcopy(found), False
        owned = [v for (o, _), v in self.rows.items() if o == owner]
        for found in owned:
            if found['label'].casefold() == value['label'].casefold():
                raise SaveConflict('label', found['id'])
        if len(owned) >= 100:
            raise SaveConflict('limit')
        saved = dict(copy.deepcopy(value), schema_version=1, created_at=STAMP, updated_at=STAMP)
        self.rows[key] = saved
        return copy.deepcopy(saved), True

    def list_locations(self, owner):
        self.call('list', owner)
        return [copy.deepcopy(v) for (o, _), v in self.rows.items() if o == owner]

    def get_location(self, owner, ident):
        self.call('get', owner)
        if (owner, ident) not in self.rows:
            raise SavedNotFound()
        return copy.deepcopy(self.rows[(owner, ident)])

    def delete_location(self, owner, ident):
        self.call('delete', owner)
        return self.rows.pop((owner, ident), None) is not None


class SavedLocationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        auth_fixture.AuthTests.setUpClass()
        cls.key = auth_fixture.AuthTests.key
        cls.other_key = auth_fixture.AuthTests.other_key
        cls.certificate = auth_fixture.AuthTests.certificate

    def setUp(self):
        self.clock = auth_fixture.NOW
        self.transport = auth_fixture.CertificateTransport({'fixture-key': self.certificate})
        self.store = FixtureStore()
        self.app = create_app({'TESTING': True, 'GOOGLE_CLIENT_ID': auth_fixture.AUDIENCE,
                               'GOOGLE_CERTIFICATE_REQUEST': self.transport,
                               'AUTH_CLOCK': lambda: self.clock,
                               'CORS_ALLOWED_ORIGINS': ['https://synthetic.example'],
                               'SAVED_DATA_STORE': self.store})
        self.client = self.app.test_client()
        time_patch = patch('google.auth._helpers.utcnow', side_effect=lambda: datetime.fromtimestamp(
            self.clock, timezone.utc).replace(tzinfo=None))
        time_patch.start()
        self.addCleanup(time_patch.stop)

    def token(self, changes=None, key=None):
        return auth_fixture.AuthTests.token(self, auth_fixture.claims(**(changes or {})), key=key)

    def send(self, method, path='/saved-locations', account='a', **kwargs):
        headers = dict(kwargs.pop('headers', {}))
        if account is not None:
            headers.setdefault('Authorization', 'Bearer ' + self.token({'sub': 'synthetic-account-' + account}))
        response = self.client.open(path, method=method, headers=headers, **kwargs)
        self.assertEqual(response.headers.get('Cache-Control'), 'no-store')
        return response

    def error(self, response, status, code):
        self.assertEqual(response.status_code, status)
        self.assertEqual(response.json['code'], code)
        self.assertIsInstance(response.json['error'], str)

    def create(self, value=None, account='a'):
        value = value or record()
        response = self.send('POST', json=value, account=account)
        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.headers['Location'], '/saved-locations/' + value['id'])
        return value, response.json['location']

    def test_owner_isolation_and_client_uuid_collision(self):
        value, public = self.create()
        self.assertEqual(public, dict(value, schema_version=1, created_at=STAMP, updated_at=STAMP,
                                      resolution_required=True))
        self.assertNotIn('owner', public)
        self.assertNotIn('address', public)
        self.assertNotIn('coordinates', public)
        path = '/saved-locations/' + value['id']
        self.error(self.send('GET', path, account='b'), 404, 'LOCATION_NOT_FOUND')
        self.error(self.send('DELETE', path, account='b'), 404, 'LOCATION_NOT_FOUND')
        self.assertEqual(self.send('GET', account='b').json['locations'], [])
        self.assertEqual(self.send('POST', json=value, account='b').status_code, 201)
        self.assertEqual(self.send('DELETE', path, account='b').status_code, 204)
        self.assertEqual(self.send('GET', path).status_code, 200)
        self.assertEqual({owner for _, owner in self.store.calls}, {A, B})

    def test_replay_normalization_conflicts_and_label_duplicate(self):
        value = record(label='  Cafe\u0301 pickup  ')
        response = self.send('POST', json=value)
        self.assertEqual(response.status_code, 201)
        ident = value['id']
        value['label'] = 'Caf\u00e9 pickup'
        replay = self.send('POST', json=value)
        self.assertEqual(replay.status_code, 200)
        self.assertEqual(replay.json, response.json)
        changed = dict(value, source={'kind': 'google_places', 'place_id': 'synthetic-other-id'})
        self.error(self.send('POST', json=changed), 409, 'LOCATION_EXISTS')
        duplicate = record(label='CAF\u00c9 PICKUP')
        conflict = self.send('POST', json=duplicate)
        self.error(conflict, 409, 'LABEL_EXISTS')
        self.assertEqual(conflict.json['existing_location_id'], ident)
        self.assertEqual(self.send('POST', json=record(label='Other friend')).status_code, 201)
        self.assertEqual(len(self.send('GET').json['locations']), 2)

    def test_list_is_sorted_and_empty_is_success(self):
        self.assertEqual(self.send('GET').json, {'status': 'success', 'locations': []})
        for label in ['Zulu', 'alpha', 'Bravo']:
            self.create(record(label=label))
        self.assertEqual([row['label'] for row in self.send('GET').json['locations']], ['alpha', 'Bravo', 'Zulu'])

    def test_delete_frees_private_item_and_missing_foreign_match(self):
        value, _ = self.create()
        path = '/saved-locations/' + value['id']
        before = self.send('GET', '/saved-locations/' + str(uuid.uuid4()))
        foreign = self.send('GET', path, account='b')
        self.assertEqual(before.json, foreign.json)
        self.assertEqual(self.send('DELETE', path).status_code, 204)
        self.assertEqual(self.send('GET').json['locations'], [])
        self.error(self.send('GET', path), 404, 'LOCATION_NOT_FOUND')
        self.error(self.send('DELETE', path), 404, 'LOCATION_NOT_FOUND')
        self.create(record(label=value['label']))

    def test_quota_and_replay_at_quota(self):
        for index in range(100):
            self.create(record(label=f'Friend {index:03d}'))
        self.error(self.send('POST', json=record(label='Friend 101')), 409, 'LOCATION_LIMIT')
        first = next(iter(self.store.rows.values()))
        self.assertEqual(self.send('POST', json={k: first[k] for k in ('id', 'label', 'source')}).status_code, 200)
        self.assertEqual(self.send('POST', json=record(label='Friend 101'), account='b').status_code, 201)

    def test_all_operations_require_valid_real_google_proof_before_store(self):
        ident = str(uuid.uuid4())
        requests = [('POST', '/saved-locations'), ('GET', '/saved-locations'),
                    ('GET', '/saved-locations/' + ident), ('DELETE', '/saved-locations/' + ident)]
        for method, path in requests:
            with self.subTest(method=method, path=path):
                self.error(self.send(method, path, account=None), 401, 'AUTH_REQUIRED')
                invalid = self.token(key=self.other_key)
                self.error(self.send(method, path, headers={'Authorization': 'Bearer ' + invalid}),
                           401, 'INVALID_CREDENTIAL')
        self.assertEqual(self.store.calls, [])

    def test_wrong_audience_expiry_and_identity_outage(self):
        for changes in [{'aud': 'wrong-audience'}, {'iss': 'https://wrong.invalid'},
                        {'exp': self.clock}, {'sub': ''}]:
            self.error(self.send('POST', json=record(), headers={'Authorization': 'Bearer ' + self.token(changes)}),
                       401, 'INVALID_CREDENTIAL')
        self.transport.available = False
        self.error(self.send('GET'), 503, 'AUTH_UNAVAILABLE')
        self.assertEqual(self.store.calls, [])

    def test_same_verified_subject_changed_profile_preserves_owner(self):
        value, _ = self.create()
        token = self.token({'email': 'changed@example.invalid', 'given_name': 'Changed', 'iss': 'accounts.google.com'})
        self.assertEqual(self.send('GET', '/saved-locations/' + value['id'], headers={'Authorization': 'Bearer ' + token}).status_code, 200)
        self.assertEqual(self.store.calls[-1][1], A)

    def test_request_bounds_and_unknowns_do_not_touch_store(self):
        good = record()
        invalid = [None, [], {}, dict(good, owner=B), dict(good, user_id=B), dict(good, email='x'),
                   dict(good, schema_version=1), dict(good, updated_at=STAMP), dict(good, name='provider'),
                   dict(good, label=''), dict(good, label='  '), dict(good, label='x'*81),
                   dict(good, label='a\nsecret'), dict(good, label='\nleading-control'),
                   dict(good, label='trailing-control\n'), dict(good, label='\ud800'),
                   dict(good, id=str(uuid.uuid1())), dict(good, id=good['id'].upper()),
                   dict(good, id=True), dict(good, id=good['id'].replace('-', '')),
                   dict(good, source={'kind': 'manual'}), dict(good, source={'kind': 'google_places'}),
                   dict(good, source={'kind': 'google_places', 'place_id': ''}),
                   dict(good, source={'kind': 'google_places', 'place_id': 1}),
                   dict(good, source={'kind': 'google_places', 'place_id': 'a b'}),
                   dict(good, source={'kind': 'google_places', 'place_id': ' leading'}),
                   dict(good, source={'kind': 'google_places', 'place_id': 'a\n'}),
                   dict(good, source={'kind': 'google_places', 'place_id': '\ud800'}),
                   dict(good, source={'kind': 'google_places', 'place_id': 'x'*4097}),
                   dict(good, source={'kind': 'google_places', 'place_id': '\U0001f600'*1025}),
                   dict(good, source={**good['source'], 'name': 'provider'})]
        for index, value in enumerate(invalid):
            with self.subTest(case=index):
                self.error(self.send('POST', data=json.dumps(value), content_type='application/json'), 400, 'INVALID_LOCATION')
        for field in ('address', 'coordinates', 'geometry'):
            self.error(self.send('POST', json=dict(good, **{field: 'provider'})), 400, 'PROVIDER_DATA_NOT_STORABLE')
        self.assertEqual(self.store.calls, [])

    def test_exact_bounds_and_place_id_is_preserved(self):
        source_id = 'opaque\u0065\u0301:' + 'x'*4085
        self.assertLessEqual(len(source_id.encode()), 4096)
        value, result = self.create(record(label='\U0001f600'*80, place_id=source_id))
        self.assertEqual(result['source']['place_id'], source_id)
        self.assertEqual(len(result['label'].encode()), 320)
        self.create(record(label='Exact ID bound', place_id='x'*4096))

    def test_strict_json_body_size_encoding_and_media(self):
        bad_bodies = ['null', '[]', '', '{"id":"x","id":"y"}', '{"x":NaN}', '{"x":Infinity}',
                      '{"x":-Infinity}', '['*25+']'*25, '{"x":'+('['*25)+(']'*25)+'}']
        for body in bad_bodies:
            self.error(self.send('POST', data=body, content_type='application/json'), 400, 'INVALID_LOCATION')
        self.error(self.send('POST', data=b'\xff', content_type='application/json'), 400, 'INVALID_LOCATION')
        self.error(self.send('POST', data='x'*16385, content_type='application/json'), 413, 'PAYLOAD_TOO_LARGE')
        self.error(self.send('POST', data=json.dumps(record()), content_type='text/plain'), 415, 'UNSUPPORTED_MEDIA_TYPE')
        self.error(self.send('POST', data=json.dumps(record()), content_type='application/json', headers={'Content-Encoding': 'gzip'}),
                   415, 'UNSUPPORTED_MEDIA_TYPE')
        self.assertEqual(self.store.calls, [])

    def test_query_body_rejection_and_bad_path_ids(self):
        value, _ = self.create()
        path = '/saved-locations/' + value['id']
        before = len(self.store.calls)
        for method, endpoint in [('POST', '/saved-locations'), ('GET', '/saved-locations'), ('GET', path), ('DELETE', path)]:
            self.error(self.send(method, endpoint+'?owner=spoof', json=record() if method == 'POST' else None), 400, 'INVALID_QUERY')
        for method, endpoint in [('GET', '/saved-locations'), ('GET', path), ('DELETE', path)]:
            code = 'INVALID_DELETE_REQUEST' if method == 'DELETE' else 'INVALID_LOCATION'
            self.error(self.send(method, endpoint, data=' '), 400, code)
        for ident in ['not-a-uuid', str(uuid.uuid1()), value['id'].upper()]:
            self.error(self.send('GET', '/saved-locations/'+ident), 404, 'LOCATION_NOT_FOUND')
            self.error(self.send('DELETE', '/saved-locations/'+ident), 404, 'LOCATION_NOT_FOUND')
        self.assertEqual(len(self.store.calls), before)

    def test_unavailable_and_corrupt_store_fail_closed_for_each_operation(self):
        ident = str(uuid.uuid4())
        for failure in (StoreUnavailable(), StoreCorrupt()):
            self.store.error = failure
            for method, path, kwargs in [('POST', '/saved-locations', {'json': record()}),
                                         ('GET', '/saved-locations', {}),
                                         ('GET', '/saved-locations/'+ident, {}),
                                         ('DELETE', '/saved-locations/'+ident, {})]:
                self.error(self.send(method, path, **kwargs), 503, 'STORE_UNAVAILABLE')

    def test_persisted_schema_validation_prevents_provider_content_leak(self):
        value, _ = self.create()
        key = (A, value['id'])
        good = copy.deepcopy(self.store.rows[key])
        mutations = [dict(good, address='secret-address'), dict(good, coordinates={'lat': 1, 'lng': 2}),
                     dict(good, owner=B), dict(good, schema_version=True), dict(good, schema_version=2),
                     dict(good, label=' '+good['label']), dict(good, label=3),
                     dict(good, source={'kind': 'manual'}), dict(good, created_at='invalid'),
                     dict(good, updated_at='2031-01-01T00:00:00Z'), dict(good, id=str(uuid.uuid4()))]
        for index, broken in enumerate(mutations):
            with self.subTest(case=index):
                self.store.rows[key] = broken
                response = self.send('GET', '/saved-locations/' + value['id'])
                self.error(response, 503, 'STORE_UNAVAILABLE')
                self.assertNotIn('secret-address', response.get_data(as_text=True))
        self.store.rows[key] = good
        self.assertEqual(self.send('GET', '/saved-locations/' + value['id']).status_code, 200)

    def test_create_returned_record_must_match_validated_request(self):
        value = record()
        for changes in ({'label': 'Other owner content'},
                        {'source': {'kind': 'google_places', 'place_id': 'synthetic-different-id'}},
                        {'address': 'synthetic-private-address'}):
            broken = dict(value, schema_version=1, created_at=STAMP, updated_at=STAMP, **changes)
            with patch.object(self.store, 'create_location', return_value=(broken, True)):
                response = self.send('POST', json=value)
                self.error(response, 503, 'STORE_UNAVAILABLE')
                self.assertNotIn('Other owner content', response.get_data(as_text=True))
                self.assertNotIn('synthetic-private-address', response.get_data(as_text=True))

    def test_create_status_requires_boolean_store_outcome(self):
        value = record()
        stored = dict(value, schema_version=1, created_at=STAMP, updated_at=STAMP)
        for created in (None, 0, 1, '', 'created', [], {}):
            with self.subTest(outcome=repr(created)), patch.object(
                    self.store, 'create_location', return_value=(stored, created)):
                self.error(self.send('POST', json=value), 503, 'STORE_UNAVAILABLE')

    def test_delete_status_requires_boolean_store_outcome(self):
        path = '/saved-locations/' + str(uuid.uuid4())
        for removed in (None, 0, 1, '', 'removed', [], {}):
            with self.subTest(outcome=repr(removed)), patch.object(
                    self.store, 'delete_location', return_value=removed):
                self.error(self.send('DELETE', path), 503, 'STORE_UNAVAILABLE')

    def test_invalid_persisted_list_rows_and_excess_are_unavailable(self):
        for rows in (None, {}, [None], [dict(record(), schema_version=1, created_at=STAMP, updated_at=STAMP)]*2):
            with patch.object(self.store, 'list_locations', return_value=rows):
                self.error(self.send('GET'), 503, 'STORE_UNAVAILABLE')
        with patch.object(self.store, 'list_locations', return_value=[{}]*101):
            self.error(self.send('GET'), 503, 'STORE_UNAVAILABLE')

    def test_no_store_for_unsupported_method_preflight_and_error_paths(self):
        self.assertIs(self.app.extensions['saved_data_store'], self.store)
        path = '/saved-locations/' + str(uuid.uuid4())
        unsupported = self.send('PATCH', path)
        self.error(unsupported, 405, 'METHOD_NOT_ALLOWED')
        self.assertEqual(unsupported.mimetype, 'application/json')
        self.assertIn('DELETE', unsupported.headers['Allow'])
        missing = self.send('GET', path + '/unknown-extra-segment')
        self.error(missing, 404, 'SAVED_ROUTE_NOT_FOUND')
        self.assertEqual(missing.mimetype, 'application/json')
        for method, endpoint in [('POST', '/saved-locations'), ('DELETE', path)]:
            result = self.send('OPTIONS', endpoint, account=None, headers={
                'Origin': 'https://synthetic.example', 'Access-Control-Request-Method': method,
                'Access-Control-Request-Headers': 'authorization,content-type'})
            self.assertEqual(result.status_code, 200)
            self.assertEqual(result.headers['Access-Control-Allow-Origin'], 'https://synthetic.example')
            self.assertIn(method, result.headers['Access-Control-Allow-Methods'])
            self.assertIn('authorization', result.headers['Access-Control-Allow-Headers'].lower())
            self.assertNotIn('Access-Control-Allow-Credentials', result.headers)
        rejected = self.send('OPTIONS', path, account=None, headers={
            'Origin': 'https://synthetic.example.attacker.invalid', 'Access-Control-Request-Method': 'DELETE',
            'Access-Control-Request-Headers': 'authorization,content-type'})
        self.assertNotIn('Access-Control-Allow-Origin', rejected.headers)
        self.assertEqual(self.store.calls, [])
        self.assertEqual(self.transport.calls, 0)

    def test_sensitive_validation_values_not_echoed_or_logged(self):
        marker = 'synthetic-private-place-value'
        payload = dict(record(), address=marker, owner=marker)
        with patch.object(self.app.logger, 'info') as info, patch.object(self.app.logger, 'error') as error:
            response = self.send('POST', json=payload)
            self.assertNotIn(marker, response.get_data(as_text=True))
            info.assert_not_called()
            error.assert_not_called()
