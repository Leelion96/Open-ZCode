import { SED_SAFE_FLAGS } from "./bash-readonly-policy-flags-text.js";

const SED_QUIET_FLAGS = new Set(["-n", "--quiet", "--silent"]);
const SED_ZERO_TERMINATED_FLAGS = new Set(["-z", "--zero-terminated"]);
const SED_PRINT_COMMAND = /^(?:[1-9]\d*(?:,[1-9]\d*)?)?p$/u;
const SED_UNSUPPORTED_SCRIPT_CHARACTERS = /[\p{Cc}\p{Zl}\p{Zp}]/u;
const SED_SUBSTITUTION_PREFIX = "s/";
const SED_SUBSTITUTION_FLAGS = /^[gpimIM]*[1-9]?[gpimIM]*$/u;
const SED_SUBSTITUTION_ESCAPES = new Set("/\\&123456789.^$*+?()[]{}|");
const SED_SUBSTITUTION_DELIMITERS = 2;

export function isSedInPlaceOption(word: string): boolean {
  return word.startsWith("-i") || word === "--in-place" || word.startsWith("--in-place=");
}

export function sedCommandIsDangerous(_commandText: string, args: readonly string[]): boolean {
  // 原先只排除 -i 和局部 w 语法，漏掉了脚本执行和替换写入；这里只接受完整的安全语法。
  // 复用 Bash AST 的 argv，避免再次拆分 shell 文本产生解析差异。
  let index = 0;
  let quiet = false;
  let zeroTerminated = false;
  for (; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--") {
      index += 1;
      break;
    }
    if (!arg.startsWith("-")) break;
    const flags = arg.startsWith("--") ? [arg] : [...arg.slice(1)].map((flag) => `-${flag}`);
    if (flags.length === 0 || flags.some((flag) => !Object.hasOwn(SED_SAFE_FLAGS, flag)))
      return true;
    quiet ||= flags.some((flag) => SED_QUIET_FLAGS.has(flag));
    zeroTerminated ||= flags.some((flag) => SED_ZERO_TERMINATED_FLAGS.has(flag));
  }

  const script = args[index];
  if (!script || SED_UNSUPPORTED_SCRIPT_CHARACTERS.test(script)) return true;
  const files = args.slice(index + 1);
  // GNU sed 会重排脚本后的选项；不能把后置 -e/-f/-i 当普通文件名跳过。
  if (files.some((file) => file.startsWith("-") && file !== "-")) return true;
  if (quiet && script.split(";").every((command) => SED_PRINT_COMMAND.test(command.trim()))) {
    return false;
  }
  return quiet || zeroTerminated || files.length > 0 || !isReadonlySedSubstitution(script);
}

function isReadonlySedSubstitution(script: string): boolean {
  if (!script.startsWith(SED_SUBSTITUTION_PREFIX) || script.includes(";")) return false;
  let delimiters = 0;
  let lastDelimiter = -1;
  for (let index = SED_SUBSTITUTION_PREFIX.length; index < script.length; index += 1) {
    const character = script[index];
    if (character === "\\") {
      index += 1;
      if (!SED_SUBSTITUTION_ESCAPES.has(script[index] ?? "")) return false;
    } else if (character === "/") {
      delimiters += 1;
      lastDelimiter = index;
    }
  }
  return (
    delimiters === SED_SUBSTITUTION_DELIMITERS &&
    SED_SUBSTITUTION_FLAGS.test(script.slice(lastDelimiter + 1))
  );
}

export function jqCommandIsDangerous(_commandText: string, args: readonly string[]): boolean {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (!arg) continue;
    if (isJqDangerousOption(arg)) return true;
    if (arg === "--") return jqFilterIsDangerous(args[index + 1] ?? "");
    if (arg === "--indent") {
      index += 1;
      continue;
    }
    if (arg.startsWith("-")) continue;
    return jqFilterIsDangerous(arg);
  }
  return false;
}

function isJqDangerousOption(word: string): boolean {
  return (
    word === "-f" ||
    word.startsWith("-f") ||
    word === "-L" ||
    word.startsWith("-L") ||
    word === "--argfile" ||
    word.startsWith("--argfile=") ||
    word === "--from-file" ||
    word.startsWith("--from-file=") ||
    word === "--library-path" ||
    word.startsWith("--library-path=") ||
    word === "--rawfile" ||
    word.startsWith("--rawfile=") ||
    word === "--run-tests" ||
    word.startsWith("--run-tests=") ||
    word === "--slurpfile" ||
    word.startsWith("--slurpfile=")
  );
}

