#!/usr/bin/env node
// Foreground supervisor for one physical iOS device: iproxy + WebDriverAgent runner
// + scripts/device-service.mjs. Run under a per-UDID LaunchAgent (see install-ios-service.mjs).
//
// Safety rules: this process never unlocks, trusts, or enters a passcode on a device. It sends
// exactly one mutating request (POST /session) and never retries it. All retries are GET-only
// and bounded. Anything uncertain tears the whole runtime down and exits for launchd to retry.
import { spawn, execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants, existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, normalize, sep } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);

export const EXIT = { OK: 0, FAILURE: 1, USAGE: 64, BLOCKED: 75 };
export const WDA_DEVICE_PORT = 8100;
export const MJPEG_DEVICE_PORT = 9100;
export const WDA_BUNDLE_ID = 'com.dallascrilley.agentdeviceios.WebDriverAgentRunner';
export const ONLY_TESTING = 'WebDriverAgentRunner/UITestingUITests/testRunner';
export const DEFAULT_WDA_NAME = 'iPhone';
// Empty capabilities: no bundleId (no app launch), no terminate/reset, no automatic alert action.
export const SESSION_BODY = {
  capabilities: {
    alwaysMatch: {
      shouldTerminateApp: false,
      forceAppLaunch: false,
      autoAcceptAlerts: false,
      autoDismissAlerts: false,
    },
    firstMatch: [{}],
  },
};

export const DEFAULT_TIMING = {
  readinessMs: 90_000,
  serviceReadinessMs: 90_000,
  pollMs: 1_000,
  requestMs: 5_000,
  sessionPostMs: 30_000,
  proxyStartMs: 10_000,
  devicectlMs: 45_000,
  termGraceMs: 5_000,
  killGraceMs: 3_000,
};

// Service child environment is an allowlist: Android and cloud credentials never pass through.
const SERVICE_ENV_PASSTHROUGH = [
  'HOME',
  'PATH',
  'USER',
  'LOGNAME',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'TZ',
  'TYPESAFE_API_KEY',
  'TYPESAFE_MODEL',
  'DECISION_BACKEND',
  'AGENT_DEVICE_LOCK_ROOT',
];
// Device tools receive no credentials at all.
const TOOL_ENV_PASSTHROUGH = [
  'HOME',
  'PATH',
  'USER',
  'LOGNAME',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'TZ',
  'DEVELOPER_DIR',
];

export class RuntimeError extends Error {
  constructor(message, exit = EXIT.FAILURE) {
    super(message);
    this.exit = exit;
  }
}
const usage = (message) => new RuntimeError(message, EXIT.USAGE);
const blocked = (message) => new RuntimeError(message, EXIT.BLOCKED);

function required(env, name) {
  const value = env[name];
  if (typeof value !== 'string' || value === '') throw usage(`${name} is required.`);
  return value;
}

function parsePort(value, name) {
  if (!/^[0-9]{4,5}$/.test(value)) throw usage(`${name} must be a port from 1024 to 65535.`);
  const port = Number(value);
  if (port < 1024 || port > 65535) throw usage(`${name} must be a port from 1024 to 65535.`);
  return port;
}

function absolutePath(value, name) {
  if (value.includes('\0') || !isAbsolute(value) || normalize(value) !== value)
    throw usage(`${name} must be a normalized absolute path.`);
  return value;
}

// Physical UDID: 8 hex, hyphen, 16 hex (modern devices) or 40 hex (legacy devices).
export const UDID_PATTERN = /^(?:[0-9A-Fa-f]{8}-[0-9A-Fa-f]{16}|[0-9A-Fa-f]{40})$/;
export const VENDOR_UUID_PATTERN = /^[0-9A-Fa-f]{8}(?:-[0-9A-Fa-f]{4}){3}-[0-9A-Fa-f]{12}$/;
const REVISION_PATTERN = /^[0-9A-Fa-f]{40}$/;
// eslint-disable-next-line no-control-regex
const CONTROL_PATTERN = /[\u0000-\u001f\u007f]/;

export function derivedXctestrunName(udid) {
  return `mobile-jev-ios-${udid}.xctestrun`;
}

/** Keys a private runtime config file may set. Credentials are deliberately absent. */
export const CONFIG_FILE_KEYS = [
  'IOS_DEVICE_UDID',
  'IOS_DEVICE_NAME',
  'IOS_WDA_URL',
  'IOS_WDA_BUILD_DIR',
  'IOS_WDA_SOURCE_REVISION',
  'IOS_WDA_BINDING_FILE',
  'IOS_WDA_EXPECTED_NAME',
  'IOS_EXPECTED_VENDOR_UUID',
  'IOS_VENDOR_UUID_FILE',
  'IOS_WDA_XCTESTRUN',
  'DEVICE_SERVICE_PORT',
  'IPROXY_BIN',
  'IOS_IPROXY_BIN',
  'IOS_XCRUN_BIN',
  'IOS_XCODEBUILD_BIN',
  'IOS_PLUTIL_BIN',
  'IOS_LSOF_BIN',
  'IOS_NODE_BIN',
  'IOS_DEVICE_SERVICE_SCRIPT',
  'DECISION_BACKEND',
  'TYPESAFE_MODEL',
  'AGENT_DEVICE_LOCK_ROOT',
];

