import React from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import RouteResults from './RouteResults';
import { driverSteps, formatClock } from './routeSteps';

const point = (stop_id, place_id, extra = {}) => ({ stop_id, label: '', address: `${stop_id} Street, Irvine, CA`,
  coordinates: { lat: 1, lng: 1 }, source: { kind: 'google_places', place_id }, ...extra });
const trip = (extra = {}) => ({
  id: 'result-1',
  inputs: {
    drivers: [{ ...point('d1', 'home', { label: 'Home' }), capacity: 3 }, { ...point('d2', 'tustin', { place_name: 'Tustin Market' }), capacity: 4 }],
    passengers: [point('p1', 'mia', { label: "Mia's apartment" }), point('p2', 'mia', { label: "Mia's apartment" }), point('p3', 'uci')],
    destination: point('end', 'bcd', { label: 'BCD Tofu' }),
  },
  assignments: [['d1', 'p1', 'p2', 'end'], ['d2', 'p3', 'end']],
  ...extra,
});
// Leg seconds per driver: 10 then 15 min for the first, 20 then 5 min for the second.
const LEGS = [[600, 900], [1200, 300]];

function show(props = {}) {
  const result = props.result || trip();
  const routes = result.inputs.drivers.map((_, index) => driverSteps(result, index));
  const handlers = { onSelect: jest.fn(), onRetry: jest.fn(), onRename: jest.fn(async () => {}) };
  const view = render(<RouteResults result={result} routes={routes} legs={LEGS} status="ready" selected={null}
    {...handlers} {...props} />);
  return { ...handlers, ...view, result, routes };
}
beforeEach(() => {
  window.requestAnimationFrame = (callback) => setTimeout(callback, 0);
});
const flushFrame = () => act(async () => { await new Promise((done) => setTimeout(done, 0)); });
// Edits commit through awaited callbacks; async act settles them.
async function settle(fire) { await act(async () => { fire(); }); }

test('shows one card per driver, named by place until someone is named, with seats and total drive', () => {
  show();
  const headers = screen.getAllByRole('button', { name: /seats/ });
  expect(headers.map((header) => header.textContent)).toEqual([
    expect.stringMatching(/^Home2 of 3 seats · 25 min drive/), expect.stringMatching(/^Tustin Market1 of 4 seats · 25 min drive/)]);
  headers.forEach((header) => {
    expect(header).toHaveAttribute('aria-expanded', 'false');
    // A collapsed card's panel is not in the page, so nothing points at it.
    expect(header).not.toHaveAttribute('aria-controls');
  });
  expect(screen.getByText('All drivers are on the map. Choose a driver to see their stops.')).toBeVisible();
  expect(screen.queryByText(/Driver \d/)).not.toBeInTheDocument();
});

test('an open card lists its stops with head counts and points its header at the panel', () => {
  show({ selected: 0 });
  const header = screen.getByRole('button', { name: /^Home/ });
  expect(header).toHaveAttribute('aria-expanded', 'true');
  // The panel it names is the open card's body, which holds the steps.
  // eslint-disable-next-line testing-library/no-node-access
  expect(document.getElementById(header.getAttribute('aria-controls'))).toContainElement(screen.getByText('2 people'));
  const steps = screen.getAllByRole('listitem').filter((item) => item.classList.contains('route-step'));
  expect(steps.map((item) => item.textContent)).toEqual([
    expect.stringContaining('Start: Home'), expect.stringContaining("Pickup 1: Mia's apartment"), expect.stringContaining('Destination: BCD Tofu')]);
  expect(within(steps[1]).getByText('2 people')).toBeVisible();
});

