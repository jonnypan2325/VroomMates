"""Independent exhaustive objective checks and domain contract regressions."""

import math
import random
from itertools import permutations, product
import unittest
from unittest.mock import patch

from backend.models import Driver, Passenger
from backend.optimizer import assign_drivers, give_paths, haversine_distance


ABS_TOL_MILES = 1e-8
REL_TOL = 1e-12


def independent_distance(a, b):
    """Separate atan2 haversine expression; no production distance helper."""
    lon_a, lat_a, lon_b, lat_b = map(math.radians, (*a, *b))
    h = (math.sin((lat_b - lat_a) / 2) ** 2
         + math.cos(lat_a) * math.cos(lat_b) * math.sin((lon_b - lon_a) / 2) ** 2)
    h = min(1.0, max(0.0, h))
    return 7918 * math.atan2(math.sqrt(h), math.sqrt(1 - h))


def route_objective(origins, pickups, destination, paths):
    legs = []
    for origin, path in zip(origins, paths):
        points = [origin] + [pickups[j] for j in path] + [destination]
        legs.extend(independent_distance(a, b) for a, b in zip(points, points[1:]))
    return math.fsum(legs)


def exhaustive_oracle(origins, pickups, destination, capacities):
    """Enumerate assignments and all route permutations, independent of DP."""
    best = math.inf
    for assignment in product(range(len(origins)), repeat=len(pickups)):
        groups = [tuple(j for j, d in enumerate(assignment) if d == i)
                  for i in range(len(origins))]
        if any(len(g) > c for g, c in zip(groups, capacities)):
            continue
        for paths in product(*(permutations(g) for g in groups)):
            best = min(best, route_objective(origins, pickups, destination, paths))
    return best