/**
 * Merge a private JSON config file into the environment. IOS_RUNTIME_CONFIG names a flat JSON
 * object of CONFIG_FILE_KEYS (values are strings; DEVICE_SERVICE_PORT may be a number). The file
 * must be owner-only (no group or other permission bits). File values win over inherited ones.
 * Credentials never come from this file; the credential wrapper injects them.
 */
export function loadRuntimeEnv(env) {
  const path = env.IOS_RUNTIME_CONFIG;
  if (!path) return env;
  absolutePath(path, 'IOS_RUNTIME_CONFIG');
  let values;
  try {
    if (statSync(path).mode & 0o077)
      throw usage('IOS_RUNTIME_CONFIG must not be group or world accessible.');
    values = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    if (error instanceof RuntimeError) throw error;
    throw usage('IOS_RUNTIME_CONFIG is unreadable or not valid JSON.');
  }
  if (!values || typeof values !== 'object' || Array.isArray(values))
    throw usage('IOS_RUNTIME_CONFIG must contain a JSON object.');
  const merged = { ...env };
  for (const [key, value] of Object.entries(values)) {
    if (!CONFIG_FILE_KEYS.includes(key)) throw usage(`IOS_RUNTIME_CONFIG key not allowed: ${key}.`);
    if (typeof value === 'number' && key === 'DEVICE_SERVICE_PORT') merged[key] = String(value);
    else if (typeof value === 'string') merged[key] = value;
    else throw usage(`IOS_RUNTIME_CONFIG value for ${key} must be a string.`);
  }
  return merged;
}

/**
 * Resolve the vendor UUID this device must report: the explicit pin, else the stored
 * enrollment. Returns null when neither exists (first start learns it). Refuses conflicts.
 */
export async function resolveExpectedVendor(config) {
  let enrolled = null;
  try {
    const record = JSON.parse(await readFile(config.vendorFile, 'utf8'));
    if (record?.deviceId !== config.udid || !VENDOR_UUID_PATTERN.test(record?.vendorUuid ?? ''))
      throw new RuntimeError(
        `Vendor UUID enrollment belongs elsewhere or is invalid: ${config.vendorFile}`,
      );
    enrolled = record.vendorUuid;
  } catch (error) {
    if (error instanceof RuntimeError) throw error;
    if (error.code !== 'ENOENT')
      throw new RuntimeError(`Vendor UUID enrollment is unreadable: ${config.vendorFile}`);
  }
  if (
    config.expectedVendorUuid &&
    enrolled &&
    config.expectedVendorUuid.toLowerCase() !== enrolled.toLowerCase()
  )
    throw new RuntimeError('IOS_EXPECTED_VENDOR_UUID conflicts with the stored enrollment.');
  return config.expectedVendorUuid ?? enrolled;
}

/**
 * Validate the supervisor environment. Throws RuntimeError(EXIT.USAGE) on any problem.
 * checkPaths=false skips filesystem checks (used by the installer for dry runs).
 *
 * WDA's reported device name is generic (often just "iPhone"), so the vendor UUID is the only
 * value that tells two devices apart. It comes from IOS_EXPECTED_VENDOR_UUID, from a stored
 * enrollment, or (first start only) is learned from the exact-UDID proxy this process owns.
 */
