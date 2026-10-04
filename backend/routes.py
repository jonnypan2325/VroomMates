from flask import request, jsonify

from .optimizer import give_paths
from .validation import ValidationError, parse_route_request


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

        return jsonify({'status': 'success', 'optimizedRoutes': optimizedRoutes}), 200


    @app.route('/routeoptimizer/', methods=['GET'])
    def get_optimized_routes():
        response = jsonify({'error': 'Shared last-result retrieval has been removed. Use private saved trips.',
                            'code': 'LAST_RESULT_REMOVED'})
        response.status_code = 410
        response.headers['Cache-Control'] = 'no-store'
        return response
