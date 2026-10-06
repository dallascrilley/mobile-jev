import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createStore } from '../apps/jev-studio/server/store.mjs';
import { retryReadOnlyReadiness } from '../apps/jev-studio/server/device-readiness.mjs';
import { TypeSafePolicy } from './mobile-agent/policy.mjs';

const MAX_BODY_BYTES = 64 * 1024;
const OBSERVATION_MAX_AGE_MS = 30_000;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
};

export class DeviceServiceError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function sendJson(response, status, value, corsOrigin) {
  response.writeHead(status, {
    ...JSON_HEADERS,
    ...(corsOrigin ? { 'access-control-allow-origin': corsOrigin, vary: 'Origin' } : {}),
  });
  response.end(JSON.stringify(value));
}

function isLoopbackOrigin(origin) {
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  return ['http:', 'https:'].includes(parsed.protocol) && LOCAL_HOSTS.has(parsed.hostname);
}

function validateRequest(request) {
  const host = request.headers.host || '';
  let hostname;
  try {
    hostname = new URL(`http://${host}`).hostname;
  } catch {
    throw new DeviceServiceError('This service is available on loopback only.', 403);
  }
  if (!LOCAL_HOSTS.has(hostname))
    throw new DeviceServiceError('This service is available on loopback only.', 403);
  if (request.headers['sec-fetch-site'] === 'cross-site')
    throw new DeviceServiceError('Cross-site requests are not allowed.', 403);
  const origin = request.headers.origin;
  if (origin && !isLoopbackOrigin(origin)) throw new DeviceServiceError('Origin not allowed.', 403);
  return origin || undefined;
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new DeviceServiceError('Request body is too large.', 413);
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new DeviceServiceError('Request body must be valid JSON.');
  }
}

function validateAction(action) {
  if (
    !action ||
    typeof action !== 'object' ||
    Array.isArray(action) ||
    typeof action.type !== 'string'
  )
    throw new DeviceServiceError('An action object with a type is required.');
  const integer = (key, minimum = 0) => {
    if (!Number.isSafeInteger(action[key]) || action[key] < minimum)
      throw new DeviceServiceError(`${key} must be an integer >= ${minimum}.`);
  };
  switch (action.type) {
    case 'open-app':
      if (typeof action.packageName !== 'string' || !/^[A-Za-z0-9_.]+$/.test(action.packageName))
        throw new DeviceServiceError('packageName is invalid.');
      break;
    case 'tap':
      integer('x');
      integer('y');
      break;
    case 'tap-element':
      if (
        typeof action.elementId !== 'string' ||
        !action.elementId ||
        action.elementId.length > 200
      )
        throw new DeviceServiceError('elementId is invalid.');
      break;
    case 'swipe':
      for (const key of ['startX', 'startY', 'endX', 'endY']) integer(key);
      if (action.duration !== undefined) integer('duration', 10);
      if (action.regionId !== undefined && typeof action.regionId !== 'string')
        throw new DeviceServiceError('regionId must be a string.');
      break;
    case 'type':
      if (typeof action.text !== 'string' || action.text.length > 10_000)
        throw new DeviceServiceError('text must be a string with at most 10,000 characters.');
      if (action.clear !== undefined && typeof action.clear !== 'boolean')
        throw new DeviceServiceError('clear must be a boolean.');
      break;
    case 'clear':
      break;
    case 'key':
      if (!['enter', 'tab', 'delete', 'forward_delete', 'back'].includes(action.key))
        throw new DeviceServiceError('Unsupported keyboard key.');
      break;
    case 'global':
      if (!['back', 'home', 'recent'].includes(action.name))
        throw new DeviceServiceError('Unsupported global action.');
      break;
    default:
      throw new DeviceServiceError('Unsupported action type.');
  }
  return action;
}

function defaultAcquireLock() {
  return import('./mobile-agent/device-lock.mjs').then((module) => module.acquireDeviceLock);
}

function serviceDeviceId(device) {
  return process.env.AGENT_DEVICE_IDENTITY || device.deviceId || device.id || device.serial;
}

async function acquire(lock, id) {
  if (!id || typeof id !== 'string')
    throw new DeviceServiceError('AGENT_DEVICE_IDENTITY is not configured.', 503);
  const release = await lock(id);
  if (typeof release !== 'function')
    throw new Error('Device lock did not return a release function.');
  return release;
}

