import { useLocation } from 'react-router-dom';

import type { AdapterState } from '@opencycle/shared';

import { useAppStore } from '../store.js';

const BLUETOOTH_SETTINGS_URL =
  'x-apple.systempreferences:com.apple.preference.security?Privacy_Bluetooth';

type BluetoothProblem = Extract<AdapterState, 'unauthorized' | 'poweredOff'>;

export function BluetoothFix({ state }: { state: BluetoothProblem }) {
  return (
    <>
      <span>
        {state === 'unauthorized'
          ? 'macOS needs to let openCycle use Bluetooth. In System Settings, go to Privacy & Security > Bluetooth, then turn on openCycle.'
          : 'Turn Bluetooth on to connect your trainer and heart rate strap.'}
      </span>{' '}
      <a className="font-medium underline hover:text-ink" href={BLUETOOTH_SETTINGS_URL}>
        Open Bluetooth settings
      </a>
    </>
  );
}

export default function BluetoothBanner() {
  const adapterState = useAppStore((state) => state.adapterState);
  const session = useAppStore((state) => state.session);
  const location = useLocation();
  const onRidePage = location.pathname === '/' && session !== null;

  if (onRidePage || (adapterState !== 'unauthorized' && adapterState !== 'poweredOff')) {
    return null;
  }

  return (
    <aside
      aria-live="polite"
      className="border-b border-over/40 bg-over/10 px-6 py-3 text-sm text-over"
    >
      <div className="mx-auto max-w-7xl">
        <BluetoothFix state={adapterState} />
      </div>
    </aside>
  );
}
