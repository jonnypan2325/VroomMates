"""Selected SDK integration tests; opt in only to the isolated loopback emulator."""
import concurrent.futures
import os
import subprocess
import sys
import unittest
import uuid
from datetime import datetime, timezone
from unittest.mock import patch
from google.auth.credentials import AnonymousCredentials
from google.api_core.exceptions import ServiceUnavailable
from google.cloud import firestore
from backend.saved_store import FirestoreSavedStore, SavedNotFound, SaveConflict, StoreCorrupt, StoreUnavailable, _reservation_key

EMULATOR = os.environ.get('VROOMMATES_TEST_FIRESTORE_EMULATOR')
NOW = datetime(2026, 1, 1, 12, 0, 0, 123456, tzinfo=timezone.utc)


def trip(ident=None, title='Fixture trip'):
    return {'id': ident or str(uuid.uuid4()), 'title': title, 'snapshot': {'schema_version': 1,
            'inputs': {'drivers': [{'stop_id': 'd', 'source': {'kind': 'google_places', 'place_id': 'synthetic-driver'}, 'capacity': 2}],
                       'passengers': [{'stop_id': 'p', 'source': {'kind': 'google_places', 'place_id': 'synthetic-pickup'}}],
                       'destination': {'stop_id': 'z', 'source': {'kind': 'google_places', 'place_id': 'synthetic-destination'}}},
            'routes': [{'driver_id': 'd', 'stop_ids': ['d', 'p', 'z']}]}}


def location(ident=None, label='Fixture friend'):
    return {'id': ident or str(uuid.uuid4()), 'label': label,
            'source': {'kind': 'google_places', 'place_id': 'synthetic-friend'}}