function jqFilterIsDangerous(filter: string): boolean {
  return (
    /\$ENV\b/.test(filter) ||
    /(^|[^A-Za-z0-9_$.])env(?=$|[^A-Za-z0-9_])/.test(filter) ||
    /(^|[^A-Za-z0-9_])(?:include|import)(?=$|[^A-Za-z0-9_])/.test(filter)
  );
}

export function dateCommandIsDangerous(_commandText: string, args: readonly string[]): boolean {
  const valueFlags = new Set(["-d", "--date", "-r", "--reference", "--rfc-3339"]);
  for (let index = 0; index < args.length; ) {
    const arg = args[index] ?? "";
    if (arg.startsWith("--") && arg.includes("=")) {
      index += 1;
      continue;
    }
    if (arg.startsWith("-")) {
      index += valueFlags.has(arg) ? 2 : 1;
      continue;
    }
    if (!arg.startsWith("+")) return true;
    index += 1;
  }
  return false;
}

export function psCommandIsDangerous(_commandText: string, args: readonly string[]): boolean {
  return args.some((arg) => !arg.startsWith("-") && /^[a-zA-Z]*e[a-zA-Z]*$/.test(arg));
}

export function pyrightCommandIsDangerous(_commandText: string, args: readonly string[]): boolean {
  return args.some((arg) => arg === "--watch" || arg === "-w");
}

export function manCommandIsDangerous(_commandText: string, args: readonly string[]): boolean {
  const aproposFlags = new Set(["-k", "-f", "--apropos", "--whatis"]);
  const valueFlags = new Set(["-S", "-s"]);
  let isApropos = false;
  let afterDoubleDash = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (!afterDoubleDash && arg === "--") {
      afterDoubleDash = true;
      continue;
    }
    if (!afterDoubleDash && arg.startsWith("-") && arg !== "-") {
      if (aproposFlags.has(arg)) isApropos = true;
      if (valueFlags.has(arg)) index += 1;
      continue;
    }
    afterDoubleDash = true;
    if (arg.includes("/")) return !isApropos;
  }
  return false;
}

export function lsofCommandIsDangerous(_commandText: string, args: readonly string[]): boolean {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (arg === "+m" || arg.startsWith("+m")) return true;
    if (/^-[a-zA-Z]*i\S*@/.test(arg)) {
      const host = arg.slice(arg.indexOf("@") + 1).split(":")[0] ?? "";
      if (/[a-zA-Z]/.test(host)) return true;
    }
    if (/^-[a-zA-Z]*i$/.test(arg)) {
      const next = args[index + 1] ?? "";
      if (next.includes("@")) {
        const host = next.slice(next.indexOf("@") + 1).split(":")[0] ?? "";
        if (/[a-zA-Z]/.test(host)) return true;
      }
    }
  }
  return false;
}

const TPUT_DANGEROUS_CAPABILITIES = new Set([
  "clear",
  "flash",
  "if",
  "init",
  "iprog",
  "is1",
  "is2",
  "is3",
  "mc0",
  "mc4",
  "mc5",
  "mc5i",
  "mc5p",
  "pfkey",
  "pfloc",
  "pfx",
  "pfxl",
  "reset",
  "rf",
  "rmcup",
  "rs1",
  "rs2",
  "rs3",
  "smcup",
]);

export function tputCommandIsDangerous(_commandText: string, args: readonly string[]): boolean {
  let afterDoubleDash = false;
  for (let index = 0; index < args.length; ) {
    const arg = args[index] ?? "";
    if (arg === "--") {
      afterDoubleDash = true;
      index += 1;
      continue;
    }
    if (!afterDoubleDash && arg.startsWith("-")) {
      if (arg === "-S") return true;
      if (!arg.startsWith("--") && arg.length > 2 && arg.includes("S")) return true;
      index += arg === "-T" ? 2 : 1;
      continue;
    }
    if (TPUT_DANGEROUS_CAPABILITIES.has(arg)) return true;
    index += 1;
  }
  return false;
}

