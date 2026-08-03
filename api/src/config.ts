export interface Config {
  port: number;
  host: string;
  databaseUrl: string;
  cookieName: string;
  secureCookies: boolean;
  logLevel: string;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing required environment variable ${name}`);
  return value;
}

export function loadConfig(): Config {
  return {
    port: Number(process.env.PORT ?? 8080),
    host: process.env.HOST ?? '0.0.0.0',
    databaseUrl: required('DATABASE_URL'),
    cookieName: process.env.SESSION_COOKIE_NAME ?? 'crm_session',
    // Cookies are Secure unless explicitly running plain HTTP for local dev.
    secureCookies: process.env.INSECURE_COOKIES !== 'true',
    logLevel: process.env.LOG_LEVEL ?? 'info',
  };
}
