from flask import Flask, request, jsonify
from dotenv import load_dotenv
from flask_cors import CORS
import math
import heapq
import json
import logging


def haversine_distance(coord1, coord2, R=3959):
    '''
    Great-circle distance in miles between two (lng, lat) coordinates.

    Note: this module stores all coordinates as (longitude, latitude)
    tuples (Driver/Passenger.get_coords() and the destination tuple).
    R defaults to the Earth radius in miles.
    '''
    lng1, lat1 = coord1
    lng2, lat2 = coord2
    lat1_r = math.radians(lat1)
    lat2_r = math.radians(lat2)
    dlat = lat2_r - lat1_r
    dlon = math.radians(lng2 - lng1)
    a = math.sin(dlat / 2) ** 2 + math.cos(lat1_r) * math.cos(lat2_r) * math.sin(dlon / 2) ** 2
    return 2 * R * math.asin(math.sqrt(a))


#The algorithm to get the most optimal paths
class Driver:
    def __init__(self,x,y,capacity, driver_num):
        self.x = x
        self.y = y
        self.capacity = capacity
        self.driver_num = driver_num
        self.passengers = []

    def get_coords(self):
        return (self.x,self.y)

    def get_capacity(self):
        return self.capacity

    def get_driver_num(self):
        return self.driver_num

    def add_passenger(self, passenger):
        self.passengers.append(passenger)
        self.capacity = self.capacity - 1

    def get_passengers(self):
        return self.passengers

    def get_path(self, destination):
        if not self.passengers:
            return [self.get_coords(), destination]
        open_list = [(0, (self.get_coords(), tuple(self.passengers), []))]

        visited = set()

        while(open_list):
            cost, (current_position, remaining_passengers, path_taken) = heapq.heappop(open_list)

            if (current_position, remaining_passengers) in visited:
                continue

            visited.add((current_position, remaining_passengers))

            if not remaining_passengers and current_position == destination:
                return [self.get_coords()] + path_taken

            for i, passenger in enumerate(remaining_passengers):
                new_cost = cost + haversine_distance(current_position, passenger.get_coords()) + haversine_distance(passenger.get_coords(), destination)
                new_remaining_passengers = remaining_passengers[:i] + remaining_passengers[i+1:]
                new_path = path_taken + [passenger.get_coords()]
                if (passenger.get_coords(), new_remaining_passengers) not in visited:
                    heapq.heappush(open_list, (new_cost,(passenger.get_coords(),new_remaining_passengers,new_path)))

            if not remaining_passengers:
                heapq.heappush(open_list, (cost+haversine_distance(current_position, destination), (destination, remaining_passengers, path_taken+[destination])))


class Passenger:
    def __init__(self,x,y, passenger_num):
        self.x = x
        self.y = y
        self.passenger_num = passenger_num

    def get_coords(self):
        return (self.x,self.y)

    def get_passenger_num(self):
        return self.passenger_num

def distance_from_line(passenger, driver, destination):
    '''
    Detour cost (in miles) for `driver` to pick up `passenger` and continue
    to `destination`, compared to driving straight to the destination:

        detour = d(driver -> passenger) + d(passenger -> destination)
                 - d(driver -> destination)

    By the triangle inequality this is always >= 0. Lower means the
    passenger is a better fit for this driver's route, so it's a useful
    pairwise score for assignment optimization.
    '''
    driver_to_passenger = haversine_distance(driver.get_coords(), passenger.get_coords())
    passenger_to_dest = haversine_distance(passenger.get_coords(), destination)
    driver_to_dest = haversine_distance(driver.get_coords(), destination)
    return (driver_to_passenger + passenger_to_dest) - driver_to_dest


def assign_drivers(drivers, passengers, destination):
    '''
    Assigns each passenger to a driver using a global-greedy bipartite
    assignment over pairwise detour cost (see `distance_from_line`).

    Compared to the previous per-passenger greedy, this lets a passenger
    with one outstanding cheap match "win" that driver even if some other
    passenger is processed first in iteration order. Capacity is enforced
    via `driver.get_capacity()` / `driver.add_passenger()`.
    '''
    if not drivers or not passengers:
        return drivers

    candidates = []
    for passenger in passengers:
        for driver in drivers:
            cost = distance_from_line(passenger, driver, destination)
            candidates.append((
                cost,
                passenger.get_passenger_num(),
                driver.get_driver_num(),
            ))
    # Sort by cost ascending; ties broken deterministically by ids.
    candidates.sort()

    driver_by_num = {d.get_driver_num(): d for d in drivers}
    passenger_by_num = {p.get_passenger_num(): p for p in passengers}
    assigned = set()

    for _cost, pnum, dnum in candidates:
        if pnum in assigned:
            continue
        driver = driver_by_num[dnum]
        if driver.get_capacity() > 0:
            driver.add_passenger(passenger_by_num[pnum])
            assigned.add(pnum)
            if len(assigned) == len(passengers):
                break
    return drivers


def give_paths(drivers, passengers, destination):
    '''
    Returns one path per driver (in input order). A path is a list of
    (lng, lat) tuples starting at the driver and ending at `destination`.
    Drivers with no assigned passengers get a direct two-point path.
    '''
    drivers = assign_drivers(drivers, passengers, destination)
    paths = []
    for d in drivers:
        if not d.get_passengers():
            paths.append([d.get_coords(), destination])
            continue
        path = d.get_path(destination)
        if not path:
            # Defensive fallback: A* search returned nothing (should not
            # happen since destination is always reachable). Emit at
            # least the driver origin and destination so the frontend
            # gets a renderable route.
            path = [d.get_coords(), destination]
        paths.append(path)
    return paths

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