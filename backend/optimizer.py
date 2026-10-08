"""Bounded, exact geographic total-distance optimization (no Flask state).

Every listed driver travels. Minimizing complete route lengths therefore also
minimizes added distance, since the sum of their direct trips is constant.
Costs use ordinary floating-point arithmetic; strict recurrence comparisons
prefer fewer pickup/car pairs at equal costs, then identity, without promising
global rounded-cost ties.
"""

import math

MAX_PASSENGERS = 12
MAX_DRIVERS = 8


def haversine_distance(coord1, coord2, R=3959):
    """Great-circle miles for (longitude, latitude), with roundoff clamping."""
    lng1, lat1 = coord1
    lng2, lat2 = coord2
    lat1_r, lat2_r = math.radians(lat1), math.radians(lat2)
    dlat, dlon = lat2_r - lat1_r, math.radians(lng2 - lng1)
    a = (math.sin(dlat / 2) ** 2
         + math.cos(lat1_r) * math.cos(lat2_r) * math.sin(dlon / 2) ** 2)
    a = min(1.0, max(0.0, a))
    # atan2 avoids the extra asin conditioning loss near antipodal endpoints.
    return 2 * R * math.atan2(math.sqrt(a), math.sqrt(1.0 - a))


def _suffix_table(pickups, destination):
    """F[mask][j]: cheapest j-first suffix ending at the shared destination.

    Each raw identity has a bit, including passengers at equal coordinates.
    Paths contain ascending-ID indexes, so tuple ties are identity ties.
    """
    n, size = len(pickups), 1 << len(pickups)
    between = [[haversine_distance(a, b) for b in pickups] for a in pickups]
    to_dest = [haversine_distance(p, destination) for p in pickups]
    suffix = [None] * size
    members = [()] * size
    for mask in range(1, size):
        js = tuple(j for j in range(n) if mask & (1 << j))
        members[mask] = js
        row = [None] * n
        for j in js:
            rest = mask ^ (1 << j)
            if not rest:
                row[j] = (to_dest[j], (j,))
            else:
                row[j] = min((between[j][k] + suffix[rest][k][0],
                              (j,) + suffix[rest][k][1])
                             for k in members[rest])
        suffix[mask] = row
    return suffix, members


def _route_table(origin, pickups, destination, capacity, suffix, members):
    table = [None] * len(suffix)
    table[0] = (haversine_distance(origin, destination), ())
    first_legs = [haversine_distance(origin, p) for p in pickups]
    for mask in range(1, len(table)):
        if len(members[mask]) <= capacity:
            table[mask] = min((first_legs[j] + suffix[mask][j][0],
                               suffix[mask][j][1]) for j in members[mask])
    return table


