"""Vercel OIDC federation wiring with synthetic settings; no token exchange or network."""
import unittest
from unittest.mock import patch

from google.auth import exceptions

from backend import create_app
from backend.saved_store import FirestoreSavedStore
from backend.vercel_credentials import VercelOidcTokenSupplier, workload_identity_credentials

SETTINGS = {'GCP_PROJECT_NUMBER': '123456789012', 'GCP_WORKLOAD_IDENTITY_POOL_ID': 'synthetic-pool',
            'GCP_WORKLOAD_IDENTITY_POOL_PROVIDER_ID': 'synthetic-provider',
            'GCP_SERVICE_ACCOUNT_EMAIL': 'synthetic@synthetic-project.iam.gserviceaccount.com'}


class VercelCredentialTests(unittest.TestCase):
    def test_without_settings_keeps_application_default_credentials(self):
        self.assertIsNone(workload_identity_credentials({}, VercelOidcTokenSupplier()))

    def test_partial_settings_fail_startup(self):
        partial = dict(SETTINGS, GCP_SERVICE_ACCOUNT_EMAIL=None)
        with self.assertRaises(ValueError):
            workload_identity_credentials(partial, VercelOidcTokenSupplier())

    def test_credentials_target_pool_provider_and_service_account(self):
        credentials = workload_identity_credentials(SETTINGS, VercelOidcTokenSupplier())
        self.assertEqual(credentials._audience, '//iam.googleapis.com/projects/123456789012/locations/global/'
                         'workloadIdentityPools/synthetic-pool/providers/synthetic-provider')
        self.assertEqual(credentials.service_account_email, SETTINGS['GCP_SERVICE_ACCOUNT_EMAIL'])

    def test_supplier_returns_latest_token_and_ignores_missing_headers(self):
        supplier = VercelOidcTokenSupplier('synthetic-startup-token')
        supplier.remember('synthetic-request-token')
        supplier.remember(None)
        self.assertEqual(supplier.get_subject_token(None, None), 'synthetic-request-token')

    def test_supplier_without_token_raises_refresh_error(self):
        with self.assertRaises(exceptions.RefreshError):
            VercelOidcTokenSupplier().get_subject_token(None, None)

    def test_app_remembers_request_token_and_passes_credentials_to_store(self):
        with patch.dict('os.environ', {'VERCEL_OIDC_TOKEN': ''}), \
                patch('backend.saved_store.firestore.Client') as client:
            app = create_app({'TESTING': True, 'GOOGLE_CLIENT_ID': 'synthetic-test-client.apps.googleusercontent.com',
                              'FIRESTORE_PROJECT_ID': 'synthetic-project', **SETTINGS})
            app.test_client().post('/auth/verify', headers={'x-vercel-oidc-token': 'synthetic-request-token'})
            self.assertEqual(app.extensions['vercel_oidc'].get_subject_token(None, None), 'synthetic-request-token')
            store = app.extensions['saved_data_store']
            self.assertIsInstance(store, FirestoreSavedStore)
            store.client
            self.assertIs(client.call_args.kwargs['credentials'], store.credentials)
            self.assertIsNotNone(store.credentials)


if __name__ == '__main__':
    unittest.main()