@unittest.skipUnless(EMULATOR, 'Opt in to isolated Firestore emulator integration tests')
class FirestoreStoreTests(unittest.TestCase):
    def setUp(self):
        if EMULATOR != '127.0.0.1:8187' or os.environ.get('FIRESTORE_EMULATOR_HOST') != EMULATOR:
            raise RuntimeError('Tests require the dedicated loopback emulator; cloud access is forbidden')
        self.client = firestore.Client(project='demo-vroommates', credentials=AnonymousCredentials())
        self.store = FirestoreSavedStore(client=self.client, clock=lambda: NOW)
        self.owner = 'google:synthetic-store-' + uuid.uuid4().hex
        self.other = 'google:synthetic-other-' + uuid.uuid4().hex

    def tearDown(self):
        self.client.close()

    def test_trip_replay_and_owner_namespace(self):
        payload = trip()
        first, created = self.store.create_trip(self.owner, payload)
        second, replayed = self.store.create_trip(self.owner, payload)
        self.assertTrue(created); self.assertFalse(replayed); self.assertEqual(first, second)
        with self.assertRaises(SaveConflict): self.store.create_trip(self.owner, dict(payload, title='Changed'))
        with self.assertRaises(SavedNotFound): self.store.get_trip(self.other, payload['id'])
        self.assertFalse(self.store.delete_trip(self.other, payload['id']))
        different, created = self.store.create_trip(self.other, dict(payload, title='Other account fixture'))
        self.assertTrue(created); self.assertNotEqual(first['title'], different['title'])
        self.assertTrue(self.store.delete_trip(self.owner, payload['id']))
        self.assertFalse(self.store.delete_trip(self.owner, payload['id']))
        with self.assertRaises(SavedNotFound): self.store.get_trip(self.owner, payload['id'])
        self.assertEqual(self.store.get_trip(self.other, payload['id']), different)

    def test_projected_pagination_ties_and_deleted_cursor(self):
        ids = sorted(str(uuid.uuid4()) for _ in range(4))
        for ident in ids: self.store.create_trip(self.owner, trip(ident))
        rows, cursor = self.store.list_trips(self.owner, 2)
        self.assertEqual([x['id'] for x in rows], ids[::-1][:2])
        self.assertEqual(set(rows[0]), {'id', 'title', 'created_at', 'schema_version', 'driver_count', 'passenger_count'})
        self.store.delete_trip(self.owner, cursor[1])
        last, next_cursor = self.store.list_trips(self.owner, 2, cursor)
        self.assertEqual([x['id'] for x in last], ids[::-1][2:])
        self.assertIsNone(next_cursor)
        self.assertEqual(self.store.list_trips(self.other, 2, cursor), ([], None))

    def test_location_atomic_label_and_delete(self):
        payload = location()
        first, new = self.store.create_location(self.owner, payload)
        replay, new_again = self.store.create_location(self.owner, payload)
        self.assertTrue(new); self.assertFalse(new_again); self.assertEqual(first, replay)
        self.assertEqual(first['created_at'], first['updated_at'])
        with self.assertRaises(SaveConflict) as result:
            self.store.create_location(self.owner, location(label='FIXTURE FRIEND'))
        self.assertEqual(result.exception.kind, 'label'); self.assertEqual(result.exception.existing_id, payload['id'])
        self.store.create_location(self.owner, location(label='Second friend'))
        self.assertEqual(len(self.store.list_locations(self.owner)), 2)
        self.assertEqual(self.store.list_locations(self.other), [])
        self.assertFalse(self.store.delete_location(self.other, payload['id']))
        self.assertTrue(self.store.delete_location(self.owner, payload['id']))
        self.assertFalse(self.store.delete_location(self.owner, payload['id']))
        self.store.create_location(self.owner, location(label='Fixture friend'))
        metadata = self.store._account(self.owner).get().to_dict()
        self.assertEqual(metadata['location_count'], 2)
        self.assertEqual(len(metadata['location_labels']), 2)

    def test_concurrent_same_trip_and_label_creates(self):
        payload = trip()
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
            results = list(pool.map(lambda _: self.store.create_trip(self.owner, payload), range(4)))
        self.assertEqual(sum(created for _, created in results), 1)
        self.assertEqual(len(self.store.list_trips(self.owner, 100)[0]), 1)
        def save(_):
            try:
                return self.store.create_location(self.owner, location())[1]
            except SaveConflict as error:
                self.assertEqual(error.kind, 'label')
                return False
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
            results = list(pool.map(save, range(4)))
        self.assertEqual(sum(results), 1)
        self.assertEqual(len(self.store.list_locations(self.owner)), 1)

    def test_location_limit_replay_and_corruption(self):
        account = self.store._account(self.owner)
        batch = self.client.batch(); labels = {}
        records = [location(label='Fixture friend ' + str(i)) for i in range(100)]
        for record in records:
            labels[_reservation_key(record['label'])] = record['id']
            batch.create(account.collection('locations').document(record['id']),
                         {'label': record['label'], 'source': record['source'], 'schema_version': 1, 'created_at': NOW, 'updated_at': NOW})
        batch.set(account, {'schema_version': 1, 'location_count': 100, 'location_labels': labels})
        batch.commit(retry=None, timeout=5)
        with self.assertRaises(SaveConflict) as result: self.store.create_location(self.owner, location(label='Overflow'))
        self.assertEqual(result.exception.kind, 'limit')
        self.assertFalse(self.store.create_location(self.owner, records[0])[1])
        account.update({'location_count': 99}, retry=None, timeout=5)
        with self.assertRaises(StoreCorrupt): self.store.create_location(self.owner, location(label='Corrupt metadata'))
        account.collection('locations').document(records[0]['id']).update({'coordinates': {'lat': 1, 'lng': 2}})
        with self.assertRaises(StoreCorrupt): self.store.get_location(self.owner, records[0]['id'])

    def test_label_values_are_not_firestore_field_names(self):
        for label in ['__reserved__', 'dot.label', 'back`tick']:
            record = location(label=label)
            self.assertTrue(self.store.create_location(self.owner, record)[1])
            self.assertEqual(self.store.get_location(self.owner, record['id'])['label'], label)
            with self.assertRaises(SaveConflict) as conflict:
                self.store.create_location(self.owner, location(label=label.upper()))
            self.assertEqual(conflict.exception.kind, 'label')
            self.assertTrue(self.store.delete_location(self.owner, record['id']))
        metadata = self.store._account(self.owner).get().to_dict()
        self.assertEqual(metadata['location_count'], 0)
        self.assertEqual(metadata['location_labels'], {})

    def test_corrupt_location_delete_is_controlled_without_mutation(self):
        payload = location()
        self.store.create_location(self.owner, payload)
        ref = self.store._account(self.owner).collection('locations').document(payload['id'])
        for broken in [42, [], None, ' Bad label ', '\nBad label']:
            ref.update({'label': broken}, retry=None, timeout=5)
            with self.assertRaises(StoreCorrupt): self.store.delete_location(self.owner, payload['id'])
            self.assertTrue(ref.get(retry=None, timeout=5).exists)
        ref.update({'label': payload['label'], 'source': {'kind': 'manual', 'place_id': 'synthetic'}}, retry=None, timeout=5)
        with self.assertRaises(StoreCorrupt): self.store.delete_location(self.owner, payload['id'])
        self.assertTrue(ref.get(retry=None, timeout=5).exists)

    def test_read_failure_and_ambiguous_committed_save(self):
        with patch.object(self.store, '_get', side_effect=ServiceUnavailable('synthetic transport failure')):
            with self.assertRaises(StoreUnavailable): self.store.get_trip(self.owner, str(uuid.uuid4()))
        payload = trip(); run = self.store._transaction
        def committed_then_lost(callback):
            run(callback)
            raise StoreUnavailable()
        with patch.object(self.store, '_transaction', side_effect=committed_then_lost):
            with self.assertRaises(StoreUnavailable): self.store.create_trip(self.owner, payload)
        recovered = self.store.get_trip(self.owner, payload['id'])
        self.assertEqual(recovered['snapshot'], payload['snapshot'])
        self.assertFalse(self.store.create_trip(self.owner, payload)[1])

    def test_new_backend_process_readback(self):
        payload = trip(); place = location()
        self.store.create_trip(self.owner, payload); self.store.create_location(self.owner, place)
        program = '''
import sys
from unittest.mock import patch
with patch('dotenv.load_dotenv', return_value=False):
 from google.auth.credentials import AnonymousCredentials
 from google.cloud import firestore
 from backend import create_app
 from backend.saved_store import FirestoreSavedStore, SavedNotFound
 client=firestore.Client(project='demo-vroommates',credentials=AnonymousCredentials())
 store=FirestoreSavedStore(client=client)
 app=create_app({'GOOGLE_CLIENT_ID':'synthetic-test-client.apps.googleusercontent.com','CORS_ALLOWED_ORIGINS':['http://localhost:3000'],'SAVED_DATA_STORE':store})
 assert store.get_trip(sys.argv[1],sys.argv[3])['title']=='Fixture trip'
 assert store.get_location(sys.argv[1],sys.argv[4])['label']=='Fixture friend'
 for method,ident in [(store.get_trip,sys.argv[3]),(store.get_location,sys.argv[4])]:
  try:method(sys.argv[2],ident)
  except SavedNotFound:pass
  else:raise AssertionError('owner isolation')
 client.close()
 print('fresh backend process readback PASS')
'''
        result = subprocess.run([sys.executable, '-B', '-c', program, self.owner, self.other, payload['id'], place['id']],
                                capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), 'fresh backend process readback PASS')
        self.store.delete_trip(self.owner, payload['id']); self.store.delete_location(self.owner, place['id'])
        deletion_program = '''
import sys
from unittest.mock import patch
with patch('dotenv.load_dotenv',return_value=False):
 from google.auth.credentials import AnonymousCredentials
 from google.cloud import firestore
 from backend import create_app
 from backend.saved_store import FirestoreSavedStore,SavedNotFound
 client=firestore.Client(project='demo-vroommates',credentials=AnonymousCredentials())
 store=FirestoreSavedStore(client=client)
 app=create_app({'GOOGLE_CLIENT_ID':'synthetic-test-client.apps.googleusercontent.com','CORS_ALLOWED_ORIGINS':['http://localhost:3000'],'SAVED_DATA_STORE':store})
 for method,ident in [(store.get_trip,sys.argv[2]),(store.get_location,sys.argv[3])]:
  try:method(sys.argv[1],ident)
  except SavedNotFound:pass
  else:raise AssertionError('deleted data returned after restart')
 client.close()
 print('fresh backend deletion readback PASS')
'''
        deleted=subprocess.run([sys.executable,'-B','-c',deletion_program,self.owner,payload['id'],place['id']],capture_output=True,text=True,timeout=30)
        self.assertEqual(deleted.returncode,0,deleted.stderr)
        self.assertEqual(deleted.stdout.strip(),'fresh backend deletion readback PASS')

