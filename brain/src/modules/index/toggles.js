/**
 * System toggles — the Linux replacement for the macOS launcher's
 * AppleScript / networksetup / defaults based toggles.
 *
 * Every command here is one an active session user is allowed to make: a
 * gsettings write, a NetworkManager radio call, a BlueZ power state, a D-Bus
 * property on GNOME's own rfkill daemon, or a systemd/loginctl call. Nothing
 * needs root, and nothing is interpolated into a shell.
 */

import fs from 'node:fs';
import { createLogger } from '../../common/logger.js';

const log = createLogger('index.toggles');

const TOGGLE_IMPL = {
  'dark-mode': {
    icon: 'weather-clear-night-symbolic',
    read: async () => gsettingsGet('org.gnome.desktop.interface', 'color-scheme'),
    on: async () => gsettingsSet('org.gnome.desktop.interface', 'color-scheme', 'prefer-dark'),
    off: async () => gsettingsSet('org.gnome.desktop.interface', 'color-scheme', 'default'),
    isOn: (value) => value === 'prefer-dark',
  },
  wifi: {
    icon: 'network-wireless-symbolic',
    read: async () => (await nmcliRadio()) === 'enabled',
    on: async () => nmcliRadio('on'),
    off: async () => nmcliRadio('off'),
    isOn: (v) => v === true,
  },
  dnd: {
    icon: 'notifications-disabled-symbolic',
    read: async () => gsettingsGet('org.gnome.desktop.notifications', 'show-banners'),
    on: async () => gsettingsSet('org.gnome.desktop.notifications', 'show-banners', 'false'),
    off: async () => gsettingsSet('org.gnome.desktop.notifications', 'show-banners', 'true'),
    isOn: (v) => v === 'false' || v === false,
  },
  'hidden-files': {
    icon: 'view-hidden-symbolic',
    read: async () => gsettingsGet('org.gtk.Settings.FileChooser', 'show-hidden'),
    on: async () => gsettingsSet('org.gtk.Settings.FileChooser', 'show-hidden', 'true'),
    off: async () => gsettingsSet('org.gtk.Settings.FileChooser', 'show-hidden', 'false'),
    isOn: (v) => v === 'true' || v === true,
  },
  'empty-trash': {
    icon: 'user-trash-symbolic',
    read: async () => null,
    on: async () => run(['gio', 'trash', '--empty']),
    off: async () => run(['gio', 'trash', '--empty']),
    isOn: () => false,
  },
  sleep: {
    icon: 'weather-clear-night-symbolic',
    read: async () => null,
    on: async () => run(['systemctl', 'suspend']),
    off: async () => run(['systemctl', 'suspend']),
    isOn: () => false,
  },
  lock: {
    icon: 'changes-prevent-symbolic',
    read: async () => null,
    on: async () => run(['loginctl', 'lock-session']),
    off: async () => run(['loginctl', 'lock-session']),
    isOn: () => false,
  },
  bluetooth: {
    icon: 'bluetooth-active-symbolic',
    // Left out of the list entirely on a machine with no adapter, rather than
    // offered and failing on Enter.
    probe: () => hasBluetoothAdapter(),
    read: async () => bluetoothPowered(),
    on: async () => {
      // Two steps, and the order matters: while GNOME's rfkill soft block is
      // set, BlueZ refuses with "Failed to set power on: org.bluez.Error.Failed".
      await bluetoothUnblock();
      await run(['bluetoothctl', 'power', 'on']);
    },
    off: async () => run(['bluetoothctl', 'power', 'off']),
    isOn: (v) => v === true,
  },
};

/**
 * GTK renamed its schemas for GTK4 ("org.gtk.Settings.*" became
 * "org.gtk.gtk4.Settings.*"), and a GNOME 49 session frequently has no GTK3
 * schema installed at all — so a hard-coded name fails with
 * "No such schema", which is exactly how the hidden-files toggle broke here.
 * Resolve the alias once, and return the original name if nothing matches so the
 * real call still produces a useful error.
 */
const SCHEMA_ALIASES = new Map([['org.gtk.Settings.FileChooser', ['org.gtk.gtk4.Settings.FileChooser']]]);
const resolvedSchemas = new Map();

async function resolveSchema(schema) {
  if (resolvedSchemas.has(schema)) return resolvedSchemas.get(schema);
  for (const candidate of [schema, ...(SCHEMA_ALIASES.get(schema) ?? [])]) {
    const proc = Bun.spawn(['gsettings', 'list-keys', candidate], { stdout: 'ignore', stderr: 'ignore' });
    if ((await proc.exited) === 0) {
      resolvedSchemas.set(schema, candidate);
      if (candidate !== schema) log.debug(`schema alias: ${schema} -> ${candidate}`);
      return candidate;
    }
  }
  resolvedSchemas.set(schema, schema);
  return schema;
}

/**
 * Bluetooth state, straight from BlueZ. `Powered` is the honest signal: an
 * adapter that is rfkill-blocked reports Powered: no, which is exactly what the
 * toggle should show.
 */
