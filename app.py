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

# Shared in-memory state. Mutated by both the legacy /routeoptimizer/ bulk
# endpoint and the per-entity /api/* CRUD endpoints, so curl/Postman GETs
# reflect what the UI last submitted.
_state = {
    'drivers': {},        # id (int) -> {'location': {'lat', 'lng'}, 'capacity': int}
    'passengers': {},     # id (int) -> {'location': {'lat', 'lng'}}
    'destination': None,  # {'lat', 'lng'} or None
    'routes': [],         # list of routes; each route is a list of {lat, lng} dicts
    '_next_driver_id': 1,
    '_next_passenger_id': 1,
}


def _reset_state():
    _state['drivers'].clear()
    _state['passengers'].clear()
    _state['destination'] = None
    _state['routes'] = []
    _state['_next_driver_id'] = 1
    _state['_next_passenger_id'] = 1


def _parse_location(obj):
    '''Returns ({'lat', 'lng'}, None) on success or (None, error_message).'''
    if not isinstance(obj, dict) or 'lat' not in obj or 'lng' not in obj:
        return None, 'location must include lat and lng'
    try:
        lat = float(obj['lat'])
        lng = float(obj['lng'])
    except (TypeError, ValueError):
        return None, 'lat and lng must be numbers'
    return {'lat': lat, 'lng': lng}, None


def _parse_capacity(val):
    '''Returns (int, None) on success or (None, error_message).'''
    if not isinstance(val, int) or isinstance(val, bool) or val <= 0:
        return None, 'capacity must be a positive integer'
    return val, None


def _snapshot():
    '''Public view of state (omits private cursors).'''
    return {
        'drivers': [{'id': i, **d} for i, d in sorted(_state['drivers'].items())],
        'passengers': [{'id': i, **p} for i, p in sorted(_state['passengers'].items())],
        'destination': _state['destination'],
        'routes': _state['routes'],
    }


def _run_optimizer():
    '''Materializes optimizer objects from _state, runs give_paths, stores and
    returns optimizedRoutes. Returns (routes, None) or (None, (error, status)).'''
    if not _state['drivers']:
        return None, ('drivers must be non-empty', 400)
    if not _state['passengers']:
        return None, ('passengers must be non-empty', 400)
    if _state['destination'] is None:
        return None, ('destination is not set', 400)

    drivers = []
    total_capacity = 0
    for i, (did, d) in enumerate(sorted(_state['drivers'].items())):
        drivers.append(Driver(d['location']['lng'], d['location']['lat'], d['capacity'], did))
        total_capacity += d['capacity']

    passengers = []
    for pid, p in sorted(_state['passengers'].items()):
        passengers.append(Passenger(p['location']['lng'], p['location']['lat'], pid))

    if total_capacity < len(passengers):
        return None, (
            f'insufficient total driver capacity ({total_capacity}) '
            f'for {len(passengers)} passengers',
            400,
        )

    dest = (_state['destination']['lng'], _state['destination']['lat'])
    paths = give_paths(drivers=drivers, passengers=passengers, destination=dest)
    optimized = [
        [{'lat': coord[1], 'lng': coord[0]} for coord in path] for path in paths
    ]
    _state['routes'] = optimized
    return optimized, None


# Load environment variables from .env file
load_dotenv()

app = Flask(__name__)
CORS(app)  # Enable CORS for cross-origin requests
app.logger.setLevel(logging.INFO)
logging.basicConfig(level=logging.DEBUG)


# --- Legacy bulk endpoint (kept; now mirrors into _state) -------------------

@app.route('/routeoptimizer/', methods=['POST'])
def route_optimizer():
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return jsonify({'error': 'Request body must be a JSON object'}), 400

    driver_location = data.get('drivers')
    passenger_location = data.get('passengers')
    destination = data.get('destination')

    if not isinstance(driver_location, list) or len(driver_location) == 0:
        return jsonify({'error': 'drivers must be a non-empty list'}), 400
    if not isinstance(passenger_location, list) or len(passenger_location) == 0:
        return jsonify({'error': 'passengers must be a non-empty list'}), 400

    dest_loc, err = _parse_location(destination)
    if err:
        return jsonify({'error': f'destination: {err}'}), 400

    new_drivers = {}
    next_did = 1
    for i, driver in enumerate(driver_location):
        if not isinstance(driver, dict):
            return jsonify({'error': f'driver[{i}] must be an object'}), 400
        loc, err = _parse_location(driver.get('location'))
        if err:
            return jsonify({'error': f'driver[{i}].location: {err}'}), 400
        cap, err = _parse_capacity(driver.get('capacity'))
        if err:
            return jsonify({'error': f'driver[{i}].capacity: {err}'}), 400
        new_drivers[next_did] = {'location': loc, 'capacity': cap}
        next_did += 1

    new_passengers = {}
    next_pid = 1
    for i, passenger in enumerate(passenger_location):
        if not isinstance(passenger, dict):
            return jsonify({'error': f'passenger[{i}] must be an object'}), 400
        loc, err = _parse_location(passenger)
        if err:
            return jsonify({'error': f'passenger[{i}]: {err}'}), 400
        new_passengers[next_pid] = {'location': loc}
        next_pid += 1

    # Replace state with the submitted payload (hybrid mirror behavior).
    _reset_state()
    _state['drivers'] = new_drivers
    _state['_next_driver_id'] = next_did
    _state['passengers'] = new_passengers
    _state['_next_passenger_id'] = next_pid
    _state['destination'] = dest_loc

    optimized, err = _run_optimizer()
    if err:
        msg, status = err
        return jsonify({'error': msg}), status

    app.logger.info('Optimized Routes: ' + json.dumps(optimized, indent=4))
    return jsonify({'status': 'success', 'optimizedRoutes': optimized}), 200


