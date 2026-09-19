from flask import Flask, request, jsonify
from dotenv import load_dotenv
from flask_cors import CORS
import json
import logging

from backend.models import Driver, Passenger
from backend.optimizer import give_paths

# In-memory storage for optimized routes
optimized_routes_store = {}

# Load environment variables from .env file
load_dotenv()

app = Flask(__name__)
CORS(app)  # Enable CORS for cross-origin requests
app.logger.setLevel(logging.INFO)
logging.basicConfig(level=logging.DEBUG)

@app.route('/routeoptimizer/', methods=['POST'])
def route_optimizer():
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return jsonify({'error': 'Request body must be a JSON object'}), 400

    driver_location = data.get('drivers')
    passenger_location = data.get('passengers')
    destination = data.get('destination')

    # Top-level shape checks.
    if not isinstance(driver_location, list) or len(driver_location) == 0:
        return jsonify({'error': 'drivers must be a non-empty list'}), 400
    if not isinstance(passenger_location, list) or len(passenger_location) == 0:
        return jsonify({'error': 'passengers must be a non-empty list'}), 400
    if not isinstance(destination, dict) or 'lat' not in destination or 'lng' not in destination:
        return jsonify({'error': 'destination must include lat and lng'}), 400
    try:
        dest_lat = float(destination['lat'])
        dest_lng = float(destination['lng'])
    except (TypeError, ValueError):
        return jsonify({'error': 'destination lat/lng must be numbers'}), 400

    # Initialize drivers, validating each entry.
    drivers = []
    total_capacity = 0
    for i, driver in enumerate(driver_location):
        if not isinstance(driver, dict):
            return jsonify({'error': f'driver[{i}] must be an object'}), 400
        location = driver.get('location')
        if not isinstance(location, dict) or 'lat' not in location or 'lng' not in location:
            return jsonify({'error': f'driver[{i}].location must include lat and lng'}), 400
        try:
            lat = float(location['lat'])
            lng = float(location['lng'])
        except (TypeError, ValueError):
            return jsonify({'error': f'driver[{i}] location must be numbers'}), 400
        capacity = driver.get('capacity')
        if not isinstance(capacity, int) or isinstance(capacity, bool) or capacity <= 0:
            return jsonify({'error': f'driver[{i}].capacity must be a positive integer'}), 400
        total_capacity += capacity
        drivers.append(Driver(lng, lat, capacity, i))

    # Initialize passengers, validating each entry.
    passengers = []
    for i, passenger in enumerate(passenger_location):
        if not isinstance(passenger, dict):
            return jsonify({'error': f'passenger[{i}] must be an object'}), 400
        if 'lat' not in passenger or 'lng' not in passenger:
            return jsonify({'error': f'passenger[{i}] must include lat and lng'}), 400
        try:
            lat = float(passenger['lat'])
            lng = float(passenger['lng'])
        except (TypeError, ValueError):
            return jsonify({'error': f'passenger[{i}] lat/lng must be numbers'}), 400
        passengers.append(Passenger(lng, lat, i))

    if total_capacity < len(passengers):
        return jsonify({
            'error': (
                f'insufficient total driver capacity ({total_capacity}) '
                f'for {len(passengers)} passengers'
            )
        }), 400

    # Process destination (stored as (lng, lat) to match Driver/Passenger).
    dest = (dest_lng, dest_lat)

    # Get optimized paths
    paths = give_paths(drivers=drivers, passengers=passengers, destination=dest)

    optimizedRoutes = [
        [{'lat': coord[1], 'lng': coord[0]} for coord in paths[j]] for j in range(len(paths))
    ]

    # Log and store optimized routes
    app.logger.info("Optimized Routes: " + json.dumps(optimizedRoutes, indent=4))
    optimized_routes_store['routes'] = optimizedRoutes

    return jsonify({'status': 'success', 'optimizedRoutes': optimizedRoutes}), 200


# GET to return the last computed optimized routes
@app.route('/routeoptimizer/', methods=['GET'])
def get_optimized_routes():
    # Check if there are stored optimized routes
    if 'routes' not in optimized_routes_store:
        return jsonify({'error': 'No routes available. Submit data first using POST.'}), 404
    
    # Return the stored optimized routes
    return jsonify({'optimizedRoutes': optimized_routes_store['routes'], 'status': 'success'}), 200

if __name__ == '__main__':
    app.run(debug=True)
