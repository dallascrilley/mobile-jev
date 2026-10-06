#!/usr/bin/env node
// Install one LaunchAgent per physical iOS device. The agent runs the credential wrapper, which
// runs scripts/ios-runtime.mjs. All device settings live in a private JSON config file outside
// Git (see CONFIG_FILE_KEYS in ios-runtime.mjs); the plist only points at that file.
//
//   node scripts/install-ios-service.mjs --config ~/.local/state/agent-device-ios/iphone-config.json
//   node scripts/install-ios-service.mjs --config <file> --install
//
// Without --install this prints the plan and writes nothing.
import { execFile } from 'node:child_process';
import { accessSync, constants, existsSync, readFileSync, readdirSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir, userInfo } from 'node:os';
import { dirname, isAbsolute, join, normalize } from 'node:path';
import { parseArgs, promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { loadRuntimeEnv, parseIosRuntimeConfig, pidAlive } from './ios-runtime.mjs';

const execFileAsync = promisify(execFile);
export const LABEL_PREFIX = 'ai.typesafe.mobile-jev.ios.';
const DEFAULT_PATH = '/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin';

export class InstallError extends Error {}

// Plist values are escaped by hand; control characters (other than tab/newline) are rejected.
export function xmlEscape(value) {
  const text = String(value);
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text))
    throw new InstallError('A plist value contains a control character.');
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

const str = (value) => `<string>${xmlEscape(value)}</string>`;
const dictEntries = (entries, indent) =>
  Object.entries(entries)
    .map(([key, value]) => `${indent}<key>${xmlEscape(key)}</key>\n${indent}${str(value)}`)
    .join('\n');

