"""Real Google verifier with synthetic RSA proof; no credentials or network."""
import base64
from datetime import datetime, timezone
from email.utils import formatdate
import io
import http.client
import json
import unittest
from unittest.mock import patch

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec, padding, rsa
from cryptography.x509.oid import NameOID
from google.auth import exceptions
import requests
from urllib3.response import HTTPResponse

from backend import create_app
from backend.auth import BoundedCertificateRequest, GoogleIdentityVerifier, InvalidCredential

NOW = 1900000000
AUDIENCE = 'synthetic-test-client.apps.googleusercontent.com'


def b64(value):
    return base64.urlsafe_b64encode(value).rstrip(b'=').decode()


def claims(**changes):
    return dict(iss='https://accounts.google.com', aud=AUDIENCE, sub='synthetic-account-a',
                iat=NOW-60, exp=NOW+3600, **{}) | changes


class CertificateTransport:
    def __init__(self, certificates):
        self.certificates = certificates
        self.calls = 0
        self.available = True

    def __call__(self, url, **kwargs):
        self.calls += 1
        if not self.available:
            raise exceptions.TransportError('synthetic outage')
        return type('Response', (), {'status': 200, 'data': json.dumps(self.certificates).encode()})()


class AuthTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        cls.other_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, 'Synthetic fixture only')])
        cert = (x509.CertificateBuilder().subject_name(name).issuer_name(name)
                .public_key(cls.key.public_key()).serial_number(1)
                .not_valid_before(datetime(2020, 1, 1, tzinfo=timezone.utc))
                .not_valid_after(datetime(2035, 1, 1, tzinfo=timezone.utc))
                .sign(cls.key, hashes.SHA256()))
        cls.certificate = cert.public_bytes(serialization.Encoding.PEM).decode()
        ec_key = ec.generate_private_key(ec.SECP256R1())
        ec_cert = (x509.CertificateBuilder().subject_name(name).issuer_name(name)
                   .public_key(ec_key.public_key()).serial_number(2)
                   .not_valid_before(datetime(2020, 1, 1, tzinfo=timezone.utc))
                   .not_valid_after(datetime(2035, 1, 1, tzinfo=timezone.utc))
                   .sign(ec_key, hashes.SHA256()))
        cls.ec_certificate = ec_cert.public_bytes(serialization.Encoding.PEM).decode()

    def setUp(self):
        self.clock = NOW
        self.transport = CertificateTransport({'fixture-key': self.certificate})
        self.app = create_app({'TESTING': True, 'GOOGLE_CLIENT_ID': AUDIENCE,
                               'GOOGLE_CERTIFICATE_REQUEST': self.transport,
                               'AUTH_CLOCK': lambda: self.clock,
                               'CORS_ALLOWED_ORIGINS': ['http://localhost:3000', 'https://synthetic.example']})
        self.client = self.app.test_client()
        self.time_patch = patch('google.auth._helpers.utcnow', side_effect=lambda: datetime.fromtimestamp(self.clock, timezone.utc).replace(tzinfo=None))
        self.time_patch.start()
        self.addCleanup(self.time_patch.stop)

    def token(self, payload=None, key=None, header=None):
        header = header or {'alg': 'RS256', 'kid': 'fixture-key', 'typ': 'JWT'}
        unsigned = f'{b64(json.dumps(header).encode())}.{b64(json.dumps(payload if payload is not None else claims()).encode())}'
        signature = (key or self.key).sign(unsigned.encode(), padding.PKCS1v15(), hashes.SHA256())
        return f'{unsigned}.{b64(signature)}'

    def probe(self, token=None, **kwargs):
        return self.client.post('/auth/verify', headers={'Authorization': f'Bearer {token or self.token()}', **kwargs.pop('headers', {})}, **kwargs)

    def assert_error(self, response, status, code):
        self.assertEqual(response.status_code, status)
        self.assertEqual(response.json['code'], code)
        self.assertIsInstance(response.json['error'], str)
        self.assertEqual(response.headers['Cache-Control'], 'no-store')
        if status == 401:
            self.assertEqual(response.headers['WWW-Authenticate'], 'Bearer')

    def test_verified_minimal_identity_and_optional_name(self):
        result = self.probe(self.token(claims(given_name='Fixture', email='ignored@example.invalid')))
        self.assertEqual(result.status_code, 200)
        self.assertEqual(result.json, {'status': 'success', 'user': {'id': 'google:synthetic-account-a', 'given_name': 'Fixture'}, 'expires_at': NOW+3600})
        self.assertEqual(result.headers['Cache-Control'], 'no-store')
        result = self.probe(self.token(claims(given_name=None)))
        self.assertEqual(result.json['user'], {'id': 'google:synthetic-account-a'})

    def test_subject_is_stable_and_request_local_between_accounts(self):
        a = self.probe(self.token(claims(email='a@example.invalid', given_name='A'))).json['user']['id']
        b = self.probe(self.token(claims(sub='synthetic-account-b', given_name='B'))).json['user']['id']
        changed = self.probe(self.token(claims(iss='accounts.google.com', email='new@example.invalid', given_name='Changed'))).json['user']['id']
        self.assertEqual(a, changed)
        self.assertNotEqual(a, b)
        self.assert_error(self.client.post('/auth/verify'), 401, 'AUTH_REQUIRED')

    def test_real_signature_audience_issuer_and_jwt_rejections(self):
        invalid = [self.token(key=self.other_key), self.token(header={'alg': 'RS256', 'kid': 'unknown'}),
                   self.token(claims(aud='another-client')), self.token(claims(iss='https://attacker.invalid')),
                   'opaque-access-token', 'malformed.jwt.token',
                   b64(json.dumps({"alg": "none"}).encode()) + "." + b64(json.dumps(claims()).encode()) + ".",
                   self.token(header={'alg': 'HS256', 'kid': 'fixture-key'})]
        for token in invalid:
            with self.subTest(case=invalid.index(token)):
                self.assert_error(self.probe(token), 401, 'INVALID_CREDENTIAL')

    def test_required_claims_and_types(self):
        cases = []
        for field in ('sub', 'exp', 'iat', 'aud', 'iss'):
            payload = claims()
            del payload[field]
            cases.append(payload)
        for field, values in {'sub': [None, '', ' ', 3, [], 'x'*256],
                              'exp': [None, True, '1900003600', NOW+0.5, [], {}],
                              'iat': [None, True, str(NOW-60), NOW-0.5, [], {}],
                              'aud': [None, [], [AUDIENCE]], 'iss': [None, [], {}]}.items():
            cases.extend(claims(**{field: value}) for value in values)
        for index, payload in enumerate(cases):
            with self.subTest(case=index):
                self.assert_error(self.probe(self.token(payload)), 401, 'INVALID_CREDENTIAL')

    def test_expiry_boundary_future_issued_and_each_request(self):
        for payload in (claims(exp=NOW), claims(exp=NOW-1), claims(iat=NOW+1), claims(iat=NOW, exp=NOW)):
            self.assert_error(self.probe(self.token(payload)), 401, 'INVALID_CREDENTIAL')
        token = self.token(claims(exp=NOW+1))
        self.assertEqual(self.probe(token).status_code, 200)
        # Local logout has no server revocation: copied proof remains usable until expiry.
        self.assertEqual(self.probe(token).status_code, 200)
        self.clock += 1
        self.assert_error(self.probe(token), 401, 'INVALID_CREDENTIAL')

    def test_structurally_invalid_jwts_do_not_fetch_keys_during_outage(self):
        self.transport.available = False
        malformed = [
            'malformed.jwt.token', 'A.e30.YQ',
            f'{b64(b"not-json")}.{b64(json.dumps(claims()).encode())}.YQ',
            f'{b64(b"[]")}.{b64(json.dumps(claims()).encode())}.YQ',
            f'{b64(json.dumps({"alg": "RS256"}).encode())}.{b64(b"[]")}.YQ',
            f'{b64(json.dumps({"alg": "RS256"}).encode())}.{b64(b"not-json")}.YQ',
            self.token(header={'alg': 'none'}), self.token(header={'alg': 'HS256'}),
            self.token(header={'alg': 'RS256', 'crit': ['unknown']}),
            'e30.e30.A',
        ]
        for index, credential in enumerate(malformed):
            with self.subTest(case=index):
                self.assert_error(self.probe(credential), 401, 'INVALID_CREDENTIAL')
                self.assertEqual(self.transport.calls, 0)

    def test_missing_and_malformed_bearer(self):
        self.assert_error(self.client.post('/auth/verify'), 401, 'AUTH_REQUIRED')
        for value in ('', 'Bearer', 'Bearer ', 'Basic abc', 'Bearer one two', 'Bearer one,Bearer two', 'Bearer '+('x'*16385)):
            self.assert_error(self.client.post('/auth/verify', headers={'Authorization': value}), 401, 'INVALID_CREDENTIAL')

    def test_no_profile_owner_or_audience_inputs(self):
        for kwargs in ({'json': {}}, {'json': {'owner': 'injected', 'client_id': AUDIENCE}}, {'data': ' '}, {'query_string': {'owner': 'injected'}}):
            self.assert_error(self.probe(**kwargs), 400, 'INVALID_AUTH_REQUEST')
        self.assert_error(self.client.post('/auth/verify', json={'owner': 'injected'}), 401, 'AUTH_REQUIRED')

    def test_key_service_unavailable_and_recovers_without_cached_auth_success(self):
        self.transport.available = False
        self.assert_error(self.probe(), 503, 'AUTH_UNAVAILABLE')
        self.transport.available = True
        self.assertEqual(self.probe().status_code, 200)
        self.transport.available = False
        self.assert_error(self.probe(), 503, 'AUTH_UNAVAILABLE')

    def test_malformed_certificate_service_responses_fail_closed(self):
        for certificates in ({}, [], {'fixture-key': 'invalid certificate'}, {'fixture-key': self.ec_certificate}, {'keys': []}):
            self.transport.certificates = certificates
            self.assert_error(self.probe(), 503, 'AUTH_UNAVAILABLE')
        self.transport.available = False
        self.assert_error(self.probe('opaque-access-token'), 401, 'INVALID_CREDENTIAL')

    def test_preflight_is_public_and_exact_origin_only(self):
        headers = {'Origin': 'https://synthetic.example', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type'}
        response = self.client.options('/auth/verify', headers=headers)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.transport.calls, 0)
        self.assertEqual(response.headers['Access-Control-Allow-Origin'], 'https://synthetic.example')
        self.assertIn('authorization', response.headers['Access-Control-Allow-Headers'].lower())
        self.assertNotIn('Access-Control-Allow-Credentials', response.headers)
        self.assertIn('Origin', response.headers['Vary'])
        headers['Origin'] = 'https://synthetic.example.attacker.invalid'
        response = self.client.options('/auth/verify', headers=headers)
        self.assertNotIn('Access-Control-Allow-Origin', response.headers)

    def test_cors_on_controlled_errors(self):
        response = self.client.post('/auth/verify', headers={'Origin': 'http://localhost:3000'})
        self.assertEqual(response.headers['Access-Control-Allow-Origin'], 'http://localhost:3000')
        self.assertNotIn('Access-Control-Allow-Credentials', response.headers)
        self.transport.available = False
        response = self.probe(headers={'Origin': 'http://localhost:3000'})
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.headers['Access-Control-Allow-Origin'], 'http://localhost:3000')

    def test_no_sensitive_error_logs(self):
        with patch.object(self.app.logger, 'error') as error, patch.object(self.app.logger, 'warning') as warning:
            response = self.probe(self.token(claims(sub='sensitive-fixture-marker', aud='wrong')))
            self.assertNotIn('sensitive-fixture-marker', response.get_data(as_text=True))
            error.assert_not_called()
            warning.assert_not_called()

    def test_fail_closed_configuration_and_dotenv_bypass(self):
        with patch('backend.load_dotenv') as dotenv:
            with self.assertRaisesRegex(ValueError, 'GOOGLE_CLIENT_ID'):
                create_app({'GOOGLE_CLIENT_ID': None})
            dotenv.assert_not_called()
        for origin in ('*', 'https://*.example', 'https://example/path', 'null', 'https://user:pass@example', 'https://example:bad'):
            with self.assertRaisesRegex(ValueError, 'CORS_ALLOWED_ORIGINS'):
                create_app({'GOOGLE_CLIENT_ID': AUDIENCE, 'CORS_ALLOWED_ORIGINS': origin})

    def test_ipv6_origin_is_literal_not_a_regex(self):
        app = create_app({'GOOGLE_CLIENT_ID': AUDIENCE, 'CORS_ALLOWED_ORIGINS': ['http://[::1]:3000']})
        client = app.test_client()
        allowed = client.post('/auth/verify', headers={'Origin': 'http://[::1]:3000'})
        denied = client.post('/auth/verify', headers={'Origin': 'http://1:3000'})
        self.assertEqual(allowed.headers.get('Access-Control-Allow-Origin'), 'http://[::1]:3000')
        self.assertNotIn('Access-Control-Allow-Origin', denied.headers)

    def test_http_certificate_cache_freshness_rotation_and_timeout(self):
        transport = BoundedCertificateRequest(timeout=2.5)
        payloads = [{'fixture-key': self.certificate}, {'rotated-key': self.certificate}]
        calls = []
        def send(adapter, prepared, stream=False, timeout=None, verify=True, cert=None, proxies=None):
            calls.append(timeout)
            data = json.dumps(payloads[min(len(calls)-1, 1)]).encode()
            headers = {'Cache-Control': 'public, max-age=60', 'Date': formatdate(self.clock, usegmt=True), 'Content-Length': str(len(data))}
            wire = b'HTTP/1.1 200 OK\r\n' + ''.join(f'{key}: {value}\r\n' for key, value in headers.items()).encode() + b'\r\n' + data
            sock = type('FixtureSocket', (), {'makefile': lambda *_args: io.BytesIO(wire)})()
            original = http.client.HTTPResponse(sock)
            original.begin()
            raw = HTTPResponse(body=original, headers=headers, status=200, original_response=original, preload_content=False)
            return adapter.build_response(prepared, raw)
        # HTTPAdapter is below CacheControlAdapter: exercise the actual cache without network.
        with patch('requests.adapters.HTTPAdapter.send', autospec=True, side_effect=send), patch('time.time', return_value=NOW):
            verifier = GoogleIdentityVerifier(AUDIENCE, transport, clock=lambda: self.clock)
            self.assertEqual(verifier.verify(self.token()).subject, 'synthetic-account-a')
            self.assertEqual(verifier.verify(self.token()).subject, 'synthetic-account-a')
            self.assertEqual(calls, [2.5])
            with patch('requests.adapters.HTTPAdapter.send', side_effect=requests.Timeout()):
                self.assertEqual(verifier.verify(self.token()).subject, 'synthetic-account-a')
        self.clock += 61
        with patch('requests.adapters.HTTPAdapter.send', autospec=True, side_effect=send), patch('time.time', return_value=NOW+61):
            self.assertEqual(verifier.verify(self.token(header={'alg': 'RS256', 'kid': 'rotated-key'})).subject, 'synthetic-account-a')
            self.assertEqual(calls, [2.5, 2.5])
        self.clock += 61
        with patch('requests.adapters.HTTPAdapter.send', side_effect=requests.Timeout()), patch('time.time', return_value=NOW+122):
            from backend.auth import VerificationUnavailable
            with self.assertRaises(VerificationUnavailable):
                verifier.verify(self.token(header={'alg': 'RS256', 'kid': 'rotated-key'}))
