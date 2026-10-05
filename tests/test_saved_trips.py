"""Synthetic signed-owner endpoint proof. Fake store is NOT durability evidence."""
import copy
from datetime import datetime, timezone
import json
import unittest
import uuid
from unittest.mock import patch

from backend import create_app
from backend.saved_api import encode_trip_cursor
from backend.saved_store import SavedNotFound, SaveConflict, StoreCorrupt, StoreUnavailable
from backend.saved_trips import validate_snapshot
import tests.test_auth as auth_fixture

STAMP = '2030-01-01T00:00:00.000000Z'


def payload(ident=None, passengers=2):
    points = [{'stop_id': f'p{i}', 'label': f'Fixture {i}',
               'source': {'kind': 'google_places', 'place_id': 'fixture-same-place'}}
              for i in range(passengers)]
    return {'id': ident or str(uuid.uuid4()), 'title': 'Fixture trip', 'snapshot': {
        'schema_version': 1,
        'inputs': {
            'drivers': [{'stop_id': 'd0', 'label': 'Fixture driver', 'capacity': passengers,
                         'source': {'kind': 'google_places', 'place_id': 'fixture-driver'}}],
            'passengers': points,
            'destination': {'stop_id': 'dest', 'source': {'kind': 'google_places', 'place_id': 'fixture-dest'}}},
        'routes': [{'driver_id': 'd0', 'stop_ids': ['d0'] + [row['stop_id'] for row in points] + ['dest']}]}}


class FakeTripStore:
    def __init__(self):
        self.rows = {}
        self.calls = []
        self.fail = None
        self.lose_after_commit = False
        self.override = None

    def called(self, method, owner):
        self.calls.append((method, owner))
        if self.fail:
            raise self.fail()

    def create_trip(self, owner, record):
        self.called('create', owner)
        key = owner, record['id']
        if key in self.rows:
            existing = self.rows[key]
            if {k: existing[k] for k in record} != record:
                raise SaveConflict('record')
            return copy.deepcopy(existing), False
        self.rows[key] = dict(copy.deepcopy(record), created_at=STAMP)
        if self.lose_after_commit:
            self.lose_after_commit = False
            raise StoreUnavailable()
        return copy.deepcopy(self.override or self.rows[key]), True

    def get_trip(self, owner, ident):
        self.called('get', owner)
        if (owner, ident) not in self.rows:
            raise SavedNotFound()
        return copy.deepcopy(self.override or self.rows[owner, ident])

    def list_trips(self, owner, limit, cursor=None):
        self.called('list', owner)
        rows = [row for (who, _), row in self.rows.items() if who == owner]
        rows.sort(key=lambda row: (row['created_at'], row['id']), reverse=True)
        if cursor:
            rows = [row for row in rows if (row['created_at'], row['id']) < cursor]
        summaries = [{'id': row['id'], 'title': row['title'], 'created_at': row['created_at'],
                      'schema_version': row['snapshot']['schema_version'],
                      'driver_count': len(row['snapshot']['inputs']['drivers']),
                      'passenger_count': len(row['snapshot']['inputs']['passengers'])}
                     for row in rows[:limit]]
        next_cursor = (summaries[-1]['created_at'], summaries[-1]['id']) if len(rows) > limit else None
        if self.override is not None:
            return copy.deepcopy(self.override)
        return summaries, next_cursor

    def delete_trip(self, owner, ident):
        self.called('delete', owner)
        return self.rows.pop((owner, ident), None) is not None


class SavedTripTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # Reuse fixture helper code without inheriting/importing its unittest class.
        auth_fixture.AuthTests.setUpClass()
        cls.signer = auth_fixture.AuthTests()

    def setUp(self):
        self.clock = auth_fixture.NOW
        self.transport = auth_fixture.CertificateTransport({'fixture-key': self.signer.certificate})
        self.store = FakeTripStore()
        self.app = create_app({'TESTING': True, 'GOOGLE_CLIENT_ID': auth_fixture.AUDIENCE,
                               'GOOGLE_CERTIFICATE_REQUEST': self.transport,
                               'AUTH_CLOCK': lambda: self.clock,
                               'SAVED_DATA_STORE': self.store,
                               'CORS_ALLOWED_ORIGINS': ['https://synthetic.example']})
        self.client = self.app.test_client()
        self.timer = patch('google.auth._helpers.utcnow', side_effect=lambda:
            datetime.fromtimestamp(self.clock, timezone.utc).replace(tzinfo=None))
        self.timer.start()
        self.addCleanup(self.timer.stop)
        self.a = self.signer.token(auth_fixture.claims())
        self.b = self.signer.token(auth_fixture.claims(sub='synthetic-account-b'))

    def call(self, method, path='/saved-trips', token=None, **kwargs):
        headers = {'Authorization': 'Bearer ' + (token or self.a), **kwargs.pop('headers', {})}
        return self.client.open(path, method=method, headers=headers, **kwargs)

    def assert_error(self, response, status, code):
        self.assertEqual(response.status_code, status)
        self.assertEqual(response.json['code'], code)
        self.assertIsInstance(response.json['error'], str)
        self.assertEqual(response.headers['Cache-Control'], 'no-store')

    def test_save_load_detached_normalized_references_and_empty_driver(self):
        value = payload()
        value['title'] = '  Fixture trip  '
        value['snapshot']['inputs']['passengers'][0]['label'] = ' Cafe\u0301 '
        value['snapshot']['inputs']['drivers'].append({'stop_id': 'd1', 'capacity': 1,
            'source': {'kind': 'google_places', 'place_id': 'fixture-driver'}})
        value['snapshot']['routes'].append({'driver_id': 'd1', 'stop_ids': ['d1', 'dest']})
        response = self.call('POST', json=value)
        self.assertEqual(response.status_code, 201)
        trip = response.json['trip']
        self.assertEqual(set(trip), {'id', 'title', 'created_at', 'snapshot'})
        self.assertEqual(trip['title'], 'Fixture trip')
        self.assertEqual(trip['snapshot']['inputs']['passengers'][0]['label'], 'Café')
        self.assertEqual(trip['snapshot']['inputs']['destination']['label'], '')
        self.assertEqual(trip['snapshot']['routes'], value['snapshot']['routes'])
        value['snapshot']['routes'][0]['stop_ids'].clear()
        self.assertEqual(self.call('GET', '/saved-trips/' + trip['id']).json['trip'], trip)
        self.assertEqual(response.headers['Cache-Control'], 'no-store')

    def test_known_eighteen_passengers_save_without_optimizer(self):
        with patch('backend.routes.give_paths', side_effect=AssertionError('no optimizer call')):
            result = self.call('POST', json=payload(passengers=18))
        self.assertEqual(result.status_code, 201)
        self.assertEqual(len(result.json['trip']['snapshot']['routes'][0]['stop_ids']), 20)

    def test_same_place_id_preserves_distinct_occurrences_and_exact_source_bytes(self):
        value = payload()
        value['snapshot']['inputs']['passengers'][0]['source']['place_id'] = 'opaque-Cafe\u0301'
        response = self.call('POST', json=value)
        self.assertEqual(response.status_code, 201)
        points = response.json['trip']['snapshot']['inputs']['passengers']
        self.assertEqual(points[0]['source']['place_id'], 'opaque-Cafe\u0301')
        self.assertEqual(response.json['trip']['snapshot']['routes'][0]['stop_ids'], ['d0', 'p0', 'p1', 'dest'])

    def test_two_owner_isolation_same_uuid_and_spoof_rejection(self):
        value = payload()
        self.assertEqual(self.call('POST', json=value).status_code, 201)
        path = '/saved-trips/' + value['id']
        self.assert_error(self.call('GET', path, token=self.b), 404, 'TRIP_NOT_FOUND')
        self.assertEqual(self.call('GET', token=self.b).json['trips'], [])
        self.assertEqual(self.call('DELETE', path, token=self.b).status_code, 204)
        self.assertEqual(self.call('GET', path).status_code, 200)
        self.assertEqual(self.call('POST', token=self.b, json=value).status_code, 201)
        before = len(self.store.calls)
        value['owner'] = 'google:synthetic-account-b'
        self.assert_error(self.call('POST', json=value), 400, 'INVALID_SAVE_REQUEST')
        self.assertEqual(len(self.store.calls), before)
        self.assertEqual({owner for _, owner in self.store.calls}, {'google:synthetic-account-a', 'google:synthetic-account-b'})

    def test_real_auth_guard_before_every_store_operation(self):
        ident = str(uuid.uuid4())
        endpoints = [('POST', '/saved-trips'), ('GET', '/saved-trips'),
                     ('GET', '/saved-trips/' + ident), ('DELETE', '/saved-trips/' + ident)]
        for method, path in endpoints:
            self.assert_error(self.client.open(path, method=method), 401, 'AUTH_REQUIRED')
            for token in [self.signer.token(key=self.signer.other_key),
                          self.signer.token(auth_fixture.claims(aud='wrong')),
                          self.signer.token(auth_fixture.claims(exp=self.clock)), 'not-a-token']:
                self.assert_error(self.call(method, path, token=token), 401, 'INVALID_CREDENTIAL')
        self.assertEqual(self.store.calls, [])
        self.transport.available = False
        self.assert_error(self.call('GET'), 503, 'AUTH_UNAVAILABLE')
        self.assertEqual(self.store.calls, [])

    def test_stable_subject_relogin_and_expiry_each_request(self):
        value = payload()
        self.call('POST', json=value)
        changed = self.signer.token(auth_fixture.claims(iss='accounts.google.com', given_name='Changed', email='fixture@example.invalid'))
        self.assertEqual(self.call('GET', '/saved-trips/' + value['id'], token=changed).status_code, 200)
        expiring = self.signer.token(auth_fixture.claims(exp=self.clock + 1))
        self.assertEqual(self.call('GET', token=expiring).status_code, 200)
        self.clock += 1
        before = len(self.store.calls)
        self.assert_error(self.call('GET', token=expiring), 401, 'INVALID_CREDENTIAL')
        self.assertEqual(len(self.store.calls), before)

    def test_replay_conflict_new_id_copy_and_ambiguous_commit_reconcile(self):
        value = payload()
        self.store.lose_after_commit = True
        self.assert_error(self.call('POST', json=value), 503, 'STORE_UNAVAILABLE')
        first = self.call('GET', '/saved-trips/' + value['id']).json['trip']
        replay = self.call('POST', json=value)
        self.assertEqual(replay.status_code, 200)
        self.assertEqual(replay.json['trip'], first)
        value['title'] = 'Changed'
        self.assert_error(self.call('POST', json=value), 409, 'TRIP_CONFLICT')
        value['title'] = first['title']
        value['id'] = str(uuid.uuid4())
        self.assertEqual(self.call('POST', json=value).status_code, 201)
        self.assertEqual(len(self.call('GET').json['trips']), 2)

    def test_delete_missing_foreign_invalid_repeat_and_recreate(self):
        value = payload()
        self.call('POST', json=value)
        path = '/saved-trips/' + value['id']
        for target in ['/saved-trips/not-an-id', '/saved-trips/' + str(uuid.uuid4())]:
            response = self.call('DELETE', target)
            self.assertEqual(response.status_code, 204)
            self.assertEqual(response.data, b'')
            self.assertEqual(response.headers['Cache-Control'], 'no-store')
        self.assertEqual(self.call('DELETE', path).status_code, 204)
        self.assertEqual(self.call('DELETE', path).status_code, 204)
        self.assert_error(self.call('GET', path), 404, 'TRIP_NOT_FOUND')
        self.assertEqual(self.call('GET').json['trips'], [])
        self.assertEqual(self.call('POST', json=value).status_code, 201)

    def test_list_summary_only_tie_break_cursor_and_foreign_cursor(self):
        ids = [str(uuid.uuid4()) for _ in range(3)]
        for ident in ids:
            self.call('POST', json=payload(ident))
        response = self.call('GET', '/saved-trips?limit=1')
        self.assertEqual(response.status_code, 200)
        row = response.json['trips'][0]
        self.assertEqual(row['id'], max(ids))
        self.assertEqual(set(row), {'id', 'title', 'created_at', 'schema_version', 'driver_count', 'passenger_count'})
        cursor = response.json['next_cursor']
        page = self.call('GET', '/saved-trips?limit=1&cursor=' + cursor)
        self.assertEqual(page.json['trips'][0]['id'], sorted(ids, reverse=True)[1])
        self.assertEqual(self.call('GET', '/saved-trips?cursor=' + cursor, token=self.b).json['trips'], [])
        final = self.call('GET', '/saved-trips?cursor=' + page.json['next_cursor'])
        self.assertEqual(final.json['next_cursor'], None)

    def test_invalid_outer_fields_title_id_and_spoofed_metadata(self):
        cases = []
        for key, bad in [('id', None), ('id', str(uuid.uuid4()).upper()), ('id', 'not-a-uuid'),
                         ('title', ''), ('title', 2), ('title', 'x'*201), ('title', 'x\x00y'), ('title', 'x\ud800'), ('title', '\nFixture')]:
            value = payload(); value[key] = bad; cases.append(value)
        for key in ['owner_id', 'created_at', 'profile', 'request_id', 'lat']:
            value = payload(); value[key] = 'fixture'; cases.append(value)
        for key in ['id', 'title', 'snapshot']:
            value = payload(); del value[key]; cases.append(value)
        for value in cases:
            self.assert_error(self.call('POST', json=value), 400, 'INVALID_SAVE_REQUEST')
        self.assertEqual(self.store.calls, [])

    def test_version_and_retained_provider_fields_rejected(self):
        for version, code in [(2, 'UNSUPPORTED_SNAPSHOT_VERSION'), (True, 'INVALID_SNAPSHOT'),
                              (1.0, 'INVALID_SNAPSHOT'), ('1', 'INVALID_SNAPSHOT')]:
            value = payload(); value['snapshot']['schema_version'] = version
            self.assert_error(self.call('POST', json=value), 400, code)
        for target in ['snapshot', 'inputs', 'point', 'source', 'route']:
            for field in ['address', 'formatted_address', 'coordinates', 'name', 'lat', 'lng', 'owner']:
                value = payload(); snap = value['snapshot']
                obj = {'snapshot': snap, 'inputs': snap['inputs'], 'point': snap['inputs']['passengers'][0],
                       'source': snap['inputs']['passengers'][0]['source'], 'route': snap['routes'][0]}[target]
                obj[field] = 'fixture'
                self.assert_error(self.call('POST', json=value), 400, 'INVALID_SNAPSHOT')
        self.assertEqual(self.store.calls, [])

    def test_source_and_optional_user_label_validation(self):
        for bad in [None, {}, {'kind': 'manual', 'place_id': 'fixture'},
                    {'kind': 'google_places', 'place_id': ''}, {'kind': 'google_places', 'place_id': 2},
                    *[{'kind': 'google_places', 'place_id': item} for item in
                      [' fixture', 'fixture ', 'fix ture', 'fix\tture', 'fix\u00a0ture', 'x\x00y', 'x\ud800', 'x'*4097]]]:
            value = payload(); value['snapshot']['inputs']['destination']['source'] = bad
            self.assert_error(self.call('POST', json=value), 400, 'INVALID_SNAPSHOT')
        for bad in [None, True, 'x'*1001, 'x\x00y', 'x\ud800', '\nFixture']:
            value = payload(); value['snapshot']['inputs']['destination']['label'] = bad
            self.assert_error(self.call('POST', json=value), 400, 'INVALID_SNAPSHOT')
        self.assertEqual(self.store.calls, [])

    def test_route_occurrence_driver_capacity_and_shape_rejections(self):
        cases = []
        for stops in [['d0', 'p0', 'dest'], ['d0', 'p0', 'p0', 'dest'], ['d0', 'p0', 'unknown', 'dest'],
                      ['d0', 'dest', 'p0', 'p1', 'dest'], ['p0', 'p0', 'p1', 'dest'],
                      ['d0', 'p0', 'p1', 'p0'], ['d0'], ['d0', 3, 'p1', 'dest']]:
            value = payload(); value['snapshot']['routes'][0]['stop_ids'] = stops; cases.append(value)
        for field, bad in [('driver_id', 'p0'), ('driver_id', True), ('stop_ids', {}), ('stop_ids', 'd0')]:
            value = payload(); value['snapshot']['routes'][0][field] = bad; cases.append(value)
        for bad in [[], [{}], None, 'route']:
            value = payload(); value['snapshot']['routes'] = bad; cases.append(value)
        for bad in [0, -1, True, 1.5, '3', 1]:
            value = payload(); value['snapshot']['inputs']['drivers'][0]['capacity'] = bad; cases.append(value)
        for target, bad in [('drivers', []), ('passengers', []), ('destination', None), ('drivers', {})]:
            value = payload(); value['snapshot']['inputs'][target] = bad; cases.append(value)
        for bad in ['d0', 'dest', 'p0', '', 'spaces bad', 'x'*65, 3, None]:
            value = payload(); value['snapshot']['inputs']['passengers'][1]['stop_id'] = bad; cases.append(value)
        value = payload()
        value['snapshot']['inputs']['drivers'][0]['capacity'] = 1
        value['snapshot']['inputs']['drivers'].append({'stop_id': 'd1', 'capacity': 2,
            'source': {'kind': 'google_places', 'place_id': 'fixture-driver'}})
        value['snapshot']['routes'].append({'driver_id': 'd1', 'stop_ids': ['d1', 'dest']})
        cases.append(value)  # Fleet total fits, but the occupied driver's capacity does not.
        for value in cases:
            self.assert_error(self.call('POST', json=value), 400, 'INVALID_SNAPSHOT')
        self.assertEqual(self.store.calls, [])

    def test_count_boundaries_and_detached_pure_validator(self):
        value = payload(passengers=256)
        normalized = validate_snapshot(value['snapshot'])
        self.assertEqual(len(normalized['inputs']['passengers']), 256)
        value['snapshot']['routes'][0]['stop_ids'][1] = 'mutated'
        self.assertEqual(normalized['routes'][0]['stop_ids'][1], 'p0')
        self.assertEqual(self.call('POST', json=payload(passengers=257)).status_code, 400)
        value = payload()
        value['snapshot']['inputs']['drivers'] *= 65
        self.assert_error(self.call('POST', json=value), 400, 'INVALID_SNAPSHOT')
        # The 64-driver boundary remains saveable with one occupied and 63 empty routes.
        value = payload()
        for i in range(1, 64):
            value['snapshot']['inputs']['drivers'].append({'stop_id': f'd{i}', 'capacity': 1,
                'source': {'kind': 'google_places', 'place_id': 'fixture-driver'}})
            value['snapshot']['routes'].append({'driver_id': f'd{i}', 'stop_ids': [f'd{i}', 'dest']})
        self.assertEqual(self.call('POST', json=value).status_code, 201)

    def test_bounded_json_media_duplicates_nonfinite_depth_and_utf8(self):
        for raw in [b'[]', b'null', b'{', b'{"id":1,"id":2}', b'{"x":NaN}', b'\xff',
                    ('{"x":' + '['*18 + '0' + ']'*18 + '}').encode()]:
            self.assert_error(self.call('POST', data=raw, content_type='application/json'), 400, 'INVALID_SAVE_REQUEST')
        self.assert_error(self.call('POST', data=b' ' * 65537, content_type='application/json'), 413, 'PAYLOAD_TOO_LARGE')
        self.assert_error(self.call('POST', data='{}', content_type='text/plain'), 415, 'UNSUPPORTED_MEDIA_TYPE')
        self.assert_error(self.call('POST', data='{}', content_type='application/json', headers={'Content-Encoding': 'gzip'}), 415, 'UNSUPPORTED_MEDIA_TYPE')
        # WSGI stream without Content-Length still gets max+1 bounded read.
        import io
        self.assert_error(self.call('POST', content_type='application/json', environ_overrides={
            'CONTENT_LENGTH': '', 'wsgi.input_terminated': True, 'wsgi.input': io.BytesIO(b' '*65537)}), 413, 'PAYLOAD_TOO_LARGE')
        self.assertEqual(self.store.calls, [])

    def test_invalid_query_body_and_cursor_no_store_access(self):
        for query in ['limit=0', 'limit=101', 'limit=-1', 'limit=01', 'limit=true', 'limit=1&limit=2',
                      'owner=fixture', 'cursor=', 'cursor=not-valid', 'cursor=***']:
            self.assert_error(self.call('GET', '/saved-trips?' + query), 400, 'INVALID_LIST_REQUEST')
        for method in ['GET', 'DELETE']:
            self.assert_error(self.call(method, '/saved-trips/' + str(uuid.uuid4()) + '?owner=fixture'), 400, 'INVALID_SAVE_REQUEST')
            self.assert_error(self.call(method, '/saved-trips/' + str(uuid.uuid4()), data=b'{}'), 400, 'INVALID_SAVE_REQUEST')
        self.assert_error(self.call('POST', '/saved-trips?owner=fixture', json=payload()), 400, 'INVALID_SAVE_REQUEST')
        self.assert_error(self.call('GET', data=b'{}'), 400, 'INVALID_LIST_REQUEST')
        self.assertEqual(self.store.calls, [])

    def test_store_failures_and_corrupt_records_summaries_are_controlled(self):
        value = payload()
        self.call('POST', json=value)
        for method, path in [('POST', '/saved-trips'), ('GET', '/saved-trips'),
                             ('GET', '/saved-trips/' + value['id']), ('DELETE', '/saved-trips/' + value['id'])]:
            self.store.fail = StoreUnavailable
            self.assert_error(self.call(method, path, json=payload() if method == 'POST' else None), 503, 'STORE_UNAVAILABLE')
        self.store.fail = None
        original = self.store.rows['google:synthetic-account-a', value['id']]
        for change in [{'owner': 'forged'}, {'created_at': 'invalid'}, {'id': str(uuid.uuid4())},
                       {'title': ' unnormalized '}, {'snapshot': {'schema_version': 99}}]:
            self.store.override = dict(copy.deepcopy(original), **change)
            self.assert_error(self.call('GET', '/saved-trips/' + value['id']), 500, 'SAVED_TRIP_UNREADABLE')
        self.store.override = None
        summaries, _ = self.store.list_trips('google:synthetic-account-a', 50)
        for change in [{'driver_count': True}, {'passenger_count': 0}, {'schema_version': 1.0},
                       {'source': 'must not leak'}, {'created_at': 'invalid'}, {'title': ' unnormalized '}]:
            self.store.override = ([dict(summaries[0], **change)], None)
            self.assert_error(self.call('GET'), 500, 'SAVED_TRIP_UNREADABLE')
        self.store.override = (summaries, (STAMP, str(uuid.uuid4())))
        self.assert_error(self.call('GET'), 500, 'SAVED_TRIP_UNREADABLE')

    def test_create_does_not_claim_success_for_a_different_store_result(self):
        value = payload()
        different = copy.deepcopy(value)
        different['snapshot'] = validate_snapshot(different['snapshot'])
        different['title'] = 'Other committed intent'
        different['created_at'] = STAMP
        self.store.override = different
        self.assert_error(self.call('POST', json=value), 500, 'SAVED_TRIP_UNREADABLE')

    def test_factory_injection_private_json_routing_errors_and_no_store(self):
        self.assertIs(self.app.extensions['saved_data_store'], self.store)
        for method, path, status, code in [
                ('PATCH', '/saved-trips', 405, 'METHOD_NOT_ALLOWED'),
                ('PUT', '/saved-trips/' + str(uuid.uuid4()), 405, 'METHOD_NOT_ALLOWED'),
                ('GET', '/saved-trips/missing/child', 404, 'SAVED_ROUTE_NOT_FOUND'),
                ('GET', '/saved-trips/', 404, 'SAVED_ROUTE_NOT_FOUND')]:
            self.assert_error(self.call(method, path), status, code)
        self.assertEqual(self.store.calls, [])

    def test_factory_delete_cors_preflight_allowed_and_denied_origins(self):
        path = '/saved-trips/' + str(uuid.uuid4())
        response = self.client.open(path, method='OPTIONS', headers={
            'Origin': 'https://synthetic.example',
            'Access-Control-Request-Method': 'DELETE',
            'Access-Control-Request-Headers': 'authorization,content-type'})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers['Access-Control-Allow-Origin'], 'https://synthetic.example')
        self.assertIn('DELETE', response.headers['Access-Control-Allow-Methods'])
        self.assertEqual(response.headers['Cache-Control'], 'no-store')
        self.assertEqual(self.store.calls, [])
        denied = self.client.open(path, method='OPTIONS', headers={
            'Origin': 'https://denied.invalid', 'Access-Control-Request-Method': 'DELETE'})
        self.assertNotIn('Access-Control-Allow-Origin', denied.headers)
        result = self.call('DELETE', path, headers={'Origin': 'https://synthetic.example'})
        self.assertEqual(result.status_code, 204)
        self.assertEqual(result.headers['Access-Control-Allow-Origin'], 'https://synthetic.example')
        unauth = self.client.get('/saved-trips', headers={'Origin': 'https://synthetic.example'})
        self.assert_error(unauth, 401, 'AUTH_REQUIRED')
        self.assertEqual(unauth.headers['Access-Control-Allow-Origin'], 'https://synthetic.example')

    def test_no_private_payload_logging_or_provider_calls(self):
        with patch.object(self.app.logger, 'info') as info, patch.object(self.app.logger, 'error') as error:
            value = payload()
            self.call('POST', json=value)
            self.call('GET', '/saved-trips/' + value['id'])
            self.call('GET')
            self.call('DELETE', '/saved-trips/' + value['id'])
        info.assert_not_called(); error.assert_not_called()
