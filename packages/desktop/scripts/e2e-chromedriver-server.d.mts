export function resolveE2EChromedriverExecutable(options: {
  electronVersion: string;
  cacheDir: string;
  explicitPath?: string;
}): string;

export function startE2EChromedriverServer(options: {
  executablePath: string;
  prefixArgs?: string[];
  logPath: string;
  timeoutMs?: number;
}): Promise<{ hostname: string; port: number; stop(): Promise<void> }>;
