import React, { useState } from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import RouteResults from './RouteResults';
import { driverSteps, formatTripClock, formatTripDate } from './routeSteps';
import { TextEncoder } from 'util';

beforeAll(() => { global.TextEncoder = TextEncoder; });

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
  expect(screen.queryByLabelText('Arrive by time')).not.toBeInTheDocument();
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

// The arrive-by time lives with the route: this wrapper saves what the fields send, as the planner does.
function Planned({ initial = '', origin = 'reopened', status = 'ready', legs = LEGS, onSave = async () => {} }) {
  const [result, setResult] = useState(() => {
    const base = trip({ origin });
    return initial ? { ...base, inputs: { ...base.inputs, arrive_by: initial } } : base;
  });
  const routes = result.inputs.drivers.map((_, index) => driverSteps(result, index));
  const save = async (value) => {
    await onSave(value);
    setResult((current) => {
      const { arrive_by: previous, ...rest } = current.inputs;
      return { ...current, inputs: value ? { ...rest, arrive_by: value } : rest };
    });
  };
  return <RouteResults result={result} routes={routes} legs={legs} status={status} selected={0} onSelect={() => {}}
    onRetry={() => {}} onArriveBy={save} />;
}
const pad = (number) => String(number).padStart(2, '0');
const today = () => { const now = new Date(); return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`; };
const setDate = (value) => settle(() => fireEvent.change(screen.getByLabelText('Arrive by date'), { target: { value } }));
const setTime = (value) => settle(() => fireEvent.change(screen.getByLabelText('Arrive by time'), { target: { value } }));

test('a saved arrive-by shows its weekday and day, and works back leaving and pickup times', () => {
  render(<Planned initial="2099-10-30T19:00" />);
  expect(screen.getByText(formatTripDate('2099-10-30'))).toBeVisible();
  expect(formatTripDate('2099-10-30')).not.toMatch(/2099/);
  expect(screen.getByLabelText('Arrive by date')).toHaveValue('2099-10-30');
  expect(screen.getByLabelText('Arrive by time')).toHaveValue('19:00');
  expect(screen.getByText('Estimates use Google drive times, without traffic or time spent at pickups.')).toBeVisible();
  expect(screen.getByText(`Leaves ${formatTripClock(1115, '2099-10-30')}`)).toBeVisible();
  expect(screen.getByText(`about ${formatTripClock(1125, '2099-10-30')}`)).toBeVisible();
  expect(screen.getByText(`Arrives ${formatTripClock(1140, '2099-10-30')}`)).toBeVisible();
  expect(screen.getByRole('button', { name: /^Home/ })).toHaveTextContent(`leaves ${formatTripClock(1115, '2099-10-30')}`);
});

test('without an arrive-by the route asks for one and shows drive minutes', () => {
  render(<Planned />);
  expect(screen.getByText('Date')).toBeVisible();
  expect(screen.getByText('Set a time to see when each driver leaves and reaches each pickup.')).toBeVisible();
  expect(screen.queryByText(/^Leaves/)).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: /^Home/ })).toHaveTextContent('25 min drive');
});

test('a time typed alone is for today; clearing either half clears the arrive-by', async () => {
  const onSave = jest.fn(async () => {});
  render(<Planned onSave={onSave} />);
  await setTime('23:59');
  expect(onSave).toHaveBeenLastCalledWith(`${today()}T23:59`);
  expect(screen.getByLabelText('Arrive by date')).toHaveValue(today());
  await setTime('');
  expect(onSave).toHaveBeenLastCalledWith('');
  await setDate('2099-10-30');
  expect(onSave).toHaveBeenCalledTimes(2);
  await setTime('19:00');
  expect(onSave).toHaveBeenLastCalledWith('2099-10-30T19:00');
  await setDate('');
  expect(onSave).toHaveBeenLastCalledWith('');
  expect(screen.getByText('Date')).toBeVisible();
  expect(screen.getByLabelText('Arrive by time')).toHaveValue('');
});

test('a past arrive-by is allowed with a quiet note', () => {
  render(<Planned initial="2000-01-01T08:00" />);
  expect(screen.getByText('This time has passed.')).toBeVisible();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

test('leaving times on the day before an early arrival name their day', () => {
  // 25 minutes of driving to arrive at 00:10 means leaving at 23:45 the evening before.
  render(<Planned initial="2099-11-02T00:10" />);
  const leaving = formatTripClock(-15, '2099-11-02');
  expect(leaving).toMatch(/^\S+ /);
  expect(screen.getByText(`Leaves ${leaving}`)).toBeVisible();
  expect(screen.getByText(`Arrives ${formatTripClock(10, '2099-11-02')}`)).toBeVisible();
  expect(formatTripClock(10, '2099-11-02')).not.toMatch(/^\S+ \d/);
});

test('times wait for drive times', () => {
  render(<Planned initial="2099-10-30T19:00" status="loading" legs={[]} />);
  expect(screen.getByText('Times appear once drive times load.')).toBeVisible();
  expect(screen.queryByText(/^Leaves/)).not.toBeInTheDocument();
});

test('an arrive-by that cannot be saved says so and puts the saved one back', async () => {
  const onSave = jest.fn(async () => { throw new Error('The time was not saved. Check your connection and try again.'); });
  render(<Planned initial="2099-10-30T19:00" onSave={onSave} />);
  await setTime('20:15');
  expect(screen.getByRole('alert')).toHaveTextContent('The time was not saved. Check your connection and try again.');
  expect(screen.getByLabelText('Arrive by time')).toHaveValue('19:00');
});

test('a route just calculated starts on today, unsaved; a reopened one does not', async () => {
  const onSave = jest.fn(async () => {});
  const { unmount } = render(<Planned origin="calculated" onSave={onSave} />);
  expect(screen.getByLabelText('Arrive by date')).toHaveValue(today());
  expect(screen.getByText(formatTripDate(today()))).toBeVisible();
  expect(screen.getByLabelText('Arrive by time')).toHaveValue('');
  expect(screen.getByText('Set a time to see when each driver leaves and reaches each pickup.')).toBeVisible();
  expect(onSave).not.toHaveBeenCalled();
  // Cleared, the date stays empty for this route rather than coming back.
  await setDate('');
  expect(screen.getByText('Date')).toBeVisible();
  expect(onSave).not.toHaveBeenCalled();
  unmount();
  render(<Planned origin="reopened" />);
  expect(screen.getByLabelText('Arrive by date')).toHaveValue('');
  expect(screen.getByText('Date')).toBeVisible();
});

test('the date field is keyboard reachable as the real date input', () => {
  render(<Planned initial="2099-10-30T19:00" />);
  const date = screen.getByLabelText('Arrive by date');
  date.focus();
  expect(date).toHaveFocus();
  expect(date).toHaveAttribute('type', 'date');
  expect(screen.getByRole('group', { name: 'Arrive by' })).toContainElement(date);
});
