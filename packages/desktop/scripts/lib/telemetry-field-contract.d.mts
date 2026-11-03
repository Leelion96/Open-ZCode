export interface TelemetryFieldAudit {
  errors: string[];
  additions: Array<{
    event: string;
    field: string;
    status: "unverified" | "verified" | "merged" | "deferred";
    evidence?: { commit: string; source: string; document: string };
    reason?: string;
  }>;
}

export function auditTelemetryFields(options: {
  records: readonly Record<string, unknown>[];
  contractPath?: string;
  repoRoot?: string;
  artifactDir?: string;
  sync?: boolean;
}): Promise<TelemetryFieldAudit>;
