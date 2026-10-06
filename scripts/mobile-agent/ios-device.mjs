import { execFile } from 'node:child_process';
import http from 'node:http';
import { lstat, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { assertFresh, StaleObservationError, summarizeState } from './device.mjs';
import { confirmInput, prepareInputVerification } from './input-verification.mjs';

const run = promisify(execFile);

// Contract:
//  * IOS_DEVICE_UDID      exact physical UDID; devices are never guessed.
//  * IOS_WDA_URL          loopback WebDriverAgent URL owned by the supervised launcher.
//  * IOS_WDA_SESSION_ID   optional; otherwise the active session reported by /status is used.
//  * IOS_WDA_BINDING_FILE owner-only (0600) manifest written by the launcher:
//      { deviceId, deviceName, expectedWdaName, wdaUrl, runnerPid, proxyPid, sourceRevision,
//        expectedVendorUuid }
//    WDA /wda/device/info exposes a generic name and the vendor UUID, never the UDID. The manifest
//    binds this endpoint to the UDID; devicectl then proves the exact-UDID transport.
const UDID = /^(?:[0-9A-F]{8}-[0-9A-F]{16}|[0-9A-F]{40})$/i;
const UUID = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i;
const SESSION = /^[A-Za-z0-9-]{8,64}$/;
const ELEMENT = /^[A-Za-z0-9-]{8,64}$/;
const BUNDLE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/;
const REVISION = /^[0-9a-f]{40}$/;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '[::1]']);
const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const SPRINGBOARD = 'com.apple.springboard';

const MAX_TEXT = 4000;
const MAX_TREE_NODES = 30_000;
const MAX_TREE_DEPTH = 100;
const MAX_SCREEN = 20_000;
const SOURCE_BYTES = 8 * 1024 * 1024;
const SCREENSHOT_BYTES = 28 * 1024 * 1024;
const SMALL_BYTES = 256 * 1024;
const REQUEST_BODY_BYTES = 64 * 1024;
const READ_TIMEOUT_MS = 10_000;
const SOURCE_TIMEOUT_MS = 20_000;
const MUTATION_TIMEOUT_MS = 15_000;
const TRANSPORT_FRESH_MS = 30_000;
const IDENTITY_FRESH_MS = 5000;

export const IOS_CAPABILITIES = Object.freeze({
  platform: 'ios',
  coordinateSpace: 'points',
  globalActions: Object.freeze(['home']),
  keys: Object.freeze(['enter', 'delete']),
  gestures: Object.freeze(['tap', 'swipe']),
  openApp: true,
  text: Object.freeze({ replace: 'verified', append: 'transport-only' }),
});

const EDITABLE = new Set(['TextField', 'SecureTextField', 'TextView', 'SearchField']);
const CLICKABLE = new Set([
  'Button',
  'Link',
  'Cell',
  'Switch',
  'Toggle',
  'Tab',
  'Icon',
  'MenuItem',
  'Segment',
  'Stepper',
]);
const SCROLLABLE = new Set(['ScrollView', 'Table', 'CollectionView', 'WebView']);
const LABEL_AS_TEXT = new Set([
  'Button',
  'StaticText',
  'Link',
  'Cell',
  'Tab',
  'Switch',
  'MenuItem',
]);
const VALUE_BEARING = new Set(['Slider', 'PickerWheel', 'ProgressIndicator', 'PageIndicator']);
const CONTAINERS = new Set(['Application', 'Window']);

const uncertain = () =>
  new Error('iOS input result is uncertain; observe before recovery. Do not replay.');

class WdaRequestError extends Error {
  constructor(message, status, wdaError) {
    super(message);
    this.status = status;
    this.wdaError = wdaError;
  }
}

// Only the W3C error code is kept (for example "no such element"); messages can hold screen text.
function errorCode(bytes) {
  try {
    const code = JSON.parse(bytes.toString('utf8'))?.value?.error;
    return typeof code === 'string' && /^[a-z ]{1,64}$/.test(code) ? code : undefined;
  } catch {
    return undefined;
  }
}

