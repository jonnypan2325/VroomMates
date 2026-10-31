import { useEffect, useMemo, useRef, useState } from 'react';
import { MUTED_COLOR, driverColor, driverInk, driverSteps, routeLayers, stepPerson, stopDetail, stopName, viewedFirst } from './routeSteps';
import { carIcon, destinationIcon, pickupIcon } from './markerIcons';
import { ROUTE_STYLE } from './routeStyle';

const IDLE = { key: null, status: 'idle', legs: [], paths: [] };
// A directions request that takes longer than this counts as unavailable.
const DIRECTIONS_TIMEOUT = 8000;
const { line, casing, layers: LAYERS } = ROUTE_STYLE;

function requestRoute(service, steps) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), DIRECTIONS_TIMEOUT);
    try {
      service.route({
        origin: steps[0].coordinates, destination: steps[steps.length - 1].coordinates,
        waypoints: steps.slice(1, -1).map((step) => ({ location: step.coordinates, stopover: true })),
        travelMode: window.google.maps.TravelMode.DRIVING,
      }, (response, status) => {
        clearTimeout(timer);
        resolve(status === 'OK' && response?.routes?.[0] ? response.routes[0] : null);
      });
    } catch {
      clearTimeout(timer);
      resolve(null);
    }
  });
}

/** The person first when named, then the place and its address. */
const stepLines = (step) => [stepPerson(step), stopName(step.point), stopDetail(step.point)].filter(Boolean);

function infoContent(step) {
  const box = document.createElement('div');
  box.className = 'route-info';
  stepLines(step).forEach((text, index) => {
    const line = document.createElement(index ? 'span' : 'strong');
    line.textContent = text;
    box.appendChild(line);
  });
  return box;
}

/**
 * Draws every driver's route on the map in that driver's colour. With a driver selected, the
 * others turn grey underneath it. Markers come from the stored stops, so they show even when
 * Google's directions (and with them the drive times) are unavailable.
 */
export default function useRouteMap(map, result, selected, attempt) {
  const routes = useMemo(() => result ? result.inputs.drivers.map((_, index) => driverSteps(result, index)) : [], [result]);
  const [directions, setDirections] = useState(IDLE);
  const info = useRef(null);
  // Renaming a person or the destination keeps these, so names never re-request directions or reframe the map.
  const resultId = result?.id;
  const geometry = result?.coordinates;
  const latestRoutes = useRef(routes);
  latestRoutes.current = routes;
  // The drivers chosen on this route, latest first: shown all together, the latest lies on top. A new route starts afresh.
  const recent = useRef({ id: null, order: [] });
  if (recent.current.id !== resultId) recent.current = { id: resultId, order: [] };
  if (selected !== null && recent.current.order[0] !== selected) recent.current.order = viewedFirst(recent.current.order, selected);
  const order = recent.current.order;

  useEffect(() => {
    if (!resultId) { setDirections(IDLE); return undefined; }
    // The map arrives after Maps loads; until then drive times are still coming, not unavailable.
    if (!map) {
      setDirections({ ...IDLE, key: resultId, status: 'loading' });
      return undefined;
    }
    if (!window.google?.maps?.DirectionsService) {
      setDirections({ ...IDLE, key: resultId, status: 'error' });
      return undefined;
    }
    let live = true;
    setDirections({ ...IDLE, key: resultId, status: 'loading' });
    const service = new window.google.maps.DirectionsService();
    Promise.all(latestRoutes.current.map((steps) => requestRoute(service, steps))).then((found) => {
      if (!live) return;
      setDirections({ key: resultId, status: found.every(Boolean) ? 'ready' : 'error',
        legs: found.map((route) => route ? route.legs.map((leg) => leg.duration?.value) : null),
        paths: found.map((route) => route?.overview_path || null) });
    });
    return () => { live = false; };
  }, [map, resultId, geometry, attempt]);

  const current = directions.key === result?.id ? directions : IDLE;

  useEffect(() => {
    if (!map || !result || !window.google?.maps?.Marker) return undefined;
    const maps = window.google.maps;
    if (!info.current) info.current = new maps.InfoWindow();
    const popup = info.current;
    const drawn = [];
    const marker = (step, icon, zIndex) => {
      const pin = new maps.Marker({ map, position: step.coordinates, icon, zIndex, title: stepLines(step).join('\n') });
      // Hover shows the title; a tap or click opens the same name and address.
      pin.addListener('click', () => { popup.setContent(infoContent(step)); popup.open({ map, anchor: pin }); });
      drawn.push(pin);
    };
    const layers = routeLayers(routes.length, order);
    routes.forEach((steps, index) => {
      const active = selected === null || selected === index;
      const color = active ? driverColor(index) : MUTED_COLOR;
      const path = current.paths[index];
      if (path) {
        // Each coloured route lies on its own white edge, like Google Maps, so it reads on any tiles and where
        // routes cross. Grey routes go without, so they stay behind the chosen one.
        const weight = active ? line.width : line.mutedWidth;
        const layer = selected === index ? LAYERS.chosen : layers[index];
        if (active) {
          drawn.push(new maps.Polyline({ map, path, strokeColor: casing.color, strokeOpacity: 1,
            strokeWeight: weight + casing.extraWidth, zIndex: layer }));
        }
        drawn.push(new maps.Polyline({ map, path, strokeColor: color, strokeOpacity: active ? 1 : line.mutedOpacity,
          strokeWeight: weight, zIndex: layer + 1 }));
      }
      steps.slice(0, -1).forEach((step) => marker(step,
        step.kind === 'start' ? carIcon(color) : pickupIcon(color, step.number, active ? driverInk(index) : '#fff'),
        active ? LAYERS.marker : LAYERS.mutedMarker));
    });
    if (routes.length) marker(routes[0][routes[0].length - 1], destinationIcon(), LAYERS.destination);
    return () => {
      drawn.forEach((item) => item.setMap(null));
      popup.close();
    };
  }, [map, result, routes, selected, current.paths, order]);

  // Frame the selected route, or all of them, whenever the choice changes; not when directions arrive.
  useEffect(() => {
    const routes = latestRoutes.current;
    if (!map || !routes.length || !window.google?.maps?.LatLngBounds) return;
    const bounds = new window.google.maps.LatLngBounds();
    routes.forEach((steps, index) => {
      if (selected === null || selected === index) steps.forEach((step) => bounds.extend(step.coordinates));
    });
    map.fitBounds(bounds, ROUTE_STYLE.framePadding);
  }, [map, geometry, selected]);

  return { routes, status: current.status, legs: current.legs };
}
