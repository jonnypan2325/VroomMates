import { GLYPHS } from './glyphs';
import { ROUTE_STYLE } from './routeStyle';

// Map markers are drawn SVG: a car for a driver's start, a numbered disc per pickup, a flag at the destination.
// Each is drawn on a fixed grid (its viewBox) and shown at the size the route style gives it.
const INK = '#1f2430';
const { large: LARGE, pickup: PICKUP } = ROUTE_STYLE.markers;

const { car: CAR, wheels: WHEELS, flag: FLAG } = GLYPHS;

// Every marker is anchored at its centre.
const icon = (svg, size) => {
  const maps = window.google.maps;
  return { url: 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(svg),
    scaledSize: new maps.Size(size, size), anchor: new maps.Point(size / 2, size / 2) };
};

export function carIcon(color) {
  return icon(`<svg xmlns="http://www.w3.org/2000/svg" width="${LARGE}" height="${LARGE}" viewBox="0 0 34 34">
    <circle cx="17" cy="17" r="15" fill="${color}" stroke="#fff" stroke-width="2.5"/>
    <g transform="translate(5 4)" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
      <path d="${CAR}"/>${WHEELS.map(([cx, cy]) => `<circle cx="${cx}" cy="${cy}" r="1.5" fill="#fff"/>`).join('')}</g></svg>`, LARGE);
}

export function pickupIcon(color, number, ink = '#fff') {
  const size = number > 9 ? 13 : 14;
  return icon(`<svg xmlns="http://www.w3.org/2000/svg" width="${PICKUP}" height="${PICKUP}" viewBox="0 0 28 28">
    <circle cx="14" cy="14" r="12" fill="${color}" stroke="#fff" stroke-width="2.5"/>
    <text x="14" y="14" dy=".36em" text-anchor="middle" font-family="Poppins, Arial, sans-serif" font-size="${size}"
      font-weight="700" fill="${ink}">${number}</text></svg>`, PICKUP);
}

export function destinationIcon() {
  return icon(`<svg xmlns="http://www.w3.org/2000/svg" width="${LARGE}" height="${LARGE}" viewBox="0 0 34 34">
    <circle cx="17" cy="17" r="15" fill="#fff" stroke="${INK}" stroke-width="2.5"/>
    <g transform="translate(5 5)" fill="none" stroke="${INK}" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
      <path d="${FLAG}" fill="${INK}" fill-opacity=".9"/></g></svg>`, LARGE);
}
