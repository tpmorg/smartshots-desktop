import { load } from '@tauri-apps/plugin-store';

const STORE_FILE = 'preferences.json';
const KEY_NOTIFICATIONS = 'notificationsEnabled';
const KEY_WATCHER_AUTOSTART = 'watcherAutostart';

export type Preferences = {
  notificationsEnabled: boolean;
  watcherAutostart: boolean;
};

const DEFAULT_PREFERENCES: Preferences = {
  notificationsEnabled: false,
  watcherAutostart: false
};

let storePromise: ReturnType<typeof load> | null = null;

function getStore() {
  if (!storePromise) {
    storePromise = load(STORE_FILE);
  }
  return storePromise;
}

export async function readPreferences(): Promise<Preferences> {
  const store = await getStore();

  const notificationsEnabled = normalizeBool(await store.get(KEY_NOTIFICATIONS), DEFAULT_PREFERENCES.notificationsEnabled);
  const watcherAutostart = normalizeBool(await store.get(KEY_WATCHER_AUTOSTART), DEFAULT_PREFERENCES.watcherAutostart);

  return {
    notificationsEnabled,
    watcherAutostart
  };
}

export async function saveNotificationsEnabled(value: boolean): Promise<void> {
  const store = await getStore();
  await store.set(KEY_NOTIFICATIONS, value);
  await store.save();
}

export async function saveWatcherAutostart(value: boolean): Promise<void> {
  const store = await getStore();
  await store.set(KEY_WATCHER_AUTOSTART, value);
  await store.save();
}

function normalizeBool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}
