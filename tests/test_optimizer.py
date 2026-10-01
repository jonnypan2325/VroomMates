"""Protect domain invariants without freezing heuristic route choices."""

import math
import heapq
from itertools import permutations
import unittest
from unittest.mock import patch

from backend.models import Driver, Passenger
from backend.optimizer import assign_drivers, give_paths, haversine_distance


class OptimizerTests(unittest.TestCase):
    def test_eighteen_shared_pickups_do_not_expand_identity_permutations(self):
        driver = Driver(-74, 40, 18, 0)
        pickup = (-74.1, 40.1)
        destination = (-74.2, 40.6)
        for i in range(18):
            driver.add_passenger(Passenger(*pickup, i))
        push = heapq.heappush
        pushes = 0

        def bounded_push(queue, item):
            nonlocal pushes
            pushes += 1
            # Bound search work instead of relying on machine-dependent elapsed time.
            self.assertLessEqual(pushes, 20)
            return push(queue, item)

        with patch("backend.optimizer.heapq.heappush", side_effect=bounded_push):
            self.assertEqual(driver.get_path(destination),
                             [driver.get_coords()] + [pickup] * 18 + [destination])

    def test_mixed_shared_pickups_preserve_minimum_existing_search_cost(self):
        origin, destination = (-74, 40), (-74.2, 40.6)
        a, b, c = (-74.1, 40.1), (-74.3, 40.2), (-74.4, 40.4)
        pickups = [a, b, a, c, b]
        driver = Driver(*origin, len(pickups), 0)
        for i, pickup in enumerate(pickups):
            driver.add_passenger(Passenger(*pickup, i))

        def search_cost(stops):
            current = origin
            cost = 0
            for stop in stops:
                cost += haversine_distance(current, stop) + haversine_distance(stop, destination)
                current = stop
            return cost + haversine_distance(current, destination)

        route = driver.get_path(destination)
        self.assertEqual(route[0], origin)
        self.assertEqual(route[-1], destination)
        self.assertCountEqual(route[1:-1], pickups)
        self.assertAlmostEqual(search_cost(route[1:-1]),
                               min(search_cost(order) for order in set(permutations(pickups))))

    def test_coordinates_and_distance_use_longitude_latitude(self):
        driver = Driver(-74, 40, 2, 7)
        passenger = Passenger(-73, 41, 8)
        self.assertEqual(driver.get_coords(), (-74, 40))
        self.assertEqual(passenger.get_coords(), (-73, 41))
        self.assertEqual(driver.get_driver_num(), 7)
        self.assertEqual(passenger.get_passenger_num(), 8)
        self.assertEqual(haversine_distance((-74, 40), (-74, 40)), 0)
        # A quarter meridian has length pi * radius / 2.
        self.assertAlmostEqual(haversine_distance((0, 0), (0, 90)), math.pi * 3959 / 2)
        self.assertLess(haversine_distance((0, 60), (1, 60)),
                        haversine_distance((0, 0), (1, 0)))

    def test_assigns_every_passenger_once_within_capacity(self):
        drivers = [Driver(-74, 40, 1, 0), Driver(-74.5, 40.3, 2, 1)]
        passengers = [Passenger(-74.1, 40.1, 0), Passenger(-74.3, 40.2, 1),
                      Passenger(-74.4, 40.4, 2)]
        capacities = [driver.get_capacity() for driver in drivers]
        self.assertIs(assign_drivers(drivers, passengers, (-74.2, 40.6)), drivers)
        assigned = []
        for driver, capacity in zip(drivers, capacities):
            assigned.extend(driver.get_passengers())
            self.assertLessEqual(len(driver.get_passengers()), capacity)
            self.assertEqual(driver.get_capacity(), capacity - len(driver.get_passengers()))
        self.assertCountEqual(assigned, passengers)
        self.assertCountEqual([p.get_passenger_num() for p in assigned], [0, 1, 2])

    def test_routes_preserve_input_order_endpoints_and_pickups(self):
        drivers = [Driver(-74.5, 40.3, 2, 2), Driver(-74, 40, 2, 0),
                   Driver(-74.8, 40.7, 2, 1)]
        passengers = [Passenger(-74.1, 40.1, 0), Passenger(-74.3, 40.2, 1)]
        destination = (-74.2, 40.6)
        routes = give_paths(drivers, passengers, destination)
        self.assertEqual(len(routes), len(drivers))
        self.assertTrue(any(not d.get_passengers() for d in drivers))
        for driver, route in zip(drivers, routes):
            self.assertEqual(route[0], driver.get_coords())
            self.assertEqual(route[-1], destination)
            self.assertCountEqual(route[1:-1], [p.get_coords() for p in driver.get_passengers()])
            if not driver.get_passengers():
                self.assertEqual(route, [driver.get_coords(), destination])

    def test_equal_costs_choose_passenger_then_driver_id(self):
        # Reverse iteration order so IDs, rather than loop order, decide the tie.
        drivers = [Driver(-74, 40, 1, 1), Driver(-74, 40, 1, 0)]
        passengers = [Passenger(-74.1, 40.1, 1), Passenger(-74.1, 40.1, 0)]
        assign_drivers(drivers, passengers, (-74.2, 40.6))
        self.assertEqual(drivers[1].get_passengers(), [passengers[1]])
        self.assertEqual(drivers[0].get_passengers(), [passengers[0]])

    def test_same_coordinate_pickups_are_retained_and_stable(self):
        driver = Driver(-74, 40, 2, 0)
        passengers = [Passenger(-74.1, 40.1, i) for i in range(2)]
        destination = (-74.2, 40.6)
        expected = [driver.get_coords(), passengers[0].get_coords(),
                    passengers[1].get_coords(), destination]
        self.assertEqual(give_paths([driver], passengers, destination), [expected])
        self.assertEqual(driver.get_path(destination), expected)
        self.assertEqual(driver.get_path(destination), expected)
        self.assertEqual(driver.get_capacity(), 0)

    def test_repeated_assignment_preserves_non_idempotent_mutation(self):
        driver = Driver(-74, 40, 2, 0)
        passenger = Passenger(-74.1, 40.1, 0)
        for remaining in (1, 0):
            assign_drivers([driver], [passenger], (-74.2, 40.6))
            self.assertEqual(driver.get_capacity(), remaining)
            self.assertEqual(driver.get_passengers(), [passenger] * (2 - remaining))

    def test_empty_passengers_give_every_driver_a_direct_route(self):
        drivers = [Driver(-74, 40, 1, 0), Driver(-74.5, 40.3, 2, 1)]
        destination = (-74.2, 40.6)
        self.assertEqual(give_paths(drivers, [], destination),
                         [[d.get_coords(), destination] for d in drivers])
        self.assertEqual([d.get_capacity() for d in drivers], [1, 2])
        self.assertEqual(give_paths([], [], destination), [])


if __name__ == "__main__":
    unittest.main()