@app.route('/routeoptimizer/', methods=['GET'])
def get_optimized_routes():
    if not _state['routes']:
        return jsonify({'error': 'No routes available. Submit data first using POST.'}), 404
    return jsonify({'optimizedRoutes': _state['routes'], 'status': 'success'}), 200


# --- REST API for curl / Postman --------------------------------------------

@app.route('/api/state', methods=['GET'])
def api_get_state():
    return jsonify(_snapshot()), 200


@app.route('/api/clear', methods=['POST'])
def api_clear():
    _reset_state()
    return jsonify(_snapshot()), 200


@app.route('/api/drivers', methods=['GET'])
def api_list_drivers():
    return jsonify(_snapshot()['drivers']), 200


@app.route('/api/drivers', methods=['POST'])
def api_add_driver():
    data = request.get_json(silent=True) or {}
    loc, err = _parse_location(data.get('location'))
    if err:
        return jsonify({'error': f'location: {err}'}), 400
    cap, err = _parse_capacity(data.get('capacity'))
    if err:
        return jsonify({'error': f'capacity: {err}'}), 400
    did = _state['_next_driver_id']
    _state['_next_driver_id'] += 1
    _state['drivers'][did] = {'location': loc, 'capacity': cap}
    return jsonify({'id': did, 'location': loc, 'capacity': cap}), 201


@app.route('/api/drivers/<int:driver_id>', methods=['GET'])
def api_get_driver(driver_id):
    d = _state['drivers'].get(driver_id)
    if d is None:
        return jsonify({'error': f'driver {driver_id} not found'}), 404
    return jsonify({'id': driver_id, **d}), 200


@app.route('/api/drivers/<int:driver_id>', methods=['PUT'])
def api_update_driver(driver_id):
    d = _state['drivers'].get(driver_id)
    if d is None:
        return jsonify({'error': f'driver {driver_id} not found'}), 404
    data = request.get_json(silent=True) or {}
    if 'location' in data:
        loc, err = _parse_location(data['location'])
        if err:
            return jsonify({'error': f'location: {err}'}), 400
        d['location'] = loc
    if 'capacity' in data:
        cap, err = _parse_capacity(data['capacity'])
        if err:
            return jsonify({'error': f'capacity: {err}'}), 400
        d['capacity'] = cap
    return jsonify({'id': driver_id, **d}), 200


@app.route('/api/drivers/<int:driver_id>', methods=['DELETE'])
def api_delete_driver(driver_id):
    if _state['drivers'].pop(driver_id, None) is None:
        return jsonify({'error': f'driver {driver_id} not found'}), 404
    return jsonify({'status': 'deleted', 'id': driver_id}), 200


@app.route('/api/passengers', methods=['GET'])
def api_list_passengers():
    return jsonify(_snapshot()['passengers']), 200


@app.route('/api/passengers', methods=['POST'])
def api_add_passenger():
    data = request.get_json(silent=True) or {}
    loc, err = _parse_location(data.get('location'))
    if err:
        return jsonify({'error': f'location: {err}'}), 400
    pid = _state['_next_passenger_id']
    _state['_next_passenger_id'] += 1
    _state['passengers'][pid] = {'location': loc}
    return jsonify({'id': pid, 'location': loc}), 201


@app.route('/api/passengers/<int:passenger_id>', methods=['GET'])
def api_get_passenger(passenger_id):
    p = _state['passengers'].get(passenger_id)
    if p is None:
        return jsonify({'error': f'passenger {passenger_id} not found'}), 404
    return jsonify({'id': passenger_id, **p}), 200


@app.route('/api/passengers/<int:passenger_id>', methods=['PUT'])
def api_update_passenger(passenger_id):
    p = _state['passengers'].get(passenger_id)
    if p is None:
        return jsonify({'error': f'passenger {passenger_id} not found'}), 404
    data = request.get_json(silent=True) or {}
    if 'location' in data:
        loc, err = _parse_location(data['location'])
        if err:
            return jsonify({'error': f'location: {err}'}), 400
        p['location'] = loc
    return jsonify({'id': passenger_id, **p}), 200


@app.route('/api/passengers/<int:passenger_id>', methods=['DELETE'])
def api_delete_passenger(passenger_id):
    if _state['passengers'].pop(passenger_id, None) is None:
        return jsonify({'error': f'passenger {passenger_id} not found'}), 404
    return jsonify({'status': 'deleted', 'id': passenger_id}), 200


@app.route('/api/destination', methods=['GET'])
def api_get_destination():
    return jsonify(_state['destination']), 200


@app.route('/api/destination', methods=['PUT'])
def api_set_destination():
    loc, err = _parse_location(request.get_json(silent=True))
    if err:
        return jsonify({'error': err}), 400
    _state['destination'] = loc
    return jsonify(loc), 200


@app.route('/api/destination', methods=['DELETE'])
def api_clear_destination():
    _state['destination'] = None
    return jsonify({'status': 'deleted'}), 200


@app.route('/api/optimize', methods=['POST'])
def api_optimize():
    optimized, err = _run_optimizer()
    if err:
        msg, status = err
        return jsonify({'error': msg}), status
    return jsonify({'status': 'success', 'optimizedRoutes': optimized}), 200


@app.route('/api/routes', methods=['GET'])
def api_get_routes():
    return jsonify({'optimizedRoutes': _state['routes']}), 200


if __name__ == '__main__':
    app.run(debug=True)