// Bounded loopback HTTP for WebDriverAgent. Errors never echo response bodies, which can contain
// screen text.
export function wdaRequest({
  url,
  method = 'GET',
  body,
  timeoutMs = READ_TIMEOUT_MS,
  maxBytes = SMALL_BYTES,
}) {
  const target = new URL(url);
  if (
    target.protocol !== 'http:' ||
    !LOOPBACK_HOSTS.has(target.hostname) ||
    target.username ||
    target.password ||
    target.hash
  )
    throw new Error('WDA requests are limited to loopback HTTP.');
  if (!['GET', 'POST'].includes(method)) throw new Error('Unsupported WDA method.');
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000)
    throw new Error('Invalid WDA timeout.');
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error('Invalid WDA size limit.');
  const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  if (payload && payload.length > REQUEST_BODY_BYTES)
    throw new Error('WDA request body too large.');
  const started = performance.now();
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const req = http.request(
      {
        hostname: target.hostname.replace(/^\[|\]$/g, ''),
        port: target.port,
        path: target.pathname + target.search,
        method,
        agent: false,
        headers: {
          Accept: 'application/json',
          Connection: 'close',
          ...(payload
            ? { 'Content-Type': 'application/json', 'Content-Length': payload.length }
            : {}),
        },
      },
      (res) => {
        if (!LOOPBACK_ADDRESSES.has(res.socket?.remoteAddress)) {
          res.destroy();
          return finish(reject, new WdaRequestError('WDA peer is not loopback.'));
        }
        const declared = Number(res.headers['content-length']);
        if (Number.isFinite(declared) && declared > maxBytes) {
          res.destroy();
          return finish(reject, new WdaRequestError('WDA response is too large.'));
        }
        const chunks = [];
        let length = 0;
        res.on('data', (chunk) => {
          length += chunk.length;
          if (length > maxBytes) {
            res.destroy();
            finish(reject, new WdaRequestError('WDA response is too large.'));
          } else chunks.push(chunk);
        });
        res.on('error', () => finish(reject, new WdaRequestError('WDA response interrupted.')));
        res.on('aborted', () => finish(reject, new WdaRequestError('WDA response interrupted.')));
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300)
            return finish(
              reject,
              new WdaRequestError(
                `WDA returned HTTP ${res.statusCode}.`,
                res.statusCode,
                errorCode(Buffer.concat(chunks)),
              ),
            );
          const bytes = Buffer.concat(chunks);
          Object.defineProperty(bytes, 'timing', {
            value: {
              wallMs: Math.round((performance.now() - started) * 10) / 10,
              status: res.statusCode,
            },
          });
          finish(resolve, bytes);
        });
      },
    );
    timer = setTimeout(() => {
      req.destroy();
      finish(reject, new WdaRequestError('WDA request timed out.'));
    }, timeoutMs);
    req.on('error', () => finish(reject, new WdaRequestError('WDA transport failed.')));
    req.end(payload);
  });
}

function parseEnvelope(bytes) {
  let envelope;
  try {
    envelope = JSON.parse(Buffer.from(bytes).toString('utf8'));
  } catch {
    throw new Error('WDA returned invalid JSON.');
  }
  if (
    !envelope ||
    typeof envelope !== 'object' ||
    Array.isArray(envelope) ||
    !Object.hasOwn(envelope, 'value') ||
    (envelope.sessionId !== undefined &&
      envelope.sessionId !== null &&
      typeof envelope.sessionId !== 'string')
  )
    throw new Error('WDA returned a malformed response.');
  return envelope;
}

export function normalizeLoopbackUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('IOS_WDA_URL must be a loopback http URL.');
  }
  if (
    url.protocol !== 'http:' ||
    !LOOPBACK_HOSTS.has(url.hostname) ||
    !url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  )
    throw new Error('IOS_WDA_URL must be http://127.0.0.1:PORT (loopback only).');
  return `http://${url.host}`;
}

const sameUdid = (a, b) =>
  typeof a === 'string' && typeof b === 'string' && a.toUpperCase() === b.toUpperCase();

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Reads and validates the launcher-owned binding manifest: a private regular file owned by this
// user that names live launcher processes.
export async function loadBinding({ file, udid, wdaUrl, alive = isProcessAlive }) {
  if (!file) throw new Error('Set IOS_WDA_BINDING_FILE to the launcher-owned binding manifest.');
  let info, text;
  try {
    info = await lstat(file);
    if (!info.isFile() || info.size > 8192) throw new Error();
    text = await readFile(file, 'utf8');
  } catch {
    throw new Error('iOS binding manifest is missing, unreadable or invalid.');
  }
  if ((info.mode & 0o077) !== 0 || (process.getuid && info.uid !== process.getuid()))
    throw new Error('iOS binding manifest must be owner-only (0600) and owned by this user.');
  let manifest;
  try {
    manifest = JSON.parse(text);
  } catch {
    throw new Error('iOS binding manifest is not valid JSON.');
  }
  const name = (v) => typeof v === 'string' && v.length > 0 && v.length <= 128;
  if (
    !manifest ||
    typeof manifest !== 'object' ||
    !UDID.test(manifest.deviceId ?? '') ||
    !name(manifest.deviceName) ||
    !name(manifest.expectedWdaName) ||
    !UUID.test(manifest.expectedVendorUuid ?? '') ||
    !REVISION.test(manifest.sourceRevision ?? '') ||
    !Number.isSafeInteger(manifest.runnerPid) ||
    manifest.runnerPid < 2 ||
    !Number.isSafeInteger(manifest.proxyPid) ||
    manifest.proxyPid < 2
  )
    throw new Error('iOS binding manifest is incomplete or malformed.');
  if (!sameUdid(manifest.deviceId, udid))
    throw new Error('iOS binding manifest is for a different device.');
  let manifestUrl;
  try {
    manifestUrl = normalizeLoopbackUrl(manifest.wdaUrl);
  } catch {
    throw new Error('iOS binding manifest URL is not an exact loopback URL.');
  }
  if (manifestUrl !== wdaUrl) throw new Error('iOS binding manifest is for a different WDA URL.');
  if (!alive(manifest.runnerPid) || !alive(manifest.proxyPid))
    throw new Error('The supervised WDA runner or proxy is no longer running.');
  return Object.freeze({ ...manifest });
}

function wdBool(value, field) {
  if (value === undefined || value === null) return false;
  if (value === true || value === '1' || value === 'true') return true;
  if (value === false || value === '0' || value === 'false') return false;
  throw new Error(`WDA tree has an invalid boolean (${field}).`);
}

