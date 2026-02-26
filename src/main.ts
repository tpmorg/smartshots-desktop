import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { isPermissionGranted, requestPermission, sendNotification } from '@tauri-apps/plugin-notification';
import { getCurrent, onOpenUrl } from '@tauri-apps/plugin-deep-link';
import { assertEnv } from './env';
import { SupabaseService } from './supabaseService';

type WatcherEventPayload = {
  path: string;
};

type OAuthCallbackPayload = {
  url: string;
};

const authStatus = document.querySelector<HTMLParagraphElement>('#auth-status')!;
const watcherStatus = document.querySelector<HTMLParagraphElement>('#watcher-status')!;
const uploadStatus = document.querySelector<HTMLParagraphElement>('#upload-status')!;
const dirsList = document.querySelector<HTMLUListElement>('#dirs-list')!;
const signinBtn = document.querySelector<HTMLButtonElement>('#signin-btn')!;
const signoutBtn = document.querySelector<HTMLButtonElement>('#signout-btn')!;
const callbackUrlInput = document.querySelector<HTMLInputElement>('#callback-url-input')!;
const applyCallbackBtn = document.querySelector<HTMLButtonElement>('#apply-callback-btn')!;
const watcherBtn = document.querySelector<HTMLButtonElement>('#watcher-btn')!;
const notificationsToggle = document.querySelector<HTMLInputElement>('#notifications-toggle')!;

assertEnv();
const supabase = new SupabaseService();
let watcherRunning = false;
let notificationsEnabled = false;

async function init(): Promise<void> {
  const dirs = await invoke<string[]>('get_default_screenshot_dirs');
  dirs.forEach((dir) => {
    const li = document.createElement('li');
    li.textContent = dir;
    dirsList.appendChild(li);
  });

  const authed = await supabase.isAuthenticated();
  updateAuthUI(authed);

  supabase.onAuthenticationStateChanged((isAuthenticated) => {
    updateAuthUI(isAuthenticated);
  });

  await onOpenUrl(async (urls) => {
    const [url] = urls;
    await handleIncomingAuthUrl(url);
  });

  const currentUrls = await getCurrent();
  if (currentUrls && currentUrls.length > 0) {
    await handleIncomingAuthUrl(currentUrls[0]);
  }

  await listen<OAuthCallbackPayload>('oauth-callback-url', async (event) => {
    await handleIncomingAuthUrl(event.payload.url);
  });

  await listenForScreenshots();
}

function updateAuthUI(authed: boolean): void {
  authStatus.textContent = authed ? 'Auth: signed in' : 'Auth: signed out';
  signinBtn.disabled = authed;
  signoutBtn.disabled = !authed;
}

signinBtn.addEventListener('click', async () => {
  authStatus.textContent = 'Auth: opening browser... if callback does not return, paste URL below.';
  try {
    const redirectTo = await invoke<string>('get_oauth_redirect_url');
    await supabase.beginOAuthSignInWithRedirect(redirectTo);
  } catch (error) {
    authStatus.textContent = `Auth: failed (${String(error)})`;
  }
});

signoutBtn.addEventListener('click', async () => {
  try {
    await supabase.signOut();
    updateAuthUI(false);
  } catch (error) {
    authStatus.textContent = `Auth: sign-out failed (${String(error)})`;
  }
});

applyCallbackBtn.addEventListener('click', async () => {
  await handleIncomingAuthUrl(callbackUrlInput.value.trim());
});

watcherBtn.addEventListener('click', async () => {
  try {
    if (!watcherRunning) {
      await invoke('start_screenshot_watcher');
      watcherRunning = true;
      watcherStatus.textContent = 'Watcher: running';
      watcherBtn.textContent = 'Stop watcher';
    } else {
      await invoke('stop_screenshot_watcher');
      watcherRunning = false;
      watcherStatus.textContent = 'Watcher: stopped';
      watcherBtn.textContent = 'Start watcher';
    }
  } catch (error) {
    watcherStatus.textContent = `Watcher: error (${String(error)})`;
  }
});

notificationsToggle.addEventListener('change', async () => {
  if (notificationsToggle.checked) {
    let permissionGranted = await isPermissionGranted();
    if (!permissionGranted) {
      const permission = await requestPermission();
      permissionGranted = permission === 'granted';
    }

    notificationsEnabled = permissionGranted;
    notificationsToggle.checked = permissionGranted;
  } else {
    notificationsEnabled = false;
  }
});

async function listenForScreenshots(): Promise<void> {
  const unlisten = await listen<WatcherEventPayload>('screenshot-created', async (event) => {
    const filePath = event.payload.path;
    uploadStatus.textContent = `Uploads: processing ${filePath}`;

    try {
      await supabase.uploadScreenshot(filePath);
      uploadStatus.textContent = `Uploads: uploaded ${filePath}`;

      if (notificationsEnabled) {
        await sendNotification({
          title: 'Smartshots',
          body: 'Screenshot uploaded successfully.'
        });
      }
    } catch (error) {
      uploadStatus.textContent = `Uploads: failed (${String(error)})`;

      if (notificationsEnabled) {
        await sendNotification({
          title: 'Smartshots',
          body: 'Screenshot upload failed. Open app for details.'
        });
      }
    }
  });

  window.addEventListener('beforeunload', () => {
    unlisten();
  });
}

void init();

async function handleIncomingAuthUrl(url: string | undefined): Promise<void> {
  if (!url) return;
  const ok = await supabase.handleAuthCallback(url);
  authStatus.textContent = ok ? 'Auth: signed in' : 'Auth: callback failed';
}
