import { load } from '@tauri-apps/plugin-store';

const STORE_FILE = 'preferences.json';
const KEY_NOTIFICATIONS = 'notificationsEnabled';
const KEY_WATCHER_AUTOSTART = 'watcherAutostart';
const KEY_HIDE_TO_TRAY_ON_CLOSE = 'hideToTrayOnClose';
const KEY_AUTO_SYNC_NEW = 'autoSyncNewScreenshots';
const KEY_REVIEW_BACKLOG_ON_LAUNCH = 'reviewBacklogOnLaunch';

export type Preferences = {
  notificationsEnabled: boolean;
  watcherAutostart: boolean;
  hideToTrayOnClose: boolean;
  autoSyncNewScreenshots: boolean;
  reviewBacklogOnLaunch: boolean;
};

const DEFAULT_PREFERENCES: Preferences = {
  notificationsEnabled: false,
  watcherAutostart: false,
  hideToTrayOnClose: true,
  autoSyncNewScreenshots: true,
  reviewBacklogOnLaunch: true
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
  const hideToTrayOnClose = normalizeBool(
    await store.get(KEY_HIDE_TO_TRAY_ON_CLOSE),
    DEFAULT_PREFERENCES.hideToTrayOnClose
  );
  const autoSyncNewScreenshots = normalizeBool(await store.get(KEY_AUTO_SYNC_NEW), DEFAULT_PREFERENCES.autoSyncNewScreenshots);
  const reviewBacklogOnLaunch = normalizeBool(
    await store.get(KEY_REVIEW_BACKLOG_ON_LAUNCH),
    DEFAULT_PREFERENCES.reviewBacklogOnLaunch
  );

  return {
    notificationsEnabled,
    watcherAutostart,
    hideToTrayOnClose,
    autoSyncNewScreenshots,
    reviewBacklogOnLaunch
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

export async function saveHideToTrayOnClose(value: boolean): Promise<void> {
  const store = await getStore();
  await store.set(KEY_HIDE_TO_TRAY_ON_CLOSE, value);
  await store.save();
}

export async function saveAutoSyncNewScreenshots(value: boolean): Promise<void> {
  const store = await getStore();
  await store.set(KEY_AUTO_SYNC_NEW, value);
  await store.save();
}

export async function saveReviewBacklogOnLaunch(value: boolean): Promise<void> {
  const store = await getStore();
  await store.set(KEY_REVIEW_BACKLOG_ON_LAUNCH, value);
  await store.save();
}

function normalizeBool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}
