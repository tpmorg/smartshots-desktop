export const config = {
  supabaseUrl: import.meta.env.VITE_SUPABASE_URL as string,
  supabaseAnonKey: import.meta.env.VITE_SUPABASE_ANON_KEY as string,
  supabaseBucket: (import.meta.env.VITE_SUPABASE_BUCKET as string) || 'screenshots',
  apiBaseUrl: (import.meta.env.VITE_API_BASE_URL as string) || 'https://www.smartshotsai.com',
  oauthRedirect: (import.meta.env.VITE_OAUTH_REDIRECT as string) || 'smartshots://auth/callback'
};

export function assertEnv(): void {
  if (!config.supabaseUrl || !config.supabaseAnonKey) {
    throw new Error('Missing required VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY');
  }
}
