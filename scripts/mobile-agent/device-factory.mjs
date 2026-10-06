import { LocalAndroidDevice } from './local-device.mjs';
import { MobilerunDevice } from './device.mjs';
export function createDevice(options = {}) {
  const backend =
    options.backend ||
    process.env.MOBILE_DEVICE_BACKEND ||
    (process.env.ADB_SERIAL ? 'local' : 'mobilerun');
  if (backend === 'local') return new LocalAndroidDevice(options);
  if (backend === 'mobilerun') return new MobilerunDevice(options);
  throw new Error('Device backend must be local or mobilerun.');
}