async function bluetoothPowered() {
  const proc = Bun.spawn(['bluetoothctl', 'show'], { stdout: 'pipe', stderr: 'ignore' });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  const line = out.split('\n').find((l) => l.trim().startsWith('Powered:'));
  if (!line) throw new Error('no bluetooth adapter found');
  return line.includes('yes');
}

async function hasBluetoothAdapter() {
  try {
    return fs.readdirSync('/sys/class/bluetooth').length > 0;
  } catch {
    return false;
  }
}

/**
 * Clear GNOME's Bluetooth soft block through its own rfkill daemon — the same
 * thing the quick-settings switch does. BlueZ cannot power an adapter on while
 * the block is set, so this has to happen first. `AirplaneMode` (all radios) is
 * left alone deliberately: this is the Bluetooth-specific flag.
 */
async function bluetoothUnblock() {
  await run([
    'gdbus',
    'call',
    '--session',
    '--dest',
    'org.gnome.SettingsDaemon.Rfkill',
    '--object-path',
    '/org/gnome/SettingsDaemon/Rfkill',
    '--method',
    'org.freedesktop.DBus.Properties.Set',
    'org.gnome.SettingsDaemon.Rfkill',
    'BluetoothAirplaneMode',
    '<false>',
  ]);
}

/**
 * Nothing in this module may block forever.
 *
 * A single command that never returns strands the whole toggle list, because
 * `loadToggles` publishes it only after every state read resolves — which is
 * exactly what happened when `bluetoothctl show` began hanging inside the
 * systemd user service. The panel then had no toggle rows at all: no dark mode,
 * no Wi-Fi, no Bluetooth, with nothing in the log to say why.
 */
const TOGGLE_TIMEOUT_MS = 2500;

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms);
  });
  try {
    return Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function run(argv) {
  const proc = Bun.spawn(argv, { stdout: 'ignore', stderr: 'pipe' });
  const code = await withTimeout(proc.exited, 8000, argv[0]);
  if (code !== 0) {
    const err = await new Response(proc.stderr).text();
    throw new Error(`${argv.join(' ')} exited ${code}: ${err.trim()}`);
  }
}

async function gsettingsGet(schema, key) {
  const actual = await resolveSchema(schema);
  const proc = Bun.spawn(['gsettings', 'get', actual, key], { stdout: 'pipe', stderr: 'ignore' });
  const out = (await new Response(proc.stdout).text()).trim();
  await proc.exited;
  return out.replace(/^'|'$/g, '');
}

async function gsettingsSet(schema, key, value) {
  await run(['gsettings', 'set', await resolveSchema(schema), key, value]);
}

async function nmcliRadio(state) {
  if (state) return run(['nmcli', 'radio', 'wifi', state]);
  const proc = Bun.spawn(['nmcli', '-t', '-f', 'WIFI', 'radio'], { stdout: 'pipe', stderr: 'ignore' });
  const out = (await new Response(proc.stdout).text()).trim();
  await proc.exited;
  return out.split(':')[1] ?? 'unknown';
}

/** Row titles reflect the action, exactly like the macOS version. */
export async function loadToggles(config) {
  const rows = [];
  for (const toggle of config.toggles ?? []) {
    const impl = TOGGLE_IMPL[toggle.id];

    // A toggle whose hardware (or schema) is missing is left out of the list
    // entirely, rather than offered and then failing on Enter.
    if (impl?.probe) {
      let available = false;
      try {
        available = await impl.probe();
      } catch {
        available = false;
      }
      if (!available) {
        log.debug(`skipping the ${toggle.id} toggle: not available on this system`);
        continue;
      }
    }

    let isOn = null;
    if (impl) {
      try {
        const raw = impl.read ? await withTimeout(impl.read(), TOGGLE_TIMEOUT_MS, toggle.id) : null;
        isOn = impl.isOn(raw);
      } catch (err) {
        // The row is still offered, just without a known state — better than
        // losing it, and much better than losing all of them.
        log.warn(`could not read state for ${toggle.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    rows.push({
      id: `toggle:${toggle.id}`,
      kind: 'system_toggle',
      title: toggle.title,
      // "Turn Wi-Fi Off" flips to "Turn Wi-Fi On" once the radio is off.
      detail: isOn === null ? 'System' : isOn ? 'Currently on — Enter turns it off' : 'Currently off — Enter turns it on',
      keywords: `${toggle.keywords} toggle on off enable disable`,
      icon_kind: 'named',
      icon: impl?.icon ?? 'preferences-system-symbolic',
      toggleId: toggle.id,
      state: isOn,
      hasState: isOn !== null,
    });
  }
  return rows;
}

export async function executeToggle(toggleId, flipTitle) {
  const impl = TOGGLE_IMPL[toggleId];
  if (!impl) throw new Error(`unknown toggle: ${toggleId}`);

  let isOn = false;
  try {
    isOn = impl.read ? impl.isOn(await withTimeout(impl.read(), TOGGLE_TIMEOUT_MS, toggleId)) : false;
  } catch {
    isOn = false;
  }

  await (isOn ? impl.off() : impl.on());

  if (flipTitle) {
    const flipped = flipTitle(isOn);
    if (flipped) return flipped;
  }
  return isOn ? 'Turned off' : 'Turned on';
}
