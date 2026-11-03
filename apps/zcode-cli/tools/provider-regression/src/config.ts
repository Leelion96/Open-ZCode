import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  ModelConfigRules,
  ProviderConfigMap,
  ProviderConfigResolver,
  ProviderRegistry,
  parsePersonalProviderConfigMap,
  parsePersonalModelConfigRules,
} from "@zcode/provider";
import { decodeZCodeBuiltinRelease } from "@zcode/provider-node";

const nonempty = z.string().trim().min(1);
const ids = z
  .array(nonempty)
  .min(1)
  .refine((v) => new Set(v).size === v.length, "重复标识");
const providerFileSchema = z
  .object({
    builtinFile: nonempty,
    providerRules: z.array(z.unknown()).min(1),
    modelConfigRules: z.unknown().optional(),
  })
  .strict();
const mediaSchema = z
  .object({ path: nonempty, mediaType: nonempty, prompt: nonempty, expected: nonempty })
  .strict();
const parallelism = z.number().int().positive().safe();
const providerConcurrency = z
  .object({ models: parallelism.optional(), cases: parallelism.optional() })
  .strict();
export const listSchema = z
  .object({
    targets: z
      .array(
        z
          .object({
            providerId: nonempty,
            modelIds: ids,
            concurrency: providerConcurrency.optional(),
          })
          .strict(),
      )
      .min(1)
      .refine(
        (targets) => new Set(targets.map((target) => target.providerId)).size === targets.length,
        "重复 Provider，请合并 modelIds",
      ),
    concurrency: z
      .object({
        providers: parallelism.default(1),
        models: parallelism.default(1),
        cases: parallelism.default(1),
      })
      .strict()
      .prefault({}),
    caseIds: ids.default(["*"]),
    repetitions: z.number().int().min(1).max(10).default(1),
    maxOutputTokens: z.number().int().positive().safe().optional(),
    timeoutMs: z.number().int().min(100).max(600000).default(120000),
    fixtures: z
      .object({
        image: mediaSchema.optional(),
        video: mediaSchema.optional(),
        audio: mediaSchema.optional(),
        pdf: mediaSchema.optional(),
      })
      .strict()
      .default({}),
  })
  .strict();
export type TestList = z.infer<typeof listSchema>;
export type MediaFixture = z.infer<typeof mediaSchema>;
export const hash = (value: string) => createHash("sha256").update(value).digest("hex");

export async function loadConfiguration(providersFile: string, listFile: string) {
  const [providerText, listText] = await Promise.all([
    readFile(providersFile, "utf8"),
    readFile(listFile, "utf8"),
  ]);
  const config = providerFileSchema.parse(JSON.parse(providerText));
  const list = listSchema.parse(JSON.parse(listText));
  const builtinText = await readFile(resolve(dirname(providersFile), config.builtinFile), "utf8");
  const builtin = decodeZCodeBuiltinRelease(JSON.parse(builtinText));
  const original = parsePersonalProviderConfigMap({ providerRules: config.providerRules });
  const missingKeys = new Set<string>();
  const secrets: string[] = [];
  const rules = original.toJSON().map((rule) => {
    const access = rule.config.access;
    if (access?.type === "zhipu-account") throw new Error("此测试入口只支持 API Key Provider");
    const key = access?.apiKey?.trim();
    if (key) secrets.push(key);
    else missingKeys.add(rule.providerId);
    for (const value of Object.values(rule.config.api?.headers ?? {}))
      if (value) secrets.push(value);
    // 缺 Key 仍需解析能力以生成未测清单；占位值绝不进入请求，执行前检查 missingKeys。
    return {
      ...rule,
      config: {
        ...rule.config,
        access: {
          ...access,
          type: access?.type ?? "api-key",
          apiKey: key || "regression-missing-key",
        },
      },
    };
  });
  const resolution = new ProviderConfigResolver().resolve({
    zcodeBuiltinProviders: ProviderConfigMap.empty(),
    zcodeBuiltinProviderTemplates: builtin.config.providerTemplates,
    zcodeBuiltinModelRules: builtin.config.modelConfigRules,
    personalProviders: parsePersonalProviderConfigMap({ providerRules: rules }),
    personalModels:
      config.modelConfigRules === undefined
        ? ModelConfigRules.empty()
        : parsePersonalModelConfigRules(config.modelConfigRules),
    accountProviders: ProviderConfigMap.empty(),
  });
  if (resolution.issues.length)
    throw new Error(
      `Provider 配置不完整：${resolution.issues.map((i) => i.path.join(".")).join(", ")}`,
    );
  const registry = new ProviderRegistry(resolution.registryProviders);
  const targets = list.targets.flatMap((target) => {
    const provider = registry.getProvider(target.providerId);
    if (!provider) throw new Error("测试清单引用了不存在或未启用的 Provider");
    if (target.modelIds.includes("*") && target.modelIds.length !== 1)
      throw new Error("* 不可与具体模型混用");
    const models =
      target.modelIds[0] === "*"
        ? provider.models
        : target.modelIds.map((id) => {
            const model = registry.getModel(target.providerId, id);
            if (!model) throw new Error("测试清单引用了不存在的模型");
            return model;
          });
    return models.map((model) => ({ provider, model }));
  });
  if (
    new Set(targets.map((t) => JSON.stringify([t.provider.providerId, t.model.modelId]))).size !==
    targets.length
  )
    throw new Error("测试清单重复选择了同一模型");
  if (!targets.length) throw new Error("测试清单没有模型");
  return {
    targets,
    registry,
    list,
    missingKeys,
    secrets,
    fixtureDir: dirname(resolve(listFile)),
    revision: builtin.revision,
    configHash: hash(providerText + builtinText),
    listHash: hash(listText),
  };
}
