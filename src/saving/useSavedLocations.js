import { useCallback, useEffect, useRef, useState } from 'react';
import { SavedApiError, canonicalText, newId, requestJSON, sameData } from './api';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/;
const RECORD_KEYS = ['id', 'label', 'source', 'schema_version', 'created_at', 'updated_at', 'resolution_required'].sort();

function sourceReference(source) {
  if (!source || !sameData(Object.keys(source).sort(), ['kind', 'place_id'])
      || source.kind !== 'google_places' || typeof source.place_id !== 'string'
      || !source.place_id || /[\s\p{C}]/u.test(source.place_id)
      || new TextEncoder().encode(source.place_id).length > 4096) {
    throw new SavedApiError(400, 'INVALID_LOCATION', 'Choose a location from the address suggestions before saving.');
  }
  return Object.freeze({ kind: 'google_places', place_id: source.place_id });
}

function recordFrom(body) {
  const row = body?.location;
  try {
    if (body?.status !== 'success' || !row || !sameData(Object.keys(row).sort(), RECORD_KEYS)
        || !UUID.test(row.id) || row.schema_version !== 1 || row.resolution_required !== true
        || !STAMP.test(row.created_at) || !Number.isFinite(Date.parse(row.created_at))
        || row.updated_at !== row.created_at || canonicalText(row.label, 80, 320) !== row.label) throw new Error();
    const source = sourceReference(row.source);
    return Object.freeze({ id: row.id, label: row.label, source, schema_version: 1,
      created_at: row.created_at, updated_at: row.updated_at, resolution_required: true });
  } catch (_) {
    throw new SavedApiError(503, 'INVALID_RESPONSE', 'Saved locations could not be confirmed. Please retry.');
  }
}

function content(row) {
  return { id: row.id, label: row.label, source: row.source };
}

function aborted() {
  return new DOMException('The account or request changed.', 'AbortError');
}

function pendingError(error, attempt) {
  const safe = error instanceof SavedApiError ? error
    : new SavedApiError(503, 'STORE_UNAVAILABLE', 'Saved locations are temporarily unavailable. Please retry.');
  if (!attempt) return safe;
  // References only, held in memory for an explicit retry; never provider addresses or geometry.
  const wrapped = new SavedApiError(safe.status, safe.code, safe.message, safe.existingId);
  wrapped.retryLabel = attempt.body.label;
  wrapped.retrySource = attempt.body.source;
  return wrapped;
}

