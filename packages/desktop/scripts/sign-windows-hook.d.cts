declare function sign(configuration: { path: string; isNest?: boolean }): Promise<void>;

declare namespace sign {
  /**
   * 判断文件是否为 Windows PE（MZ 魔数）。
   * 仅在成功读取且确认非 MZ 时返回 false（含不足 2 字节的短文件）；
   * 打开/读取失败会抛错，由调用方 fail-closed（评审 CR-01）。
   */
  function isWindowsPortableExecutable(filePath: string): Promise<boolean>;
}

export = sign;
