from .models import Driver, Passenger


class ValidationError(ValueError):
    """Keep deliberate request errors separate from unexpected failures."""


def parse_route_request(data):
    """Preserve fail-fast error order and convert coordinates to (longitude, latitude)."""
    if not isinstance(data, dict):
        raise ValidationError('Request body must be a JSON object')

    driver_location = data.get('drivers')
    passenger_location = data.get('passengers')
    destination = data.get('destination')

    if not isinstance(driver_location, list) or len(driver_location) == 0:
        raise ValidationError('drivers must be a non-empty list')
    if not isinstance(passenger_location, list) or len(passenger_location) == 0:
        raise ValidationError('passengers must be a non-empty list')
    if not isinstance(destination, dict) or 'lat' not in destination or 'lng' not in destination:
        raise ValidationError('destination must include lat and lng')
    try:
        dest_lat = float(destination['lat'])
        dest_lng = float(destination['lng'])
    except (TypeError, ValueError):
        raise ValidationError('destination lat/lng must be numbers')

    drivers = []
    total_capacity = 0
    for i, driver in enumerate(driver_location):
        if not isinstance(driver, dict):
            raise ValidationError(f'driver[{i}] must be an object')
        location = driver.get('location')
        if not isinstance(location, dict) or 'lat' not in location or 'lng' not in location:
            raise ValidationError(f'driver[{i}].location must include lat and lng')
        try:
            lat = float(location['lat'])
            lng = float(location['lng'])
        except (TypeError, ValueError):
            raise ValidationError(f'driver[{i}] location must be numbers')
        capacity = driver.get('capacity')
        if not isinstance(capacity, int) or isinstance(capacity, bool) or capacity <= 0:
            raise ValidationError(f'driver[{i}].capacity must be a positive integer')
        total_capacity += capacity
        drivers.append(Driver(lng, lat, capacity, i))

    passengers = []
    for i, passenger in enumerate(passenger_location):
        if not isinstance(passenger, dict):
            raise ValidationError(f'passenger[{i}] must be an object')
        if 'lat' not in passenger or 'lng' not in passenger:
            raise ValidationError(f'passenger[{i}] must include lat and lng')
        try:
            lat = float(passenger['lat'])
            lng = float(passenger['lng'])
        except (TypeError, ValueError):
            raise ValidationError(f'passenger[{i}] lat/lng must be numbers')
        passengers.append(Passenger(lng, lat, i))

    if total_capacity < len(passengers):
        raise ValidationError(
            f'insufficient total driver capacity ({total_capacity}) '
            f'for {len(passengers)} passengers'
        )

    return drivers, passengers, (dest_lng, dest_lat)