test('a lone driver\'s card is always open and its header is not a dimmed button', () => {
  const result = trip();
  result.inputs.drivers = [result.inputs.drivers[0]];
  result.inputs.passengers = result.inputs.passengers.slice(0, 2);
  result.assignments = [result.assignments[0]];
  show({ result });
  expect(screen.queryByRole('button', { name: /seats/ })).not.toBeInTheDocument();
  expect(screen.getByText('2 of 3 seats', { exact: false })).toBeVisible();
  expect(screen.getByRole('button', { name: /^Who is at the start/ })).toBeInTheDocument();
  expect(screen.queryByText('Show all drivers')).not.toBeInTheDocument();
});

test('an arrive-by time replaces drive minutes with leaving and pickup times worked back from it', () => {
  show({ selected: 0 });
  expect(screen.getByText('Set a time to see when each driver leaves and reaches each pickup.')).toBeVisible();
  expect(screen.queryByText(/^Leaves/)).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('Arrive by'), { target: { value: '19:00' } });
  expect(screen.getByText('Estimates use Google drive times, without traffic or time spent at pickups.')).toBeVisible();
  expect(screen.getByText(`Leaves ${formatClock(1115)}`)).toBeVisible();
  expect(screen.getByText(`about ${formatClock(1125)}`)).toBeVisible();
  expect(screen.getByText(`Arrives ${formatClock(1140)}`)).toBeVisible();
  expect(screen.getByRole('button', { name: /^Home/ })).toHaveTextContent(`leaves ${formatClock(1115)}`);
  expect(screen.getByRole('button', { name: /^Tustin Market/ })).toHaveTextContent(`leaves ${formatClock(1115)}`);
});

test('arrival times wait for drive times, and a new route starts without an arrive-by time', () => {
  const { rerender, routes, result } = show({ selected: 0, status: 'loading', legs: [] });
  fireEvent.change(screen.getByLabelText('Arrive by'), { target: { value: '19:00' } });
  expect(screen.getByText('Times appear once drive times load.')).toBeVisible();
  expect(screen.queryByText(/^Leaves/)).not.toBeInTheDocument();
  rerender(<RouteResults result={{ ...result, id: 'result-2' }} routes={routes} legs={LEGS} status="ready" selected={0}
    onSelect={jest.fn()} onRetry={jest.fn()} />);
  expect(screen.getByLabelText('Arrive by')).toHaveValue('');
});

test('names are added in place: the place shows until then and stays under the field while typing', async () => {
  const { onRename } = show({ selected: 0 });
  expect(screen.getByText('a name to add or change who is driving or getting picked up.', { exact: false })).toBeVisible();
  fireEvent.doubleClick(screen.getByRole('button', { name: /^Who is at the start: none, showing Home/ }));
  const field = screen.getByRole('textbox', { name: 'Who is at the start' });
  expect(field).toHaveAttribute('placeholder', 'Who is driving?');
  expect(screen.getAllByText('Home').some((node) => node.classList.contains('is-while-editing'))).toBe(true);
  fireEvent.change(field, { target: { value: 'Sam' } });
  await settle(() => fireEvent.keyDown(field, { key: 'Enter' }));
  expect(onRename).toHaveBeenCalledWith({ stopIds: ['d1'] }, 'Sam');
  fireEvent.doubleClick(screen.getByRole('button', { name: /^Who is at pickup 1/ }));
  const pickup = screen.getByRole('textbox', { name: 'Who is at pickup 1' });
  fireEvent.change(pickup, { target: { value: 'Mia and Alex' } });
  await settle(() => fireEvent.keyDown(pickup, { key: 'Enter' }));
  // One pickup with two people names both of them.
  expect(onRename).toHaveBeenLastCalledWith({ stopIds: ['p1', 'p2'] }, 'Mia and Alex');
});

test('named stops read person, then place; the card header says where the driver starts', () => {
  const result = trip();
  result.inputs.drivers[0].person = 'Jonathan';
  result.inputs.passengers[0].person = 'Mia';
  result.inputs.passengers[1].person = 'Alex';
  show({ result, selected: 0 });
  expect(screen.getByRole('button', { name: /^Jonathan from Home/ })).toBeVisible();
  expect(screen.getByRole('button', { name: /^Who is at the start: Jonathan/ })).toBeVisible();
  expect(screen.getByRole('button', { name: /^Who is at pickup 1: Mia,? and Alex/ })).toBeVisible();
  expect(screen.getByText("Mia's apartment")).toHaveClass('route-step-place');
});

