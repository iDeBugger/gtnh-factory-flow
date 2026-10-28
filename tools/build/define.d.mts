export declare function clientDefines(
  env: Record<string, string | undefined>,
  options?: { mode?: string },
): Record<string, string>;
export declare function serverDefines(
  env: Record<string, string | undefined>,
): Record<string, string>;
export declare const CLIENT_ENV_NAMES: string[];