async function withLock(lock, id, fn) {
  const release = await acquire(lock, id);
  try {
    return await fn();
  } finally {
    await release();
  }
}

async function runRecovery({ binary, spawnProcess, lock, id }) {
  if (!binary) throw new DeviceServiceError('TABLET_RECOVER_BIN is not configured.', 503);
  return withLock(
    lock,
    id,
    () =>
      new Promise((resolve, reject) => {
        let child;
        try {
          child = spawnProcess(binary, [], {
            shell: false,
            stdio: ['ignore', 'ignore', 'ignore'],
            detached: process.platform !== 'win32',
          });
        } catch {
          reject(new DeviceServiceError('Could not start tablet recovery.', 502));
          return;
        }
        let settled = false;
        let timedOut = false;
        let escalation;
        const timer = setTimeout(() => {
          if (settled) return;
          timedOut = true;
          try {
            if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGTERM');
            else child.kill('SIGTERM');
          } catch {
            /* The process already exited. */
          }
          escalation = setTimeout(() => {
            try {
              if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
              else child.kill('SIGKILL');
            } catch {
              /* The process already exited. */
            }
          }, 2000);
          escalation.unref();
        }, 30_000);
        timer.unref();
        child.once('error', () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          clearTimeout(escalation);
          reject(new DeviceServiceError('Could not start tablet recovery.', 502));
        });
        child.once('close', (code) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          clearTimeout(escalation);
          if (timedOut) reject(new DeviceServiceError('Tablet recovery timed out.', 504));
          else if (code === 0) resolve({ recovered: true });
          else reject(new DeviceServiceError('Tablet recovery failed.', 502));
        });
      }),
  );
}

