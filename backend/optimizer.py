"""Pure distance, assignment, and waypoint-ordering logic (no Flask state)."""

import math
import heapq
from itertools import count


def haversine_distance(coord1, coord2, R=3959):
    """Return the great-circle distance in miles for (longitude, latitude) coordinates.

    R is the Earth radius in miles.
    """
    lng1, lat1 = coord1
    lng2, lat2 = coord2
    lat1_r = math.radians(lat1)
    lat2_r = math.radians(lat2)
    dlat = lat2_r - lat1_r
    dlon = math.radians(lng2 - lng1)
    a = math.sin(dlat / 2) ** 2 + math.cos(lat1_r) * math.cos(lat2_r) * math.sin(dlon / 2) ** 2
    return 2 * R * math.asin(math.sqrt(a))


def order_stops(driver, destination):
    """Preserve the existing search cost, which includes destination distance at each pickup.

    This cost does not represent the total route distance.
    """
    if not driver.passengers:
        return [driver.get_coords(), destination]
    # Equal-cost states can contain Passenger objects, which Python cannot order.
    sequence = count()
    open_list = [(0, next(sequence), (driver.get_coords(), tuple(driver.passengers), []))]

    visited = set()

    while(open_list):
        cost, _, (current_position, remaining_passengers, path_taken) = heapq.heappop(open_list)

        if (current_position, remaining_passengers) in visited:
            continue

        visited.add((current_position, remaining_passengers))

        if not remaining_passengers and current_position == destination:
            return [driver.get_coords()] + path_taken

        for i, passenger in enumerate(remaining_passengers):
            new_cost = cost + haversine_distance(current_position, passenger.get_coords()) + haversine_distance(passenger.get_coords(), destination)
            new_remaining_passengers = remaining_passengers[:i] + remaining_passengers[i+1:]
            new_path = path_taken + [passenger.get_coords()]
            if (passenger.get_coords(), new_remaining_passengers) not in visited:
                heapq.heappush(open_list, (new_cost, next(sequence), (passenger.get_coords(),new_remaining_passengers,new_path)))

        if not remaining_passengers:
            heapq.heappush(open_list, (cost+haversine_distance(current_position, destination), next(sequence), (destination, remaining_passengers, path_taken+[destination])))


def distance_from_line(passenger, driver, destination):
    """Return the added distance in miles for a pickup before the destination.

    Assignment uses this pairwise cost rather than the cost of the complete route.
    """
    driver_to_passenger = haversine_distance(driver.get_coords(), passenger.get_coords())
    passenger_to_dest = haversine_distance(passenger.get_coords(), destination)
    driver_to_dest = haversine_distance(driver.get_coords(), destination)
    return (driver_to_passenger + passenger_to_dest) - driver_to_dest


def assign_drivers(drivers, passengers, destination):
    """Use global-greedy assignment over pairwise detour costs.

    This function mutates driver passenger lists and remaining capacities.
    Reusing the same objects can assign a passenger again.
    """
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
    # Passenger IDs precede driver IDs to preserve deterministic assignment ties.
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
    """Return routes in driver input order because the frontend selects drivers by index.

    Each listed driver travels to the destination, even without passengers.
    Route coordinates use (longitude, latitude).
    """
    drivers = assign_drivers(drivers, passengers, destination)
    paths = []
    for d in drivers:
        if not d.get_passengers():
            paths.append([d.get_coords(), destination])
            continue
        path = d.get_path(destination)
        if not path:
            # Preserve a route with endpoints if the search returns no path.
            # This fallback omits assigned pickups.
            path = [d.get_coords(), destination]
        paths.append(path)
    return paths
