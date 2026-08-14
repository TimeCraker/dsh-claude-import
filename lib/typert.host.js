/* dsh-claude-import 的 Typert 宿主面（手工维护，勿依赖生成器）。 */
import { z } from "zod";

const selections$schema = z.object({
  skills: z.boolean(),
  rules: z.boolean(),
  commands: z.boolean(),
  claudeMd: z.boolean(),
  agentsMd: z.boolean(),
});

const strategies$schema = z.record(z.string(), z.enum(["overwrite", "merge", "skip"]));

const preview_input$schema = z.object({
  workspace: z.string().nullable(),
  selections: selections$schema,
  strategies: strategies$schema.optional(),
});

const preview_item$schema = z.object({
  key: z.string(),
  kind: z.enum(["skills", "rules", "commands", "claudeMd", "agentsMd"]),
  scope: z.enum(["user", "project"]),
  source: z.string(),
  target: z.string(),
  blockId: z.string().optional(),
  status: z.enum([
    "new",
    "identical",
    "conflict",
    "empty",
    "unsupported",
    "present-unmarked",
    "updated",
    "unclosed",
  ]),
  strategy: z.enum(["overwrite", "merge", "skip"]),
  summary: z.string(),
  files: z.number().optional(),
  bytes: z.number().optional(),
});

const preview_result$schema = z.object({
  destinations: z.object({
    userSkillsDir: z.string(),
    projectSkillsDir: z.string().nullable(),
    userInstructionFile: z.string(),
    projectInstructionFile: z.string().nullable(),
  }),
  items: z.array(preview_item$schema),
});

const execute_input$schema = z.object({
  workspace: z.string().nullable(),
  selections: selections$schema,
  strategies: strategies$schema,
});

const execute_result_item$schema = z.object({
  key: z.string(),
  status: z.enum(["imported", "skipped", "identical", "unsupported", "error"]),
  message: z.string(),
  files: z.number().optional(),
  bytes: z.number().optional(),
});

const execute_result$schema = z.object({
  results: z.array(execute_result_item$schema),
});

export const TYPERT = {
  package: "dsh-claude-import",
  face: "host",
  schemas: [],
  invocations: [
    {
      id: "dsh-claude-import#claudeImport/preview",
      service: "claudeImport",
      namespace: "claudeImport",
      method: "preview",
      invocation: { kind: "direct" },
      parameters: [
        {
          name: "input",
          wire: "input",
          source: "json",
          codec: {
            mode: "strict",
            typeSymbol: "dsh-claude-import#claudeImport/preview:input",
            schema: preview_input$schema,
          },
        },
      ],
      cancellation: { parameter: "signal" },
      result: {
        mode: "strict",
        typeSymbol: "dsh-claude-import#claudeImport/preview:result",
        schema: preview_result$schema,
      },
      sourceLocation: { file: "dsh-claude-import/lib/index.js", line: 1, column: 1 },
    },
    {
      id: "dsh-claude-import#claudeImport/execute",
      service: "claudeImport",
      namespace: "claudeImport",
      method: "execute",
      invocation: { kind: "direct" },
      parameters: [
        {
          name: "input",
          wire: "input",
          source: "json",
          codec: {
            mode: "strict",
            typeSymbol: "dsh-claude-import#claudeImport/execute:input",
            schema: execute_input$schema,
          },
        },
      ],
      cancellation: { parameter: "signal" },
      result: {
        mode: "strict",
        typeSymbol: "dsh-claude-import#claudeImport/execute:result",
        schema: execute_result$schema,
      },
      sourceLocation: { file: "dsh-claude-import/lib/index.js", line: 1, column: 1 },
    },
  ],
  model: {
    services: [
      {
        key: "claudeImport",
        exportName: "ClaudeImportService",
        description: "把 Claude Code 配置（skills / rules / CLAUDE.md / AGENTS.md）导入 DSH 对应落点。",
        summary: "Claude Code 配置导入。",
        tags: [],
        jsDoc: "/**\n * Claude Code 配置导入服务。\n * @typert service claudeImport\n */",
        members: [
          {
            kind: "method",
            name: "preview",
            signature: "@Remote preview(input: ClaudeImportRequest): Promise<ClaudeImportPreview>",
            summary: "规划一次导入：枚举选中资产、计算目标状态，不写盘。",
            jsDoc: "/**\n * 规划一次导入：枚举选中资产、计算目标状态，不写盘。\n * @param input - 工作区、资产勾选与策略。\n * @returns 落点与逐项状态。\n */",
          },
          {
            kind: "method",
            name: "execute",
            signature: "@Remote execute(input: ClaudeImportRequest, signal: AbortSignal): Promise<ClaudeImportResult>",
            summary: "执行导入：逐项落地并返回逐项结果。",
            jsDoc: "/**\n * 执行导入：逐项落地并返回逐项结果。\n * @param input - 工作区、资产勾选与策略。\n * @param signal - 取消信号。\n * @returns 逐项结果。\n */",
          },
        ],
        types: [],
      },
    ],
    events: [],
    objects: [],
  },
};