test('a failed rename keeps the old name and says why', async () => {
  const onRename = jest.fn(async () => { throw new Error('The name was not saved. Check your connection and try again.'); });
  show({ selected: 0, onRename });
  fireEvent.doubleClick(screen.getByRole('button', { name: /^Who is at the start/ }));
  const field = screen.getByRole('textbox', { name: 'Who is at the start' });
  fireEvent.change(field, { target: { value: 'Sam' } });
  await settle(() => fireEvent.keyDown(field, { key: 'Enter' }));
  expect(screen.getByRole('alert')).toHaveTextContent('The name was not saved. Check your connection and try again.');
  expect(screen.getByRole('button', { name: /^Who is at the start: none/ })).toBeVisible();
});

test('the destination renames for this trip, except while it is marked as moved', () => {
  const { rerender, routes } = show({ selected: 0 });
  expect(screen.getByRole('button', { name: /^Destination name: BCD Tofu/ })).toBeVisible();
  const moved = trip({ moved: ['end'] });
  rerender(<RouteResults result={moved} routes={routes} legs={LEGS} status="ready" selected={0} onSelect={jest.fn()}
    onRetry={jest.fn()} onRename={jest.fn()} />);
  expect(screen.queryByRole('button', { name: /^Destination name/ })).not.toBeInTheDocument();
  const destination = screen.getAllByRole('listitem').find((item) => item.classList.contains('is-destination'));
  expect(within(destination).getByText('BCD Tofu')).toBeVisible();
  expect(within(destination).getByText('Moved')).toBeVisible();
});

test('without onRename the names are plain text with no hint', () => {
  show({ selected: 0, onRename: undefined });
  expect(screen.queryByRole('button', { name: /^Who is at/ })).not.toBeInTheDocument();
  expect(screen.queryByText(/a name to add or change/)).not.toBeInTheDocument();
});

test('Show all drivers hands focus to the card that was open', async () => {
  const { onSelect } = show({ selected: 1 });
  fireEvent.click(screen.getByRole('button', { name: 'Show all drivers' }));
  expect(onSelect).toHaveBeenCalledWith(null);
  await flushFrame();
  expect(screen.getByRole('button', { name: /^Tustin Market/ })).toHaveFocus();
});

test('unavailable directions are a short warning whose Retry keeps focus on the route', async () => {
  const { onRetry } = show({ status: 'error', legs: [] });
  expect(screen.getAllByRole('status').some((region) => region.textContent === 'Directions are unavailable.Retry')).toBe(true);
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Retry directions' }));
  expect(onRetry).toHaveBeenCalled();
  await flushFrame();
  expect(screen.getByRole('heading', { name: 'Your route' })).toHaveFocus();
  fireEvent.change(screen.getByLabelText('Arrive by'), { target: { value: '19:00' } });
  expect(screen.getByText('Times need drive times from Google.')).toBeVisible();
});

test('hands a route to a phone: Google Maps link, copied link and a QR code drawn in the page', async () => {
  const writeText = jest.fn(async () => {});
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  show({ selected: 0 });
  const link = screen.getByRole('link', { name: "Open Home's route in Google Maps" });
  expect(link.getAttribute('href')).toMatch(/^https:\/\/www\.google\.com\/maps\/dir\/\?api=1/);
  await settle(() => fireEvent.click(screen.getByRole('button', { name: 'Copy link' })));
  expect(writeText).toHaveBeenCalledWith(link.getAttribute('href'));
  expect(screen.getByText('Link copied.')).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'QR code' }));
  expect(screen.getByRole('img', { name: "QR code for Home's route" })).toBeInTheDocument();
});
