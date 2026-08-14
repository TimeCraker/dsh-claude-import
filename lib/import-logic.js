/**
 * dsh-claude-import 核心导入逻辑（纯函数模块）。
 *
 * 与 DSH 运行时解耦：所有文件系统扫描、冲突判定、块级合并与幂等逻辑都在
 * 这里实现，宿主插件（lib/index.js）只做薄薄的 RPC 转发。这样本模块可以
 * 在挂载进 DSH 之前用纯 Node 脚本独立测试。
 *
 * 落点约定：
 * - 用户级 skills：  `~/.claude/skills/<name>`   → `~/.agents/skills/<name>`
 * - 项目级 skills：  `<ws>/.claude/skills/<name>` → `<ws>/.agents/skills/<name>`
 * - 用户级指令文本：~/.claude/{CLAUDE.md,AGENTS.md,rules/*.md} → 以带标记的
 *   块合并进 `~/.dsh/AGENTS.md`（dsh-agent-instructions 的用户级指令文件）
 * - 项目级指令文本：<ws>/.claude/{CLAUDE.md,AGENTS.md,rules/*.md} → 以带标记的
 *   块合并进 `<ws>/AGENTS.md`（官方项目级候选文件，会话 cwd 位于项目内时生效）
 * - commands：DSH 命令为代码注册制，无 .md 落点 → 仅提示暂不支持
 *
 * @module dsh-claude-import/import-logic
 */
import { createHash } from "node:crypto";
import { cp, lstat, mkdir, readFile, readdir, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

/** 支持的五类 Claude 资产。 */
export const ASSET_KINDS = ["skills", "rules", "commands", "claudeMd", "agentsMd"];

/** 冲突处理三策略。 */
export const STRATEGIES = ["overwrite", "merge", "skip"];

/** 文本块标记格式（幂等锚点）。 */
const BLOCK_BEGIN_RE = /<!-- dsh-claude-import:begin id="([^"]+)" -->/g;

/**
 * 规范化主机配置目录。
 * @param config - 显式目录，缺省按环境推导。
 * @returns 三个绝对目录。
 */
export function resolveDirs(config) {
  const home = config.home ?? process.env.USERPROFILE ?? process.env.HOME ?? ".";
  return {
    claudeHome: config.claudeHome ?? join(home, ".claude"),
    agentsHome: config.agentsHome ?? join(home, ".agents"),
    dshHome: config.dshHome ?? join(home, ".dsh"),
  };
}

/** 目录是否可安全枚举（存在且是目录）。 */
async function isDirectory(path) {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** 文件是否存在（跟随联接）。 */
async function isFile(path) {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/**
 * 递归计算目录树的内容指纹：相对路径 → sha256(内容)。
 * 联接（junction）按真实内容计算，因此指向同一来源的联接与真实副本指纹一致。
 * @param dir - 目录绝对路径。
 * @returns 相对路径（/ 分隔）到 16 进制摘要的映射；目录不存在时返回 undefined。
 */
export async function hashTree(dir) {
  if (!(await isDirectory(dir))) return undefined;
  const map = new Map();
  const walk = async (current) => {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
      } else if (entry.isFile()) {
        const digest = createHash("sha256").update(await readFile(path)).digest("hex");
        map.set(relative(dir, path).split(sep).join("/"), digest);
      }
    }
  };
  await walk(dir);
  return map;
}

/**
 * 比较源与目标目录：指纹一致则内容相同。
 * @returns 'missing' | 'identical' | 'conflict'；目标为联接（junction/symlink）时
 *          附加 isLink 标记（覆盖/合并需先摘掉链接，避免写穿到链接目标）。
 */
export async function compareSkillDirs(source, target) {
  const sourceTree = await hashTree(source);
  if (sourceTree === undefined) return { status: "empty" };
  let link = false;
  try {
    link = (await lstat(target)).isSymbolicLink();
  } catch {
    /* target 不存在 */
  }
  const targetTree = await hashTree(target);
  if (targetTree === undefined) return { status: "missing" };
  if (sourceTree.size !== targetTree.size) return { status: "conflict", isLink: link };
  for (const [rel, digest] of sourceTree) {
    if (targetTree.get(rel) !== digest) return { status: "conflict", isLink: link };
  }
  return { status: "identical", isLink: link };
}

/** 计算目录内文件数（浅层子目录算作技能）与总字节数（递归）。 */
export async function dirSize(dir) {
  let files = 0;
  let bytes = 0;
  const walk = async (current) => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) {
        files += 1;
        bytes += (await stat(path)).size;
      }
    }
  };
  if (await isDirectory(dir)) await walk(dir);
  return { files, bytes };
}

