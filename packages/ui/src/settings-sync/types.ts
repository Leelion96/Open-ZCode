import type {
  SettingsSyncAgent,
  SettingsSyncCategory,
  SettingsSyncDiscoveryResult,
  SettingsSyncImportResult,
} from "@zcode/shared";

export type SettingsSyncUiStep = "selection" | "importing" | "complete";

export interface SettingsSyncUiTask {
  id: string;
  agent: SettingsSyncAgent;
  category: SettingsSyncCategory;
  discoveredCount: number;
  status: "pending" | "running" | "success" | "skipped" | "failed";
}

export interface SettingsSyncUiState {
  open: boolean;
  loading: boolean;
  importing: boolean;
  step: SettingsSyncUiStep;
  discovery: SettingsSyncDiscoveryResult | null;
  selectedKeys: string[];
  tasks: SettingsSyncUiTask[];
  result: SettingsSyncImportResult | null;
  /** 没有打开项目时，需要项目才能导入、因此记为失败的条目数。 */
  workspaceRequiredCount: number;
  error: string | null;
}
