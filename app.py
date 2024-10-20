from flask import Flask, request, jsonify
from dotenv import load_dotenv
from flask_cors import CORS
import os

# Load environment variables from .env file
load_dotenv()

app = Flask(__name__)
CORS(app)  # Enable CORS after defining the app

@app.route('/routeoptimizer', methods=['POST'])
def route_optimizer():
    google_maps_api_key = os.getenv('GOOGLE_MAPS_API_KEY')  # Access the API key

    # Extract data from request
    data = request.get_json()
    driver_location = data.get('drivers')
    passenger_location = data.get('passengers')
    destination = data.get('destination')

    # Return a sample response
    return jsonify({
        'status': 'success',
        'message': 'Route optimization performed',
        'route': 'route',
        '1': driver_location,
        '2': passenger_location,
        '3': destination,
    })

if __name__ == '__main__':
    app.run(debug=True)
