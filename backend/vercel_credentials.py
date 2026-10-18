"""Firestore credentials from Vercel's OIDC token through Workload Identity Federation."""
import threading
from google.auth import exceptions, identity_pool

SETTINGS = ('GCP_PROJECT_NUMBER', 'GCP_WORKLOAD_IDENTITY_POOL_ID',
            'GCP_WORKLOAD_IDENTITY_POOL_PROVIDER_ID', 'GCP_SERVICE_ACCOUNT_EMAIL')


class VercelOidcTokenSupplier(identity_pool.SubjectTokenSupplier):
    """Vercel sends the token per request; SDK refresh may run on another thread."""
    def __init__(self, token=None):
        self._token = token
        self._lock = threading.Lock()

    def remember(self, token):
        if token:
            with self._lock:
                self._token = token

    def get_subject_token(self, context, request):
        with self._lock:
            token = self._token
        if not token:
            raise exceptions.RefreshError('Vercel OIDC token unavailable')
        return token


def workload_identity_credentials(config, supplier):
    values = [config.get(name) for name in SETTINGS]
    if not any(values):
        return None  # Local development keeps Application Default Credentials.
    if not all(values):
        raise ValueError('Workload Identity Federation requires ' + ', '.join(SETTINGS))
    number, pool, provider, account = values
    return identity_pool.Credentials(
        audience=f'//iam.googleapis.com/projects/{number}/locations/global/workloadIdentityPools/{pool}/providers/{provider}',
        subject_token_type='urn:ietf:params:oauth:token-type:jwt',
        token_url='https://sts.googleapis.com/v1/token',
        service_account_impersonation_url=f'https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/{account}:generateAccessToken',
        subject_token_supplier=supplier,
        scopes=['https://www.googleapis.com/auth/datastore'])
