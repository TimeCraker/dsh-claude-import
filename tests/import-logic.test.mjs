/**
 * import-logic 的独立单元测试（node --test）。
 * 全部用临时目录模拟 home / claude / dsh / agents 结构，不触碰真实配置。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm, readdir, stat, lstat, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import {
  applyTextImport,
  classifyTextTarget,
  compareSkillDirs,
  executeImport,
  locateBlock,
  planImport,
  renderBlock,
  resolveDirs,
} from "../lib/import-logic.js";

async function makeHome() {
  const home = await mkdtemp(join(tmpdir(), "dsh-claude-import-test-"));
  const claude = join(home, ".claude");
  const dsh = join(home, ".dsh");
  const agents = join(home, ".agents");
  await mkdir(join(claude, "skills"), { recursive: true });
  await mkdir(join(claude, "rules"), { recursive: true });
  await mkdir(join(claude, "commands"), { recursive: true });
  await mkdir(dsh, { recursive: true });
  await mkdir(agents, { recursive: true });
  return { home, claude, dsh, agents };
}

const configFor = (dirs) => ({
  home: dirs.home,
  claudeHome: dirs.claude,
  dshHome: dirs.dsh,
  agentsHome: dirs.agents,
});

const ALL = { skills: true, rules: true, commands: true, claudeMd: true, agentsMd: true };

async function makeSkill(dir, name, body = "# test") {
  const skillDir = join(dir, "skills", name);
  await mkdir(skillDir, { recursive: true });
  await writeFile(join(skillDir, "SKILL.md"), `---\nname: ${name}\ndescription: test skill\n---\n\n${body}\n`, "utf8");
  return skillDir;
}

test("resolveDirs 按配置与约定推导三个目录", () => {
  const dirs = resolveDirs({ home: "C:\\Users\\test", claudeHome: "C:\\Users\\test\\.claude" });
  assert.equal(dirs.claudeHome, "C:\\Users\\test\\.claude");
  assert.equal(dirs.agentsHome, "C:\\Users\\test\\.agents");
  assert.equal(dirs.dshHome, "C:\\Users\\test\\.dsh");
});

test("skill 新增 → 覆盖冲突 → 幂等一致，全程不重复", async () => {
  const dirs = await makeHome();
  const cfg = configFor(dirs);
  const source = await makeSkill(dirs.claude, "alpha-skill");

  const first = await executeImport(cfg, { workspace: null, selections: ALL, strategies: {} });
  const firstItem = first.results.find((item) => item.key === "user:skills/alpha-skill");
  assert.equal(firstItem.status, "imported");
  assert.equal((await stat(join(dirs.agents, "skills", "alpha-skill", "SKILL.md"))).isFile(), true);

  // 二次导入：内容一致 → identical，目标不被重复写入
  const second = await executeImport(cfg, { workspace: null, selections: ALL, strategies: {} });
  assert.equal(second.results.find((item) => item.key === "user:skills/alpha-skill").status, "identical");
  assert.deepEqual(
    (await readdir(join(dirs.agents, "skills"))).sort(),
    ["alpha-skill"],
  );
  await rm(source, { recursive: true, force: true });
});

test("skill 冲突三策略：覆盖 / 合并 / 跳过", async () => {
  const dirs = await makeHome();
  const cfg = configFor(dirs);
  await makeSkill(dirs.claude, "beta-skill", "source body v1");

  // 第一次导入后修改源 → 冲突
  await executeImport(cfg, { workspace: null, selections: ALL, strategies: {} });
  await writeFile(join(dirs.claude, "skills", "beta-skill", "SKILL.md"), "---\nname: beta-skill\ndescription: x\n---\n\nsource body v2\n", "utf8");

  const skip = await executeImport(cfg, { workspace: null, selections: ALL, strategies: { "user:skills/beta-skill": "skip" } });
  assert.equal(skip.results.find((item) => item.key === "user:skills/beta-skill").status, "skipped");
  assert.match(await readFile(join(dirs.agents, "skills", "beta-skill", "SKILL.md"), "utf8"), /source body v1/);

  const overwrite = await executeImport(cfg, { workspace: null, selections: ALL, strategies: { "user:skills/beta-skill": "overwrite" } });
  assert.equal(overwrite.results.find((item) => item.key === "user:skills/beta-skill").status, "imported");
  assert.match(await readFile(join(dirs.agents, "skills", "beta-skill", "SKILL.md"), "utf8"), /source body v2/);

  // 合并：目标有自有文件，源更新 → 合并后自有文件保留、源文件覆盖
  await writeFile(join(dirs.agents, "skills", "beta-skill", "extra-note.md"), "target-owned\n", "utf8");
  await writeFile(join(dirs.claude, "skills", "beta-skill", "SKILL.md"), "---\nname: beta-skill\ndescription: x\n---\n\nsource body v3\n", "utf8");
  const merge = await executeImport(cfg, { workspace: null, selections: ALL, strategies: { "user:skills/beta-skill": "merge" } });
  assert.equal(merge.results.find((item) => item.key === "user:skills/beta-skill").status, "imported");
  assert.match(await readFile(join(dirs.agents, "skills", "beta-skill", "SKILL.md"), "utf8"), /source body v3/);
  assert.equal(await readFile(join(dirs.agents, "skills", "beta-skill", "extra-note.md"), "utf8"), "target-owned\n");
});

test("文本块：新建追加 → 一致 → 更新覆盖，幂等无重复块", async () => {
  const dirs = await makeHome();
  const cfg = configFor(dirs);
  const rulesFile = join(dirs.claude, "rules", "rule-one.md");
  await writeFile(rulesFile, "# 规则一\n\n先写测试。\n", "utf8");

  const first = await executeImport(cfg, { workspace: null, selections: ALL, strategies: { "user:rules/rule-one.md": "overwrite" } });
  assert.equal(first.results.find((item) => item.key === "user:rules/rule-one.md").status, "imported");
  let target = await readFile(join(dirs.dsh, "AGENTS.md"), "utf8");
  assert.match(target, /dsh-claude-import:begin id="user:rules\/rule-one\.md"/);
  assert.match(target, /先写测试/);

  // 二次导入 → identical，块不重复
  const second = await executeImport(cfg, { workspace: null, selections: ALL, strategies: {} });
  assert.equal(second.results.find((item) => item.key === "user:rules/rule-one.md").status, "identical");
  target = await readFile(join(dirs.dsh, "AGENTS.md"), "utf8");
  assert.equal(target.match(/dsh-claude-import:begin id="user:rules\/rule-one\.md"/g).length, 1);

  // 源更新 → 覆盖只替换块内容
  await writeFile(rulesFile, "# 规则一（改）\n\n改后内容。\n", "utf8");
  const third = await executeImport(cfg, { workspace: null, selections: ALL, strategies: { "user:rules/rule-one.md": "overwrite" } });
  assert.equal(third.results.find((item) => item.key === "user:rules/rule-one.md").status, "imported");
  target = await readFile(join(dirs.dsh, "AGENTS.md"), "utf8");
  assert.match(target, /改后内容/);
  assert.doesNotMatch(target, /先写测试/);
  assert.equal(target.match(/dsh-claude-import:begin id="user:rules\/rule-one\.md"/g).length, 1);
});

test("present-unmarked：无标记但等效内容已在目标中 → 视为已导入，跳过", async () => {
  const dirs = await makeHome();
  const cfg = configFor(dirs);
  const body = "# 手工合并过的规则\n\n这些内容之前被手工合并过。\n";
  await writeFile(join(dirs.dsh, "AGENTS.md"), `# 已有内容\n\n${body}\n`, "utf8");
  await writeFile(join(dirs.claude, "rules", "manual-rule.md"), body, "utf8");

  const result = await executeImport(cfg, { workspace: null, selections: ALL, strategies: {} });
  assert.equal(result.results.find((item) => item.key === "user:rules/manual-rule.md").status, "identical");
  const target = await readFile(join(dirs.dsh, "AGENTS.md"), "utf8");
  assert.equal(target.match(/dsh-claude-import:begin/g)?.length ?? 0, 0);
});

test("项目级导入：工作区 .claude 资产落到 <ws>/.agents 与 <ws>/AGENTS.md", async () => {
  const dirs = await makeHome();
  const cfg = configFor(dirs);
  const ws = join(dirs.home, "my-project");
  await makeSkill(join(ws, ".claude"), "project-skill");
  await writeFile(join(ws, ".claude", "CLAUDE.md"), "# 项目 CLAUDE\n\n项目规则内容。\n", "utf8");

  const result = await executeImport(cfg, { workspace: ws, selections: ALL, strategies: {} });
  assert.equal(result.results.find((item) => item.key === "project:skills/project-skill").status, "imported");
  assert.equal(result.results.find((item) => item.key === "project:CLAUDE.md").status, "imported");
  assert.equal((await stat(join(ws, ".agents", "skills", "project-skill", "SKILL.md"))).isFile(), true);
  const projectAgents = await readFile(join(ws, "AGENTS.md"), "utf8");
  assert.match(projectAgents, /项目规则内容/);
  assert.match(projectAgents, /## \[dsh-claude-import\] CLAUDE\.md/);
});

test("预览计划：未勾选的资产不出现；commands 标记暂不支持", async () => {
  const dirs = await makeHome();
  const cfg = configFor(dirs);
  await makeSkill(dirs.claude, "gamma-skill");
  await writeFile(join(dirs.claude, "commands", "deploy.md"), "# deploy\n", "utf8");

  const plan = await planImport(cfg, { workspace: null, selections: { skills: true, rules: false, commands: true, claudeMd: false, agentsMd: false }, strategies: {} });
  const keys = plan.items.map((item) => item.key);
  assert.ok(keys.includes("user:skills/gamma-skill"));
  assert.ok(keys.includes("user:commands/deploy.md"));
  assert.equal(keys.some((key) => key.includes("rules")), false);
  assert.equal(plan.items.find((item) => item.kind === "commands").status, "unsupported");
});

test("junction 目标：一致不动链接；覆盖只摘链接不伤链接指向的目录", { skip: process.platform !== "win32" }, async () => {
  const dirs = await makeHome();
  const cfg = configFor(dirs);
  const source = await makeSkill(dirs.claude, "linked-skill");
  const targetRoot = join(dirs.agents, "skills");
  await mkdir(targetRoot, { recursive: true });
  const link = join(targetRoot, "linked-skill");
  await symlink(source, link, "junction");

  // 一致（链接镜像源内容）：no-op，链接保留
  const same = await executeImport(cfg, { workspace: null, selections: ALL, strategies: {} });
  assert.equal(same.results.find((item) => item.key === "user:skills/linked-skill").status, "identical");
  assert.equal((await lstat(link)).isSymbolicLink(), true);

  // 把链接改指向另一个内容不同的目录 → 冲突；覆盖只摘链接、不动链接指向的目录
  const other = await mkdtemp(join(dirs.home, "other-"));
  await writeFile(join(other, "SKILL.md"), "---\nname: other\ndescription: x\n---\n\nother\n", "utf8");
  await unlink(link);
  await symlink(other, link, "junction");
  const replaced = await executeImport(cfg, { workspace: null, selections: ALL, strategies: { "user:skills/linked-skill": "overwrite" } });
  assert.equal(replaced.results.find((item) => item.key === "user:skills/linked-skill").status, "imported");
  assert.equal((await lstat(link)).isSymbolicLink(), false);
  assert.match(await readFile(join(link, "SKILL.md"), "utf8"), /# test/);
  assert.match(await readFile(join(other, "SKILL.md"), "utf8"), /other/);
  assert.match(await readFile(join(source, "SKILL.md"), "utf8"), /# test/);
});

test("块工具函数：renderBlock / locateBlock / classifyTextTarget / applyTextImport", async () => {
  const id = "user:CLAUDE.md";
  const label = "CLAUDE.md";
  const body = "第一行\n第二行\n";
  const block = renderBlock(id, label, body);
  assert.match(block, /^<!-- dsh-claude-import:begin id="user:CLAUDE\.md" -->/);
  assert.match(block, /<!-- dsh-claude-import:end id="user:CLAUDE\.md" -->$/);

  const doc = `# 顶部\n\n${block}\n\n# 底部\n`;
  const found = locateBlock(doc, id);
  assert.ok(found);
  assert.equal(found.unclosed, false);

  assert.equal(classifyTextTarget(doc, id, label, body).status, "identical");
  assert.equal(classifyTextTarget(doc, id, label, "新内容\n").status, "updated");
  assert.equal(classifyTextTarget("# 其它\n", id, label, body).status, "new");
  assert.equal(classifyTextTarget(undefined, id, label, body).status, "missing");
  const stripped = `已有 ${block.replace(/<!--[^>]*-->\n?/g, "")} 文本`;
  assert.equal(classifyTextTarget(stripped, id, label, body).status, "present-unmarked");

  const dirs = await makeHome();
  const target = join(dirs.dsh, "AGENTS.md");
  const outcome = await applyTextImport(target, undefined, id, label, "原文\n", "overwrite");
  assert.equal(outcome.status, "imported");
  const written = await readFile(target, "utf8");
  assert.match(written, /原文/);

  // 缺省 skip 策略对新建资产 = 跳过
  const skippedOutcome = await applyTextImport(join(dirs.dsh, "AGENTS-skip.md"), undefined, id, label, "原文\n", "skip");
  assert.equal(skippedOutcome.status, "skipped");
});

test("文本 merge 策略：块内追加而非覆盖", async () => {
  const dirs = await makeHome();
  const cfg = configFor(dirs);
  await writeFile(join(dirs.claude, "CLAUDE.md"), "第一版\n", "utf8");
  await executeImport(cfg, { workspace: null, selections: ALL, strategies: { "user:CLAUDE.md": "overwrite" } });
  await writeFile(join(dirs.claude, "CLAUDE.md"), "第二版\n", "utf8");
  await executeImport(cfg, { workspace: null, selections: ALL, strategies: { "user:CLAUDE.md": "merge" } });
  const target = await readFile(join(dirs.dsh, "AGENTS.md"), "utf8");
  assert.match(target, /第一版/);
  assert.match(target, /第二版/);
  assert.equal(target.match(/dsh-claude-import:begin id="user:CLAUDE\.md"/g).length, 1);
});

test("compareSkillDirs：缺失 / 一致 / 冲突 / 空源", async () => {
  const dirs = await makeHome();
  await makeSkill(dirs.claude, "cmp-skill");
  const source = join(dirs.claude, "skills", "cmp-skill");
  const target = join(dirs.agents, "skills", "cmp-skill");

  assert.equal((await compareSkillDirs(source, target)).status, "missing");
  await executeImport(configFor(dirs), { workspace: null, selections: ALL, strategies: {} });
  assert.equal((await compareSkillDirs(source, target)).status, "identical");
  await writeFile(join(target, "extra.md"), "x\n", "utf8");
  assert.equal((await compareSkillDirs(source, target)).status, "conflict");
  assert.equal((await compareSkillDirs(join(dirs.claude, "skills", "不存在"), target)).status, "empty");
});