/** 移除目标目录（若为联接只摘链接，绝不动链接指向的内容）。 */
async function removeTarget(target) {
  let info;
  try {
    info = await lstat(target);
  } catch {
    return;
  }
  if (info.isSymbolicLink()) {
    await unlink(target);
    return;
  }
  await rm(target, { recursive: true, force: true });
}

/** 整目录覆盖：复制到临时名后原子改名。 */
async function replaceDir(source, target) {
  const tmp = `${target}.dsh-import-tmp-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  await cp(source, tmp, { recursive: true });
  await removeTarget(target);
  await rename(tmp, target);
}

/** 目录合并：源文件覆盖同名文件，保留目标自有文件；目标为联接时先实体化。 */
async function mergeDir(source, target) {
  let materialized = false;
  try {
    if ((await lstat(target)).isSymbolicLink()) {
      const tmp = `${target}.dsh-import-tmp-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
      await cp(target, tmp, { recursive: true, dereference: true });
      await unlink(target);
      await rename(tmp, target);
      materialized = true;
    }
  } catch {
    /* target 不存在，直接合并复制 */
  }
  try {
    await cp(source, target, { recursive: true, force: true });
  } catch (error) {
    if (materialized) {
      // 实体化已完成但合并失败时，目标仍是完整副本，保留即可。
    }
    throw error;
  }
}

/**
 * 生成导入块的块内体（两个标记之间的部分，含标题行）。
 * @param id - 稳定块 id（如 `user:rules/engineering-conduct.md`）。
 * @param label - 展示用标题。
 * @param body - 原始内容。
 */
export function blockInner(id, label, body) {
  const content = body.replace(/\s+$/, "");
  return `\n\n## [dsh-claude-import] ${label}\n\n${content}`;
}

/**
 * 生成一个完整导入块（块内体 + 起止标记）。
 * @param id - 稳定块 id（如 `user:rules/engineering-conduct.md`）。
 * @param label - 展示用标题。
 * @param body - 原始内容。
 */
export function renderBlock(id, label, body) {
  const inner = blockInner(id, label, body);
  return `<!-- dsh-claude-import:begin id="${id}" -->${inner}\n<!-- dsh-claude-import:end id="${id}" -->`;
}

/** 用给定块内体重新拼装完整块（合并策略使用）。 */
export function renderBlockFromInner(id, inner) {
  return `<!-- dsh-claude-import:begin id="${id}" -->${inner}\n<!-- dsh-claude-import:end id="${id}" -->`;
}

/**
 * 定位指定 id 的既有块。
 * @returns { start, end, body } 或 undefined。
 */
export function locateBlock(content, id) {
  BLOCK_BEGIN_RE.lastIndex = 0;
  let match;
  while ((match = BLOCK_BEGIN_RE.exec(content)) !== null) {
    if (match[1] !== id) continue;
    const endTag = `<!-- dsh-claude-import:end id="${id}" -->`;
    const end = content.indexOf(endTag, match.index + match[0].length);
    if (end === -1) return { start: match.index, end: content.length, body: content.slice(match.index + match[0].length), unclosed: true };
    return {
      start: match.index,
      end: end + endTag.length,
      body: content.slice(match.index + match[0].length, end),
      unclosed: false,
    };
  }
  return undefined;
}

/**
 * 判定一个文本资产相对目标指令文件的状态。
 * @param targetContent - 目标文件当前内容（undefined = 文件不存在）。
 * @param id - 块 id。
 * @param label - 块标题。
 * @param sourceBody - 源文件原始内容。
 * @returns 'missing'(目标文件不存在) | 'new'(文件存在但无此块) |
 *          'identical' | 'updated'(块内容已变) | 'present-unmarked'(无块标记但等效内容已存在) |
 *          'unclosed'(块未闭合，按损坏处理)
 */
export function classifyTextTarget(targetContent, id, label, sourceBody) {
  if (targetContent === undefined) return { status: "missing" };
  const expectedInner = blockInner(id, label, sourceBody);
  const block = locateBlock(targetContent, id);
  if (block !== undefined) {
    if (block.unclosed) return { status: "unclosed", block };
    const normalize = (text) => text.replace(/\s+$/, "");
    if (normalize(block.body) === normalize(expectedInner)) return { status: "identical", block };
    return { status: "updated", block };
  }
  const trimmed = sourceBody.replace(/\s+/g, " ").trim();
  if (trimmed.length > 0 && targetContent.replace(/\s+/g, " ").includes(trimmed)) {
    return { status: "present-unmarked" };
  }
  return { status: "new" };
}

