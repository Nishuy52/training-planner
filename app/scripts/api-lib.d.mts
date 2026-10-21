export type ApiConfig = { appUrl: string; clientId: string; clientSecret: string };
export declare function parseEnvFile(text: string): Record<string, string>;
export declare function resolveConfig(env: Record<string, string | undefined>, fileVars?: Record<string, string>): ApiConfig;
export declare function normalizePath(p: string): string;
export declare function buildRequest(
  method: string,
  path: string,
  body: string | undefined,
  config: ApiConfig,
): { url: string; init: { method: string; headers: Record<string, string>; redirect: 'manual'; body?: string } };
export declare function redact(text: string, secrets: Array<string | undefined>): string;
