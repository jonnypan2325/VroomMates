// Credentials live only in this instance. Never put them in React state or storage.
export default class GoogleIdentitySession {
  constructor({ apiUrl, fetchImpl = (...args) => fetch(...args), now = Date.now,
    setTimer = setTimeout, clearTimer = clearTimeout, onLogout = () => {} }) {
    this.apiUrl = apiUrl.replace(/\/$/, '');
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.onLogout = onLogout;
    this.listeners = new Set();
    this.controllers = new Set();
    this.generation = 0;
    this.credential = null;
    this.candidate = null;
    this.timer = null;
    this.state = { status: 'anonymous', profile: null, error: '', retryable: false, generation: 0 };
  }

  subscribe = (listener) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = () => this.state;

  publish(next) {
    this.state = { ...next, generation: this.generation };
    this.listeners.forEach((listener) => listener());
  }

  clear(error = '') {
    this.generation += 1;
    this.credential = null;
    this.candidate = null;
    this.clearTimer(this.timer);
    this.timer = null;
    this.controllers.forEach((controller) => controller.abort());
    this.controllers.clear();
    this.publish({ status: 'anonymous', profile: null, error, retryable: false });
  }

  logout = () => {
    this.clear();
    this.onLogout();
  };

  rejectGoogle(generation) {
    if (generation !== this.generation) return;
    this.clear('Sign-in was not completed. Please try again.');
  }

  async acceptGoogle(response, generation) {
    if (generation !== this.generation || this.state.status === 'authenticated') return;
    this.clear();
    if (typeof response?.credential !== 'string' || !response.credential) {
      this.publish({ status: 'anonymous', profile: null, error: 'Sign-in failed. Please try again.', retryable: false });
      return;
    }
    this.candidate = response.credential;
    await this.verifyCandidate(this.generation);
  }

  retry = () => {
    if (this.state.retryable && this.candidate) return this.verifyCandidate(this.generation);
    return Promise.resolve();
  };

  async verifyCandidate(generation) {
    const credential = this.candidate;
    const controller = new AbortController();
    this.controllers.add(controller);
    this.publish({ status: 'verifying', profile: null, error: '', retryable: false });
    try {
      const response = await this.fetchImpl(`${this.apiUrl}/auth/verify`, {
        method: 'POST', credentials: 'omit', cache: 'no-store',
        headers: { Authorization: `Bearer ${credential}` }, signal: controller.signal,
      });
      if (generation !== this.generation) return;
      if (response.status === 503) throw new Error('unavailable');
      if (!response.ok) {
        this.clear('Sign-in failed. Please sign in again.');
        return;
      }
      const body = await response.json();
      if (generation !== this.generation) return;
      if (body.status !== 'success' || typeof body.user?.id !== 'string'
          || !body.user.id.startsWith('google:') || body.user.id.length <= 7
          || !Number.isSafeInteger(body.expires_at) || body.expires_at * 1000 <= this.now()) {
        this.clear('Sign-in expired or could not be verified. Please sign in again.');
        return;
      }
      this.credential = credential;
      this.candidate = null;
      this.expiresAt = body.expires_at * 1000;
      this.publish({ status: 'authenticated', profile: {
        id: body.user.id,
        ...(typeof body.user.given_name === 'string' && body.user.given_name
          ? { given_name: body.user.given_name } : {}),
      }, error: '', retryable: false });
      this.scheduleExpiry(generation);
    } catch (error) {
      if (generation !== this.generation || controller.signal.aborted) return;
      this.publish({ status: 'anonymous', profile: null,
        error: 'Sign-in verification is temporarily unavailable. Please retry.', retryable: true });
    } finally {
      this.controllers.delete(controller);
    }
  }

  scheduleExpiry(generation) {
    const remaining = this.expiresAt - this.now();
    if (remaining <= 0) {
      if (generation === this.generation) this.clear('Your sign-in expired. Please sign in again.');
      return;
    }
    this.timer = this.setTimer(() => {
      if (generation === this.generation) this.scheduleExpiry(generation);
    }, Math.min(remaining, 2147483647));
  }

  // Future protected handlers use this helper; it binds each dispatch to its owner.
  request = async (path, options = {}) => {
    if (!path.startsWith('/') || path.startsWith('//')) throw new Error('Use an API-relative path.');
    if (!this.credential || this.state.status !== 'authenticated') throw new Error('Sign in required.');
    if (this.now() >= this.expiresAt) {
      this.clear('Your sign-in expired. Please sign in again.');
      throw new Error('Sign in required.');
    }
    const generation = this.generation;
    const credential = this.credential;
    const controller = new AbortController();
    const cancel = () => controller.abort();
    if (options.signal?.aborted) controller.abort();
    options.signal?.addEventListener('abort', cancel, { once: true });
    this.controllers.add(controller);
    try {
      const headers = new Headers(options.headers);
      headers.set('Authorization', `Bearer ${credential}`);
      const response = await this.fetchImpl(`${this.apiUrl}${path}`, {
        ...options, headers, signal: controller.signal, credentials: 'omit', cache: 'no-store',
      });
      if (generation !== this.generation || controller.signal.aborted) {
        throw new DOMException('Authentication changed.', 'AbortError');
      }
      if (response.status === 401) this.clear('Your sign-in expired. Please sign in again.');
      // A narrow response facade keeps raw streams/clones from bypassing the guard.
      const ensureCurrent = () => {
        if (generation !== this.generation || controller.signal.aborted) {
          throw new DOMException('Authentication changed.', 'AbortError');
        }
      };
      const wrapResponse = (raw) => {
        const guarded = {
          ok: raw.ok, status: raw.status, statusText: raw.statusText,
          headers: raw.headers, url: raw.url, type: raw.type, redirected: raw.redirected,
          get bodyUsed() { return raw.bodyUsed; },
        };
        for (const method of ['json', 'text', 'blob', 'arrayBuffer', 'formData']) {
          if (typeof raw[method] !== 'function') continue;
          guarded[method] = async (...args) => {
            ensureCurrent();
            try {
              const body = await raw[method](...args);
              ensureCurrent();
              return body;
            } catch (error) {
              ensureCurrent();
              throw error;
            }
          };
        }
        if (typeof raw.clone === 'function') guarded.clone = () => {
          ensureCurrent();
          return wrapResponse(raw.clone());
        };
        return Object.freeze(guarded);
      };
      return wrapResponse(response);
    } catch (error) {
      if (generation !== this.generation || controller.signal.aborted) {
        throw new DOMException('Authentication changed.', 'AbortError');
      }
      throw error;
    } finally {
      options.signal?.removeEventListener('abort', cancel);
      this.controllers.delete(controller);
    }
  };
}