function rectOf(node) {
  const r = node.rect;
  if (
    !r ||
    typeof r !== 'object' ||
    ![r.x, r.y, r.width, r.height].every(Number.isFinite) ||
    r.width < 0 ||
    r.height < 0
  )
    throw new Error('WDA tree contains an invalid rect.');
  return { left: r.x, top: r.y, right: r.x + r.width, bottom: r.y + r.height };
}

export function clampBounds(b, screen) {
  return {
    left: Math.max(0, b.left),
    top: Math.max(0, b.top),
    right: Math.min(screen.width, b.right),
    bottom: Math.min(screen.height, b.bottom),
  };
}

const sameBounds = (a, b) =>
  a.left === b.left && a.top === b.top && a.right === b.right && a.bottom === b.bottom;

function optionalString(value, field) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new Error(`WDA tree has an invalid ${field}.`);
  return value;
}

// WDA reports the placeholder as the value of an empty text field. Applies to editable nodes only.
export function fieldValue(value, placeholder) {
  return placeholder && value === placeholder ? '' : value;
}

function validateScreen(size) {
  if (
    !size ||
    !Number.isSafeInteger(size.width) ||
    !Number.isSafeInteger(size.height) ||
    size.width < 1 ||
    size.height < 1 ||
    size.width > MAX_SCREEN ||
    size.height > MAX_SCREEN
  )
    throw new Error('WDA window size must be positive whole-point dimensions.');
  return { width: size.width, height: size.height };
}

// Converts WDA's JSON accessibility tree into the shared Mobilerun-shaped state so element IDs,
// fingerprints, input detection and password masking use the same code as Android. All geometry
// is in points.
// WDA's tree isFocused is accessibility focus, not keyboard focus, so it is ignored. `focus` is the
// identity of WDA's active (keyboard-focused) element; it marks a field only when exactly one
// editable node matches. No field is ever inferred from a visible keyboard or a sole editable.
export function summarizeIosState({ tree, size, bundleId, appLabel = '', deviceId, focus = null }) {
  const screen = validateScreen(size);
  if (!tree || typeof tree !== 'object' || Array.isArray(tree))
    throw new Error('WDA source is not an accessibility tree.');
  let count = 0;
  let keyboardVisible = false;
  const kinds = new Map();
  const names = new Map();
  const editables = [];
  const convert = (x, path, depth) => {
    if (!x || typeof x !== 'object' || Array.isArray(x))
      throw new Error('WDA tree contains an invalid node.');
    if (++count > MAX_TREE_NODES || depth > MAX_TREE_DEPTH)
      throw new Error('WDA tree is too large.');
    if (typeof x.type !== 'string' || !x.type) throw new Error('WDA tree node has no type.');
    if (x.children !== undefined && !Array.isArray(x.children))
      throw new Error('WDA tree has invalid children.');
    const visible = wdBool(x.isVisible, 'isVisible');
    if (x.type === 'Keyboard') {
      keyboardVisible ||= visible;
      return null; // Keyboard keys are never action targets; typing uses the text endpoints.
    }
    const bounds = rectOf(x);
    const traits = optionalString(x.traits, 'traits');
    const label = optionalString(x.label, 'label');
    const rawValue = optionalString(x.value, 'value');
    const placeholder = optionalString(x.placeholderValue, 'placeholderValue');
    const editable = EDITABLE.has(x.type);
    const password = x.type === 'SecureTextField';
    let text = '';
    let description = '';
    let hint = '';
    if (CONTAINERS.has(x.type)) {
      // Application and window labels repeat the app name and are not controls.
    } else if (editable) {
      text = password ? '' : fieldValue(rawValue, placeholder);
      description = label;
      hint = placeholder;
    } else if (VALUE_BEARING.has(x.type) || /\bAdjustable\b/.test(traits)) {
      text = rawValue;
      description = label;
    } else if (LABEL_AS_TEXT.has(x.type)) {
      text = label || (x.type === 'StaticText' ? rawValue : '');
    } else {
      description = label;
      text = rawValue && rawValue !== label ? rawValue : '';
    }
    kinds.set(path, x.type);
    names.set(path, optionalString(x.name, 'name'));
    wdBool(x.isFocused, 'isFocused');
    const toggle = x.type === 'Switch' || x.type === 'Toggle';
    const node = {
      boundsInScreen: bounds,
      isVisibleToUser: visible,
      text,
      contentDescription: description,
      hint,
      resourceId: optionalString(x.rawIdentifier, 'rawIdentifier'),
      className: x.type,
      isClickable: CLICKABLE.has(x.type) || /\b(Button|Link)\b/.test(traits),
      isEditable: editable,
      isScrollable: SCROLLABLE.has(x.type),
      isEnabled: wdBool(x.isEnabled, 'isEnabled'),
      isFocused: false,
      isPassword: password,
      isCheckable: toggle,
      isChecked: toggle && ['1', 'true'].includes(rawValue),
      isSelected: /\bSelected\b/.test(traits),
      children: undefined,
    };
    if (editable && visible && node.isEnabled)
      editables.push({ node, kind: x.type, bounds, name: names.get(path) });
    node.children = x.children?.map((child, i) => convert(child, `${path}.${i}`, depth + 1));
    return node;
  };
  const root = convert(tree, 'ui', 0);
  if (focus) {
    const matches = editables.filter(
      (e) =>
        e.kind === focus.kind &&
        e.name === focus.name &&
        sameBounds(clampBounds(e.bounds, screen), focus.bounds),
    );
    if (matches.length === 1) matches[0].node.isFocused = true;
  }
  const observation = summarizeState(
    {
      device_context: { screen_bounds: { ...screen } },
      phone_state: {
        packageName: bundleId,
        currentApp: appLabel || bundleId,
        isEditable: false,
        keyboardVisible: false, // Never let a visible keyboard imply which field has focus.
      },
      a11y_tree: root,
    },
    deviceId,
  );
  Object.freeze(observation.screen);
  for (const element of observation.elements) {
    element.kind = kinds.get(element.id);
    element.wdaName = names.get(element.id) ?? '';
    Object.freeze(element.bounds);
  }
  observation.phone.keyboardVisible = keyboardVisible;
  if (observation.phone.inputElementId) observation.phone.focusEvidence = 'wda-active-element';
  observation.platform = 'ios';
  observation.capabilities = IOS_CAPABILITIES;
  return observation;
}

