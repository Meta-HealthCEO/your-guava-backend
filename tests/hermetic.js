/**
 * Runs before every test file, after the framework is installed (setupFilesAfterEnv).
 * 1. dotenv is inert: no module a test loads (server.js, seeds, migrations) can read a developer's .env.
 * 2. Outbound network is refused. http/https request and get, and global fetch, throw NETWORK_IN_TEST for
 *    any host that is not loopback. Code under test often swallows the error and degrades, so every attempt
 *    is also recorded and the file fails in afterAll, naming the host.
 */
const http = require('http');
const https = require('https');

jest.mock('dotenv', () => ({
  config: () => ({ parsed: {} }),
  parse: jest.requireActual('dotenv').parse,
}));

const GUARD = Symbol.for('your-guava.network-guard');
const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '::ffff:127.0.0.1', '0.0.0.0']);

const normaliseHost = (raw) => {
  const host = String(raw ?? '').trim().toLowerCase();
  if (host.startsWith('[')) return host.slice(1, host.indexOf(']'));
  return (host.match(/:/g) || []).length === 1 ? host.split(':')[0] : host;
};

const hostOf = (args) => {
  const [first, second] = args;
  if (typeof first === 'string' || first instanceof URL) {
    if (second && typeof second === 'object' && (second.hostname || second.host)) {
      return normaliseHost(second.hostname || second.host);
    }
    try {
      return normaliseHost(new URL(String(first)).hostname);
    } catch {
      return 'unparseable-url';
    }
  }
  if (!first || typeof first !== 'object' || first.socketPath) return 'localhost';
  return normaliseHost(first.hostname || first.host || 'localhost');
};

const attempts = [];
const blocked = (host, via) => {
  const error = new Error(`NETWORK_IN_TEST: ${via} to "${host}" is blocked in tests. Mock the service boundary instead.`);
  error.code = 'NETWORK_IN_TEST';
  attempts.push(error.message);
  return error;
};

// Core modules are shared by every test file in the process, so patch once and point the patch at the
// current file's log each time a file starts.
const guardModule = (mod, name) => {
  if (!mod[GUARD]) {
    const original = { request: mod.request, get: mod.get };
    const state = { blocked: null };
    for (const method of ['request', 'get']) {
      mod[method] = function guardedRequest(...args) {
        const host = hostOf(args);
        if (!LOOPBACK.has(host)) throw state.blocked(host, `${name}.${method}`);
        return original[method].apply(this, args);
      };
    }
    mod[GUARD] = state;
  }
  mod[GUARD].blocked = blocked;
};
guardModule(http, 'http');
guardModule(https, 'https');

if (typeof globalThis.fetch === 'function' && !globalThis.fetch[GUARD]) {
  const originalFetch = globalThis.fetch;
  const guardedFetch = (input, init) => {
    const url = typeof input === 'string' || input instanceof URL ? String(input) : input?.url;
    let host;
    try {
      host = normaliseHost(new URL(url).hostname);
    } catch {
      host = 'unparseable-url';
    }
    if (!LOOPBACK.has(host)) return Promise.reject(blocked(host, 'fetch'));
    return originalFetch(input, init);
  };
  guardedFetch[GUARD] = true;
  globalThis.fetch = guardedFetch;
}

globalThis.__guavaNetworkGuard = {
  attempts,
  clear: () => { attempts.length = 0; },
};

afterAll(() => {
  if (attempts.length === 0) return;
  const unique = [...new Set(attempts)];
  attempts.length = 0;
  throw new Error(`This test file attempted outbound network access:\n  ${unique.join('\n  ')}`);
});