/** 原子写文件（临时文件 + 改名，Windows 上 rename 会替换已存在目标）。 */
export async function atomicWriteText(path, content) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.dsh-import-tmp-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  await writeFile(tmp, content, "utf8");
  await rename(tmp, path);
}

/**
 * 对目标指令文件应用一次文本导入。
 * @param targetPath - 目标文件绝对路径。
 * @param content - 当前内容（undefined = 文件不存在）。
 * @param id - 块 id。
 * @param label - 块标题。
 * @param sourceBody - 源文件原始内容。
 * @param strategy - overwrite | merge | skip。
 * @returns { status, message }。
 */
export async function applyTextImport(targetPath, content, id, label, sourceBody, strategy) {
  const classified = classifyTextTarget(content, id, label, sourceBody);
  switch (classified.status) {
    case "identical":
      return { status: "identical", message: "已导入，内容一致，无需改动" };
    case "present-unmarked":
      return { status: "identical", message: "目标中已存在等效内容（先前导入，无标记），跳过以免重复" };
    case "missing":
    case "new": {
      if (strategy === "skip") return { status: "skipped", message: "按策略跳过" };
      const base = content ?? "";
      const expectedBody = renderBlock(id, label, sourceBody);
      const next = base.length === 0 ? `${expectedBody}\n` : `${base.replace(/\s+$/, "")}\n\n${expectedBody}\n`;
      await atomicWriteText(targetPath, next);
      return { status: "imported", message: classified.status === "missing" ? "已创建指令文件并写入块" : "已追加导入块" };
    }
    case "unclosed":
      return { status: "error", message: "目标文件中存在未闭合的导入块，请先手工修复" };
    case "updated": {
      if (strategy === "skip") return { status: "skipped", message: "源已更新，按策略跳过" };
      const normalize = (text) => text.replace(/\s+$/, "");
      if (strategy === "merge") {
        const mergedInner = `${normalize(classified.block.body)}\n\n---\n\n${blockInner(id, label, sourceBody)}`;
        const next = content.slice(0, classified.block.start) + renderBlockFromInner(id, mergedInner) + content.slice(classified.block.end);
        await atomicWriteText(targetPath, next);
        return { status: "imported", message: "已把新内容合并追加进导入块" };
      }
      const next = content.slice(0, classified.block.start) + renderBlock(id, label, sourceBody) + content.slice(classified.block.end);
      await atomicWriteText(targetPath, next);
      return { status: "imported", message: "已用最新源内容覆盖导入块" };
    }
    default:
      return { status: "error", message: `未知状态 ${classified.status}` };
  }
}

/**
 * 枚举一个 Claude 配置目录里的资产。
 * @param claudeDir - ~/.claude 或 <ws>/.claude。
 * @param scope - 'user' | 'project'。
 * @param targets - { agentsHome, dshHome, workspace }。
 * @returns 资产数组（key/kind/scope/source/target/blockId/label）。
 */
export async function listClaudeAssets(claudeDir, scope, targets) {
  const assets = [];
  const add = (asset) => {
    assets.push(asset);
  };

  const skillsDir = join(claudeDir, "skills");
  if (await isDirectory(skillsDir)) {
    for (const entry of await readdir(skillsDir, { withFileTypes: true })) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const name = entry.name;
      if (name.startsWith(".")) continue;
      const source = join(skillsDir, name);
      if (!(await isFile(join(source, "SKILL.md")))) continue;
      const skillTargets = scope === "user"
        ? join(targets.agentsHome, "skills", name)
        : join(targets.workspace, ".agents", "skills", name);
      add({
        key: `${scope}:skills/${name}`,
        kind: "skills",
        scope,
        source,
        target: skillTargets,
        label: `skills/${name}`,
      });
    }
  }

  for (const fileName of ["CLAUDE.md", "AGENTS.md"]) {
    const source = join(claudeDir, fileName);
    if (!(await isFile(source))) continue;
    const kind = fileName === "CLAUDE.md" ? "claudeMd" : "agentsMd";
    const target = scope === "user"
      ? join(targets.dshHome, "AGENTS.md")
      : join(targets.workspace, "AGENTS.md");
    add({
      key: `${scope}:${fileName}`,
      kind,
      scope,
      source,
      target,
      blockId: `${scope}:${fileName}`,
      label: fileName,
    });
  }

  const rulesDir = join(claudeDir, "rules");
  if (await isDirectory(rulesDir)) {
    const walk = async (current) => {
      for (const entry of await readdir(current, { withFileTypes: true })) {
        const path = join(current, entry.name);
        if (entry.isDirectory()) {
          await walk(path);
        } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
          const rel = relative(rulesDir, path).split(sep).join("/");
          const target = scope === "user"
            ? join(targets.dshHome, "AGENTS.md")
            : join(targets.workspace, "AGENTS.md");
          add({
            key: `${scope}:rules/${rel}`,
            kind: "rules",
            scope,
            source: path,
            target,
            blockId: `${scope}:rules/${rel}`,
            label: `rules/${rel}`,
          });
        }
      }
    };
    await walk(rulesDir);
  }

  const commandsDir = join(claudeDir, "commands");
  if (await isDirectory(commandsDir)) {
    const entries = await readdir(commandsDir, { withFileTypes: true });
    const files = entries.filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".md"));
    for (const entry of files) {
      add({
        key: `${scope}:commands/${entry.name}`,
        kind: "commands",
        scope,
        source: join(commandsDir, entry.name),
        target: "(无落点)",
        label: `commands/${entry.name}`,
      });
    }
  }

  return assets;
}