def _solve(drivers, passengers, destination):
    """Return ID-ordered drivers/passengers and their optimal pickup index paths.

    Solve before any mutation. Suffix DP considers every next pickup; partition
    DP considers every capacity-feasible subset for each driver prefix.
    Tables use O(P*2**P + D*2**P) states and O(D*3**P) partition work.
    """
    if len(drivers) > MAX_DRIVERS:
        raise ValueError(f'total_distance supports at most {MAX_DRIVERS} drivers')
    if len(passengers) > MAX_PASSENGERS:
        raise ValueError(f'total_distance supports at most {MAX_PASSENGERS} passengers')
    ds = sorted(drivers, key=lambda d: d.get_driver_num())
    ps = sorted(passengers, key=lambda p: p.get_passenger_num())
    if sum(d.get_capacity() for d in ds) < len(ps):
        raise ValueError('insufficient total driver capacity')
    pickups = [p.get_coords() for p in ps]
    suffix, members = _suffix_table(pickups, destination)
    size = len(suffix)
    routes = [_route_table(d.get_coords(), pickups, destination,
                           d.get_capacity(), suffix, members) for d in ds]
    # Positional assignment signature compares passenger-to-driver ranks in ID
    # order. Ranks have the same ordering as driver IDs, even for sparse IDs.
    base = len(ds) + 1
    weights = [base ** (len(ps) - j - 1) for j in range(len(ps))]
    mask_weight = [0] * size
    for mask in range(1, size):
        bit = mask & -mask
        mask_weight[mask] = mask_weight[mask ^ bit] + weights[bit.bit_length() - 1]
    # Count distinct pickup coordinates per car. Summing these counts measures
    # splits without a weighted objective or any sacrifice in route distance.
    pickup_visits = [len({pickups[j] for j in members[mask]})
                     for mask in range(size)]
    previous = [None] * size
    previous[0] = (0.0, 0, 0)
    parents = []
    for i, table in enumerate(routes):
        current, parent = [None] * size, [None] * size
        for mask in range(size):
            sub = mask
            best = None
            while True:
                old, route = previous[mask ^ sub], table[sub]
                if old is not None and route is not None:
                    candidate = (old[0] + route[0], old[1] + pickup_visits[sub],
                                 old[2] + i * mask_weight[sub])
                    if best is None or candidate < best:
                        best, parent[mask] = candidate, sub
                if not sub:
                    break
                sub = (sub - 1) & mask
            current[mask] = best
        previous = current
        parents.append(parent)
    mask = size - 1
    if previous[mask] is None:
        raise ValueError('insufficient total driver capacity')
    paths = [None] * len(ds)
    for i in reversed(range(len(ds))):
        sub = parents[i][mask]
        if sub is None:
            raise RuntimeError('invalid optimizer reconstruction')
        paths[i] = routes[i][sub][1]
        mask ^= sub
    if mask:
        raise RuntimeError('incomplete optimizer reconstruction')
    return ds, ps, paths


def order_stops(driver, destination):
    """Shortest complete single-driver route, retaining both endpoints.

    Preserve F03's linear all-colocated shortcut even beyond the general bound.
    Unsupported larger mixed groups fail explicitly instead of expanding search.
    """
    passengers = driver.get_passengers()
    origin = driver.get_coords()
    if not passengers:
        return [origin, destination]
    pickups = [p.get_coords() for p in passengers]
    if all(p == pickups[0] for p in pickups):
        return [origin] + pickups + [destination]
    if len(pickups) > MAX_PASSENGERS:
        raise ValueError(f'total_distance supports at most {MAX_PASSENGERS} passengers')
    pickups = [p.get_coords() for p in sorted(passengers, key=lambda p: p.get_passenger_num())]
    suffix, members = _suffix_table(pickups, destination)
    table = _route_table(origin, pickups, destination, len(pickups), suffix, members)
    return [origin] + [pickups[j] for j in table[-1][1]] + [destination]


def distance_from_line(passenger, driver, destination):
    """Single-pickup detour retained as a public compatibility helper."""
    return (haversine_distance(driver.get_coords(), passenger.get_coords())
            + haversine_distance(passenger.get_coords(), destination)
            - haversine_distance(driver.get_coords(), destination))


def _apply(ds, ps, paths):
    for driver, path in zip(ds, paths):
        for j in path:
            driver.add_passenger(ps[j])


def assign_drivers(drivers, passengers, destination):
    """Append optimal fresh-request groups and decrement remaining capacities.

    Historical repeated calls still append/decrement; optimality is guaranteed
    for fresh validated objects, not preassigned/reused driver groups.
    """
    if not drivers or not passengers:
        return drivers
    ds, ps, paths = _solve(drivers, passengers, destination)
    _apply(ds, ps, paths)
    return drivers


def give_paths(drivers, passengers, destination):
    """Solve once, mutate once, and emit routes in original driver input order."""
    if not passengers:
        return [d.get_path(destination) for d in drivers]
    ds, ps, paths = _solve(drivers, passengers, destination)
    preassigned = any(d.get_passengers() for d in ds)
    _apply(ds, ps, paths)
    if preassigned:
        return [d.get_path(destination) for d in drivers]
    by_driver = {id(d): [d.get_coords()] + [ps[j].get_coords() for j in path]
                 + [destination] for d, path in zip(ds, paths)}
    return [by_driver[id(d)] for d in drivers]
