import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
export const secret = "fixture-private-api-key";
export const architectureAnswer = [
  "目标与边界",
  "组件与数据",
  "状态与时序",
  "故障推演",
  "方案取舍",
  "验证与运维",
]
  .map(
    (title, i) =>
      `## ${i + 1}. ${title}\n${"任务状态由数据库持有，投递允许重复，写入用版本校验，外部结果未知时进入对账流程。".repeat(6)}`,
  )
  .join("\n\n");
export async function fixture(apiType = "openai-chat-completions") {
  const dir = await mkdtemp(join(tmpdir(), "provider-regression-"));
  const release = {
    schemaVersion: 1,
    revision: 1,
    config: {
      providerConfigRules: {
        templateRules: [
          {
            templateId: "example",
            templateNameMap: { "en-US": "Example" },
            config: {
              api: { type: apiType, baseUrl: "https://provider.example.com/v1" },
              access: { type: "api-key" },
              builtinModelIds: ["model-a"],
            },
          },
        ],
        providerRules: [],
      },
      modelConfigRules: {
        modelRules: [
          {
            modelMatch: ".*",
            config: {
              enabled: true,
              properties: {
                requiresMfjsToolSchema: false,
                contextWindow: 32000,
                inputFormat: {
                  supportsText: true,
                  supportsImage: false,
                  supportsVideo: false,
                  supportsAudio: false,
                  supportsPdf: false,
                },
                outputFormat: { supportsText: true },
                supportsToolCall: true,
                supportsJsonSchemaOutput: false,
                supportsNativeWebSearch: false,
                supportsMidConversationSystem: true,
              },
              optionSpecs: {
                reasoningLevel: {
                  values: ["low", "high"],
                  map: '{"reasoning_effort": reasoningLevel}',
                },
                maxOutputTokens: { max: 8192, map: '{"max_tokens": maxOutputTokens}' },
              },
            },
          },
        ],
        modelApiRules: [],
        providerSiteRules: [],
        templateModelRules: [],
        builtinProviderModelRules: [],
      },
    },
  };
  await writeFile(join(dir, "builtin.json"), JSON.stringify(release));
  await writeFile(
    join(dir, "providers.json"),
    JSON.stringify({
      builtinFile: "builtin.json",
      providerRules: [
        {
          providerId: "test-a",
          templateId: "example",
          config: { group: "standard-personal", access: { type: "api-key", apiKey: secret } },
        },
      ],
    }),
  );
  const list = {
    targets: [{ providerId: "test-a", modelIds: ["*"] }],
    caseIds: ["REASON-001"],
    repetitions: 3,
    maxOutputTokens: 1024,
    timeoutMs: 2000,
  };
  await writeFile(join(dir, "list.json"), JSON.stringify(list));
  return {
    dir,
    list,
    options: {
      providersFile: join(dir, "providers.json"),
      listFile: join(dir, "list.json"),
      outputDir: join(dir, "report"),
    },
  };
}
export function chatResponse(reasoningTokens?: number, finish = "stop") {
  const payloads = [
    {
      choices: [
        {
          index: 0,
          delta: { role: "assistant", reasoning_content: "思考😀" },
          finish_reason: null,
        },
      ],
    },
    { choices: [{ index: 0, delta: { content: architectureAnswer }, finish_reason: null }] },
    {
      choices: [{ index: 0, delta: {}, finish_reason: finish }],
      usage: {
        prompt_tokens: 20,
        completion_tokens: 25,
        ...(reasoningTokens === undefined
          ? {}
          : { completion_tokens_details: { reasoning_tokens: reasoningTokens } }),
      },
    },
  ];
  return new Response(
    payloads
      .map(
        (p) =>
          `data: ${JSON.stringify({ id: "test", object: "chat.completion.chunk", created: 1, model: "model-a", ...p })}\n\n`,
      )
      .join("") + "data: [DONE]\n\n",
    { headers: { "content-type": "text/event-stream" } },
  );
}
