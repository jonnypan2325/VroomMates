from flask import Flask, request, jsonify
from dotenv import load_dotenv
from flask_cors import CORS
import os

load_dotenv()  # Load environment variables from .env file

app = Flask(__name__)
CORS(app)

@app.route('/routeoptimizer', methods=['POST'])
def route_optimizer():
    google_maps_api_key = os.getenv('GOOGLE_MAPS_API_KEY')  # Access the API key
    # Use google_maps_api_key in your logic as needed

    data = request.get_json()
    driver_location = data.get('driverLocation')
    passenger_location = data.get('passengerLocation')
    destination = data.get('destination')

    # Example: Just printing the data for now
    # print("Driver Location:", driver_location)
    # print("Passenger Location:", passenger_location)
    # print("Destination:", destination)

    # PASS TO BACKEND HEREREERE
    #             ^^return route
    # Implement your route optimization logic here and return the result
    return jsonify({
        'status': 'success',
        'message': 'Route optimization performed',
        'route': 'route'
    })

    # {
    #     Driver1: {
    #         location,
    #         loaction,
    #         ...
    #     },
    #     Driver2: {
    #         location,
    #         location
    #     },
    #     ...
    # }

if __name__ == '__main__':
    app.run(debug=True)