function point(x, y, screen) {
  if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y) || x < 0 || y < 0)
    throw new Error('Coordinates must be whole non-negative screen points.');
  if (x >= screen.width || y >= screen.height)
    throw new Error('Coordinates are outside the screen.');
}

const move = (x, y, duration = 0) => ({ type: 'pointerMove', duration, x, y, origin: 'viewport' });
const down = { type: 'pointerDown', button: 0 };
const up = { type: 'pointerUp', button: 0 };
const pause = (duration) => ({ type: 'pause', duration });
const pointerActions = (steps) => ({
  actions: [
    { type: 'pointer', id: 'finger1', parameters: { pointerType: 'touch' }, actions: steps },
  ],
});

export class IosDevice {
  constructor({
    deviceId = process.env.IOS_DEVICE_UDID,
    wdaUrl = process.env.IOS_WDA_URL,
    sessionId = process.env.IOS_WDA_SESSION_ID,
    bindingFile = process.env.IOS_WDA_BINDING_FILE,
    identityCheck,
    request = wdaRequest,
    runner = run,
    devicectl = ['xcrun', 'devicectl'],
    alive = isProcessAlive,
    textCompletionMode,
  } = {}) {
    if (textCompletionMode !== undefined)
      throw new Error('Text completion mode does not apply to the iOS backend.');
    if (deviceId !== undefined && !UDID.test(deviceId))
      throw new Error('IOS_DEVICE_UDID must be an exact physical device UDID.');
    const pinned = (process.env.AGENT_DEVICE_IDENTITY || '').trim();
    if (pinned && deviceId && !sameUdid(pinned, deviceId))
      throw new Error('AGENT_DEVICE_IDENTITY must equal IOS_DEVICE_UDID for iOS.');
    if (sessionId !== undefined && !SESSION.test(sessionId))
      throw new Error('IOS_WDA_SESSION_ID is malformed.');
    this.deviceId = deviceId;
    this.wdaUrl = wdaUrl === undefined ? undefined : normalizeLoopbackUrl(wdaUrl);
    this.baseUrl = this.wdaUrl;
    this.configuredSession = sessionId;
    this.bindingFile = bindingFile;
    this.identityCheck = identityCheck;
    this.request = request;
    this.runner = runner;
    this.devicectl = devicectl;
    this.alive = alive;
    this.backend = 'ios';
    this.capabilities = IOS_CAPABILITIES;
    this.installedApps = [];
    this.status = undefined;
    this.name = undefined;
    this.transportAt = -Infinity;
    this.identityAt = -Infinity;
  }

  requireConfig() {
    if (!this.deviceId)
      throw new Error('Set IOS_DEVICE_UDID or pass --device; never guess devices.');
    if (!this.wdaUrl) throw new Error('Set IOS_WDA_URL to the supervised loopback WDA endpoint.');
  }

  async read(path, { timeoutMs = READ_TIMEOUT_MS, maxBytes = SMALL_BYTES, session } = {}) {
    let bytes;
    try {
      bytes = await this.request({
        url: `${this.wdaUrl}${path}`,
        method: 'GET',
        timeoutMs,
        maxBytes,
      });
    } catch (cause) {
      throw Object.assign(
        new Error(
          'WDA request failed or timed out; the device may be disconnected or locked, or the runner stopped.',
        ),
        { status: cause?.status, wdaError: cause?.wdaError },
      );
    }
    const envelope = parseEnvelope(bytes);
    const failure = envelope.value;
    if (
      failure &&
      typeof failure === 'object' &&
      typeof failure.error === 'string' &&
      typeof failure.message === 'string'
    )
      // W3C error envelope: keep only its code, never the message (it can hold screen text).
      throw Object.assign(new Error('WDA reported an error.'), {
        wdaError: /^[a-z ]{1,64}$/.test(failure.error) ? failure.error : undefined,
      });
    if (session && envelope.sessionId !== session)
      throw new Error('WDA session changed; observe and decide again.');
    return envelope;
  }

  // Every mutation is dispatched once. Any doubt about the outcome is reported, never replayed.
  async mutate(path, body, session) {
    let envelope;
    try {
      const bytes = await this.request({
        url: `${this.wdaUrl}${path}`,
        method: 'POST',
        body,
        timeoutMs: MUTATION_TIMEOUT_MS,
        maxBytes: SMALL_BYTES,
      });
      envelope = parseEnvelope(bytes);
    } catch {
      throw uncertain();
    }
    if (session && envelope.sessionId !== session) throw uncertain();
    return envelope.value;
  }

