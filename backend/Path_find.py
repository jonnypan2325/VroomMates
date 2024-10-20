import math
import heapq
import json

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

if __name__ == "__main__":
    drivers = [Driver(33.6656, -117.8750, 4,0), Driver(33.6764, -117.9020,4,1)]
    passengers = [Passenger(lat, lon, index) for index, (lat, lon) in enumerate([
        (33.6412, -117.8403),  # UC Irvine
        (33.6504, -117.8542),  # University Park, Irvine
        (33.6546, -117.8670),  # San Joaquin Marsh & Wildlife Sanctuary
        (33.6703, -117.8854),  # Back Bay View Park
        (33.6737, -117.8963),  # Newport Beach Golf Course
        (33.6806, -117.9211),  # Newport Pier
        (33.6180, -117.9297)  # Balboa Peninsula
    ])]
    destination = (33.6111, -117.9296)
    drivers = assign_drivers(drivers, passengers, destination)
    for driver in drivers:
        print(driver.get_coords())
        print(driver.get_path(destination))
