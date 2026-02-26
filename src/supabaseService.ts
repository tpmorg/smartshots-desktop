import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { openUrl } from '@tauri-apps/plugin-opener';
import { basename } from '@tauri-apps/api/path';
import { readFile } from '@tauri-apps/plugin-fs';
import imageCompression from 'browser-image-compression';
import { config } from './env';

export type AuthChangeHandler = (isAuthenticated: boolean) => void;

export class SupabaseService {
  private supabase: SupabaseClient;
  private authHandlers = new Set<AuthChangeHandler>();

  constructor() {
    this.supabase = createClient(config.supabaseUrl, config.supabaseAnonKey, {
      auth: {
        detectSessionInUrl: false,
        persistSession: true,
        autoRefreshToken: true
      }
    });

    this.supabase.auth.onAuthStateChange((_event, session) => {
      const authed = Boolean(session?.access_token);
      this.authHandlers.forEach((handler) => handler(authed));
    });
  }

  onAuthenticationStateChanged(handler: AuthChangeHandler): () => void {
    this.authHandlers.add(handler);
    return () => this.authHandlers.delete(handler);
  }

  async isAuthenticated(): Promise<boolean> {
    const { data } = await this.supabase.auth.getSession();
    return Boolean(data.session?.access_token);
  }

  async beginOAuthSignIn(): Promise<void> {
    return this.beginOAuthSignInWithRedirect(config.oauthRedirect);
  }

  async beginOAuthSignInWithRedirect(redirectTo: string): Promise<void> {
    const { data, error } = await this.supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo,
        skipBrowserRedirect: true,
        queryParams: {
          access_type: 'offline',
          prompt: 'consent'
        }
      }
    });

    if (error) {
      throw error;
    }

    if (!data.url) {
      throw new Error('OAuth URL was not returned by Supabase');
    }

    await openUrl(data.url);
  }

  async handleAuthCallback(url: string): Promise<boolean> {
    try {
      const callbackUrl = new URL(url);
      const code = callbackUrl.searchParams.get('code');

      if (code) {
        const { error } = await this.supabase.auth.exchangeCodeForSession(code);
        return !error;
      }

      const fragment = callbackUrl.hash.replace(/^#/, '');
      const params = new URLSearchParams(fragment);

      const accessToken = params.get('access_token');
      const refreshToken = params.get('refresh_token') ?? '';

      if (!accessToken) {
        return false;
      }

      const { error } = await this.supabase.auth.setSession({
        access_token: accessToken,
        refresh_token: refreshToken
      });

      return !error;
    } catch {
      return false;
    }
  }

  async signOut(): Promise<void> {
    const { error } = await this.supabase.auth.signOut();
    if (error) {
      throw error;
    }
  }

  async uploadScreenshot(filePath: string): Promise<void> {
    const { data } = await this.supabase.auth.getSession();
    const session = data.session;

    if (!session?.user) {
      throw new Error('Not authenticated');
    }

    const sourceBytes = await readFile(filePath);
    const fileName = await basename(filePath);

    const originalExtension = getExtension(fileName);
    const originalType = guessContentType(fileName);
    const sourceBlob = new Blob([sourceBytes], { type: originalType });
    const sourceFile = new File([sourceBlob], fileName, { type: sourceBlob.type });

    const compressed = await imageCompression(sourceFile, {
      maxSizeMB: 2,
      maxWidthOrHeight: 2560,
      useWebWorker: true,
      initialQuality: 0.85
    });

    const storagePath = `${Date.now()}-${randomBase36(8)}.${originalExtension}`;
    const uploadType = compressed.type || originalType || 'application/octet-stream';

    const { error } = await this.supabase.storage.from(config.supabaseBucket).upload(storagePath, compressed, {
      contentType: uploadType,
      upsert: false,
      cacheControl: '3600'
    });

    if (error) {
      throw error;
    }
  }
}

function guessContentType(name: string): string {
  const lower = name.toLowerCase();
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpeg') || lower.endsWith('.jpg')) return 'image/jpeg';
  if (lower.endsWith('.webp')) return 'image/webp';
  return 'application/octet-stream';
}

function getExtension(name: string): string {
  const idx = name.lastIndexOf('.');
  if (idx < 0 || idx === name.length - 1) {
    return 'bin';
  }
  return name.slice(idx + 1).toLowerCase();
}

function randomBase36(length: number): string {
  let out = '';
  while (out.length < length) {
    out += Math.random().toString(36).slice(2);
  }
  return out.slice(0, length);
}
