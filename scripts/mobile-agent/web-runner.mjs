import { createDevice } from './device-factory.mjs';
import { withDeviceLock } from './device-lock.mjs';
import { TypeSafePolicy, runAgent } from './agent.mjs';
import { pathToFileURL } from 'node:url';
import { retryReadOnlyReadiness } from '../../apps/jev-studio/server/device-readiness.mjs';

const emit = (type, data) =>
  process.stdout.write(JSON.stringify({ type, at: Date.now(), ...data }) + '\n');

export async function assertReadyWithRetry(device, { attempts = 5, delayMs = 250, sleep } = {}) {
  return retryReadOnlyReadiness(() => device.assertReady(), { attempts, delayMs, sleep });
}

export async function runWebTask({
  device,
  policy,
  createPolicy,
  goal,
  maxSteps,
  settleMs = 800,
  lock = withDeviceLock,
  run = runAgent,
  onStep = () => {},
  onAction = () => {},
  readiness = {},
}) {
  const identity =
    process.env.AGENT_DEVICE_IDENTITY || device.deviceId || device.id || device.serial;
  if (!identity) throw new Error('AGENT_DEVICE_IDENTITY is not configured for this device.');
  const safeDevice = new Proxy(device, {
    get(target, key) {
      if (key === 'assertReady') return () => assertReadyWithRetry(target, readiness);
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return lock(identity, async () => {
    const activePolicy = createPolicy ? await createPolicy() : policy;
    if (!activePolicy) throw new Error('A decision policy is required.');
    return run({
      device: safeDevice,
      policy: activePolicy,
      goal,
      maxSteps,
      settleMs,
      execute: true,
      onStep,
      onAction,
    });
  });
}

async function main() {
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
    if (input.length > 10_000) throw new Error('Task input is too long.');
  }
  const { goal, maxSteps, backend = 'jev' } = JSON.parse(input);
  if (!['jev', 'rizzo', 'tev1'].includes(backend)) throw new Error('Unsupported decision backend.');
  process.env.DECISION_BACKEND = backend;
  const device = await createDevice();
  const result = await runWebTask({
    device,
    createPolicy: () => new TypeSafePolicy({ backend }),
    goal,
    maxSteps,
    onStep: ({
      step,
      attempt,
      status,
      operation,
      label,
      confidence,
      targetConfidence,
      latencyMs,
      responseModel,
      reason,
    }) =>
      emit('decision', {
        step,
        attempt,
        status,
        operation,
        label,
        confidence,
        targetConfidence,
        latencyMs,
        model: responseModel,
        reason,
      }),
    onAction: ({ step, operation, label, executedMs }) =>
      emit('action', { step, operation, label, executedMs }),
  });
  emit('result', {
    outcome: result.status,
    steps: result.steps,
    timings: result.timings,
    reason: result.decision?.reason,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    let message = error.message;
    for (const [name, value] of Object.entries(process.env)) {
      if (!/(?:API_KEY|TOKEN|SECRET)$/i.test(name) || !value) continue;
      message = message.split(value).join('[redacted]');
    }
    emit('error', { message });
    process.exitCode = 1;
  });
}
