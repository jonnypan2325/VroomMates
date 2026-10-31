import React, { useId, useRef, useState } from 'react';
import InlineEdit from '../saving/InlineEdit';
import { Chevron } from '../saving/SavedLocationControls';
import { GLYPHS } from './markerIcons';
import { MAX_WAYPOINTS, mapsLinks, partLabel } from './mapsLinks';
import RouteQr from './RouteQr';
import { arrivalTimes, clockMinutes, driverColor, driverInk, driverName, formatClock, formatDuration, peopleText, seatsUsed, stepPerson,
  stopDetail, stopName } from './routeSteps';
import './Results.css';

function StepMark({ step }) {
  if (step.kind === 'pickup') return <span className="route-step-mark is-pickup" aria-hidden="true">{step.number}</span>;
  const glyph = step.kind === 'start'
    ? <><path d={GLYPHS.car} /><g fill="currentColor" stroke="none">
      {GLYPHS.wheels.map(([cx, cy]) => <circle key={cx} cx={cx} cy={cy} r="1.5" />)}</g></>
    : <path d={GLYPHS.flag} fill="currentColor" fillOpacity=".9" />;
  return <span className={'route-step-mark is-' + step.kind} aria-hidden="true">
    <svg width="18" height="18" viewBox="2 2 20 20" fill="none" stroke="currentColor" strokeWidth="1.9"
      strokeLinecap="round" strokeLinejoin="round">{glyph}</svg>
  </span>;
}

function RouteActions({ steps, name }) {
  const parts = mapsLinks(steps);
  const [copied, setCopied] = useState('');
  const [qrOpen, setQrOpen] = useState(false);
  const qrId = useId();
  const copy = async (part, index) => {
    const which = parts.length > 1 ? `Part ${index + 1} link` : 'Link';
    try {
      await navigator.clipboard.writeText(part.url);
      setCopied(`${which} copied.`);
    } catch (_) {
      setCopied('Copying is unavailable here. Open the route in Google Maps and share it from there.');
    }
  };
  return <div className="route-actions">
    {parts.length > 1 && <p className="saving-note">
      Google Maps opens at most {MAX_WAYPOINTS} stops at a time, so this route opens in {parts.length} parts.</p>}
    {parts.map((part, index) => <div className="route-action-row" key={part.url}>
      {parts.length > 1 && <span className="route-part-label">Part {index + 1}: {partLabel(part)}</span>}
      <a className="route-maps-link" href={part.url} target="_blank" rel="noopener noreferrer"
        aria-label={`Open ${name}'s route${parts.length > 1 ? ', part ' + (index + 1) + ',' : ''} in Google Maps`}>
        Open in Google Maps</a>
      <button type="button" className="text-button" onClick={() => void copy(part, index)}>Copy link</button>
    </div>)}
    <button type="button" className="text-button route-qr-toggle" aria-expanded={qrOpen} aria-controls={qrId}
      onClick={() => setQrOpen((open) => !open)}>QR code <Chevron open={qrOpen} /></button>
    <div id={qrId} className="route-qr" hidden={!qrOpen}>
      {qrOpen && parts.map((part, index) => <figure key={part.url}>
        <RouteQr value={part.url} title={`QR code for ${name}'s route${parts.length > 1 ? ', part ' + (index + 1) : ''}`} />
        <figcaption>{parts.length > 1 ? `Part ${index + 1}: ${partLabel(part)}. ` : ''}Scan with a phone camera to open this route in Google Maps.</figcaption>
      </figure>)}
    </div>
    <p className="saving-note" role="status">{copied}</p>
  </div>;
}

const streetName = (point) => point.place_name || (point.address || '').split(',')[0].trim();

/**
 * A stop's name. Drivers and pickups name who is there, with the place under it; the destination's name
 * is what this trip calls it. Without `onRename` the names are plain text.
 */
