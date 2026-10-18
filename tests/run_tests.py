"""Run discovery with synthetic startup config, before root app imports dotenv."""
import sys
import unittest
from unittest.mock import patch


def main():
    with patch('dotenv.load_dotenv', return_value=False), patch.dict('os.environ', {
        'GOOGLE_CLIENT_ID': 'synthetic-test-client.apps.googleusercontent.com',
        'CORS_ALLOWED_ORIGINS': 'http://localhost:3000',
    }):
        suite = unittest.defaultTestLoader.discover('tests')
        return 0 if unittest.TextTestRunner(verbosity=2).run(suite).wasSuccessful() else 1


if __name__ == '__main__':
    sys.exit(main())
