import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadEnvironment } from './env.mjs';
loadEnvironment();
const exec = promisify(execFile);
const [command, ...args] = process.argv.slice(2);
if (!command) throw new Error('Pass a command and arguments.');
let key = process.env.TYPESAFE_API_KEY;
const credentialReference = process.env.TYPESAFE_CREDENTIAL_REFERENCE;
if (!key && !credentialReference)
  throw new Error('Set TYPESAFE_CREDENTIAL_REFERENCE to the approved 1Password field reference.');
if (!key) {
  const { stdout: identity } = await exec(`${process.env.HOME}/.local/bin/op`, [
    'whoami',
    '--format',
    'json',
  ]);
  if (JSON.parse(identity).user_type !== 'SERVICE_ACCOUNT')
    throw new Error('1Password service account required.');
  const { stdout } = await exec(`${process.env.HOME}/.local/bin/op`, ['read', credentialReference]);
  key = stdout.trim();
}
const child = spawn(command, args, {
  env: { ...process.env, TYPESAFE_API_KEY: key },
  stdio: 'inherit',
});
child.on('error', () => {
  console.error('Unable to launch credential-injected command.');
  process.exitCode = 1;
});
child.on('exit', (code) => {
  process.exitCode = code || 0;
});
process.on('SIGTERM', () => child.kill('SIGTERM'));
process.on('SIGINT', () => child.kill('SIGINT'));