export function ssCommandIsDangerous(_commandText: string, args: readonly string[]): boolean {
  const keywords =
    /^(dst|src|dport|sport|and|or|not|eq|ne|ge|le|gt|lt|autobound|state|exclude|dev|fwmark|cgroup)$/;
  const valueKeywords = /^(state|exclude|dport|sport|dev|fwmark|cgroup)$/;
  const valueFlags = /^(-f|--family|-A|--query|--socket)$/;
  const positional: string[] = [];
  let afterDoubleDash = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (!afterDoubleDash && arg === "--") {
      afterDoubleDash = true;
      continue;
    }
    if (!afterDoubleDash && arg.startsWith("-")) {
      if (valueFlags.test(arg)) index += 1;
      continue;
    }
    positional.push(arg);
  }

  const tokens = positional
    .join(" ")
    .split(/[\s()=!<>&|,]+/)
    .filter(Boolean);
  let skipValue = false;
  for (const token of tokens) {
    if (skipValue) {
      skipValue = false;
      continue;
    }
    if (keywords.test(token)) {
      skipValue = valueKeywords.test(token);
      continue;
    }
    if (
      /[g-zG-Z]/.test(token) ||
      (/[a-fA-F]/.test(token) && (token.includes(".") || !token.includes(":")))
    )
      return true;
  }
  return false;
}

const TEST_NUMERIC_OPERATORS = new Set(["-eq", "-ne", "-lt", "-le", "-gt", "-ge"]);
const TEST_SAFE_NUMBER = /^-?(0[xX][0-9a-fA-F]+|[0-9]+#[0-9a-zA-Z]+|[0-9]+)$/;

export function testCommandIsDangerous(_commandText: string, args: readonly string[]): boolean {
  if (
    args.some(
      (arg) => arg === "-v" || arg === "-R" || arg === "-a" || arg === "-o" || /\[/.test(arg),
    )
  )
    return true;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (TEST_NUMERIC_OPERATORS.has(arg)) {
      for (const value of [args[index - 1], args[index + 1]]) {
        if (value !== undefined && !TEST_SAFE_NUMBER.test(value)) return true;
      }
    }
    if (arg === "-t") {
      const value = args[index + 1];
      if (value !== undefined && !TEST_SAFE_NUMBER.test(value)) return true;
    }
  }
  return false;
}

export const XARGS_TARGET_COMMANDS = new Set([
  "echo",
  "printf",
  "wc",
  "grep",
  "egrep",
  "fgrep",
  "head",
  "tail",
]);
const XARGS_VALUE_FLAGS = new Set(["-I", "-n", "-P", "-L", "-s", "-E", "-d"]);

export function xargsCommandIsDangerous(_commandText: string, args: readonly string[]): boolean {
  for (let index = 0; index < args.length; index += 1) {
    let arg = args[index] ?? "";
    if (!arg) continue;
    if (arg === "--" && index + 1 < args.length) {
      index += 1;
      arg = args[index] ?? "";
    }
    if (arg.startsWith("-") && arg !== "-") {
      if (XARGS_VALUE_FLAGS.has(arg)) index += 1;
      continue;
    }
    return !XARGS_TARGET_COMMANDS.has(arg);
  }
  return false;
}

export function ghCommandIsDangerous(_commandText: string, args: readonly string[]): boolean {
  for (const arg of args) {
    if (!arg) continue;
    let value = arg;
    if (arg.startsWith("-")) {
      const equalsIndex = arg.indexOf("=");
      if (equalsIndex === -1) continue;
      value = arg.slice(equalsIndex + 1);
      if (!value) continue;
    }
    if (!value.includes("/") && !value.includes("://") && !value.includes("@")) continue;
    if (value.includes("://") || value.includes("@")) return true;
    if ((value.match(/\//g) ?? []).length >= 2) return true;
  }
  return false;
}

const DOCKER_DANGEROUS_GLOBAL_FLAGS = [
  "-H",
  "-c",
  "--config",
  "--context",
  "--host",
  "--tlscacert",
  "--tlscert",
  "--tlskey",
];
const DOCKER_DANGEROUS_SHORT_FLAGS = new Set(
  DOCKER_DANGEROUS_GLOBAL_FLAGS.filter((flag) => flag.length === 2).map((flag) => flag[1]),
);

export function dockerCommandIsDangerous(_commandText: string, args: readonly string[]): boolean {
  return hasDangerousDockerOption(args);
}

export function hasDangerousDockerOption(args: readonly string[]): boolean {
  return args.some((arg) => {
    if (
      DOCKER_DANGEROUS_GLOBAL_FLAGS.some(
        (flag) =>
          arg === flag ||
          arg.startsWith(`${flag}=`) ||
          (flag.length === 2 && arg.length > 2 && arg.startsWith(flag)),
      )
    )
      return true;
    const shortFlags = arg.match(/^-([A-Za-z]+)/)?.[1];
    if (shortFlags !== undefined && shortFlags.length >= 2) {
      for (const flag of shortFlags) {
        if (DOCKER_DANGEROUS_SHORT_FLAGS.has(flag)) return true;
      }
    }
    return false;
  });
}

export * from "./bash-readonly-policy-git-callbacks.js";
