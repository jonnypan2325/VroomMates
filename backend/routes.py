import json

from flask import request, jsonify

from .optimizer import give_paths
from .validation import ValidationError, parse_route_request


# All app instances in this process share the last successful result.
optimized_routes_store = {}


def register_routes(app):
    @app.route('/routeoptimizer/', methods=['POST'])
    def route_optimizer():
        data = request.get_json(silent=True)
        try:
            drivers, passengers, dest = parse_route_request(data)
        except ValidationError as error:
            return jsonify({"error": str(error)}), 400

        paths = give_paths(drivers=drivers, passengers=passengers, destination=dest)

        optimizedRoutes = [
            [{'lat': coord[1], 'lng': coord[0]} for coord in paths[j]] for j in range(len(paths))
        ]

        app.logger.info("Optimized Routes: " + json.dumps(optimizedRoutes, indent=4))
        # Replace the stored result only after optimization and serialization succeed.
        optimized_routes_store['routes'] = optimizedRoutes

        return jsonify({'status': 'success', 'optimizedRoutes': optimizedRoutes}), 200


    @app.route('/routeoptimizer/', methods=['GET'])
    def get_optimized_routes():
        if 'routes' not in optimized_routes_store:
            return jsonify({'error': 'No routes available. Submit data first using POST.'}), 404

        return jsonify({'optimizedRoutes': optimized_routes_store['routes'], 'status': 'success'}), 200
