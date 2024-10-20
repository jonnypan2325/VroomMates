from flask import Flask, request, jsonify
from dotenv import load_dotenv
from flask_cors import CORS
import os
import math
import heapq
import json
import logging
logging.basicConfig(level=logging.DEBUG)

routes = []

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
        def haversine_distance(coord1, coord2, R=3959):
            '''
            Calculates the distance between two points on the earth
            '''
            lat1, lon1 = coord1
            lat2, lon2 = coord2
            lat1 = math.radians(lat1)
            lon1 = math.radians(lon1)
            lat2 = math.radians(lat2)
            lon2 = math.radians(lon2)
            dlat = lat2 - lat1
            dlon = lon2 - lon1
            dist = 2 * R * math.sqrt((math.sin(dlat / 2) ** 2) + math.cos(lat1) * math.cos(lat2) * (math.sin(dlon / 2)**2))
            return dist
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

def distance_from_line(passenger, driver,destination):
    '''
    Returns the distance of the passenger from the path of the driver to the destination
    '''
    P_x, P_y = passenger.get_coords()
    A_x, A_y = driver.get_coords()
    B_x, B_y = destination
    offset = abs((B_x - A_x)*P_y + (A_y - B_y)*P_x - B_x*A_y + B_y*A_x)
    distance = math.sqrt((B_y-A_y)*(B_y-A_y) + (B_x-A_x)*(B_x-A_x))
    return offset/distance

def assign_drivers(drivers, passengers, destination):
    '''
    Assigns each passenger ot each driver based on the proximity to the path
    '''
    passengers_distances = []
    for passenger in passengers:
        path_distances = {}
        for driver in drivers:
            path_distances[distance_from_line(passenger,driver,destination)] = driver.get_driver_num()
        sorted_keys = sorted(path_distances)
        sorted_dict = {key:path_distances[key] for key in sorted_keys}
        passengers_distances.append(sorted_dict)
    for passenger in passengers:
        distances = passengers_distances[passenger.get_passenger_num()]
        for distance in distances.keys():
            driver = drivers[distances[distance]]
            if (driver.get_capacity() > 0):
                driver.add_passenger(passenger)
                break
    return drivers

def give_paths(passengers, drivers, destination):
    drivers = assign_drivers(drivers, passengers, destination)
    paths = []
    for d in drivers:
        paths.append(d.get_path(destination))
    return paths

# Load environment variables from .env file
logging.basicConfig(level=logging.DEBUG)

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
    data = request.get_json()

    # Validate input data

    driver_location = data.get('drivers')
    passenger_location = data.get('passengers')
    destination = data.get('destination')

    if not driver_location or not passenger_location or not destination:
        return jsonify({'error': 'Missing required data'}), 400

    # Initialize drivers and passengers
    drivers = []
    for i, driver in enumerate(driver_location):
        lat = driver['coordinates']['lat']
        lng = driver['coordinates']['lng']
        capacity = driver['capacity']
        drivers.append(Driver(lng, lat, capacity, i))

    passengers = []
    for i, passenger in enumerate(passenger_location):
        lat = passenger['coordinates']['lat']
        lng = passenger['coordinates']['lng']
        passengers.append(Passenger(lng, lat, i))

    # Process destination
    dest = (destination["lng"], destination["lat"])

    # Get optimized paths
    paths = give_paths(drivers=drivers, passengers=passengers, destination=dest)

    optimizedRoutes = [
        [{'lat': coord[1], 'lng': coord[0]} for coord in paths[j]] for j in range(len(paths))
    ]

    # Log and store optimized routes
    app.logger.info("Optimized Routes: " + json.dumps(optimizedRoutes, indent=4))
    optimized_routes_store['routes'] = optimizedRoutes

    return jsonify({'status': 'success', 'message': 'Routes computed successfully'}), 200


'''@app.route('/routeoptimizer/', methods=['GET','POST'])
def route_optimizer():
    google_maps_api_key = os.getenv('GOOGLE_MAPS_API_KEY')  # Access the API key

    print("Route optimizer function started", flush=True)
    # Extract data from request
    data = request.get_json()
    app.logger.info("test")
    app.logger.info(json.dumps(data, indent=4))  # Logs incoming data
    app.logger.info("Optimized Routes: " + json.dumps(optimizedRoutes, indent=4))  # Logs optimized routes
    print(data, flush=True)
    driver_location = data.get('drivers')
    passenger_location = data.get('passengers')
    destination = data.get('destination')

    drivers = []
    i = 0
    for driver in driver_location:
        lat = driver['coordinates']['lat']
        lng = driver['coordinates']['lng']
        capacity = driver['capacity']
        drivers.append(Driver(lng, lat, capacity, i))
        i = i+1
    
    passengers = []
    i = 0
    for passenger in passenger_location:
        lat = passenger['coordinates']['lat']
        lng = passenger['coordinates']['lng']
        passengers.append(Passenger(lng,lat,i))
        i = i + 1
    
    dest = (destination["lng"],destination["lat"])
    # paths holds a list of driver paths (Ex: [[(dx,dy)...,(Dx,Dy)],[(dx,dy)...,(Dx,Dy)]])
    paths = give_paths(drivers=drivers, passengers=passengers, destination=dest)
    app.logger.info("Generated paths: " + json.dumps(paths, indent=4))

    optimizedRoutes = [
        [{'lat': coord[1], 'lng': coord[0]} for coord in paths[j]] for j in range(len(paths))
    ]
    print("Optimized Routes:", json.dumps(optimizedRoutes, indent=4))

    # Return the optimized routes as a JSON response
    #return jsonify({'optimizedRoutes': optimizedRoutes, 'status': 'success'})
    routes = optimizedRoutes
    return jsonify({'optimizedRoutes': optimizedRoutes, 'status': 'success'})
'''
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