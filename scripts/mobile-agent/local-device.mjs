import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { MobilerunDevice, KEYS, GLOBAL_ACTIONS } from './device.mjs';
import { prepareInputVerification, confirmInput } from './input-verification.mjs';
const exec = promisify(execFile);
const quote = (s) => "'" + String(s).replaceAll("'", "'\\''") + "'";

export function parseContent(output) {
  const text = output.trim();
  const start = text.indexOf('{');
  if (start < 0)
    throw new Error('Portal returned no structured state. Check Accessibility access.');
  let result;
  try {
    result = JSON.parse(text.slice(start));
  } catch {
    throw new Error('Portal returned invalid JSON.');
  }
  if (result.status !== 'success')
    throw new Error('Portal operation failed; inspect the device before retrying.');
  return result.result;
}

export function parseMutationResult(output) {
  // Android 16 discards ContentProvider.insert() return values. Exit alone is
  // transport evidence; readable text changes are verified in act().
  if (!output.trim()) return { accepted: true, verified: false };
  const match = output.trim().match(/^Inserted (content:\/\/\S+)$/);
  let uri;
  try {
    if (!match) throw new Error();
    uri = new URL(match[1]);
    if (
      uri.protocol !== 'content:' ||
      uri.host !== 'com.mobilerun.portal' ||
      uri.pathname !== '/result' ||
      uri.searchParams.getAll('status').length !== 1 ||
      uri.searchParams.get('status') !== 'success'
    )
      throw new Error();
  } catch {
    throw new Error(
      'Portal mutation result is uncertain or failed; observe before recovery. Do not replay.',
    );
  }
  return { accepted: true };
}

