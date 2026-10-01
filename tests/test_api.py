"""Characterize the public API through the runnable root application."""

import unittest
from unittest.mock import patch

import app as root_app
from backend.routes import optimized_routes_store
from backend.validation import ValidationError, parse_route_request


def valid_payload():
    return {
        "drivers": [
            {"location": {"lat": 40.0, "lng": -74.0}, "capacity": 1},
            {"location": {"lat": 40.3, "lng": -74.4}, "capacity": 1},
        ],
        "passengers": [{"lat": 40.1, "lng": -74.1}],
        "destination": {"lat": 40.5, "lng": -74.2},
    }


class ValidationTests(unittest.TestCase):
    def test_parsing_converts_coordinates_to_longitude_latitude(self):
        payload = valid_payload()
        payload["drivers"][0]["location"] = {"lat": "40.0", "lng": "-74.0"}
        drivers, passengers, destination = parse_route_request(payload)
        self.assertEqual([d.get_coords() for d in drivers], [(-74.0, 40.0), (-74.4, 40.3)])
        self.assertEqual([d.get_driver_num() for d in drivers], [0, 1])
        self.assertEqual([d.get_capacity() for d in drivers], [1, 1])
        self.assertEqual([p.get_coords() for p in passengers], [(-74.1, 40.1)])
        self.assertEqual([p.get_passenger_num() for p in passengers], [0])
        self.assertEqual(destination, (-74.2, 40.5))

    def test_validation_errors_preserve_message_and_order(self):
        cases = [
            (None, "Request body must be a JSON object"),
            ({}, "drivers must be a non-empty list"),
            ({"drivers": [None]}, "passengers must be a non-empty list"),
            ({"drivers": [None], "passengers": [None]}, "destination must include lat and lng"),
        ]
        for payload, message in cases:
            with self.subTest(payload=payload):
                with self.assertRaises(ValidationError) as caught:
                    parse_route_request(payload)
                self.assertEqual(str(caught.exception), message)


