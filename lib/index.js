/**
 * dsh-claude-import 宿主插件：提供 `claudeImport` 服务，把 Claude Code 配置
 * （skills / rules / CLAUDE.md / AGENTS.md）导入 DSH 对应落点。
 *
 * 远程方法（经 Typert 网关暴露给浏览器端）：
 * - preview(input, signal)：只读规划，返回落点与逐项状态（不写盘）
 * - execute(input, signal)：按逐项策略执行导入，返回逐项结果
 *
 * 本模块是「稳定薄壳」：真正的导入逻辑在 lib/import-logic.js，每次 RPC
 * 调用都用带缓存戳的 URL 动态导入，因此修改逻辑文件后下一次调用即生效，
 * 无需重启宿主进程（web profile 的模块级 HMR 是关闭的，这是本机开发期
 * 的唯一热更新通道）。
 * @module dsh-claude-import
 */
import { TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import z from "@deepseek-ai/schemastery";

/** 宿主插件配置：三个涉及目录，缺省按本机惯例推导。 */
const Config = z.object({
  claudeHome: z.string().default(resolve(homedir(), ".claude")),
  agentsHome: z.string().default(resolve(homedir(), ".agents")),
  dshHome: z.string().default(process.env.DSH_HOME ?? resolve(homedir(), ".dsh")),
  home: z.string().default(homedir()),
});

/** 服务名（也是 Typert namespace 与网关 ctx.get 键）。 */
const SERVICE_NAME = "claudeImport";

/** 每次调用都以新缓存戳加载逻辑模块，保证最新代码生效。 */
async function loadLogic() {
  const url = `${pathToFileURL(resolve(import.meta.dirname, "import-logic.js")).href}?dsh-claude-import=${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
  return await import(url);
}

/**
 * Claude 配置导入服务。
 * @typert service claudeImport
 */
class ClaudeImportService extends TypertRemoteService {
  static Config = Config;

  config;

  constructor(ctx, config) {
    super(ctx, SERVICE_NAME);
    this.config = config;
  }

  /**
   * 规划一次导入：枚举选中资产、计算目标状态与推荐摘要，不写盘。
   * @param input - `{ workspace, selections, strategies }`。
   * @param signal - 取消信号。
   * @returns `{ destinations, items }`。
   */
  async preview(input, signal) {
    const logic = await loadLogic();
    return await logic.planImport(this.config, input, signal);
  }

  /**
   * 执行导入：重新规划后逐项落地，返回逐项结果。
   * @param input - `{ workspace, selections, strategies }`。
   * @param signal - 取消信号。
   * @returns `{ results }`。
   */
  async execute(input, signal) {
    const logic = await loadLogic();
    return await logic.executeImport(this.config, input, signal);
  }
}

export { ClaudeImportService, Config, SERVICE_NAME, ClaudeImportService as default };
