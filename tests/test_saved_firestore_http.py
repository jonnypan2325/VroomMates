"""Real synthetic Google proof through Flask and the selected Firestore SDK."""
import os
import unittest
import uuid
from datetime import datetime, timezone
from unittest.mock import patch
from google.auth.credentials import AnonymousCredentials
from google.cloud import firestore
from backend import create_app
from backend.saved_store import FirestoreSavedStore
import tests.test_auth as auth_fixture
import tests.test_saved_store as store_fixture


@unittest.skipUnless(os.environ.get('VROOMMATES_TEST_FIRESTORE_EMULATOR'), 'Opt in to isolated Firestore HTTP integration')
class SavedFirestoreHttpTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        auth_fixture.AuthTests.setUpClass.__func__(cls)

    token = auth_fixture.AuthTests.token

    def setUp(self):
        if os.environ.get('VROOMMATES_TEST_FIRESTORE_EMULATOR') != '127.0.0.1:8187' or os.environ.get('FIRESTORE_EMULATOR_HOST') != '127.0.0.1:8187':
            raise RuntimeError('Only dedicated loopback emulator is permitted')
        self.sdk = firestore.Client(project='demo-vroommates', credentials=AnonymousCredentials())
        self.addCleanup(self.sdk.close)
        self.store = FirestoreSavedStore(client=self.sdk)
        self.transport = auth_fixture.CertificateTransport({'fixture-key': self.certificate})
        self.subject_a, self.subject_b = 'synthetic-http-a-' + uuid.uuid4().hex, 'synthetic-http-b-' + uuid.uuid4().hex
        self.app = create_app({'TESTING': True, 'GOOGLE_CLIENT_ID': auth_fixture.AUDIENCE,
                              'GOOGLE_CERTIFICATE_REQUEST': self.transport,
                              'AUTH_CLOCK': lambda: auth_fixture.NOW,
                              'CORS_ALLOWED_ORIGINS': ['http://localhost:3000'], 'SAVED_DATA_STORE': self.store})
        self.http = self.app.test_client()
        clock = patch('google.auth._helpers.utcnow', return_value=datetime.fromtimestamp(auth_fixture.NOW, timezone.utc).replace(tzinfo=None))
        clock.start(); self.addCleanup(clock.stop)
        self.a = {'Authorization': 'Bearer ' + self.token(auth_fixture.claims(sub=self.subject_a))}
        self.b = {'Authorization': 'Bearer ' + self.token(auth_fixture.claims(sub=self.subject_b))}

    def test_authenticated_trip_and_place_roundtrip_isolated(self):
        trip = store_fixture.trip(); place = store_fixture.location()
        for path, body, envelope in [('/saved-trips', trip, 'trip'), ('/saved-locations', place, 'location')]:
            created = self.http.post(path, json=body, headers=self.a)
            self.assertEqual(created.status_code, 201, created.get_json())
            self.assertEqual(created.headers['Cache-Control'], 'no-store')
            self.assertEqual(self.http.post(path, json=body, headers=self.a).status_code, 200)
            loaded = self.http.get(path + '/' + body['id'], headers=self.a)
            self.assertEqual(loaded.status_code, 200)
            self.assertEqual(loaded.json[envelope], created.json[envelope])
            self.assertEqual(self.http.get(path + '/' + body['id'], headers=self.b).status_code, 404)
            self.assertEqual(self.http.get(path + '/' + body['id']).status_code, 401)
        self.assertEqual(len(self.http.get('/saved-trips', headers=self.a).json['trips']), 1)
        self.assertEqual(self.http.get('/saved-trips', headers=self.b).json['trips'], [])
        self.assertEqual(self.http.get('/saved-locations', headers=self.b).json['locations'], [])
        row = self.store._account('google:' + self.subject_a).collection('locations').document(place['id']).get().to_dict()
        self.assertEqual(set(row), {'label', 'source', 'created_at', 'updated_at', 'schema_version'})
        self.assertTrue(self.http.get('/saved-locations/' + place['id'], headers=self.a).json['location']['resolution_required'])

    def test_delete_does_not_cross_owners_and_label_reusable(self):
        place = store_fixture.location()
        self.assertEqual(self.http.post('/saved-locations', json=place, headers=self.a).status_code, 201)
        self.assertEqual(self.http.post('/saved-locations', json=place, headers=self.b).status_code, 201)
        self.assertEqual(self.http.delete('/saved-locations/' + place['id'], headers=self.a).status_code, 204)
        self.assertEqual(self.http.delete('/saved-locations/' + place['id'], headers=self.a).status_code, 404)
        self.assertEqual(self.http.get('/saved-locations/' + place['id'], headers=self.b).status_code, 200)
        self.assertEqual(self.http.post('/saved-locations', json=store_fixture.location(), headers=self.a).status_code, 201)
        trip = store_fixture.trip()
        self.assertEqual(self.http.post('/saved-trips', json=trip, headers=self.a).status_code, 201)
        self.assertEqual(self.http.delete('/saved-trips/' + trip['id'], headers=self.b).status_code, 204)
        self.assertEqual(self.http.get('/saved-trips/' + trip['id'], headers=self.a).status_code, 200)
        self.assertEqual(self.http.delete('/saved-trips/' + trip['id'], headers=self.a).status_code, 204)
        self.assertEqual(self.http.get('/saved-trips/' + trip['id'], headers=self.a).status_code, 404)

    def test_private_headers_media_proof_and_cors(self):
        for path in ['/saved-trips', '/saved-locations']:
            denied = self.http.post(path, data='x' * 70000, content_type='application/json')
            self.assertEqual(denied.status_code, 401)
            preflight = self.http.options(path + '/' + str(uuid.uuid4()), headers={'Origin': 'http://localhost:3000', 'Access-Control-Request-Method': 'DELETE', 'Access-Control-Request-Headers': 'Authorization'})
            self.assertIn('DELETE', preflight.headers['Access-Control-Allow-Methods'])
            self.assertEqual(preflight.headers['Cache-Control'], 'no-store')
            method = self.http.put(path, headers=self.a)
            self.assertEqual(method.status_code, 405); self.assertEqual(method.json['code'], 'METHOD_NOT_ALLOWED')
            self.assertEqual(method.headers['Cache-Control'], 'no-store')
            media = self.http.post(path, data='{}', content_type='text/plain', headers=self.a)
            self.assertEqual(media.status_code, 415)
        self.assertEqual(self.http.get('/routeoptimizer/').status_code, 410)

    def test_reference_body_conflicts_and_cursor(self):
        trip = store_fixture.trip(); place = store_fixture.location()
        self.assertEqual(self.http.post('/saved-trips', json=trip, headers=self.a).status_code, 201)
        self.assertEqual(self.http.post('/saved-trips', json=dict(trip, title='Changed'), headers=self.a).status_code, 409)
        trip['id'] = str(uuid.uuid4())
        self.assertEqual(self.http.post('/saved-trips', json=trip, headers=self.a).status_code, 201)
        page = self.http.get('/saved-trips?limit=1', headers=self.a)
        self.assertEqual(len(page.json['trips']), 1)
        next_page = self.http.get('/saved-trips?limit=1&cursor=' + page.json['next_cursor'], headers=self.a)
        self.assertEqual(len(next_page.json['trips']), 1)
        self.assertNotEqual(page.json['trips'][0]['id'], next_page.json['trips'][0]['id'])
        self.assertEqual(self.http.post('/saved-locations', json=place, headers=self.a).status_code, 201)
        conflict = self.http.post('/saved-locations', json=store_fixture.location(), headers=self.a)
        self.assertEqual(conflict.status_code, 409)
        self.assertEqual(conflict.json['existing_location_id'], place['id'])
        bad = dict(place, coordinates={'lat': 1, 'lng': 2})
        self.assertEqual(self.http.post('/saved-locations', json=bad, headers=self.a).status_code, 400)

    def test_corrupt_location_delete_is_generic_unavailable(self):
        place = store_fixture.location()
        self.http.post('/saved-locations', json=place, headers=self.a)
        ref = self.store._account('google:' + self.subject_a).collection('locations').document(place['id'])
        ref.update({'label': 42}, retry=None, timeout=5)
        result = self.http.delete('/saved-locations/' + place['id'], headers=self.a)
        self.assertEqual(result.status_code, 503)
        self.assertEqual(result.json['code'], 'STORE_UNAVAILABLE')
        self.assertTrue(ref.get(retry=None, timeout=5).exists)