  async devicectlJson(args, timeoutSeconds = 25) {
    const dir = await mkdtemp(join(tmpdir(), 'ios-devicectl-'));
    const out = join(dir, 'out.json');
    const [bin, ...prefix] = this.devicectl;
    try {
      try {
        await this.runner(
          bin,
          [...prefix, ...args, '--json-output', out, '--timeout', String(timeoutSeconds)],
          { timeout: (timeoutSeconds + 10) * 1000, maxBuffer: 1024 * 1024, encoding: 'utf8' },
        );
      } catch {
        throw new Error('devicectl failed or timed out for the pinned device.');
      }
      let json;
      try {
        const info = await lstat(out);
        if (!info.isFile() || info.size > 16 * 1024 * 1024) throw new Error();
        json = JSON.parse(await readFile(out, 'utf8'));
      } catch {
        throw new Error('devicectl returned invalid output.');
      }
      if (json?.info?.outcome !== 'success' || !json.result || typeof json.result !== 'object')
        throw new Error('devicectl reported an unsuccessful outcome.');
      return json.result;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  // Exact-UDID CoreDevice transport precheck. A details response is metadata; readiness needs a
  // connected tunnel, Developer Mode and available developer services.
  async checkTransport(expectedName) {
    const result = await this.devicectlJson([
      'device',
      'info',
      'details',
      '--device',
      this.deviceId,
    ]);
    const udids = [result.hardwareProperties?.udid, result.properties?.hardware?.udid].filter(
      (v) => v !== undefined,
    );
    if (!udids.length || !udids.every((v) => sameUdid(v, this.deviceId)))
      throw new Error('devicectl reports a different device than the pinned UDID.');
    const connection = result.connectionProperties;
    const properties = result.deviceProperties;
    if (
      connection?.tunnelState !== 'connected' ||
      connection?.pairingState !== 'paired' ||
      properties?.bootState !== 'booted'
    )
      throw new Error('The pinned iOS device is not connected, paired and booted.');
    if (properties?.developerModeStatus !== 'enabled' || properties?.ddiServicesAvailable !== true)
      throw new Error(
        'The pinned iOS device has Developer Mode or developer services unavailable.',
      );
    if (result.hardwareProperties?.platform !== 'iOS')
      throw new Error('The pinned device is not an iOS device.');
    if (expectedName !== undefined && properties?.name !== expectedName)
      throw new Error('devicectl device name does not match the binding manifest.');
    this.transportAt = performance.now();
  }

  async verifyIdentity({ maxAgeMs = 0 } = {}) {
    this.requireConfig();
    const now = performance.now();
    if (this.identityAt > -Infinity && now - this.identityAt <= maxAgeMs) return;
    let name;
    if (this.identityCheck) {
      // Test injection only; real runtimes require the manifest.
      name = (await this.identityCheck({ deviceId: this.deviceId, wdaUrl: this.wdaUrl }))
        ?.deviceName;
    } else {
      const binding = await loadBinding({
        file: this.bindingFile,
        udid: this.deviceId,
        wdaUrl: this.wdaUrl,
        alive: this.alive,
      });
      const info = (await this.read('/wda/device/info')).value;
      if (
        !info ||
        typeof info !== 'object' ||
        info.name !== binding.expectedWdaName ||
        typeof info.uuid !== 'string' ||
        info.uuid.toUpperCase() !== binding.expectedVendorUuid.toUpperCase() ||
        info.isSimulator === true
      )
        throw new Error('WDA endpoint does not match the pinned physical device binding.');
      name = binding.deviceName;
    }
    if (performance.now() - this.transportAt > TRANSPORT_FRESH_MS) await this.checkTransport(name);
    this.name = name;
    this.identityAt = performance.now();
  }

  async assertReady({ maxAgeMs = 0 } = {}) {
    await this.verifyIdentity({ maxAgeMs });
    const envelope = await this.read('/status');
    const status = envelope.value;
    if (!status || status.ready !== true || !/^(iOS|iPadOS)$/.test(status.os?.name ?? ''))
      throw new Error('WDA is not ready on an iOS device.');
    const locked = (await this.read('/wda/locked')).value;
    if (locked !== false) throw new Error('The iOS device is locked or its lock state is unknown.');
    this.status = { sessionId: envelope.sessionId ?? null };
    return {
      id: this.deviceId,
      name: this.name || 'iOS device',
      state: 'ready',
      backend: 'ios',
      version: status.build?.version,
    };
  }

  session() {
    const active = this.status?.sessionId ?? null;
    if (this.configuredSession && active !== this.configuredSession)
      throw new Error('The configured WDA session is not the active session.');
    const id = this.configuredSession || active;
    if (!id || !SESSION.test(id))
      throw new Error('No WDA session is active; the launcher must provide IOS_WDA_SESSION_ID.');
    return id;
  }

  async listDevices() {
    if (this.deviceId) {
      const details = await this.devicectlJson([
        'device',
        'info',
        'details',
        '--device',
        this.deviceId,
      ]);
      return [
        {
          id: this.deviceId,
          name: details.deviceProperties?.name || this.deviceId,
          state: details.connectionProperties?.tunnelState || 'unknown',
        },
      ];
    }
    // Listing never selects a device.
    const result = await this.devicectlJson(['list', 'devices']);
    if (!Array.isArray(result.devices))
      throw new Error('devicectl returned an invalid device list.');
    return result.devices
      .map((d) => ({
        id: d.hardwareProperties?.udid,
        name: d.deviceProperties?.name,
        state: d.connectionProperties?.tunnelState || 'unknown',
      }))
      .filter((d) => typeof d.id === 'string');
  }

  async listApps() {
    await this.verifyIdentity({ maxAgeMs: IDENTITY_FRESH_MS });
    const result = await this.devicectlJson([
      'device',
      'info',
      'apps',
      '--device',
      this.deviceId,
      '--include-default-apps',
    ]);
    if (!Array.isArray(result.apps) || result.apps.length > 5000)
      throw new Error('Invalid installed-app response.');
    this.installedApps = result.apps
      .filter(
        (app) =>
          typeof app?.bundleIdentifier === 'string' &&
          BUNDLE.test(app.bundleIdentifier) &&
          typeof app.name === 'string' &&
          app.name &&
          app.hidden !== true &&
          app.appClip !== true,
      )
      .map(({ bundleIdentifier, name }) => ({ packageName: bundleIdentifier, label: name }));
    return this.installedApps;
  }

  async activeApp(session) {
    const path = session ? `/session/${session}/wda/activeAppInfo` : '/wda/activeAppInfo';
    const { value } = await this.read(path, { session });
    if (
      !value ||
      typeof value.bundleId !== 'string' ||
      !value.bundleId ||
      value.bundleId.length > 255
    )
      throw new Error('WDA returned invalid active-app information.');
    return { bundleId: value.bundleId, pid: value.pid };
  }

  async observe({ maxIdentityAgeMs = IDENTITY_FRESH_MS } = {}) {
    await this.verifyIdentity({ maxAgeMs: maxIdentityAgeMs });
    const before = await this.activeApp();
    const size = (await this.read('/window/size')).value;
    const tree = (
      await this.read('/source?format=json&excluded_attributes=frame,nativeFrame', {
        timeoutMs: SOURCE_TIMEOUT_MS,
        maxBytes: SOURCE_BYTES,
      })
    ).value;
    const after = await this.activeApp();
    if (before.bundleId !== after.bundleId || before.pid !== after.pid)
      throw new Error('The foreground app changed while observing; observe again.');
    const input = {
      tree,
      size,
      bundleId: after.bundleId,
      appLabel: this.installedApps.find((app) => app.packageName === after.bundleId)?.label,
      deviceId: this.deviceId,
    };
    const observation = summarizeIosState(input);
    if (!observation.elements.some((e) => e.editable && e.enabled)) return observation;
    // The tree's isFocused is not keyboard focus. Bind focus through WDA's active element.
    const session = await this.observationSession();
    const active = session && (await this.resolveActive(session, observation.screen));
    return active ? summarizeIosState({ ...input, focus: active }) : observation;
  }

  async observationSession() {
    const envelope = await this.read('/status');
    const active = envelope.sessionId ?? null;
    if (this.configuredSession && active !== this.configuredSession)
      throw new Error('The configured WDA session is not the active session.');
    return this.configuredSession || (active && SESSION.test(active) ? active : null);
  }

  // Identity of WDA's keyboard-focused element (type, name and geometry), or null when none.
  async resolveActive(session, screen) {
    let element;
    try {
      element = (await this.read(`/session/${session}/element/active`, { session })).value;
    } catch (error) {
      if (error.wdaError === 'no such element') return null;
      throw error;
    }
    const id = element?.ELEMENT ?? element?.['element-6066-11e4-a52e-4f735466cecf'];
    if (typeof id !== 'string' || !ELEMENT.test(id))
      throw new Error('WDA returned an invalid active element.');
    const base = `/session/${session}/element/${id}`;
    const rect = (await this.read(`${base}/rect`, { session })).value;
    const kind = (await this.read(`${base}/attribute/type`, { session })).value;
    const name = (await this.read(`${base}/attribute/name`, { session })).value;
    if (
      !rect ||
      ![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) ||
      typeof kind !== 'string' ||
      (name !== null && typeof name !== 'string')
    )
      throw new Error('WDA returned an invalid active element.');
    return {
      id,
      base,
      kind: kind.replace(/^XCUIElementType/, ''),
      name: name ?? '',
      bounds: clampBounds(
        { left: rect.x, top: rect.y, right: rect.x + rect.width, bottom: rect.y + rect.height },
        screen,
      ),
    };
  }

  async screenshot() {
    await this.verifyIdentity({ maxAgeMs: IDENTITY_FRESH_MS });
    const { value } = await this.read('/screenshot', {
      timeoutMs: SOURCE_TIMEOUT_MS,
      maxBytes: SCREENSHOT_BYTES,
    });
    if (typeof value !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(value))
      throw new Error('Screenshot response is not base64.');
    const bytes = Buffer.from(value, 'base64');
    if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
      throw new Error('Screenshot response is not a PNG.');
    return bytes;
  }

  // Rejects everything this platform cannot perform before any device I/O.
  validate(action, expected) {
    if (!action || typeof action !== 'object') throw new Error('An action object is required.');
    switch (action.type) {
      case 'open-app':
        if (typeof action.packageName !== 'string' || !BUNDLE.test(action.packageName))
          throw new Error('Invalid bundle identifier.');
        return;
      case 'tap':
        if (!Number.isSafeInteger(action.x) || !Number.isSafeInteger(action.y))
          throw new Error('Coordinates must be whole screen points.');
        return;
      case 'tap-element':
        if (!expected) throw new Error('Element taps require their original observation.');
        return;
      case 'swipe': {
        const duration = action.duration ?? 300;
        if (![action.startX, action.startY, action.endX, action.endY].every(Number.isSafeInteger))
          throw new Error('Coordinates must be whole screen points.');
        if (!Number.isSafeInteger(duration) || duration < 10 || duration > 5000)
          throw new Error('duration must be an integer from 10 to 5000 ms.');
        return;
      }
      case 'type':
        if (
          typeof action.text !== 'string' ||
          action.text.length > MAX_TEXT ||
          (action.clear !== undefined && typeof action.clear !== 'boolean')
        )
          throw new Error(`Text must be a string up to ${MAX_TEXT} characters and clear boolean.`);
        return;
      case 'clear':
        return;
      case 'key':
        if (!IOS_CAPABILITIES.keys.includes(action.key))
          throw new Error(`Key ${String(action.key)} is not supported on iOS.`);
        return;
      case 'global':
        if (!IOS_CAPABILITIES.globalActions.includes(action.name))
          throw new Error(`Global action ${String(action.name)} is not supported on iOS.`);
        return;
      default:
        throw new Error('Unsupported action type.');
    }
  }

  // Re-resolves WDA's active element right before mutation and proves it is the observed field.
  async focusedInput(current, session) {
    const node = current.elements.find((e) => e.id === current.phone.inputElementId);
    if (!current.phone.isEditable || !node?.editable || !node.enabled)
      throw new Error('Focus an editable field before typing.');
    const active = await this.resolveActive(session, current.screen);
    if (
      !active ||
      active.kind !== node.kind ||
      active.name !== node.wdaName ||
      !sameBounds(active.bounds, node.bounds)
    )
      throw new StaleObservationError('Focused field changed; observe and decide again.');
    if (!node.password) {
      const value = (await this.read(`${active.base}/attribute/value`, { session })).value;
      if (
        (value !== null && typeof value !== 'string') ||
        fieldValue(value ?? '', node.hint) !== node.text
      )
        throw new StaleObservationError('Focused field changed; observe and decide again.');
    }
    return { base: active.base, node };
  }

  async foreground(bundleId, timeoutMs) {
    const deadline = performance.now() + timeoutMs;
    for (;;) {
      try {
        if ((await this.activeApp()).bundleId === bundleId) return true;
      } catch {
        // A transient read failure is not proof; keep polling until the deadline.
      }
      if (performance.now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  async nativeSwitchTarget(node, screen, session, budgetMs) {
    const deadline = performance.now() + Math.min(5000, budgetMs);
    const remaining = () => {
      const ms = Math.floor(deadline - performance.now());
      if (ms <= 0) throw new StaleObservationError('Switch resolution expired; observe again.');
      return ms;
    };
    // SwiftUI switches can expose the full labelled row as their bounds. Its
    // centre is not necessarily hittable; let XCTest resolve the native control.
    const bytes = await this.request({
      url: `${this.wdaUrl}/session/${session}/elements`,
      method: 'POST',
      body: { using: 'class name', value: `XCUIElementType${node.kind}` },
      timeoutMs: remaining(),
      maxBytes: SMALL_BYTES,
    });
    const envelope = parseEnvelope(bytes);
    if (
      envelope.sessionId !== session ||
      !Array.isArray(envelope.value) ||
      envelope.value.length > 100
    )
      throw new StaleObservationError('Switch targets changed; observe again.');
    const matches = [];
    for (const entry of envelope.value) {
      const id = entry?.['element-6066-11e4-a52e-4f735466cecf'] || entry?.ELEMENT;
      if (typeof id !== 'string' || !ELEMENT.test(id))
        throw new Error('Invalid WDA switch target.');
      const base = `/session/${session}/element/${id}`;
      const rect = (await this.read(`${base}/rect`, { session, timeoutMs: remaining() })).value;
      const name = (await this.read(`${base}/attribute/name`, { session, timeoutMs: remaining() }))
        .value;
      if (rect && [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)) {
        const bounds = clampBounds(
          { left: rect.x, top: rect.y, right: rect.x + rect.width, bottom: rect.y + rect.height },
          screen,
        );
        if (sameBounds(bounds, node.bounds) && name === node.wdaName) matches.push(base);
      }
    }
    remaining();
    if (matches.length !== 1)
      throw new StaleObservationError('Switch target is not unique; observe again.');
    return matches[0];
  }

  async act(action, { expected, maxAgeMs = 30_000 } = {}) {
    this.validate(action, expected);
    await this.assertReady({ maxAgeMs: 0 });
    if (action.type === 'global') {
      if (expected)
        assertFresh(await this.observe({ maxIdentityAgeMs: Infinity }), expected, action, maxAgeMs);
      await this.mutate('/wda/homescreen', {});
      return (await this.foreground(SPRINGBOARD, 2000))
        ? { accepted: true, verified: true, verification: 'foreground-app' }
        : { accepted: true, verified: false, verification: 'transport-only' };
    }
    const session = this.session();
    if (action.type === 'open-app') {
      await this.listApps();
      if (!this.installedApps.some((app) => app.packageName === action.packageName))
        throw new Error('The app was not observed in the installed-app list.');
      if (expected && expected.deviceId !== this.deviceId)
        throw new Error('Observation belongs to a different device.');
      await this.mutate(
        `/session/${session}/wda/apps/launch`,
        { bundleId: action.packageName },
        session,
      );
      if (!(await this.foreground(action.packageName, 5000)))
        throw new Error('App launch is uncertain; observe before recovery. Do not replay.');
      return { accepted: true, verified: true, verification: 'foreground-app' };
    }
    const current = await this.observe({ maxIdentityAgeMs: Infinity });
    if (expected) assertFresh(current, expected, action, maxAgeMs);
    const bundle = current.phone.packageName;
    if (!bundle || (await this.activeApp(session)).bundleId !== bundle)
      throw new StaleObservationError('WDA session targets a different app; observe again.');
    const receipt = { accepted: true, verified: false, verification: 'transport-only' };
    const gesture = async (steps) => {
      await this.mutate(`/session/${session}/actions`, pointerActions(steps), session);
      return receipt;
    };
    const tap = (x, y) => gesture([move(x, y), down, pause(50), up]);
    switch (action.type) {
      case 'tap':
        point(action.x, action.y, current.screen);
        return tap(action.x, action.y);
      case 'tap-element': {
        const node = current.elements.find((e) => e.id === action.elementId);
        if (!node?.enabled || !(node.clickable || node.editable))
          throw new Error('Element is not actionable.');
        if (node.kind === 'Switch' || node.kind === 'Toggle') {
          const reference = expected || current;
          const budgetMs = maxAgeMs - (Date.now() - reference.observedAt);
          const base = await this.nativeSwitchTarget(node, current.screen, session, budgetMs);
          const fresh = await this.observe({ maxIdentityAgeMs: Infinity });
          assertFresh(fresh, reference, action, maxAgeMs);
          const refreshed = fresh.elements.find((e) => e.id === node.id);
          if (!refreshed?.enabled || !sameBounds(refreshed.bounds, node.bounds))
            throw new StaleObservationError('Switch geometry changed before input.');
          if ((await this.activeApp(session)).bundleId !== bundle)
            throw new StaleObservationError('Foreground changed before switch input.');
          assertFresh(fresh, reference, action, maxAgeMs);
          await this.mutate(`${base}/click`, {}, session);
          return receipt;
        }
        const { left, top, right, bottom } = node.bounds;
        const x = Math.floor((left + right) / 2);
        const y = Math.floor((top + bottom) / 2);
        point(x, y, current.screen);
        return tap(x, y);
      }
      case 'swipe': {
        let { startX, startY, endX, endY } = action;
        point(startX, startY, current.screen);
        point(endX, endY, current.screen);
        if (action.regionId && expected) {
          const before = expected.elements.find((e) => e.id === action.regionId)?.bounds;
          const after = current.elements.find((e) => e.id === action.regionId)?.bounds;
          if (!before || !after) throw new StaleObservationError('Scroll region disappeared.');
          // Resolve the same relative gesture in current geometry.
          const project = (value, oldStart, oldEnd, newStart, newEnd) => {
            const fraction = (value - oldStart) / (oldEnd - oldStart);
            if (!Number.isFinite(fraction) || fraction < 0 || fraction >= 1)
              throw new Error('Swipe leaves its observed region.');
            return Math.floor(newStart + fraction * (newEnd - newStart));
          };
          startX = project(startX, before.left, before.right, after.left, after.right);
          endX = project(endX, before.left, before.right, after.left, after.right);
          startY = project(startY, before.top, before.bottom, after.top, after.bottom);
          endY = project(endY, before.top, before.bottom, after.top, after.bottom);
          point(startX, startY, current.screen);
          point(endX, endY, current.screen);
        }
        return gesture([
          move(startX, startY),
          down,
          pause(50),
          move(endX, endY, action.duration ?? 300),
          up,
        ]);
      }
      default:
        return this.input(action, current, session);
    }
  }

  async input(action, current, session) {
    const field = current.elements.find((e) => e.id === current.phone.inputElementId);
    if (field?.password && (action.type !== 'key' || action.key === 'delete'))
      throw new Error('Password fields are never typed into, cleared or edited by the agent.');
    const replacement =
      action.type === 'clear' || (action.type === 'type' && action.clear === true);
    const text = action.type === 'clear' ? '' : action.text;
    let verification;
    if (replacement) {
      if (text && field && text === field.hint)
        throw new Error('Text equal to the field placeholder cannot be verified exactly.');
      verification = prepareInputVerification(current, { type: 'type', clear: true, text });
      if (!verification) throw new Error('Replacement requires a readable focused field.');
    }
    const target = await this.focusedInput(current, session);
    if (action.type === 'key') {
      await this.mutate(
        `${target.base}/value`,
        { text: action.key === 'enter' ? '\n' : '\u0008' },
        session,
      );
      return { accepted: true, verified: false, verification: 'transport-only' };
    }
    if (replacement) await this.mutate(`${target.base}/clear`, {}, session);
    if (text) await this.mutate(`${target.base}/value`, { text }, session);
    if (!replacement) return { accepted: true, verified: false, verification: 'transport-only' };
    const observe = () => this.observe({ maxIdentityAgeMs: Infinity });
    let result;
    try {
      result = await confirmInput({
        initial: await observe(),
        verification,
        observe,
        timeoutMs: 2500,
        pollMs: 100,
      });
    } catch {
      result = { verified: false };
    }
    if (!result.verified)
      throw new Error('iOS text change is uncertain; observe before recovery. Do not replay.');
    return { accepted: true, verified: true, verification: 'exact-field-readback' };
  }
}
