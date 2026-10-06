import { execFileSync } from 'node:child_process';
import { loadEnvironment } from './env.mjs';
import { createDevice } from './mobile-agent/device-factory.mjs';

loadEnvironment();
const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok, detail });
}
check('Node.js', Number(process.versions.node.split('.')[0]) >= 22, process.versions.node);
try {
  const output = execFileSync('curl', ['--version'], { encoding: 'utf8' });
  const version = output.match(/^curl (\d+)\.(\d+)/);
  check(
    'curl',
    Boolean(version && (+version[1] > 7 || (+version[1] === 7 && +version[2] >= 70))),
    output.split('\n')[0].split(' (')[0],
  );
} catch {
  check('curl', false, 'Install curl 7.70 or newer.');
}
const local = process.env.MOBILE_DEVICE_BACKEND === 'local' || Boolean(process.env.ADB_SERIAL);
if (!local)
  check(
    'Mobilerun API key',
    Boolean(process.env.MOBILERUN_API_KEY || process.env.MOBILERUN_CLOUD_API_KEY),
    'Required only for cloud mode.',
  );
check(
  'Decision provider',
  process.env.DECISION_BACKEND !== 'jev' || Boolean(process.env.TYPESAFE_API_KEY),
  'Local providers do not need a hosted key.',
);
try {
  const device = createDevice();
  const info = await device.assertReady();
  check('Device connection', true, `${info.name || info.id}: ${info.state}`);
  const observation = await device.observe();
  check(
    'UI observation',
    observation.elements.length > 0,
    `${observation.elements.length} elements, ${observation.screen.width}×${observation.screen.height}`,
  );
} catch (error) {
  check('Device connection', false, error.message);
}
for (const item of checks)
  console.log(`${item.ok ? 'PASS' : 'FAIL'}  ${item.name}: ${item.detail}`);
if (checks.some((c) => !c.ok)) process.exitCode = 1;