class OptimizerTests(unittest.TestCase):
    def test_eighteen_shared_pickups_do_not_expand_identity_permutations(self):
        driver = Driver(-74, 40, 18, 0)
        pickup = (-74.1, 40.1)
        destination = (-74.2, 40.6)
        for i in range(18):
            driver.add_passenger(Passenger(*pickup, i))
        # No subset search at all: F03 remains a linear repeated-waypoint path.
        with patch("backend.optimizer._suffix_table", side_effect=AssertionError("expanded")):
            self.assertEqual(driver.get_path(destination),
                             [driver.get_coords()] + [pickup] * 18 + [destination])

    def test_mixed_shared_pickups_minimize_complete_route_distance(self):
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
                cost += independent_distance(current, stop)
                current = stop
            return cost + independent_distance(current, destination)

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


    def assert_optimal_fixture(self, origins, pickups, destination, capacities):
        drivers = [Driver(*o, c, i) for i, (o, c) in enumerate(zip(origins, capacities))]
        passengers = [Passenger(*p, j) for j, p in enumerate(pickups)]
        routes = give_paths(drivers, passengers, destination)
        paths = [tuple(p.get_passenger_num() for p in d.get_passengers()) for d in drivers]
        self.assertEqual(sorted(j for path in paths for j in path), list(range(len(pickups))))
        for d, c, route, path in zip(drivers, capacities, routes, paths):
            self.assertLessEqual(len(path), c)
            self.assertEqual(d.get_capacity(), c - len(path))
            self.assertEqual(route, [d.get_coords()] + [pickups[j] for j in path] + [destination])
        actual = route_objective(origins, pickups, destination, paths)
        expected = exhaustive_oracle(origins, pickups, destination, capacities)
        self.assertTrue(math.isclose(actual, expected, rel_tol=REL_TOL, abs_tol=ABS_TOL_MILES),
                        (actual, expected, paths))
        return paths, actual

    def test_seeded_exhaustive_oracle_distinct_shared_and_mixed(self):
        for seed in range(12):
            rng = random.Random(seed)
            origins = [(-74 + rng.random(), 40 + rng.random()) for _ in range(3)]
            raw = [(-74 + rng.random(), 40 + rng.random()) for _ in range(5)]
            for pattern in ('distinct', 'shared', 'mixed'):
                pickups = raw if pattern == 'distinct' else ([raw[0]] * 5 if pattern == 'shared'
                                                            else [raw[0], raw[1], raw[0], raw[2], raw[1]])
                with self.subTest(seed=seed, pattern=pattern):
                    self.assert_optimal_fixture(origins, pickups, (-73.7, 40.8),
                                                [1, 2, 3] if seed % 2 else [5, 5, 5])

    def test_six_passenger_and_symmetric_exhaustive_fixtures(self):
        self.assert_optimal_fixture([(0, 0), (1, 0), (2, 0)],
                                   [(0.2, 0.1), (0.4, -0.1), (1.2, 0.3),
                                    (1.4, -0.2), (1.8, 0.1), (0.8, 0.2)], (1, 1), [2, 2, 2])
        self.assert_optimal_fixture([(0, 0)] * 3,
                                   [(-1, 1), (1, 1), (-1, 1), (1, 1)], (0, 2), [1, 2, 3])

    def test_fixed_greedy_counterexample(self):
        origins = [(-73.8656357558876, 40.847433736937234),
                   (-73.23622538102339, 40.255069025739424)]
        pickups = [(-73.50456491290807, 40.44949106478874),
                   (-73.34840702727723, 40.788723351135516),
                   (-73.90614041322577, 40.02834747652201),
                   (-73.16423489608013, 40.432767067905054)]
        paths, cost = self.assert_optimal_fixture(origins, pickups, (-73.7, 40.8), [2, 2])
        self.assertEqual(paths, [(2, 0), (3, 1)])
        self.assertLess(cost, 177)

    def test_capacity_trap_exact_capacity_and_large_capacity(self):
        for caps in ([1, 3], [100, 100]):
            with self.subTest(capacities=caps):
                self.assert_optimal_fixture([(0, 0), (10, 0)],
                                            [(0, 0), (0.01, 0), (0.02, 0), (9, 0)], (1, 0), caps)

    def test_polar_antipodal_conditioning_preserves_oracle_objective(self):
        # Independent review found asin rounding can choose a worse polar route.
        self.assert_optimal_fixture(
            [(-130.95625462669022, -89.99999969215766),
             (177.1545661437491, -89.99999943056898)],
            [(-31.861984184004058, 89.99999904681442),
             (-114.00218276785698, 89.99999944167473),
             (137.7512227792265, 89.99999984107522),
             (-165.73802457119314, -89.99999972951106)],
            (6.185220126653064, -89.99999927176076), [4, 4])

    def test_numerical_adversarial_tiny_legs_and_large_later_terms(self):
        fixtures = [
            ([(0, 0), (170, 0)], [(1e-14, 0), (2e-14, 0), (0, 0)], (3e-14, 0), [2, 3]),
            ([(-170, 70), (170, -70)], [(1e-12, 0), (2e-12, 0), (0, 0)], (1, 1), [3, 3]),
            ([(179.9, 0), (0, 90)], [(-179.9, 0), (180, 0), (0, -90)], (0, 0), [2, 2]),
            ([(0, 0)], [(179.999999, 0), (180, 0), (-180, 0)], (0, 0), [3]),
        ]
        for fixture in fixtures:
            with self.subTest(fixture=fixture):
                self.assert_optimal_fixture(*fixture)

    def test_exact_ties_use_ids_and_driver_output_order(self):
        destination = (0, 0)
        drivers = [Driver(0, 0, 2, 8), Driver(0, 0, 2, 3)]
        passengers = [Passenger(0, 0, j) for j in (9, 2, 5)]
        routes = give_paths(drivers, passengers, destination)
        self.assertEqual([[p.get_passenger_num() for p in d.get_passengers()] for d in drivers],
                         [[9], [2, 5]])
        self.assertEqual([len(route) for route in routes], [3, 4])
        self.assertEqual(routes, [[destination] * 3, [destination] * 4])

    def test_pickups_at_origin_destination_and_unused_zero_route(self):
        destination = (0, 0)
        origins = [destination, (1, 0), (2, 0)]
        pickups = [destination, destination, origins[1]]
        self.assert_optimal_fixture(origins, pickups, destination, [3, 1, 1])
        d = Driver(*destination, 1, 0)
        self.assertEqual(give_paths([d], [Passenger(*destination, 0)], destination),
                         [[destination, destination, destination]])

    def test_solver_runs_once_and_mutates_after_success(self):
        from backend import optimizer
        drivers = [Driver(0, 0, 2, 0)]
        passengers = [Passenger(1, 0, 0), Passenger(2, 0, 1)]
        with patch('backend.optimizer._solve', wraps=optimizer._solve) as solve:
            give_paths(drivers, passengers, (3, 0))
        self.assertEqual(solve.call_count, 1)
        self.assertEqual(drivers[0].get_capacity(), 0)
        untouched = Driver(0, 0, 1, 0)
        with self.assertRaisesRegex(ValueError, 'insufficient'):
            give_paths([untouched], passengers, (3, 0))
        self.assertEqual(untouched.get_capacity(), 1)
        self.assertEqual(untouched.get_passengers(), [])

    def test_standalone_mixed_oversize_is_explicit(self):
        driver = Driver(0, 0, 13, 0)
        for j in range(13):
            driver.add_passenger(Passenger(j, 0, j))
        with self.assertRaisesRegex(ValueError, 'at most 12 passengers'):
            driver.get_path((20, 0))

    def test_antipodal_roundoff_is_finite(self):
        for a, b in [((0, 0), (180, 0)), ((30, 89.9999), (-150, -89.9999)),
                     ((180, 90), (-180, -90))]:
            self.assertTrue(math.isfinite(haversine_distance(a, b)))
            self.assertLessEqual(haversine_distance(a, b), math.pi * 3959)


if __name__ == "__main__":
    unittest.main()