export function createDeviceServer({
  device,
  acquireDeviceLock,
  spawnProcess = spawn,
  recoverBin = process.env.TABLET_RECOVER_BIN,
  policy = new TypeSafePolicy({ backend: process.env.DECISION_BACKEND || 'rizzo' }),
  store = createStore({
    runner: fileURLToPath(new URL('./mobile-agent/web-runner.mjs', import.meta.url)),
  }),
  now = Date.now,
} = {}) {
  if (!device) throw new TypeError('createDeviceServer requires a device.');
  const lockProvider =
    acquireDeviceLock || (async (...args) => (await defaultAcquireLock())(...args));
  const observations = new Map();
  const id = serviceDeviceId(device);
  const clearObservations = () => {
    const expiry = now() - OBSERVATION_MAX_AGE_MS;
    for (const [key, entry] of observations) if (entry.at < expiry) observations.delete(key);
    while (observations.size > 32) observations.delete(observations.keys().next().value);
  };
  const server = createServer(async (request, response) => {
    let corsOrigin;
    try {
      corsOrigin = validateRequest(request);
      if (request.method === 'OPTIONS') {
        response.writeHead(204, {
          'access-control-allow-methods': 'GET, POST, OPTIONS',
          'access-control-allow-headers': 'content-type',
          'access-control-max-age': '600',
          ...(corsOrigin ? { 'access-control-allow-origin': corsOrigin, vary: 'Origin' } : {}),
        });
        response.end();
        return;
      }
      const url = new URL(request.url || '/', 'http://localhost');
      const requestedId = url.searchParams.get('deviceId');
      if (requestedId && requestedId !== device.deviceId)
        throw new DeviceServiceError('This service controls only its configured tablet.', 409);
      if (request.method === 'GET' && url.pathname === '/health') {
        const state = await withLock(lockProvider, id, () =>
          retryReadOnlyReadiness(() => device.assertReady()),
        );
        sendJson(
          response,
          200,
          {
            ok: true,
            backend: device.backend || process.env.MOBILE_DEVICE_BACKEND || 'mobilerun',
            device: state,
            decision: { backend: policy.backend, model: policy.model },
            runtime: {
              node: process.execPath,
              adb: device.adbBin || null,
              mobileJev: fileURLToPath(new URL('../', import.meta.url)),
              recovery: recoverBin || null,
            },
          },
          corsOrigin,
        );
        return;
      }
      if (request.method === 'GET' && url.pathname === '/devices') {
        const devices = await withLock(lockProvider, id, () => device.listDevices());
        sendJson(response, 200, devices, corsOrigin);
        return;
      }
      if (request.method === 'GET' && url.pathname === '/apps') {
        const apps = await withLock(lockProvider, id, () => device.listApps());
        sendJson(response, 200, apps, corsOrigin);
        return;
      }
      if (request.method === 'GET' && url.pathname === '/observe') {
        const observation = await withLock(lockProvider, id, () => device.observe());
        clearObservations();
        const observationId = randomUUID();
        observations.set(observationId, { at: now(), observation });
        sendJson(response, 200, { observationId, observation }, corsOrigin);
        return;
      }
      if (request.method === 'GET' && url.pathname === '/screenshot') {
        const png = await withLock(lockProvider, id, () => device.screenshot());
        if (
          !Buffer.isBuffer(png) ||
          !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        )
          throw new DeviceServiceError('Device did not return a PNG screenshot.', 502);
        response.writeHead(200, {
          'content-type': 'image/png',
          'cache-control': 'no-store',
          ...(corsOrigin ? { 'access-control-allow-origin': corsOrigin, vary: 'Origin' } : {}),
        });
        response.end(png);
        return;
      }
      if (request.method === 'POST' && url.pathname === '/actions') {
        const body = await readJson(request);
        if (body?.deviceId && body.deviceId !== device.deviceId)
          throw new DeviceServiceError('This service controls only its configured tablet.', 409);
        const action = validateAction(body?.action);
        let expected;
        if (action.type !== 'open-app') {
          if (typeof body.observationId !== 'string')
            throw new DeviceServiceError('A fresh observationId is required.');
          clearObservations();
          const cached = observations.get(body.observationId);
          if (!cached || now() - cached.at > OBSERVATION_MAX_AGE_MS)
            throw new DeviceServiceError('Observation expired. Observe again before you act.', 409);
          // Consume before dispatch so a lost response cannot replay an uncertain mutation.
          observations.delete(body.observationId);
          expected = cached.observation;
        }
        const receipt = await withLock(lockProvider, id, () => device.act(action, { expected }));
        sendJson(response, 200, { ok: true, receipt: receipt || null }, corsOrigin);
        return;
      }
      if (request.method === 'POST' && url.pathname === '/recover') {
        await runRecovery({ binary: recoverBin, spawnProcess, lock: lockProvider, id });
        sendJson(response, 200, { recovered: true }, corsOrigin);
        return;
      }
      if (request.method === 'GET' && url.pathname === '/runs') {
        sendJson(response, 200, store.list(), corsOrigin);
        return;
      }
      if (request.method === 'POST' && url.pathname === '/runs') {
        const body = await readJson(request);
        if (body?.deviceId && body.deviceId !== device.deviceId)
          throw new DeviceServiceError('This service controls only its configured tablet.', 409);
        if (!body || typeof body !== 'object' || Array.isArray(body))
          throw new DeviceServiceError('Run request must be a JSON object.');
        sendJson(response, 201, store.start(body), corsOrigin);
        return;
      }
      const match = url.pathname.match(/^\/runs\/([0-9a-f-]{36})(?:\/(stop))?$/i);
      if (match) {
        const [, runId, stop] = match;
        if (request.method === 'POST' && stop) {
          sendJson(response, 200, store.stop(runId), corsOrigin);
          return;
        }
        if (request.method === 'GET' && !stop) {
          const run = store.get(runId);
          if (!run) throw new DeviceServiceError('Run not found.', 404);
          sendJson(response, 200, run, corsOrigin);
          return;
        }
      }
      throw new DeviceServiceError('Not found.', 404);
    } catch (error) {
      const status =
        error instanceof DeviceServiceError
          ? error.status
          : error?.name === 'StaleObservationError' || error?.message?.startsWith('Device busy:')
            ? 409
            : error?.status || 500;
      sendJson(
        response,
        status,
        {
          error:
            error instanceof DeviceServiceError ? error.message : 'Device service request failed.',
        },
        corsOrigin,
      );
    }
  });
  return server;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { loadEnvironment } = await import('./env.mjs');
  loadEnvironment();
  process.env.DECISION_BACKEND ||= 'rizzo';
  const { createDevice } = await import('./mobile-agent/device-factory.mjs');
  const device = await createDevice();
  const server = createDeviceServer({ device });
  server.listen(Number(process.env.DEVICE_SERVICE_PORT || 3041), '127.0.0.1');
}