export class LocalAndroidDevice extends MobilerunDevice {
  constructor({
    deviceId = process.env.ADB_SERIAL,
    adbBin = process.env.ADB_BIN || 'adb',
    runner = exec,
    ...rest
  } = {}) {
    super({ ...rest, deviceId, baseUrl: 'https://local.invalid', apiKey: undefined });
    this.adbBin = adbBin;
    this.runner = runner;
    this.backend = 'local';
    this.baseUrl = 'adb://local';
  }
  async act(action, options = {}) {
    await this.assertIdentity();
    const replacement =
      action?.type === 'clear' || (action?.type === 'type' && action.clear === true);
    let verification;
    if (replacement) {
      const before = options.expected || (await this.observe());
      verification = prepareInputVerification(before, {
        type: 'type',
        clear: true,
        text: action.type === 'clear' ? '' : action.text,
      });
      if (!verification) throw new Error('Local replacement requires a readable focused field.');
    }
    await super.act(action, options);
    if (verification) {
      const result = await confirmInput({
        initial: await this.observe(),
        verification,
        observe: () => this.observe(),
        timeoutMs: 2500,
        pollMs: 100,
      });
      if (!result.verified)
        throw new Error('Local text change is uncertain; observe before recovery. Do not replay.');
      return { accepted: true, verified: true, verification: 'exact-field-readback' };
    }
    return { accepted: true, verified: false, verification: 'transport-only' };
  }
  async adb(args, binary = false) {
    if (!this.deviceId)
      throw new Error('Set ADB_SERIAL or pass --device; never guess among connected devices.');
    try {
      const result = await this.runner(this.adbBin, ['-s', this.deviceId, ...args], {
        encoding: binary ? 'buffer' : 'utf8',
        timeout: 15_000,
        maxBuffer: 20 * 1024 * 1024,
      });
      return result.stdout;
    } catch {
      throw new Error(
        'ADB operation failed or timed out. Mutation is not retried; observe before recovery.',
      );
    }
  }
  async shell(parts) {
    return this.adb(['shell', parts.map(quote).join(' ')]);
  }
  async content(path, values) {
    const parts = [
      'content',
      values ? 'insert' : 'query',
      '--uri',
      `content://com.mobilerun.portal/${path}`,
    ];
    if (values)
      for (const [name, type, value] of values) parts.push('--bind', `${name}:${type}:${value}`);
    const output = await this.shell(parts);
    return values ? parseMutationResult(output) : parseContent(output);
  }
  async assertIdentity() {
    const identity = (process.env.AGENT_DEVICE_IDENTITY || '').trim();
    if (identity && (await this.shell(['getprop', 'ro.serialno'])).trim() !== identity)
      throw new Error('ADB transport does not match the pinned physical tablet.');
  }
  async assertReady() {
    await this.assertIdentity();
    if ((await this.adb(['get-state'])).trim() !== 'device')
      throw new Error('Tablet is disconnected.');
    const version = await this.content('version');
    this.readyAt = performance.now();
    return { id: this.deviceId, name: 'Galaxy Tab S8+', state: 'ready', backend: 'local', version };
  }
  async listDevices() {
    const { stdout } = await this.runner(this.adbBin, ['devices', '-l'], {
      encoding: 'utf8',
      timeout: 5000,
    });
    return stdout
      .trim()
      .split('\n')
      .slice(1)
      .filter(Boolean)
      .map((line) => {
        const [id, state] = line.trim().split(/\s+/);
        return { id, name: line.match(/model:(\S+)/)?.[1] || id, state };
      });
  }
  async api(path, method = 'GET', body, binary = false) {
    const suffix = path.slice(path.indexOf('/devices/') + 9).replace(/^[^/]+/, '');
    if (method === 'GET') {
      if (suffix.startsWith('/ui-state')) return this.content('state_full?filter=false');
      if (suffix.startsWith('/screenshot')) return this.adb(['exec-out', 'screencap', '-p'], true);
      if (suffix.startsWith('/apps')) {
        const raw = await this.content('packages');
        const apps = Array.isArray(raw) ? raw : raw?.packages;
        if (!Array.isArray(apps)) throw new Error('Portal returned invalid package inventory.');
        return apps
          .map((a) => ({
            packageName: a.packageName || a.package || a.package_name,
            label: a.label || a.appName || a.name,
          }))
          .filter((a) => a.packageName && a.label);
      }
      if (!suffix) return this.assertReady();
    }
    if (suffix.startsWith('/apps/') && method === 'PUT') {
      const pkg = decodeURIComponent(suffix.slice(6));
      if (!/^[A-Za-z0-9_.]+$/.test(pkg)) throw new Error('Invalid package name.');
      const component = (
        await this.shell(['cmd', 'package', 'resolve-activity', '--brief', '--user', '0', pkg])
      )
        .trim()
        .split('\n')
        .at(-1);
      if (!component || !component.includes('/')) throw new Error('App has no launcher activity.');
      await this.shell(['am', 'start', '-n', component]);
      return;
    }
    switch (suffix) {
      case '/tap':
        await this.shell(['input', 'tap', body.x, body.y]);
        return;
      case '/swipe':
        await this.shell([
          'input',
          'swipe',
          body.startX,
          body.startY,
          body.endX,
          body.endY,
          body.duration,
        ]);
        return;
      case '/global': {
        const names = Object.fromEntries(Object.entries(GLOBAL_ACTIONS).map(([k, v]) => [v, k]));
        const code = { back: 4, home: 3, recent: 187 }[names[body.action]];
        if (!code) throw new Error('Invalid global action.');
        await this.shell(['input', 'keyevent', code]);
        return;
      }
      case '/keyboard':
        if (method === 'DELETE')
          return this.content('keyboard/input', [
            ['base64_text', 's', ''],
            ['clear', 'b', true],
          ]);
        if (method === 'PUT') {
          if (!Object.values(KEYS).includes(body.key)) throw new Error('Unsupported key.');
          return this.shell(['input', 'keyevent', body.key]);
        }
        return this.content('keyboard/input', [
          ['base64_text', 's', Buffer.from(body.text).toString('base64')],
          ['clear', 'b', Boolean(body.clear)],
        ]);
      default:
        throw new Error(
          `Unsupported local operation ${method} ${suffix}${binary ? ' binary' : ''}.`,
        );
    }
  }
}
