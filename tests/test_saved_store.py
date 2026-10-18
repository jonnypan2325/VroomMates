"""Selected SDK integration tests; opt in only to the isolated loopback emulator."""
import concurrent.futures
import copy
import os
import subprocess
import sys
import unittest
import uuid
from datetime import datetime, timedelta, timezone
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

    def test_location_update_moves_label_reservation(self):
        home = location(label='Home')
        work = location(label='Work')
        self.store.create_location(self.owner, home)
        self.store.create_location(self.owner, work)
        renamed = self.store.update_location(self.owner, home['id'], {'label': 'Home base'})
        self.assertEqual((renamed['id'], renamed['label'], renamed['source']), (home['id'], 'Home base', home['source']))
        self.assertEqual(self.store.get_location(self.owner, home['id'])['label'], 'Home base')
        reused, created = self.store.create_location(self.owner, location(label='home'))
        self.assertTrue(created)
        with self.assertRaises(SaveConflict) as result:
            self.store.update_location(self.owner, work['id'], {'label': 'HOME BASE'})
        self.assertEqual((result.exception.kind, result.exception.existing_id), ('label', home['id']))
        cased = self.store.update_location(self.owner, home['id'], {'label': 'HOME BASE'})
        self.assertEqual(cased['label'], 'HOME BASE')
        moved = self.store.update_location(self.owner, work['id'], {'source': {'kind': 'google_places', 'place_id': 'synthetic-new-office'}})
        self.assertEqual((moved['label'], moved['source']['place_id']), ('Work', 'synthetic-new-office'))
        self.assertTrue(self.store.delete_location(self.owner, home['id']))
        self.store.create_location(self.owner, location(label='Home base'))
        self.assertEqual(len(self.store.list_locations(self.owner)), 3)
        with self.assertRaises(SavedNotFound):
            self.store.update_location(self.other, work['id'], {'label': 'Theirs'})
        with self.assertRaises(SavedNotFound):
            self.store.update_location(self.owner, str(uuid.uuid4()), {'label': 'Nobody'})

    def test_location_edit_time_never_moves_backwards(self):
        home = location(label='Home')
        self.store.create_location(self.owner, home)
        later = NOW + timedelta(hours=1)
        self.store.clock = lambda: later
        self.store.update_location(self.owner, home['id'], {'label': 'Home base'})
        self.store.clock = lambda: NOW + timedelta(minutes=10)
        edited = self.store.update_location(self.owner, home['id'], {'label': 'Home again'})
        self.assertEqual(edited['updated_at'], self.store.get_location(self.owner, home['id'])['updated_at'])
        self.assertEqual(self.store.get_location(self.owner, home['id'])['updated_at'],
                         later.isoformat(timespec='microseconds').replace('+00:00', 'Z'))

    def test_trip_update_keeps_creation_and_recounts(self):
        payload = trip()
        created, _ = self.store.create_trip(self.owner, payload)
        renamed = self.store.update_trip(self.owner, payload['id'], {'title': 'Friday dinner'})
        self.assertEqual((renamed['title'], renamed['created_at']), ('Friday dinner', created['created_at']))
        bigger = copy.deepcopy(payload['snapshot'])
        bigger['inputs']['passengers'].append({'stop_id': 'q', 'source': {'kind': 'google_places', 'place_id': 'synthetic-second'}})
        bigger['routes'][0]['stop_ids'] = ['d', 'p', 'q', 'z']
        self.store.update_trip(self.owner, payload['id'], {'snapshot': bigger})
        loaded = self.store.get_trip(self.owner, payload['id'])
        self.assertEqual((loaded['title'], loaded['snapshot']), ('Friday dinner', bigger))
        rows, _ = self.store.list_trips(self.owner, 5)
        self.assertEqual((rows[0]['title'], rows[0]['passenger_count']), ('Friday dinner', 2))
        with self.assertRaises(SavedNotFound):
            self.store.update_trip(self.other, payload['id'], {'title': 'Theirs'})

    def assert_reservations_match(self):
        raw = self.store._account(self.owner).get().to_dict()
        rows = self.store.list_locations(self.owner)
        self.assertEqual(raw['location_count'], len(rows))
        self.assertEqual(raw['location_labels'], {_reservation_key(row['label']): row['id'] for row in rows})

    def test_failed_rename_mid_transaction_writes_nothing(self):
        home, work = location(label='Home'), location(label='Work')
        self.store.create_location(self.owner, home)
        self.store.create_location(self.owner, work)
        # The location update is queued first; the account write then fails, so the transaction rolls back.
        with patch('google.cloud.firestore_v1.transaction.Transaction.set',
                   side_effect=ServiceUnavailable('synthetic failure between writes')):
            with self.assertRaises(StoreUnavailable):
                self.store.update_location(self.owner, home['id'], {'label': 'Home base'})
        self.assertEqual(self.store.get_location(self.owner, home['id'])['label'], 'Home')
        self.assert_reservations_match()
        with self.assertRaises(SaveConflict):
            self.store.update_location(self.owner, work['id'], {'label': 'home'})
        self.assertTrue(self.store.create_location(self.owner, location(label='Home base'))[1])
        self.assert_reservations_match()

    def test_concurrent_renames_to_one_label_keep_one_winner(self):
        rows = [location(label='Spot %d' % index) for index in range(4)]
        for row in rows:
            self.store.create_location(self.owner, row)
        def rename(row):
            try:
                self.store.update_location(self.owner, row['id'], {'label': 'Meeting point'})
                return True
            except SaveConflict as error:
                self.assertEqual(error.kind, 'label')
                return False
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
            results = list(pool.map(rename, rows))
        self.assertEqual(sum(results), 1)
        labels = sorted(row['label'] for row in self.store.list_locations(self.owner))
        self.assertEqual(labels.count('Meeting point'), 1)
        self.assert_reservations_match()

    def test_failed_location_create_mid_transaction_writes_nothing(self):
        self.store.create_location(self.owner, location(label='Home'))
        payload = location(label='Work')
        # The location create is queued first; the account write then fails, so neither lands.
        with patch('google.cloud.firestore_v1.transaction.Transaction.set',
                   side_effect=ServiceUnavailable('synthetic failure between writes')):
            with self.assertRaises(StoreUnavailable):
                self.store.create_location(self.owner, payload)
        with self.assertRaises(SavedNotFound):
            self.store.get_location(self.owner, payload['id'])
        self.assert_reservations_match()
        self.assertTrue(self.store.create_location(self.owner, payload)[1])
        self.assert_reservations_match()

    def test_failed_location_delete_mid_transaction_writes_nothing(self):
        payload = location(label='Home')
        self.store.create_location(self.owner, payload)
        with patch('google.cloud.firestore_v1.transaction.Transaction.set',
                   side_effect=ServiceUnavailable('synthetic failure between writes')):
            with self.assertRaises(StoreUnavailable):
                self.store.delete_location(self.owner, payload['id'])
        self.assertEqual(self.store.get_location(self.owner, payload['id'])['label'], 'Home')
        self.assert_reservations_match()
        with self.assertRaises(SaveConflict):
            self.store.create_location(self.owner, location(label='home'))

    def test_failed_trip_update_mid_transaction_writes_nothing(self):
        payload = trip()
        self.store.create_trip(self.owner, payload)
        with patch('google.cloud.firestore_v1.transaction.Transaction.update',
                   side_effect=ServiceUnavailable('synthetic failure while writing')):
            with self.assertRaises(StoreUnavailable):
                self.store.update_trip(self.owner, payload['id'], {'title': 'Never saved'})
        loaded = self.store.get_trip(self.owner, payload['id'])
        self.assertEqual((loaded['title'], loaded['snapshot']), (payload['title'], payload['snapshot']))

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