/**
 * 生成预览计划：为每个选中资产计算状态与摘要。
 * @param config - 目录配置。
 * @param input - { workspace, selections, strategies }。
 * @returns { destinations, items }。
 */
export async function planImport(config, input) {
  const dirs = resolveDirs(config);
  const workspace = input.workspace && input.workspace.length > 0 ? resolve(input.workspace) : null;
  const selections = input.selections ?? {};
  const strategies = input.strategies ?? {};
  const userScope = {
    agentsHome: dirs.agentsHome,
    dshHome: dirs.dshHome,
  };
  const projectScope = workspace === null ? null : {
    agentsHome: dirs.agentsHome,
    dshHome: dirs.dshHome,
    workspace,
  };

  const destinations = {
    userSkillsDir: join(dirs.agentsHome, "skills"),
    projectSkillsDir: workspace === null ? null : join(workspace, ".agents", "skills"),
    userInstructionFile: join(dirs.dshHome, "AGENTS.md"),
    projectInstructionFile: workspace === null ? null : join(workspace, "AGENTS.md"),
  };

  const collected = [];
  if (selections.skills || selections.rules || selections.commands || selections.claudeMd || selections.agentsMd) {
    for (const asset of await listClaudeAssets(dirs.claudeHome, "user", userScope)) {
      if (selections[asset.kind]) collected.push(asset);
    }
  }
  if (workspace !== null) {
    const projectClaudeDir = join(workspace, ".claude");
    if (await isDirectory(projectClaudeDir)) {
      for (const asset of await listClaudeAssets(projectClaudeDir, "project", projectScope)) {
        if (selections[asset.kind]) collected.push(asset);
      }
    }
  }

  const items = [];
  for (const asset of collected) {
    if (asset.kind === "commands") {
      items.push({
        key: asset.key,
        kind: "commands",
        scope: asset.scope,
        source: asset.source,
        target: asset.target,
        status: "unsupported",
        strategy: "skip",
        summary: "DSH 命令为代码注册制，Claude 的 commands/*.md 暂无直接落点，已跳过（TODO）",
      });
      continue;
    }
    if (asset.kind === "skills") {
      const compared = await compareSkillDirs(asset.source, asset.target);
      const size = await dirSize(asset.source);
      const status = compared.status === "missing" ? "new" : compared.status === "identical" ? "identical" : "conflict";
      const strategy = strategies[asset.key] ?? (status === "new" ? "overwrite" : "skip");
      const linkNote = compared.isLink ? "（目标当前是目录联接，覆盖/合并会先摘除联接）" : "";
      items.push({
        key: asset.key,
        kind: "skills",
        scope: asset.scope,
        source: asset.source,
        target: asset.target,
        status,
        strategy,
        summary:
          compared.status === "empty" ? "源目录为空或不可读" :
          compared.status === "missing" ? `新增：复制 ${size.files} 个文件（${formatBytes(size.bytes)}）到目标` :
          compared.status === "identical" ? `已导入且内容一致，无需改动${linkNote}` :
          `目标已存在且内容不同（源 ${size.files} 个文件 / ${formatBytes(size.bytes)}）${linkNote}`,
        files: size.files,
        bytes: size.bytes,
      });
      continue;
    }
    // 文本类（rules / CLAUDE.md / AGENTS.md）
    let sourceBody;
    try {
      sourceBody = await readFile(asset.source, "utf8");
    } catch (error) {
      items.push({ key: asset.key, kind: asset.kind, scope: asset.scope, source: asset.source, target: asset.target, blockId: asset.blockId, label: asset.label, status: "empty", strategy: "skip", summary: `源文件不可读：${errorMessage(error)}` });
      continue;
    }
    let targetContent;
    try {
      targetContent = await readFile(asset.target, "utf8");
    } catch (error) {
      if (error.code !== "ENOENT") {
        items.push({ key: asset.key, kind: asset.kind, scope: asset.scope, source: asset.source, target: asset.target, blockId: asset.blockId, label: asset.label, status: "empty", strategy: "skip", summary: `目标文件不可读：${errorMessage(error)}` });
        continue;
      }
      targetContent = undefined;
    }
    const classified = classifyTextTarget(targetContent, asset.blockId, asset.label, sourceBody);
    const status = classified.status === "missing" ? "new" : classified.status;
    const strategy = strategies[asset.key] ?? (status === "new" ? "overwrite" : "skip");
    const summary =
      classified.status === "missing" ? "目标指令文件不存在，将创建并写入导入块" :
      classified.status === "new" ? "目标文件中尚无此导入块，将追加" :
      classified.status === "identical" ? "已导入且内容一致，无需改动" :
      classified.status === "present-unmarked" ? "目标中已存在等效内容（先前导入，无标记），跳过以免重复" :
      classified.status === "unclosed" ? "目标中存在未闭合的导入块，需先手工修复" :
      "源内容已更新，与目标中的导入块不一致";
    items.push({
      key: asset.key,
      kind: asset.kind,
      scope: asset.scope,
      source: asset.source,
      target: asset.target,
      blockId: asset.blockId,
      label: asset.label,
      status,
      strategy,
      summary,
      bytes: Buffer.byteLength(sourceBody, "utf8"),
    });
  }
  return { destinations, items };
}

