import { createContext, useContext, type ReactNode } from "react";
import type { SettingsScopeDevice } from "@/settings-scope/contract.js";

interface SettingsScopeDeviceContextValue {
  device: SettingsScopeDevice;
  /** 该设备是否有「用户」（旧格式远端、Direct URL、Web / 手机上的远端没有）。 */
  userAvailable: boolean;
}

const SettingsScopeDeviceContext = createContext<SettingsScopeDeviceContextValue>({
  device: { kind: "local" },
  userAvailable: true,
});

/**
 * 编辑表单内的作用域菜单只列出所在分区当前设备的「用户」和项目：
 * 表单的写入目标由分区按「同一设备」解析，不能在表单里跨设备切换。
 */
export function SettingsScopeDeviceProvider({
  device,
  userAvailable = true,
  children,
}: {
  device: SettingsScopeDevice;
  userAvailable?: boolean;
  children?: ReactNode;
}) {
  return (
    <SettingsScopeDeviceContext.Provider value={{ device, userAvailable }}>
      {children}
    </SettingsScopeDeviceContext.Provider>
  );
}

export function useSettingsScopeDevice(): SettingsScopeDeviceContextValue {
  return useContext(SettingsScopeDeviceContext);
}