export function parseIosRuntimeConfig(env, { checkPaths = true } = {}) {
  const udid = required(env, 'IOS_DEVICE_UDID');
  if (!UDID_PATTERN.test(udid))
    throw usage('IOS_DEVICE_UDID must be a physical UDID (8-16 hex or 40 hex).');

  const deviceName = required(env, 'IOS_DEVICE_NAME');
  if (deviceName.length > 80 || CONTROL_PATTERN.test(deviceName))
    throw usage('IOS_DEVICE_NAME must be at most 80 printable characters.');

  const wdaUrl = required(env, 'IOS_WDA_URL');
  const urlMatch = /^http:\/\/127\.0\.0\.1:([0-9]{4,5})$/.exec(wdaUrl);
  if (!urlMatch) throw usage('IOS_WDA_URL must be exactly http://127.0.0.1:<port>.');
  const wdaPort = parsePort(urlMatch[1], 'IOS_WDA_URL port');

  const servicePort = parsePort(required(env, 'DEVICE_SERVICE_PORT'), 'DEVICE_SERVICE_PORT');
  if (servicePort === wdaPort) throw usage('DEVICE_SERVICE_PORT must differ from the WDA port.');

  const sourceRevision = required(env, 'IOS_WDA_SOURCE_REVISION');
  if (!REVISION_PATTERN.test(sourceRevision))
    throw usage('IOS_WDA_SOURCE_REVISION must be a 40-character hexadecimal commit hash.');

  // Optional pin. Without a pin (and without a stored enrollment) the first start learns the
  // vendor UUID once from the proxy this supervisor owns, then stores it in vendorFile.
  const expectedVendorUuid = env.IOS_EXPECTED_VENDOR_UUID || null;
  if (expectedVendorUuid && !VENDOR_UUID_PATTERN.test(expectedVendorUuid))
    throw usage('IOS_EXPECTED_VENDOR_UUID must be a UUID.');

  const bindingFile = absolutePath(required(env, 'IOS_WDA_BINDING_FILE'), 'IOS_WDA_BINDING_FILE');
  const expectedWdaName = env.IOS_WDA_EXPECTED_NAME || DEFAULT_WDA_NAME;
  if (expectedWdaName.length > 80 || CONTROL_PATTERN.test(expectedWdaName))
    throw usage('IOS_WDA_EXPECTED_NAME must be at most 80 printable characters.');

  const bin = (name, fallback) => absolutePath(env[name] || fallback, name);
  const bins = {
    xcrun: bin('IOS_XCRUN_BIN', '/usr/bin/xcrun'),
    xcodebuild: bin('IOS_XCODEBUILD_BIN', '/usr/bin/xcodebuild'),
    iproxy: bin('IOS_IPROXY_BIN', env.IPROXY_BIN || '/opt/homebrew/bin/iproxy'),
    lsof: bin('IOS_LSOF_BIN', '/usr/sbin/lsof'),
    plutil: bin('IOS_PLUTIL_BIN', '/usr/bin/plutil'),
    node: bin('IOS_NODE_BIN', process.execPath),
  };
  const serviceScript = absolutePath(
    env.IOS_DEVICE_SERVICE_SCRIPT ||
      fileURLToPath(new URL('./device-service.mjs', import.meta.url)),
    'IOS_DEVICE_SERVICE_SCRIPT',
  );

  const buildInput = absolutePath(required(env, 'IOS_WDA_BUILD_DIR'), 'IOS_WDA_BUILD_DIR');
  let buildDir = buildInput;
  let xctestrunSource = null;
  if (checkPaths) {
    try {
      buildDir = realpathSync(buildInput);
    } catch {
      throw usage('IOS_WDA_BUILD_DIR does not exist.');
    }
    const parts = buildDir.split(sep);
    if (parts.at(-1) !== 'Products' || parts.at(-2) !== 'Build')
      throw usage('IOS_WDA_BUILD_DIR must be a Build/Products directory.');
    const candidates = readdirSync(buildDir).filter(
      (name) => name.endsWith('.xctestrun') && !name.startsWith('mobile-jev-ios-'),
    );
    const explicit = env.IOS_WDA_XCTESTRUN;
    if (explicit) {
      if (explicit !== basename(explicit) || !candidates.includes(explicit))
        throw usage('IOS_WDA_XCTESTRUN must name a source .xctestrun file in IOS_WDA_BUILD_DIR.');
      xctestrunSource = join(buildDir, explicit);
    } else {
      const preferred = candidates.filter((name) => name.startsWith('WebDriverAgentRunner_'));
      if (preferred.length !== 1)
        throw usage(
          'IOS_WDA_BUILD_DIR must contain exactly one WebDriverAgentRunner_*.xctestrun; set IOS_WDA_XCTESTRUN to choose.',
        );
      xctestrunSource = join(buildDir, preferred[0]);
    }
  }
  return {
    udid,
    deviceName,
    wdaUrl,
    wdaPort,
    servicePort,
    sourceRevision,
    bindingFile,
    expectedWdaName,
    expectedVendorUuid,
    vendorFile: absolutePath(
      env.IOS_VENDOR_UUID_FILE || `${bindingFile}.vendor-uuid.json`,
      'IOS_VENDOR_UUID_FILE',
    ),
    buildDir,
    xctestrunSource,
    xctestrunDerived: join(buildDir, derivedXctestrunName(udid)),
    bins,
    serviceScript,
  };
}

export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function groupAlive(pgid) {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function connectProbe(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const done = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(1000, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

function bindProbe(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () =>
      server.close(() => resolve(true)),
    );
  });
}

export async function portIsFree(port) {
  if (await connectProbe(port)) return false;
  return bindProbe(port);
}

const sleepFor = (ms, signal) =>
  new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });

function defaultLog(event, fields = {}) {
  process.stderr.write(`${JSON.stringify({ ts: new Date().toISOString(), event, ...fields })}\n`);
}

function pick(env, names) {
  const result = {};
  for (const name of names) if (typeof env[name] === 'string') result[name] = env[name];
  return result;
}

