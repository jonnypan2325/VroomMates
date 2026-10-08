"""Distance remains primary; equal-distance assignments avoid splitting pickups."""
import unittest
from unittest.mock import patch
from backend.models import Driver, Passenger
from backend.optimizer import _solve


def solve(origins, capacities, pickups, destination=(0, 0)):
    drivers = [Driver(*point, seats, i) for i, (point, seats) in enumerate(zip(origins, capacities))]
    passengers = [Passenger(*point, i) for i, point in enumerate(pickups)]
    return _solve(drivers, passengers, destination)[2]


class PickupPreferenceTests(unittest.TestCase):
    def test_equal_distance_keeps_pickup_together_even_in_later_car(self):
        paths = solve([(0, 0), (0, 0)], [1, 3], [(1, 0)] * 3, destination=(1, 0))
        self.assertEqual(paths, [(), (0, 1, 2)])

    def test_capacity_can_require_splitting(self):
        paths = solve([(0, 0), (0, 0)], [2, 1], [(1, 0)] * 3)
        self.assertEqual([len(p) for p in paths], [2, 1])
        self.assertEqual(sorted(j for path in paths for j in path), [0, 1, 2])

    def test_shorter_split_beats_feasible_unsplit_groups(self):
        # A shared pickup at destination plus one person at each driver's origin.
        # Grouping all three together forces the other car to cross both origins.
        distance = lambda a, b: abs(a[0] - b[0]) + abs(a[1] - b[1])
        origins, pickups = [(-10, 0), (10, 0)], [(0, 0)] * 3 + [(-10, 0), (10, 0)]
        with patch('backend.optimizer.haversine_distance', side_effect=distance):
            paths = solve(origins, [3, 2], pickups)
        self.assertEqual([len(p) for p in paths], [3, 2])
        self.assertTrue(all(any(j < 3 for j in path) for path in paths))
        cost = 0
        for origin, path in zip(origins, paths):
            points = [origin] + [pickups[j] for j in path] + [(0, 0)]
            cost += sum(distance(a, b) for a, b in zip(points, points[1:]))
        self.assertEqual(cost, 20)