function StepName({ step, onRename, moved }) {
  const where = step.kind === 'start' ? 'the start' : step.kind === 'pickup' ? `pickup ${step.number}` : 'the destination';
  if (step.kind === 'destination') {
    const fallback = streetName(step.point);
    // A moved destination is renamed after Recalculate, so the rename cannot hide that it moved.
    return onRename && !moved
      ? <InlineEdit className="route-step-name" value={step.point.label || ''} fallback={fallback} placeholder={fallback}
        maxLength={80} label="Destination name" onCommit={(text) => onRename({ destination: true }, text)} />
      : <span className="route-step-name">{stopName(step.point)}</span>;
  }
  const person = stepPerson(step);
  const place = stopName(step.point);
  return <>
    {onRename
      ? <InlineEdit className="route-step-name" value={person} fallback={place} maxLength={80}
        placeholder={step.kind === 'start' ? 'Who is driving?' : 'Who is getting picked up?'}
        label={`Who is at ${where}`} onCommit={(text) => onRename({ stopIds: step.points.map((point) => point.stop_id) }, text)} />
      : <span className="route-step-name">{person || place}</span>}
    {/* Unnamed, the place is the name, and shows again under the field while a name is typed. */}
    {person ? <span className="route-step-place">{place}</span>
      : onRename && <span className="route-step-place is-while-editing">{place}</span>}
  </>;
}

/** When the stop is reached, given an arrive-by time: the driver leaves, a pickup is about, the destination is the time set. */
function StepTime({ step, minutes }) {
  if (minutes === undefined) return step.kind === 'start' ? <span aria-hidden="true">Start</span> : null;
  const clock = formatClock(minutes);
  if (step.kind === 'start') return <span className="route-step-time">Leaves {clock}</span>;
  if (step.kind === 'destination') return <span className="route-step-time">Arrives {clock}</span>;
  return <span className="route-step-time">about {clock}</span>;
}

/** Everyone arrives at the destination by one time; each driver's leaving and pickup times are worked back from it. */
function ArriveBy({ value, onChange, status }) {
  const id = useId();
  const note = !value ? 'Set a time to see when each driver leaves and reaches each pickup.'
    : status === 'ready' ? 'Estimates use Google drive times, without traffic or time spent at pickups.'
      : status === 'loading' ? 'Times appear once drive times load.' : 'Times need drive times from Google.';
  return <div className="route-arrive">
    <label htmlFor={id}>Arrive by</label>
    <input id={id} type="time" value={value} onChange={(event) => onChange(event.target.value)}
      aria-describedby={id + '-note'} />
    <p id={id + '-note'} className="saving-note">{note}</p>
  </div>;
}