export function buildServiceEnv(config, sessionId, env = process.env) {
  return {
    ...pick(env, SERVICE_ENV_PASSTHROUGH),
    MOBILE_DEVICE_BACKEND: 'ios',
    AGENT_DEVICE_IDENTITY: config.udid,
    DEVICE_SERVICE_PORT: String(config.servicePort),
    IOS_DEVICE_UDID: config.udid,
    IOS_DEVICE_NAME: config.deviceName,
    IOS_WDA_URL: config.wdaUrl,
    IOS_WDA_SESSION_ID: sessionId,
    IOS_WDA_BINDING_FILE: config.bindingFile,
    IOS_WDA_SOURCE_REVISION: config.sourceRevision,
    IOS_WDA_EXPECTED_NAME: config.expectedWdaName,
  };
}

function deviceFacts(details) {
  const result = details?.result ?? {};
  const read = (group, key) => result[group]?.[key] ?? result.properties?.[key];
  return {
    name: read('deviceProperties', 'name'),
    udid: read('hardwareProperties', 'udid'),
    developerMode: read('deviceProperties', 'developerModeStatus'),
    tunnel: read('connectionProperties', 'tunnelState'),
  };
}

async function devicectlJson(config, env, args, label, timeoutMs) {
  const dir = await mkdtemp(join(tmpdir(), 'ios-devicectl-'));
  const out = join(dir, 'out.json');
  try {
    await execFileAsync(
      config.bins.xcrun,
      ['devicectl', ...args, '--device', config.udid, '--json-output', out, '--quiet'],
      { env: pick(env, TOOL_ENV_PASSTHROUGH), timeout: timeoutMs, killSignal: 'SIGKILL' },
    );
    return JSON.parse(await readFile(out, 'utf8'));
  } catch {
    throw blocked(`devicectl ${label} failed; the device is not reachable.`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Read-only device checks (devicectl details + lockState). Throws RuntimeError(EXIT.BLOCKED)
 * when the device cannot be used. Nothing here unlocks, trusts, or sends a passcode.
 */
export async function precheckDeviceState(config, env, timeoutMs = DEFAULT_TIMING.devicectlMs) {
  const details = await devicectlJson(
    config,
    env,
    ['device', 'info', 'details'],
    'details',
    timeoutMs,
  );
  const facts = deviceFacts(details);
  if (facts.udid !== config.udid) throw blocked('devicectl reported a different UDID.');
  if (facts.name !== config.deviceName)
    throw blocked('devicectl device name does not match IOS_DEVICE_NAME.');
  if (facts.developerMode !== 'enabled') throw blocked('Developer Mode is not enabled.');
  if (facts.tunnel !== 'connected') throw blocked('Device is not connected.');
  const lock = (
    await devicectlJson(config, env, ['device', 'info', 'lockState'], 'lockState', timeoutMs)
  )?.result;
  // Fail closed: only an explicit unlocked state passes.
  if (lock?.passcodeRequired !== false || lock?.unlockedSinceBoot !== true)
    throw blocked('Device is locked; unlock it by hand.');
}

/**
 * Run the supervisor. Resolves to a process exit code after full cleanup.
 * Options: env, log, timing overrides, signals (EventEmitter, default process).
 */
export async function runSupervisor({
  env: rawEnv = process.env,
  log = defaultLog,
  timing: timingOverride = {},
  signals = process,
} = {}) {
  const timing = { ...DEFAULT_TIMING, ...timingOverride };
  let config;
  let env = rawEnv;
  try {
    env = loadRuntimeEnv(rawEnv);
    config = parseIosRuntimeConfig(env);
  } catch (error) {
    log('config-invalid', { message: error.message });
    return error.exit ?? EXIT.USAGE;
  }

  const stop = new AbortController();
  let stopReason = null;
  let shuttingDown = false;
  const children = [];
  const runId = randomUUID();
  let lockHeld = false;
  let manifestWritten = false;
  const lockFile = `${config.bindingFile}.lock`;

  const requestStop = (reason) => {
    if (stopReason) return;
    stopReason = reason;
    log('stopping', { reason });
    stop.abort();
  };
  const onTerm = () => requestStop('SIGTERM');
  const onInt = () => requestStop('SIGINT');
  signals.on('SIGTERM', onTerm);
  signals.on('SIGINT', onInt);
  const signalled = () => stopReason === 'SIGTERM' || stopReason === 'SIGINT';

  const assertRunning = () => {
    for (const entry of children)
      if (entry.exited) throw new RuntimeError(`${entry.name} exited during startup.`);
    if (stopReason) throw new RuntimeError(`Stopped: ${stopReason}.`);
  };

  function own(name, bin, args, { childEnv, cwd }) {
    const child = spawn(bin, args, {
      env: childEnv,
      cwd,
      detached: true, // own process group, so cleanup reaches grandchildren
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    const entry = { name, child, pid: child.pid, exited: false, code: null, signal: null };
    entry.done = new Promise((resolve) => {
      child.once('exit', (code, signal) => {
        entry.exited = true;
        entry.code = code;
        entry.signal = signal;
        log('child-exit', { name, pid: entry.pid, code, signal });
        resolve(entry);
      });
      child.once('error', (error) => {
        if (entry.exited) return;
        entry.exited = true;
        entry.error = error.code || 'spawn-error';
        resolve(entry);
      });
    });
    children.push(entry);
    entry.done.then(() => {
      if (!shuttingDown) requestStop(`${name}-exited`);
    });
    return entry;
  }

  async function terminate(entry) {
    if (!entry.pid) return;
    const kill = (signal) => {
      try {
        process.kill(-entry.pid, signal);
      } catch {
        // group already gone
      }
    };
    const waitGone = async (ms) => {
      const end = Date.now() + ms;
      while (groupAlive(entry.pid) && Date.now() < end) await sleepFor(25);
      return !groupAlive(entry.pid);
    };
    kill('SIGTERM');
    if (await waitGone(timing.termGraceMs)) return;
    log('escalating-kill', { name: entry.name, pid: entry.pid });
    kill('SIGKILL');
    await waitGone(timing.killGraceMs);
  }

  async function cleanup() {
    shuttingDown = true;
    // Service first so no new input reaches the device, then runner, then proxy.
    for (const entry of [...children].reverse()) await terminate(entry);
    if (manifestWritten) {
      try {
        const current = JSON.parse(await readFile(config.bindingFile, 'utf8'));
        if (current.runId === runId && current.supervisorPid === process.pid)
          await rm(config.bindingFile, { force: true });
      } catch {
        // not ours or already gone: leave it
      }
    }
    if (lockHeld) {
      try {
        const current = JSON.parse(await readFile(lockFile, 'utf8'));
        if (current.runId === runId) await rm(lockFile, { force: true });
      } catch {
        // leave unknown lock files alone
      }
    }
    signals.off('SIGTERM', onTerm);
    signals.off('SIGINT', onInt);
  }

  async function acquireLock() {
    await mkdir(dirname(config.bindingFile), { recursive: true, mode: 0o700 });
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await writeFile(lockFile, JSON.stringify({ pid: process.pid, runId }), {
          flag: 'wx',
          mode: 0o600,
        });
        lockHeld = true;
        return;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        let owner;
        try {
          owner = JSON.parse(await readFile(lockFile, 'utf8'));
        } catch {
          throw new RuntimeError(`Binding lock is unreadable; refusing to replace it: ${lockFile}`);
        }
        if (pidAlive(owner?.pid))
          throw new RuntimeError(`Another supervisor (pid ${owner.pid}) owns ${lockFile}.`);
        await rm(lockFile, { force: true });
      }
    }
    throw new RuntimeError(`Unable to acquire binding lock ${lockFile}.`);
  }

  async function checkExistingManifest() {
    let text;
    try {
      text = await readFile(config.bindingFile, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    let manifest;
    try {
      manifest = JSON.parse(text);
    } catch {
      throw new RuntimeError(
        `Existing binding file is unreadable; preserved: ${config.bindingFile}`,
      );
    }
    if (manifest?.deviceId !== config.udid || manifest?.wdaUrl !== config.wdaUrl)
      throw new RuntimeError('Existing binding file belongs to a different device or endpoint.');
    const live = ['supervisorPid', 'runnerPid', 'proxyPid'].filter((key) =>
      pidAlive(manifest[key]),
    );
    if (live.length)
      throw new RuntimeError(
        `Existing binding file has live owner process(es): ${live.join(', ')}.`,
      );
    log('stale-binding', { file: config.bindingFile });
  }

  const precheckDevice = () => precheckDeviceState(config, env, timing.devicectlMs);

  async function plutil(args) {
    const { stdout } = await execFileAsync(config.bins.plutil, args, {
      env: pick(env, TOOL_ENV_PASSTHROUGH),
      timeout: 15_000,
    });
    return stdout.trim();
  }
  const plutilOk = (args) =>
    plutil(args).then(
      () => true,
      () => false,
    );

  /**
   * Derive a per-device .xctestrun next to the source (so __TESTROOT__ keeps working).
   * Supports FormatVersion 1 (top-level WebDriverAgentRunner dictionary) and FormatVersion 2
   * (TestConfigurations[].TestTargets[]); every other key is preserved by in-place edits.
   */
  async function deriveXctestrun() {
    const source = config.xctestrunSource;
    const bad = (why) => new RuntimeError(`Unsupported xctestrun (${why}).`);
    let version;
    try {
      version = await plutil([
        '-extract',
        '__xctestrun_metadata__.FormatVersion',
        'raw',
        '-o',
        '-',
        source,
      ]);
    } catch {
      throw bad('unreadable or missing FormatVersion');
    }
    const targets = []; // key path prefixes of every WebDriverAgentRunner test target
    if (version === '1') {
      if (
        (await plutil(['-type', 'WebDriverAgentRunner', source]).catch(() => '')) !== 'dictionary'
      )
        throw bad('no top-level WebDriverAgentRunner');
      if (await plutilOk(['-type', 'TestConfigurations', source])) throw bad('mixed schema');
      targets.push('WebDriverAgentRunner');
    } else if (version === '2') {
      let configurations;
      try {
        configurations = JSON.parse(
          await plutil(['-extract', 'TestConfigurations', 'json', '-o', '-', source]),
        );
      } catch {
        throw bad('unreadable TestConfigurations');
      }
      configurations.forEach((configuration, ci) =>
        (configuration.TestTargets ?? []).forEach((target, ti) => {
          if (
            target?.BlueprintName === 'WebDriverAgentRunner' ||
            target?.ProductModuleName === 'WebDriverAgentRunner'
          )
            targets.push(`TestConfigurations.${ci}.TestTargets.${ti}`);
        }),
      );
      if (!targets.length) throw bad('no WebDriverAgentRunner test target');
    } else throw bad(`FormatVersion ${version}`);

    for (const prefix of targets) {
      const hostPath = await plutil([
        '-extract',
        `${prefix}.TestHostPath`,
        'raw',
        '-o',
        '-',
        source,
      ]).catch(() => '');
      const resolved = normalize(hostPath.replace('__TESTROOT__', config.buildDir));
      if (
        !hostPath.startsWith('__TESTROOT__/') ||
        !resolved.startsWith(`${config.buildDir}${sep}`) ||
        !existsSync(resolved)
      )
        throw bad('TestHostPath is not an existing path inside the build directory');
    }

    const values = {
      USE_PORT: String(WDA_DEVICE_PORT),
      MJPEG_SERVER_PORT: String(MJPEG_DEVICE_PORT),
      WDA_PRODUCT_BUNDLE_IDENTIFIER: WDA_BUNDLE_ID,
    };
    const staging = `${config.xctestrunDerived}.tmp-${process.pid}-${runId}`;
    try {
      await copyFile(source, staging, constants.COPYFILE_EXCL);
      await chmod(staging, 0o600);
      for (const prefix of targets) {
        const environment = `${prefix}.EnvironmentVariables`;
        if (!(await plutilOk(['-type', environment, staging])))
          await plutil(['-insert', environment, '-dictionary', staging]);
        for (const [key, value] of Object.entries(values))
          await plutil(['-replace', `${environment}.${key}`, '-string', value, staging]);
      }
      await plutil(['-lint', staging]);
      await rename(staging, config.xctestrunDerived);
    } catch {
      await rm(staging, { force: true });
      throw new RuntimeError('Unable to derive the xctestrun file.');
    }
  }

  const requestSignal = (ms) => AbortSignal.any([stop.signal, AbortSignal.timeout(ms)]);

  async function getWithRetry(url, what, budgetMs, accept = () => true) {
    const deadline = Date.now() + budgetMs;
    let last = 'no response';
    for (;;) {
      assertRunning();
      try {
        const response = await fetch(url, {
          redirect: 'error',
          signal: requestSignal(timing.requestMs),
        });
        if (response.ok) {
          const body = await response.json();
          if (accept(body)) return body;
          last = 'not ready';
        } else last = `HTTP ${response.status}`;
      } catch (error) {
        last = error?.name || 'error';
      }
      if (Date.now() >= deadline)
        throw new RuntimeError(`${what} was not ready within ${budgetMs} ms (${last}).`);
      await sleepFor(timing.pollMs, stop.signal);
    }
  }

  async function postSessionOnce(sessionBody) {
    // Single attempt. A timeout leaves the outcome uncertain, so the runtime is torn down instead.
    let response;
    try {
      response = await fetch(`${config.wdaUrl}/session`, {
        method: 'POST',
        redirect: 'error',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(sessionBody),
        signal: requestSignal(timing.sessionPostMs),
      });
    } catch {
      throw new RuntimeError('Session creation outcome is uncertain; not retrying.');
    }
    if (!response.ok) throw new RuntimeError(`Session creation failed (HTTP ${response.status}).`);
    const body = await response.json().catch(() => null);
    const id = body?.value?.sessionId ?? body?.sessionId;
    if (typeof id !== 'string' || !/^[0-9A-Za-z-]{8,64}$/.test(id))
      throw new RuntimeError('Session creation returned no usable session id.');
    return id;
  }

  async function writeManifest(vendorUuid) {
    const manifest = {
      deviceId: config.udid,
      deviceName: config.deviceName,
      wdaUrl: config.wdaUrl,
      runnerPid: children.find((c) => c.name === 'runner').pid,
      proxyPid: children.find((c) => c.name === 'proxy').pid,
      sourceRevision: config.sourceRevision,
      expectedVendorUuid: vendorUuid,
      expectedWdaName: config.expectedWdaName,
      supervisorPid: process.pid,
      runId,
    };
    const staging = `${config.bindingFile}.tmp-${runId}`;
    await writeFile(staging, `${JSON.stringify(manifest, null, 2)}\n`, {
      flag: 'wx',
      mode: 0o600,
    });
    await rename(staging, config.bindingFile);
    manifestWritten = true;
  }

  try {
    log('starting', { udid: config.udid, wdaUrl: config.wdaUrl, servicePort: config.servicePort });
    await acquireLock();
    await checkExistingManifest();
    const expectedVendor = await resolveExpectedVendor(config);
    for (const [port, name] of [
      [config.wdaPort, 'WDA'],
      [config.servicePort, 'device service'],
    ])
      if (!(await portIsFree(port)))
        throw new RuntimeError(`${name} port ${port} already has a listener.`);
    assertRunning();
    await precheckDevice();
    assertRunning();
    await deriveXctestrun();

    const toolEnv = pick(env, TOOL_ENV_PASSTHROUGH);
    own(
      'proxy',
      config.bins.iproxy,
      ['-u', config.udid, '-l', '-s', '127.0.0.1', `${config.wdaPort}:${WDA_DEVICE_PORT}`],
      { childEnv: toolEnv, cwd: config.buildDir },
    );
    const proxyDeadline = Date.now() + timing.proxyStartMs;
    for (;;) {
      assertRunning();
      if (await connectProbe(config.wdaPort)) break;
      if (Date.now() >= proxyDeadline)
        throw new RuntimeError('iproxy did not open its local port.');
      await sleepFor(50, stop.signal);
    }
    // Exact ownership: the only listener on the WDA port is the proxy this process started.
    const owners = await listenerPids(config, config.wdaPort, env);
    const proxyEntry = children.find((c) => c.name === 'proxy');
    if (!owners || owners.length !== 1 || owners[0] !== proxyEntry.pid)
      throw new RuntimeError('The WDA port is not held solely by the owned proxy.');
    own(
      'runner',
      config.bins.xcodebuild,
      [
        'test-without-building',
        '-xctestrun',
        config.xctestrunDerived,
        '-destination',
        `platform=iOS,id=${config.udid}`,
        `-only-testing:${ONLY_TESTING}`,
      ],
      { childEnv: toolEnv, cwd: config.buildDir },
    );

    // Ready means the JSON boolean true. A string such as "true" or "false" is not ready.
    const status = await getWithRetry(
      `${config.wdaUrl}/status`,
      'WDA',
      timing.readinessMs,
      (body) => body?.value?.ready === true,
    );
    if (status?.sessionId || status?.value?.sessionId)
      throw new RuntimeError('WDA already has a session that this supervisor does not own.');
    const info = (
      await getWithRetry(`${config.wdaUrl}/wda/device/info`, 'WDA device info', timing.readinessMs)
    )?.value;
    const vendorUuid = info?.uuid ?? info?.identifierForVendor;
    if (typeof vendorUuid !== 'string' || !VENDOR_UUID_PATTERN.test(vendorUuid))
      throw new RuntimeError('WDA did not report a vendor UUID.');
    // The vendor UUID is the identity check; the WDA name is generic and only sanity-checked.
    if (expectedVendor && expectedVendor.toLowerCase() !== vendorUuid.toLowerCase())
      throw new RuntimeError('WDA vendor UUID does not match the expected vendor UUID.');
    if (info?.name !== config.expectedWdaName)
      throw new RuntimeError('WDA device name does not match IOS_WDA_EXPECTED_NAME.');
    assertRunning();
    if (!expectedVendor) {
      // First start: the port is solely held by our proxy and every owned child is alive
      // (checked above and by assertRunning), so this reading is trusted exactly once.
      await writeFile(
        config.vendorFile,
        `${JSON.stringify({ deviceId: config.udid, vendorUuid, enrolledAt: new Date().toISOString(), sourceRevision: config.sourceRevision }, null, 2)}\n`,
        { flag: 'wx', mode: 0o600 },
      );
      log('vendor-uuid-enrolled', { file: config.vendorFile });
    }

    await writeManifest(vendorUuid);
    const sessionId = await postSessionOnce(SESSION_BODY);
    assertRunning();
    log('session-created', { sessionId });

    own('service', config.bins.node, [config.serviceScript], {
      childEnv: buildServiceEnv(config, sessionId, env),
      cwd: dirname(dirname(config.serviceScript)),
    });
    await getWithRetry(
      `http://127.0.0.1:${config.servicePort}/health`,
      'device service',
      timing.serviceReadinessMs,
    );
    log('ready', { udid: config.udid, wdaUrl: config.wdaUrl, servicePort: config.servicePort });

    await new Promise((resolve) => {
      if (stopReason) return resolve();
      stop.signal.addEventListener('abort', resolve, { once: true });
    });
    await cleanup();
    return signalled() ? EXIT.OK : EXIT.FAILURE;
  } catch (error) {
    const exit = error instanceof RuntimeError ? error.exit : EXIT.FAILURE;
    if (!signalled()) log('startup-failed', { message: error.message, exit });
    await cleanup();
    return signalled() ? EXIT.OK : exit;
  }
}

async function listenerPids(config, port, env) {
  try {
    const { stdout } = await execFileAsync(
      config.bins.lsof,
      ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fp'],
      { env: pick(env, TOOL_ENV_PASSTHROUGH), timeout: 10_000 },
    );
    return stdout
      .split('\n')
      .filter((line) => line.startsWith('p'))
      .map((line) => Number(line.slice(1)));
  } catch (error) {
    // lsof exits 1 with no output when nothing listens.
    if (error.code === 1 && !error.stdout) return [];
    return null;
  }
}

/**
 * Read-only liveness and identity check of an already running runtime. It spawns nothing,
 * writes nothing, and sends only GET requests, so it is safe to call from a service recovery
 * route. Result: { ready: true, ... } or { ready: false, reason, detail, blocking? }.
 * "blocking" names a device-side cause (locked, disconnected, Developer Mode off) when the
 * runtime is down and devicectl can explain it; launchd restarts the supervisor on its own.
 */
export async function verifyRuntime({
  env: rawEnv = process.env,
  timing: timingOverride = {},
  fetchImpl = fetch,
} = {}) {
  const timing = { ...DEFAULT_TIMING, ...timingOverride };
  let config;
  let env = rawEnv;
  try {
    env = loadRuntimeEnv(rawEnv);
    config = parseIosRuntimeConfig(env, { checkPaths: false });
  } catch (error) {
    return { ready: false, reason: 'config-invalid', detail: error.message };
  }
  const down = async (reason, detail) => {
    const result = { ready: false, reason, detail };
    try {
      await precheckDeviceState(config, env, timing.devicectlMs);
    } catch (error) {
      if (error instanceof RuntimeError) result.blocking = error.message;
    }
    return result;
  };
  const fail = (reason, detail) => ({ ready: false, reason, detail });

  let manifest;
  try {
    manifest = JSON.parse(await readFile(config.bindingFile, 'utf8'));
  } catch (error) {
    return down(
      error.code === 'ENOENT' ? 'no-binding' : 'binding-unreadable',
      'No usable ownership manifest.',
    );
  }
  let expectedVendor;
  try {
    expectedVendor = (await resolveExpectedVendor(config)) ?? manifest?.expectedVendorUuid;
  } catch (error) {
    return fail('identity-conflict', error.message);
  }
  if (
    manifest?.deviceId !== config.udid ||
    manifest?.wdaUrl !== config.wdaUrl ||
    String(manifest?.expectedVendorUuid).toLowerCase() !== String(expectedVendor).toLowerCase()
  )
    return fail(
      'binding-foreign',
      'Manifest belongs to a different device, endpoint, or identity.',
    );
  const dead = ['supervisorPid', 'runnerPid', 'proxyPid'].filter(
    (key) => key in manifest && !pidAlive(manifest[key]),
  );
  if (!pidAlive(manifest.runnerPid) || !pidAlive(manifest.proxyPid) || dead.length)
    return down('process-down', `Not running: ${dead.join(', ') || 'runner/proxy'}.`);

  const owners = await listenerPids(config, config.wdaPort, env);
  if (owners === null) return fail('ownership-unverifiable', 'Unable to inspect the WDA port.');
  if (owners.length !== 1 || owners[0] !== manifest.proxyPid)
    return fail('port-owner-mismatch', 'The WDA port is not held by the recorded proxy.');

  const get = async (path) => {
    const deadline = Date.now() + timing.requestMs;
    for (;;) {
      try {
        const response = await fetchImpl(`${config.wdaUrl}${path}`, {
          redirect: 'error',
          signal: AbortSignal.timeout(timing.requestMs),
        });
        if (response.ok) return await response.json();
      } catch {
        // retry within the bound
      }
      if (Date.now() >= deadline) return null;
      await sleepFor(Math.min(250, timing.pollMs));
    }
  };
  const status = await get('/status');
  if (status?.value?.ready !== true) return down('wda-not-ready', 'WDA /status is not ready.');
  const info = (await get('/wda/device/info'))?.value;
  const vendorUuid = info?.uuid ?? info?.identifierForVendor;
  if (typeof vendorUuid !== 'string' || vendorUuid.toLowerCase() !== expectedVendor.toLowerCase())
    return fail('identity-mismatch', 'WDA vendor UUID does not match the expected device.');
  if (info?.name !== manifest.expectedWdaName)
    return fail('identity-mismatch', 'WDA device name does not match the manifest.');
  const sessionId = env.IOS_WDA_SESSION_ID;
  if (sessionId && !(await get(`/session/${encodeURIComponent(sessionId)}`)))
    return fail('session-missing', 'The recorded WDA session is not active.');
  return {
    ready: true,
    deviceId: config.udid,
    wdaUrl: config.wdaUrl,
    runnerPid: manifest.runnerPid,
    proxyPid: manifest.proxyPid,
    vendorUuid,
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const mode = process.argv[2];
  if (mode === '--verify' || mode === '--recover') {
    verifyRuntime().then((result) => {
      process.stdout.write(`${JSON.stringify(result)}\n`);
      process.exit(result.ready ? EXIT.OK : result.blocking ? EXIT.BLOCKED : EXIT.FAILURE);
    });
  } else if (mode) {
    process.stderr.write('Usage: ios-runtime.mjs [--verify|--recover]\n');
    process.exit(EXIT.USAGE);
  } else {
    runSupervisor().then((code) => process.exit(code));
  }
}