/**
 * 执行导入计划。
 * @param config - 目录配置。
 * @param input - { workspace, selections, strategies }。
 * @param signal - 取消信号。
 * @returns { results }，逐项给出结果，单项失败不中断整体。
 */
export async function executeImport(config, input, signal) {
  const { items } = await planImport(config, input);
  const strategies = input.strategies ?? {};
  const results = [];
  for (const item of items) {
    if (signal?.aborted) {
      results.push({ key: item.key, status: "skipped", message: "已取消" });
      continue;
    }
    const strategy = strategies[item.key] ?? (item.status === "new" ? "overwrite" : "skip");
    if (item.kind === "commands" || item.status === "unsupported") {
      results.push({ key: item.key, status: "unsupported", message: item.summary });
      continue;
    }
    if (item.status === "empty") {
      results.push({ key: item.key, status: "skipped", message: item.summary });
      continue;
    }
    try {
      if (item.kind === "skills") {
        if (item.status === "identical") {
          results.push({ key: item.key, status: "identical", message: "已导入且内容一致，无需改动", files: item.files, bytes: item.bytes });
          continue;
        }
        if (strategy === "skip") {
          results.push({ key: item.key, status: "skipped", message: "按策略跳过", files: item.files, bytes: item.bytes });
          continue;
        }
        if (strategy === "merge") await mergeDir(item.source, item.target);
        else await replaceDir(item.source, item.target);
        results.push({ key: item.key, status: "imported", message: strategy === "merge" ? "已合并复制进目标目录" : "已覆盖目标目录", files: item.files, bytes: item.bytes });
        continue;
      }
      // 文本类
      let targetContent;
      try {
        targetContent = await readFile(item.target, "utf8");
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        targetContent = undefined;
      }
      const sourceBody = await readFile(item.source, "utf8");
      const outcome = await applyTextImport(item.target, targetContent, item.blockId, item.label, sourceBody, strategy);
      results.push({
        key: item.key,
        status: outcome.status === "imported" ? "imported" : outcome.status,
        message: outcome.message,
        bytes: Buffer.byteLength(sourceBody, "utf8"),
      });
    } catch (error) {
      results.push({ key: item.key, status: "error", message: errorMessage(error) });
    }
  }
  return { results };
}

/** 把一个未知异常压成一行可读消息。 */
export function errorMessage(error) {
  if (error instanceof Error) return `${error.code === undefined ? "" : `${error.code}: `}${error.message}`;
  return String(error);
}

/** 人类可读字节数。 */
export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

/** 路径展示用：家里目录缩写成 `~`。 */
export function displayPath(path, home) {
  if (typeof path !== "string" || path === "(无落点)") return path;
  const resolved = resolve(path);
  const base = home ?? process.env.USERPROFILE ?? process.env.HOME ?? "";
  if (base.length > 0 && (resolved === base || resolved.startsWith(base + sep))) {
    return `~${sep}${relative(base, resolved)}`;
  }
  return resolved;
}
