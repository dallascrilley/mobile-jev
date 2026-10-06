import { LocalAndroidDevice } from './local-device.mjs';
import { MobilerunDevice } from './device.mjs';
import { IosDevice } from './ios-device.mjs';
export function createDevice(options = {}) {
  const backend =
    options.backend ||
    process.env.MOBILE_DEVICE_BACKEND ||
    (process.env.ADB_SERIAL ? 'local' : 'mobilerun');
  if (backend === 'local') return new LocalAndroidDevice(options);
  if (backend === 'mobilerun') return new MobilerunDevice(options);
  // iOS is never inferred from the environment: it must be selected explicitly.
  if (backend === 'ios') {
    const { backend: _backend, ...rest } = options;
    return new IosDevice(rest);
  }
  throw new Error('Device backend must be local, mobilerun or ios.');
}
