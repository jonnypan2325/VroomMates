// Map markers are drawn SVG: a car for a driver's start, a numbered disc per pickup, a flag at the destination.
const INK = '#1f2430';

const CAR = 'M5.5 13.5h13M7 13.5l1.4-4.1A1.5 1.5 0 0 1 9.8 8.4h4.4a1.5 1.5 0 0 1 1.4 1l1.4 4.1M6 13.5h12a1 1 0 0 1 1 1V17a1 1 0 0 1-1 1h-.5M6.5 18H6a1 1 0 0 1-1-1v-2.5a1 1 0 0 1 1-1M8.5 18h7';
const WHEELS = [[8, 18], [16, 18]];
const FLAG = 'M8 19V5.5M8 6c2.5-1.2 4.5 1.2 8 0v6.5c-3.5 1.2-5.5-1.2-8 0';

/** The same glyph paths drawn inline in the steps list, so the list and the map match. */
export const GLYPHS = { car: CAR, wheels: WHEELS, flag: FLAG };

const icon = (svg, size, anchor) => {
  const maps = window.google.maps;
  return { url: 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(svg),
    scaledSize: new maps.Size(size, size), anchor: new maps.Point(anchor[0], anchor[1]) };
};

export function carIcon(color) {
  return icon(`<svg xmlns="http://www.w3.org/2000/svg" width="34" height="34" viewBox="0 0 34 34">
    <circle cx="17" cy="17" r="15" fill="${color}" stroke="#fff" stroke-width="2.5"/>
    <g transform="translate(5 4)" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
      <path d="${CAR}"/>${WHEELS.map(([cx, cy]) => `<circle cx="${cx}" cy="${cy}" r="1.5" fill="#fff"/>`).join('')}</g></svg>`, 34, [17, 17]);
}

export function pickupIcon(color, number, ink = '#fff') {
  const size = number > 9 ? 13 : 14;
  return icon(`<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 28 28">
    <circle cx="14" cy="14" r="12" fill="${color}" stroke="#fff" stroke-width="2.5"/>
    <text x="14" y="14" dy=".36em" text-anchor="middle" font-family="Poppins, Arial, sans-serif" font-size="${size}"
      font-weight="700" fill="${ink}">${number}</text></svg>`, 28, [14, 14]);
}

export function destinationIcon() {
  return icon(`<svg xmlns="http://www.w3.org/2000/svg" width="34" height="34" viewBox="0 0 34 34">
    <circle cx="17" cy="17" r="15" fill="#fff" stroke="${INK}" stroke-width="2.5"/>
    <g transform="translate(5 5)" fill="none" stroke="${INK}" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
      <path d="${FLAG}" fill="${INK}" fill-opacity=".9"/></g></svg>`, 34, [17, 17]);
}