/** Every driver's route as cards; the open card lists its stops in order and selects that route on the map. */
export default function RouteResults({ result, routes, legs, status, selected, onSelect, onRetry, onRename, children }) {
  const baseId = useId();
  const [renameError, setRenameError] = useState('');
  // The arrive-by time stays on screen for this route only; a new or reopened route starts without one.
  const [arrive, setArrive] = useState({ id: result.id, value: '' });
  const arriveBy = arrive.id === result.id ? arrive.value : '';
  const headers = useRef([]);
  const heading = useRef(null);
  const single = routes.length === 1;
  const open = single ? 0 : selected;
  const moved = new Set(result.moved || []);
  const rename = onRename && (async (target, text) => {
    setRenameError('');
    try { await onRename(target, text); } catch (error) {
      setRenameError(error.message || 'The name could not be changed.');
      throw error;
    }
  });
  // Both controls disappear when used, so focus moves to what they revealed instead of falling to the page.
  const showAll = () => {
    const was = selected;
    onSelect(null);
    requestAnimationFrame(() => headers.current[was]?.focus());
  };
  const retryDirections = () => {
    onRetry();
    requestAnimationFrame(() => heading.current?.focus());
  };
  return <section className="route-results" aria-label="Route">
    <div className="route-results-heading">
      <h3 ref={heading} tabIndex={-1}>Your route</h3>
      <span className="saving-note" role="status">{status === 'loading' ? 'Loading drive times…' : ''}</span>
    </div>
    {children}
    {status === 'error' && <div className="trip-notice route-map-error" role="status">
      <p>Directions are unavailable.</p>
      <button type="button" className="secondary-button" aria-label="Retry directions" onClick={retryDirections}>Retry</button>
    </div>}
    <ArriveBy value={arriveBy} status={status} onChange={(value) => setArrive({ id: result.id, value })} />
    {!single && <div className="route-overview-row">
      <p className="saving-note">{selected === null ? 'All drivers are on the map. Choose a driver to see their stops.' : ''}</p>
      {selected !== null && <button type="button" className="text-button" onClick={showAll}>Show all drivers</button>}
    </div>}
    <ul className="driver-cards">
      {routes.map((steps, index) => {
        const expanded = open === index;
        const driver = result.inputs.drivers[index];
        const times = legs[index];
        const total = times && times.every(Number.isFinite) ? times.reduce((sum, value) => sum + value, 0) : null;
        const clock = arrivalTimes(clockMinutes(arriveBy), times);
        const name = driverName(result, index);
        const place = stopName(driver);
        const panel = `${baseId}-driver-${index}`;
        const title = <>
          <span className="driver-card-swatch" aria-hidden="true" />
          <span className="driver-card-title">
            <span className="driver-card-name">{name}{driver.person && <span className="driver-card-from"> from {place}</span>}</span>
            <span className="driver-card-meta">{seatsUsed(result, index)} of {driver.capacity} seats
              {clock ? <> · leaves {formatClock(clock[0])}</> : total !== null && <> · {formatDuration(total)} drive</>}</span>
          </span>
        </>;
        return <li key={driver.stop_id} className={'driver-card' + (expanded ? ' is-open' : '') + (open !== null && !expanded ? ' is-muted' : '')}
          style={{ '--driver-color': driverColor(index), '--driver-ink': driverInk(index) }}>
          {single ? <div className="driver-card-header">{title}</div>
            : <button type="button" className="driver-card-header" ref={(node) => { headers.current[index] = node; }}
              aria-expanded={expanded} aria-controls={expanded ? panel : undefined}
              onClick={() => onSelect(expanded ? null : index)}>{title}<Chevron open={expanded} /></button>}
          {expanded && <div id={panel} className="driver-card-body">
            <ol className="route-steps">
              {steps.map((step, position) => {
                const detail = stopDetail(step.point);
                const wasMoved = [step.point, ...step.points].some((point) => moved.has(point.stop_id));
                return <li key={step.point.stop_id} className={'route-step is-' + step.kind}>
                  <StepMark step={step} />
                  <span className="route-step-text">
                    <span className="visually-hidden">{step.kind === 'start' ? 'Start: ' : step.kind === 'destination' ? 'Destination: ' : `Pickup ${step.number}: `}</span>
                    <StepName step={step} onRename={rename} moved={wasMoved} />
                    {detail && <span className="route-step-address">{detail}</span>}
                    {wasMoved && <span className="route-step-moved">Moved</span>}
                  </span>
                  <span className="route-step-meta">
                    {step.kind === 'pickup' && <span>{peopleText(step.people)}</span>}
                    <StepTime step={step} minutes={clock ? clock[position] : undefined} />
                  </span>
                </li>;
              })}
            </ol>
            {seatsUsed(result, index) === 0 && <p className="saving-note">No pickups. This driver goes straight to the destination.</p>}
            {renameError && <p className="saving-error route-rename-error" role="alert">{renameError}</p>}
            {rename && !renameError && <p className="saving-note route-name-hint">
              <span className="for-mouse">Double-click</span><span className="for-touch">Tap</span> a name to add or change who is driving or getting picked up.</p>}
            <RouteActions steps={steps} name={name} />
          </div>}
        </li>;
      })}
    </ul>
  </section>;
}
