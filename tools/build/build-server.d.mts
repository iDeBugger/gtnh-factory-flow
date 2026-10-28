export declare const ENTRY_SOURCE: string;
export declare function writeEntry(outDir: string): void;
export declare function buildServer(options?: {
  root?: string;
  outDir?: string;
  env?: Record<string, string | undefined>;
}): Promise<void>;
export declare function serverEnv(
  clientDir: string,
  env: Record<string, string | undefined>,
): Record<string, string | undefined>;