class ApiContractTests(unittest.TestCase):
    def setUp(self):
        optimized_routes_store.clear()
        previous_testing = root_app.app.config["TESTING"]
        root_app.app.config["TESTING"] = True
        self.addCleanup(root_app.app.config.update, TESTING=previous_testing)
        self.addCleanup(optimized_routes_store.clear)
        self.client = root_app.app.test_client()

    def assert_error(self, response, message, status=400):
        self.assertEqual(response.status_code, status)
        self.assertTrue(response.is_json)
        self.assertEqual(response.get_json(), {"error": message})

    def test_get_before_success(self):
        self.assert_error(
            self.client.get("/routeoptimizer/"),
            "No routes available. Submit data first using POST.",
            status=404,
        )

    def test_success_routes_and_last_result(self):
        payload = valid_payload()
        response = self.client.post("/routeoptimizer/", json=payload)
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.is_json)
        result = response.get_json()
        self.assertEqual(result["status"], "success")
        routes = result["optimizedRoutes"]
        self.assertEqual(len(routes), len(payload["drivers"]))
        pickups = []
        for driver, route in zip(payload["drivers"], routes):
            self.assertEqual(route[0], driver["location"])
            self.assertEqual(route[-1], payload["destination"])
            self.assertLessEqual(len(route[1:-1]), driver["capacity"])
            pickups.extend(route[1:-1])
        self.assertCountEqual(pickups, payload["passengers"])
        self.assertEqual(sum(len(route) == 2 for route in routes), 1)
        stored = self.client.get("/routeoptimizer/")
        self.assertEqual(stored.status_code, 200)
        self.assertEqual(stored.get_json(), result)

    def test_failed_post_preserves_last_success(self):
        success = self.client.post("/routeoptimizer/", json=valid_payload())
        self.assertEqual(success.status_code, 200)
        self.assert_error(
            self.client.post("/routeoptimizer/", json={}),
            "drivers must be a non-empty list",
        )
        stored = self.client.get("/routeoptimizer/")
        self.assertEqual(stored.status_code, 200)
        self.assertEqual(stored.get_json(), success.get_json())

    def test_later_success_replaces_last_result(self):
        first = self.client.post("/routeoptimizer/", json=valid_payload())
        self.assertEqual(first.status_code, 200)
        payload = valid_payload()
        payload["destination"] = {"lat": 40.8, "lng": -74.6}
        second = self.client.post("/routeoptimizer/", json=payload)
        self.assertEqual(second.status_code, 200)
        self.assertNotEqual(first.get_json(), second.get_json())
        stored = self.client.get("/routeoptimizer/")
        self.assertEqual(stored.status_code, 200)
        self.assertEqual(stored.get_json(), second.get_json())

    def test_unexpected_optimizer_failure_preserves_last_success(self):
        success = self.client.post("/routeoptimizer/", json=valid_payload())
        self.assertEqual(success.status_code, 200)
        with patch("backend.routes.give_paths", side_effect=RuntimeError("optimizer failed")):
            with self.assertRaisesRegex(RuntimeError, "optimizer failed"):
                self.client.post("/routeoptimizer/", json=valid_payload())
        stored = self.client.get("/routeoptimizer/")
        self.assertEqual(stored.status_code, 200)
        self.assertEqual(stored.get_json(), success.get_json())

    def test_co_located_passengers(self):
        payload = valid_payload()
        payload["drivers"] = payload["drivers"][:1]
        payload["drivers"][0]["capacity"] = 2
        pickup = payload["passengers"][0]
        payload["passengers"].append(dict(pickup))
        response = self.client.post("/routeoptimizer/", json=payload)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json(), {
            "status": "success",
            "optimizedRoutes": [[payload["drivers"][0]["location"],
                                 pickup, pickup, payload["destination"]]],
        })

    def test_invalid_body(self):
        cases = [
            {},
            {"data": "{", "content_type": "application/json"},
            {"data": "{}", "content_type": "text/plain"},
            {"data": "null", "content_type": "application/json"},
            {"json": []}, {"json": "text"}, {"json": 42}, {"json": True},
        ]
        for kwargs in cases:
            with self.subTest(request=kwargs):
                self.assert_error(
                    self.client.post("/routeoptimizer/", **kwargs),
                    "Request body must be a JSON object",
                )

    def test_driver_and_passenger_list_validation(self):
        for field in ("drivers", "passengers"):
            for value in (None, [], {}, "invalid"):
                with self.subTest(field=field, value=value):
                    payload = valid_payload()
                    payload[field] = value
                    self.assert_error(
                        self.client.post("/routeoptimizer/", json=payload),
                        f"{field} must be a non-empty list",
                    )
            with self.subTest(field=field, missing=True):
                payload = valid_payload()
                del payload[field]
                self.assert_error(
                    self.client.post("/routeoptimizer/", json=payload),
                    f"{field} must be a non-empty list",
                )

    def test_destination_validation(self):
        cases = [
            (None, "destination must include lat and lng"),
            ([], "destination must include lat and lng"),
            ({}, "destination must include lat and lng"),
            ({"lat": 40}, "destination must include lat and lng"),
            ({"lng": -74}, "destination must include lat and lng"),
            ({"lat": "bad", "lng": -74}, "destination lat/lng must be numbers"),
            ({"lat": 40, "lng": None}, "destination lat/lng must be numbers"),
        ]
        for destination, error in cases:
            with self.subTest(destination=destination):
                payload = valid_payload()
                payload["destination"] = destination
                self.assert_error(self.client.post("/routeoptimizer/", json=payload), error)
        payload = valid_payload()
        del payload["destination"]
        self.assert_error(self.client.post("/routeoptimizer/", json=payload),
                          "destination must include lat and lng")

    def test_driver_entry_validation(self):
        cases = [(None, "driver[1] must be an object")]
        for location in (None, [], {}, {"lat": 40}, {"lng": -74}):
            cases.append(({"location": location, "capacity": 1},
                          "driver[1].location must include lat and lng"))
        cases.append(({"capacity": 1}, "driver[1].location must include lat and lng"))
        for location in ({"lat": None, "lng": -74}, {"lat": 40, "lng": "bad"}):
            cases.append(({"location": location, "capacity": 1},
                          "driver[1] location must be numbers"))
        for capacity in (None, True, False, 0, -1, 1.0, "1"):
            cases.append(({"location": {"lat": 40, "lng": -74}, "capacity": capacity},
                          "driver[1].capacity must be a positive integer"))
        cases.append(({"location": {"lat": 40, "lng": -74}},
                      "driver[1].capacity must be a positive integer"))
        for driver, error in cases:
            with self.subTest(driver=driver):
                payload = valid_payload()
                payload["drivers"][1] = driver
                self.assert_error(self.client.post("/routeoptimizer/", json=payload), error)

    def test_passenger_entry_validation(self):
        cases = [
            (None, "passenger[1] must be an object"),
            ({}, "passenger[1] must include lat and lng"),
            ({"lat": 40}, "passenger[1] must include lat and lng"),
            ({"lng": -74}, "passenger[1] must include lat and lng"),
            ({"lat": [], "lng": -74}, "passenger[1] lat/lng must be numbers"),
            ({"lat": 40, "lng": "bad"}, "passenger[1] lat/lng must be numbers"),
        ]
        for passenger, error in cases:
            with self.subTest(passenger=passenger):
                payload = valid_payload()
                payload["passengers"].append(passenger)
                self.assert_error(self.client.post("/routeoptimizer/", json=payload), error)

    def test_insufficient_capacity(self):
        payload = valid_payload()
        payload["drivers"] = payload["drivers"][:1]
        payload["passengers"].append({"lat": 40.2, "lng": -74.3})
        self.assert_error(self.client.post("/routeoptimizer/", json=payload),
                          "insufficient total driver capacity (1) for 2 passengers")

    def test_validation_order(self):
        # Repair each earlier error while leaving the later errors present.
        payload = {"drivers": [], "passengers": [], "destination": None}
        stages = [
            ("drivers", [], "drivers must be a non-empty list"),
            ("drivers", [None], "passengers must be a non-empty list"),
            ("passengers", [None, None], "destination must include lat and lng"),
            ("destination", {"lat": "bad", "lng": -74}, "destination lat/lng must be numbers"),
            ("destination", {"lat": 40.5, "lng": -74.2}, "driver[0] must be an object"),
            ("drivers", [{"location": {"lat": 40, "lng": -74}, "capacity": 1}],
             "passenger[0] must be an object"),
            ("passengers", [{"lat": 40.1, "lng": -74.1}, {"lat": 40.2, "lng": -74.3}],
             "insufficient total driver capacity (1) for 2 passengers"),
        ]
        for field, value, error in stages:
            with self.subTest(error=error):
                payload[field] = value
                self.assert_error(self.client.post("/routeoptimizer/", json=payload), error)

    def test_missing_trailing_slash_redirects(self):
        for method in ("GET", "POST"):
            with self.subTest(method=method):
                response = self.client.open("/routeoptimizer", method=method,
                                            json=valid_payload(), follow_redirects=False)
                self.assertEqual(response.status_code, 308)
                self.assertTrue(response.headers["Location"].endswith("/routeoptimizer/"))

    def test_cross_origin_post(self):
        origin = "http://localhost:3000"
        response = self.client.post("/routeoptimizer/", json=valid_payload(),
                                    headers={"Origin": origin})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers.get("Access-Control-Allow-Origin"), origin)


if __name__ == "__main__":
    unittest.main()