export function buildPlist({ label, node, sourceRoot, configPath, home, user, pathEnv, logDir }) {
  const script = (name) => join(sourceRoot, 'scripts', name);
  const logFile = join(logDir, `${label}.log`);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  ${str(label)}
  <key>ProgramArguments</key>
  <array>
    ${str(node)}
    ${str(script('with-typesafe-key.mjs'))}
    ${str(node)}
    ${str(script('ios-runtime.mjs'))}
  </array>
  <key>WorkingDirectory</key>
  ${str(sourceRoot)}
  <key>EnvironmentVariables</key>
  <dict>
${dictEntries({ HOME: home, USER: user, PATH: pathEnv, IOS_RUNTIME_CONFIG: configPath }, '    ')}
  </dict>
  <key>ThrottleInterval</key>
  <integer>30</integer>
  <key>ExitTimeOut</key>
  <integer>30</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  ${str(logFile)}
  <key>StandardErrorPath</key>
  ${str(logFile)}
</dict>
</plist>
`;
}

const absolute = (value, name) => {
  if (!value || !isAbsolute(value) || normalize(value) !== value)
    throw new InstallError(`${name} must be a normalized absolute path.`);
  return value;
};

/** Validate inputs and describe what would be installed. Reads files; writes nothing. */
export function planInstall(argv, { home = homedir(), user = userInfo().username } = {}) {
  const { values } = parseArgs({
    args: argv,
    options: {
      config: { type: 'string' },
      install: { type: 'boolean', default: false },
      'launch-agents-dir': { type: 'string' },
      'state-dir': { type: 'string' },
      'source-root': { type: 'string' },
      node: { type: 'string' },
      launchctl: { type: 'string' },
      path: { type: 'string' },
      'ready-timeout': { type: 'string' },
    },
    strict: true,
  });
  const configPath = absolute(values.config, '--config');
  const sourceRoot = absolute(
    values['source-root'] || fileURLToPath(new URL('../', import.meta.url)).replace(/\/$/, ''),
    '--source-root',
  );
  for (const name of ['with-typesafe-key.mjs', 'ios-runtime.mjs', 'device-service.mjs'])
    if (!existsSync(join(sourceRoot, 'scripts', name)))
      throw new InstallError(`Source root lacks scripts/${name}.`);
  const node = absolute(values.node || process.execPath, '--node');
  try {
    accessSync(node, constants.X_OK);
  } catch {
    throw new InstallError('--node is not executable.');
  }
  const stateDir = absolute(
    values['state-dir'] || join(home, '.local/state/agent-device-ios'),
    '--state-dir',
  );
  const launchAgentsDir = absolute(
    values['launch-agents-dir'] || join(home, 'Library/LaunchAgents'),
    '--launch-agents-dir',
  );
  // Reuse the supervisor's own validation, so the installer cannot accept a config it would reject.
  let config;
  try {
    config = parseIosRuntimeConfig(loadRuntimeEnv({ IOS_RUNTIME_CONFIG: configPath }));
  } catch (error) {
    throw new InstallError(`Config rejected: ${error.message}`);
  }
  const label = `${LABEL_PREFIX}${config.udid.toLowerCase()}`;
  const readyTimeoutSeconds = Number(values['ready-timeout'] ?? 200);
  if (!Number.isFinite(readyTimeoutSeconds) || readyTimeoutSeconds < 1 || readyTimeoutSeconds > 900)
    throw new InstallError('--ready-timeout must be 1-900 seconds.');
  const plistPath = join(launchAgentsDir, `${label}.plist`);
  const logDir = join(stateDir, 'logs');
  const plist = buildPlist({
    label,
    node,
    sourceRoot,
    configPath,
    home,
    user,
    pathEnv: values.path || DEFAULT_PATH,
    logDir,
  });
  return {
    install: values.install,
    label,
    config,
    configPath,
    plist,
    plistPath,
    launchAgentsDir,
    stateDir,
    logDir,
    launchctl: absolute(values.launchctl || '/bin/launchctl', '--launchctl'),
    readyTimeoutSeconds,
  };
}

function peerConflicts(plan) {
  // Another installed agent must not share ports or the binding file with this one.
  const conflicts = [];
  let names = [];
  try {
    names = readdirSync(plan.launchAgentsDir);
  } catch {
    return conflicts;
  }
  for (const name of names) {
    if (
      !name.startsWith(LABEL_PREFIX) ||
      !name.endsWith('.plist') ||
      name === `${plan.label}.plist`
    )
      continue;
    try {
      const text = readFileSync(join(plan.launchAgentsDir, name), 'utf8');
      const configPath = /<key>IOS_RUNTIME_CONFIG<\/key>\s*<string>([^<]*)<\/string>/.exec(
        text,
      )?.[1];
      if (!configPath) continue;
      const peer = parseIosRuntimeConfig(
        loadRuntimeEnv({ IOS_RUNTIME_CONFIG: configPath.replaceAll('&amp;', '&') }),
        { checkPaths: false },
      );
      for (const key of ['wdaPort', 'servicePort', 'bindingFile', 'udid'])
        if (peer[key] === plan.config[key]) conflicts.push(`${name}: same ${key}`);
    } catch {
      // unreadable peers are not ours to judge
    }
  }
  return conflicts;
}

async function bindingProblem(plan) {
  let manifest;
  try {
    manifest = JSON.parse(await readFile(plan.config.bindingFile, 'utf8'));
  } catch (error) {
    return error.code === 'ENOENT' ? null : 'binding file exists but is unreadable; preserved';
  }
  if (manifest?.deviceId !== plan.config.udid || manifest?.wdaUrl !== plan.config.wdaUrl)
    return 'binding file belongs to a different device or endpoint; preserved';
  const live = ['supervisorPid', 'runnerPid', 'proxyPid'].filter((key) => pidAlive(manifest[key]));
  return live.length
    ? `binding file has live owner processes (${live.join(', ')}); stop them first`
    : null;
}

async function atomicWrite(path, content, mode) {
  const staging = `${path}.tmp-${process.pid}`;
  await writeFile(staging, content, { mode, flag: 'wx' });
  await rename(staging, path);
}

/** Perform the plan. deps: { run(bin, args), fetchImpl, sleep, uid, out }. Returns an exit code. */
export async function install(plan, deps = {}) {
  const out = deps.out ?? ((line) => process.stdout.write(`${line}\n`));
  const run =
    deps.run ??
    (async (bin, args) => {
      try {
        const { stdout } = await execFileAsync(bin, args, { timeout: 30_000 });
        return { ok: true, stdout };
      } catch (error) {
        return { ok: false, stdout: error.stdout ?? '' };
      }
    });
  const fetchImpl = deps.fetchImpl ?? fetch;
  const sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const uid = deps.uid ?? process.getuid();
  const domain = `gui/${uid}`;
  const problems = [...peerConflicts(plan)];
  const binding = await bindingProblem(plan);
  if (binding) problems.push(binding);
  let existing = null;
  if (existsSync(plan.plistPath)) existing = await readFile(plan.plistPath, 'utf8');
  if (existing !== null && existing !== plan.plist)
    problems.push(`a different plist already exists and is preserved: ${plan.plistPath}`);

  out(
    JSON.stringify({
      label: plan.label,
      plist: plan.plistPath,
      config: plan.configPath,
      wdaUrl: plan.config.wdaUrl,
      servicePort: plan.config.servicePort,
      binding: plan.config.bindingFile,
      mode: plan.install ? 'install' : 'dry-run',
      problems,
    }),
  );
  if (problems.length) return 1;
  if (!plan.install) return 0;

  await mkdir(plan.stateDir, { recursive: true, mode: 0o700 });
  await mkdir(plan.logDir, { recursive: true, mode: 0o700 });
  await mkdir(dirname(plan.config.bindingFile), { recursive: true, mode: 0o700 });
  await mkdir(plan.launchAgentsDir, { recursive: true });
  if (existing === null) await atomicWrite(plan.plistPath, plan.plist, 0o600);
  const loaded = await run(plan.launchctl, ['print', `${domain}/${plan.label}`]);
  if (!loaded.ok) {
    const result = await run(plan.launchctl, ['bootstrap', domain, plan.plistPath]);
    if (!result.ok) {
      out(JSON.stringify({ ready: false, reason: 'launchctl bootstrap failed' }));
      return 1;
    }
  }
  // Readiness: the job runs and the service answers GET /health. Reads only, bounded.
  const deadline = Date.now() + plan.readyTimeoutSeconds * 1000;
  let last = 'not started';
  while (Date.now() < deadline) {
    const state = await run(plan.launchctl, ['print', `${domain}/${plan.label}`]);
    const running = state.ok && /state = running/.test(state.stdout);
    try {
      const response = await fetchImpl(`http://127.0.0.1:${plan.config.servicePort}/health`, {
        redirect: 'error',
        signal: AbortSignal.timeout(5000),
      });
      if (response.ok && running) {
        out(
          JSON.stringify({ ready: true, label: plan.label, servicePort: plan.config.servicePort }),
        );
        return 0;
      }
      last = `health HTTP ${response.status}`;
    } catch {
      last = running ? 'service not answering yet' : 'job not running';
    }
    await sleep(2000);
  }
  out(JSON.stringify({ ready: false, reason: last, label: plan.label }));
  return 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    process.exit(await install(planInstall(process.argv.slice(2))));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(64);
  }
}
