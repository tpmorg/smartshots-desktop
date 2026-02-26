# Smartshots Desktop (Tauri)

Cross-platform system tray app for macOS (Sonoma+) and Windows (10/11) that:

1. Authenticates users with Supabase OAuth (Google + PKCE via browser)
2. Watches platform default screenshot folders
3. Compresses screenshots
4. Uploads to Supabase Storage (`screenshots` bucket) with filename pattern: `<Date.now()>-<randomBase36>.<originalExtension>`

## Quick start

```bash
npm install
cp .env.example .env
# fill in VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY
npm run tauri:dev
```

## Current architecture

- `src-tauri/src/main.rs`: tray menu + screenshot-folder watcher + event emission
- `src/supabaseService.ts`: auth callback/session handling + compression + storage upload
- `src/main.ts`: UI wiring, deep-link callback subscription, watcher control

## OAuth callback setup

In Supabase OAuth provider settings, add:

- `smartshots://auth/callback`
- `http://127.0.0.1:38965/auth/callback`

In app config, the same redirect is set via `VITE_OAUTH_REDIRECT`.
The app currently uses a local loopback callback (`http://127.0.0.1:38965/auth/callback`) for reliable desktop OAuth handling in development and packaged builds.

## Notes on installer onboarding

Native installer-time auth flows are possible but brittle and platform-specific. The recommended implementation is first-run onboarding immediately after install, which preserves the same UX with lower packaging risk.

## Next build steps

- Persist watcher + notification preferences
- Add offline queue/retry for uploads
- Add signed/notarized installer pipeline for macOS + Windows