/** Private, tab-memory location records, with one frozen unresolved write per owner. */
export default function useSavedLocations(auth) {
  const owner = auth?.status === 'authenticated' && typeof auth.profile?.id === 'string'
    ? auth.profile.id : null;
  const key = owner ? JSON.stringify([owner, auth.generation]) : null;
  const scopeRef = useRef(null);
  if (!scopeRef.current || scopeRef.current.key !== key) {
    scopeRef.current = { key, auth, alive: false, controllers: new Set(), attempt: null,
      writing: false, listVersion: 0, listRequest: 0 };
  }
  const scope = scopeRef.current;
  scope.auth = auth;
  const [state, setState] = useState({ key: null, locations: [], loading: false, error: null });
  const current = useCallback((signal) => Boolean(scope.key && scope.alive
    && scopeRef.current === scope && !signal?.aborted), [scope]);
  const update = useCallback((change) => {
    if (!current()) return;
    setState((previous) => {
      const base = previous.key === scope.key ? previous
        : { key: scope.key, locations: [], loading: false, error: null };
      return { ...base, ...change(base) };
    });
  }, [current, scope]);

  const run = useCallback(async (path, options = {}) => {
    if (!current()) throw aborted();
    const controller = new AbortController();
    scope.controllers.add(controller);
    try {
      const body = await requestJSON(scope.auth, path, { ...options, signal: controller.signal });
      if (!current(controller.signal)) throw aborted();
      return body;
    } catch (error) {
      if (!current(controller.signal)) throw aborted();
      throw error;
    } finally {
      scope.controllers.delete(controller);
    }
  }, [current, scope]);

  const refresh = useCallback(async () => {
    if (!current()) throw aborted();
    const request = ++scope.listRequest;
    const version = scope.listVersion;
    update(() => ({ loading: true, error: null }));
    try {
      const body = await run('/saved-locations');
      if (body?.status !== 'success' || !Array.isArray(body.locations) || body.locations.length > 100) {
        throw new SavedApiError(503, 'INVALID_RESPONSE', 'Saved locations could not be loaded. Please retry.');
      }
      const locations = body.locations.map((location) => recordFrom({ status: 'success', location }));
      if (new Set(locations.map((row) => row.id)).size !== locations.length) {
        throw new SavedApiError(503, 'INVALID_RESPONSE', 'Saved locations could not be loaded. Please retry.');
      }
      if (!current()) throw aborted();
      if (request === scope.listRequest && version === scope.listVersion) {
        update(() => ({ locations, error: scope.attempt ? pendingError(new SavedApiError(503,
          'UNRESOLVED_SAVE', 'An earlier save is unconfirmed. Check and retry it before saving another location.'), scope.attempt) : null }));
      }
    } catch (error) {
      if (!current()) throw aborted();
      const failure = pendingError(error, scope.attempt);
      if (request === scope.listRequest && version === scope.listVersion) update(() => ({ error: failure }));
      throw failure;
    } finally {
      if (request === scope.listRequest) update(() => ({ loading: false }));
    }
  }, [current, run, scope, update]);

  useEffect(() => {
    scope.alive = true;
    setState({ key: scope.key, locations: [], loading: Boolean(scope.key), error: null });
    if (scope.key) refresh().catch(() => {});
    return () => {
      scope.alive = false;
      scope.controllers.forEach((controller) => controller.abort());
      scope.controllers.clear();
      scope.attempt = null;
    };
  }, [refresh, scope]);

  const remember = useCallback((row) => {
    scope.listVersion += 1;
    update((previous) => ({ locations: [...previous.locations.filter((item) => item.id !== row.id), row]
      .sort((left, right) => left.label.localeCompare(right.label)), error: null }));
  }, [scope, update]);

  const save = useCallback(async (label, source) => {
    if (!current()) throw aborted();
    if (scope.writing) throw new SavedApiError(409, 'SAVE_IN_PROGRESS', 'A location save is already in progress.');
    let expected;
    try {
      expected = { label: canonicalText(label, 80, 320), source: sourceReference(source) };
    } catch (error) {
      const invalid = pendingError(error instanceof SavedApiError ? error
        : new SavedApiError(400, 'INVALID_LOCATION', 'Enter a label of 1–80 characters (up to 320 UTF-8 bytes).'), scope.attempt);
      update(() => ({ error: invalid }));
      throw invalid;
    }
    if (scope.attempt && !sameData(expected, { label: scope.attempt.body.label, source: scope.attempt.body.source })) {
      const unresolved = pendingError(new SavedApiError(409, 'UNRESOLVED_SAVE',
        'An earlier save is unconfirmed. Check and retry it before saving another location.'), scope.attempt);
      update(() => ({ error: unresolved }));
      throw unresolved;
    }
    const retry = Boolean(scope.attempt);
    const attempt = scope.attempt || { body: Object.freeze({ id: newId(), ...expected }) };
    scope.attempt = attempt;
    scope.writing = true;
    update(() => ({ error: null }));
    try {
      if (retry) {
        let found;
        try {
          found = recordFrom(await run(`/saved-locations/${attempt.body.id}`));
        } catch (error) {
          if (error?.status !== 404) throw error;
        }
        if (found) {
          if (!sameData(content(found), attempt.body)) {
            scope.attempt = null;
            throw new SavedApiError(409, 'LOCATION_EXISTS', 'The earlier save conflicts with stored data. Refresh and choose another label.');
          }
          if (!current()) throw aborted();
          scope.attempt = null;
          remember(found);
          void refresh().catch(() => {}); // Refresh failure does not undo a confirmed save.
          return found;
        }
        // A 404 allows this explicit same-ID/body retry; it cannot disprove an earlier in-flight write.
      }
      let response;
      try {
        response = await run('/saved-locations', { method: 'POST', body: attempt.body });
      } catch (error) {
        // Only a definite rejection of POST releases its body. Transport/5xx/malformed replies remain unresolved.
        if (error instanceof SavedApiError && [400, 401, 403, 409, 413, 415, 422].includes(error.status)) {
          scope.attempt = null;
        }
        throw error;
      }
      const row = recordFrom(response);
      if (!sameData(content(row), attempt.body)) {
        throw new SavedApiError(503, 'INVALID_RESPONSE', 'The save response did not match. Check and retry the earlier save.');
      }
      if (!current()) throw aborted();
      scope.attempt = null;
      remember(row);
      void refresh().catch(() => {}); // Keep confirmed changes visible while fetching the latest list.
      return row;
    } catch (error) {
      if (!current()) throw aborted();
      const failure = pendingError(error, scope.attempt);
      update(() => ({ error: failure }));
      throw failure;
    } finally {
      scope.writing = false;
    }
  }, [current, remember, refresh, run, scope, update]);

  const remove = useCallback(async (id) => {
    if (!current()) throw aborted();
    if (!UUID.test(id)) throw new SavedApiError(400, 'INVALID_LOCATION', 'Choose a saved location to delete.');
    try {
      try {
        const response = await run(`/saved-locations/${id}`, { method: 'DELETE' });
        if (response !== null) {
          throw new SavedApiError(503, 'INVALID_RESPONSE', 'The delete could not be confirmed. Refresh or retry before removing it from the list.');
        }
      } catch (error) {
        if (error?.status !== 404) throw error;
      }
      if (!current()) throw aborted();
      scope.listVersion += 1;
      update((previous) => ({ locations: previous.locations.filter((row) => row.id !== id),
        error: scope.attempt ? pendingError(new SavedApiError(503, 'UNRESOLVED_SAVE',
          'An earlier save is still unconfirmed. Check and retry it.'), scope.attempt) : null }));
      void refresh().catch(() => {}); // A list outage is separate from the confirmed deletion.
    } catch (error) {
      if (!current()) throw aborted();
      const failure = pendingError(error, scope.attempt);
      update(() => ({ error: failure }));
      throw failure;
    }
  }, [current, refresh, run, scope, update]);

  const visible = state.key === key && owner ? state : { locations: [], loading: Boolean(owner), error: null };
  return { locations: visible.locations, loading: visible.loading, error: visible.error, refresh, save, remove };
}
