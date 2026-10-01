import logging

from dotenv import load_dotenv
from flask import Flask
from flask_cors import CORS

from .routes import register_routes


def create_app():
    load_dotenv()
    app = Flask(__name__)
    CORS(app)
    app.logger.setLevel(logging.INFO)
    logging.basicConfig(level=logging.DEBUG)
    register_routes(app)
    return app
