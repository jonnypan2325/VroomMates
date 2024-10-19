from flask import Flask, request, jsonify
from flask_cors import CORS

app = Flask(__name__)
CORS(app)  # Enable CORS for all routes

@app.route('/routeoptimizer', methods=['POST'])
def index():
    return jsonify({"message": "Hello from Flask on Vercel!"})

def route_optimizer():
    data = request.get_json()  # Get the JSON data sent from the frontend
    driver_location = data.get('driverLocation')
    passenger_location = data.get('passengerLocation')
    destination = data.get('destination')

    # Example: Run your Python route optimization algorithm here
    print('Driver Location:', driver_location)
    print('Passenger Location:', passenger_location)
    print('Destination:', destination)

    # Simulate optimized route calculation (stub data for demonstration)
    optimized_route = {
        'driverToPassenger': {'distance': '5km', 'duration': '10 minutes'},
        'passengerToDestination': {'distance': '15km', 'duration': '25 minutes'}
    }

    # Send back the optimized route as a JSON response
    return jsonify({
        'success': True,
        'route': optimized_route
    })

if __name__ == '__main__':
    app.run(debug=True, port=5000)  # Run the Flask app on port 5000
