/**
 * dsh-claude-import 浏览器端插件：在设置页「插件」→「插件配置」里注册
 * 「Claude 配置导入」卡片，提供 勾选 → 范围选择 → 落点预览 → 冲突策略 →
 * 导入 的完整流程。所有业务调用走 connection.rpc 到宿主 Typert 网关
 * （claudeImport/preview 与 claudeImport/execute），浏览器端不落盘。
 *
 * 打包形态遵循官方客户端模块协议：整体是
 * `window.__ModuleLoader__.load({ id, factory(require) })` 工厂，只从共享
 * 模块表 require（react 与 dsh-client-ui-primitives），其余能力全部走
 * cordis 注入：slots / locale / connection / workspaces。
 *
 * 注意：CLIENT_BUNDLE_ID 必须与 profile 组合里本包的 Loader 行名一致
 * （正式包名为 dsh-claude-import；本机开发别名副本改为 dsh-claude-import-next）。
 * @module dsh-claude-import/client
 */

// 与 Loader 行名（npm 包名）保持一致；本机开发别名副本需改成
// "dsh-claude-import-next"。
const CLIENT_BUNDLE_ID = "dsh-claude-import";

window.__ModuleLoader__.load({
  id: CLIENT_BUNDLE_ID,
  factory: (require) => {
    const React = require("react");
    const { Button, Modal } = require("@deepseek-ai/dsh-client-ui-primitives");

    const inject = ["slots", "locale", "connection"];

    const ASSET_FIELDS = [
      { key: "skills", labelKey: "assetSkills" },
      { key: "rules", labelKey: "assetRules" },
      { key: "commands", labelKey: "assetCommands" },
      { key: "claudeMd", labelKey: "assetClaudeMd" },
      { key: "agentsMd", labelKey: "assetAgentsMd" },
    ];

    const KIND_LABEL = {
      skills: "assetSkills",
      rules: "assetRules",
      commands: "assetCommands",
      claudeMd: "assetClaudeMd",
      agentsMd: "assetAgentsMd",
    };

    const STATUS_CLASS = {
      new: "clci-status-new",
      identical: "clci-status-ok",
      conflict: "clci-status-conflict",
      empty: "clci-status-muted",
      unsupported: "clci-status-muted",
      "present-unmarked": "clci-status-ok",
      updated: "clci-status-conflict",
      unclosed: "clci-status-conflict",
    };

    const RESULT_STATUS_CLASS = {
      imported: "clci-status-ok",
      merged: "clci-status-ok",
      skipped: "clci-status-muted",
      identical: "clci-status-ok",
      unsupported: "clci-status-muted",
      error: "clci-status-conflict",
    };

    function apply(ctx) {
      const NS = "claude-import";
      const t = ctx.locale.bind(NS);
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), "claude-import: dictionaries");
      ctx.effect(() => {
        const tag = document.createElement("style");
        tag.dataset.plugin = CLIENT_BUNDLE_ID;
        tag.dataset.pluginCss = `${CLIENT_BUNDLE_ID}/styles`;
        tag.textContent = styles;
        document.head.appendChild(tag);
        return () => {
          tag.remove();
        };
      }, "claude-import: styles");

      ctx.slots.inject("settings.plugin.item", () => ctx.slots.register({
        name: "settings.plugin.item",
        id: "claude-import",
        order: 100,
        locale: NS,
        inject: () => ({ ctx }),
      }, ClaudeImportCard));
    }

    /** 一次 RPC 调用：connection.rpc → /api 通道上的 claudeImport 网关端点。 */
    async function callClaudeImport(ctx, method, input, signal) {
      const connection = ctx.get("connection");
      if (connection === void 0) throw new Error("connection 服务不可用");
      const result = await connection.rpc.call("/api", `claudeImport/${method}`, { args: { input } }, signal);
      if (result === undefined || result.ok !== true) {
        const detail = result?.error?.message ?? result?.error ?? "远程调用失败";
        throw new Error(String(detail));
      }
      return result.value;
    }

    /** 设置页插件卡片：标题 + 说明 + 打开导入 modal 的按钮。 */
    function ClaudeImportCard(props) {
      const [open, setOpen] = React.useState(false);
      const t = props.t;
      return React.createElement("li", { className: "clci-card" },
        React.createElement("div", { className: "clci-card-body" },
          React.createElement("div", { className: "clci-head" },
            React.createElement("span", { className: "clci-name" }, t("cardTitle")),
            React.createElement("span", { className: "clci-description" }, t("cardDescription"))),
          React.createElement(Button, { variant: "primary", size: "md", onClick: () => setOpen(true) }, t("openButton")),
          open ? React.createElement(ImportModal, { t, ctx: props.ctx, onClose: () => setOpen(false) }) : null));
    }

    /** 导入 modal：勾选 → 范围 → 预览 → 逐项策略 → 执行 → 结果。 */
    function ImportModal({ t, ctx, onClose }) {
      const [selections, setSelections] = React.useState({
        skills: true, rules: true, commands: true, claudeMd: true, agentsMd: true,
      });
      const [workspace, setWorkspace] = React.useState(null);
      const [picking, setPicking] = React.useState(false);
      const [phase, setPhase] = React.useState("config");
      const [preview, setPreview] = React.useState(null);
      const [scan, setScan] = React.useState(null);
      const [strategies, setStrategies] = React.useState({});
      const [results, setResults] = React.useState(null);
      const [busy, setBusy] = React.useState(false);
      const [error, setError] = React.useState(null);
      const abortRef = React.useRef(new AbortController());

      React.useEffect(() => () => {
        abortRef.current.abort();
      }, []);

      // 打开 modal 与切换工作区时，全量枚举一次资产（与勾选无关），
      // 供勾选行显示条目数与展开明细；策略默认值一并初始化。
      React.useEffect(() => {
        let disposed = false;
        const controller = new AbortController();
        callClaudeImport(ctx, "preview", {
          workspace,
          selections: { skills: true, rules: true, commands: true, claudeMd: true, agentsMd: true },
          strategies: {},
        }, controller.signal).then((value) => {
          if (disposed) return;
          setScan(value);
          setStrategies((previous) => {
            const merged = { ...previous };
            for (const item of value.items) if (merged[item.key] === undefined) merged[item.key] = item.strategy;
            return merged;
          });
        }).catch(() => {
          if (!disposed) setScan({ items: [] });
        });
        return () => {
          disposed = true;
          controller.abort();
        };
      }, [workspace]);

      const pickWorkspace = async () => {
        const workspaces = ctx.get("workspaces");
        if (workspaces === undefined || typeof workspaces.pickDirectory !== "function") return;
        setPicking(true);
        try {
          const picked = await workspaces.pickDirectory();
          if (picked !== null && picked !== undefined) setWorkspace(picked);
        } finally {
          setPicking(false);
        }
      };

      const runPreview = async () => {
        setBusy(true);
        setError(null);
        abortRef.current = new AbortController();
        try {
          const value = await callClaudeImport(ctx, "preview", { workspace, selections, strategies }, abortRef.current.signal);
          setPreview(value);
          const merged = { ...strategies };
          for (const item of value.items) if (merged[item.key] === undefined) merged[item.key] = item.strategy;
          setStrategies(merged);
          setPhase("preview");
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause));
        } finally {
          setBusy(false);
        }
      };

      const runExecute = async () => {
        setBusy(true);
        setError(null);
        abortRef.current = new AbortController();
        try {
          const value = await callClaudeImport(ctx, "execute", { workspace, selections, strategies }, abortRef.current.signal);
          setResults(value.results);
          setPhase("done");
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause));
        } finally {
          setBusy(false);
        }
      };

      const canAct = selections.skills || selections.rules || selections.commands || selections.claudeMd || selections.agentsMd;
      const actionable = (preview?.items ?? []).filter((item) => item.status !== "identical" && item.status !== "present-unmarked" && item.status !== "unsupported" && item.status !== "empty" && item.status !== "unclosed");
      const importedCount = (results ?? []).filter((item) => item.status === "imported").length;
      const skippedCount = (results ?? []).filter((item) => item.status === "skipped" || item.status === "identical" || item.status === "unsupported").length;
      const failedCount = (results ?? []).filter((item) => item.status === "error").length;

      return React.createElement(Modal, {
        open: true,
        onClose,
        title: t("modalTitle"),
        closeLabel: t("close"),
        description: t("modalDescription"),
        contentClassName: "clci-modal-content",
        footer: phase === "config"
          ? React.createElement(React.Fragment, null,
              React.createElement(Button, { variant: "ghost", size: "md", onClick: onClose }, t("close")),
              React.createElement(Button, { variant: "primary", size: "md", disabled: !canAct || busy, onClick: runPreview }, busy ? t("previewing") : t("previewButton")))
          : phase === "preview"
            ? React.createElement(React.Fragment, null,
                React.createElement(Button, { variant: "ghost", size: "md", disabled: busy, onClick: () => setPhase("config") }, t("backButton")),
                React.createElement(Button, { variant: "primary", size: "md", disabled: busy || actionable.length === 0, onClick: runExecute }, busy ? t("importing") : t("importButton")))
            : React.createElement(React.Fragment, null,
                React.createElement(Button, { variant: "ghost", size: "md", disabled: busy, onClick: runPreview }, t("rePreviewButton")),
                React.createElement(Button, { variant: "primary", size: "md", onClick: onClose }, t("close"))),
      },
        error !== null ? React.createElement("p", { className: "clci-error", role: "alert" }, error) : null,
        phase === "config" ? React.createElement(ConfigStep, {
          t,
          selections,
          setSelections,
          workspace,
          pickWorkspace,
          picking,
          clearWorkspace: () => setWorkspace(null),
          hasWorkspaceService: ctx.get("workspaces") !== undefined,
          scanItems: scan?.items ?? null,
        }) : null,
        phase === "preview" && preview !== null ? React.createElement(PreviewStep, {
          t,
          preview,
          strategies,
          setStrategies,
        }) : null,
        phase === "done" && results !== null ? React.createElement(DoneStep, {
          t,
          results,
          importedCount,
          skippedCount,
          failedCount,
        }) : null);
    }

    /** 从资产 key 推导展示名（skills 取目录名，其余取相对路径/文件名）。 */
    function assetDisplayName(item) {
      const rest = item.key.includes(":") ? item.key.slice(item.key.indexOf(":") + 1) : item.key;
      return rest.includes("/") ? rest.slice(rest.indexOf("/") + 1) : rest;
    }

    /** 人类可读字节数。 */
    function formatBytes(bytes) {
      if (typeof bytes !== "number") return "0 B";
      if (bytes < 1024) return `${bytes} B`;
      if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
      return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
    }

    function ConfigStep(props) {
      const { t } = props;
      const [expanded, setExpanded] = React.useState({});
      const scanItems = props.scanItems;
      return React.createElement("div", { className: "clci-step" },
        React.createElement("p", { className: "clci-hint" }, t("scopeHint")),
        React.createElement("div", { className: "clci-scope-row" },
          React.createElement("span", { className: "clci-scope-chip" }, props.workspace === null ? t("scopeUser") : t("scopeProject")),
          props.hasWorkspaceService ? React.createElement(Button, { variant: "outline", size: "sm", disabled: props.picking, onClick: props.pickWorkspace }, props.picking ? t("picking") : t("chooseWorkspace")) : null,
          props.workspace !== null ? React.createElement(Button, { variant: "ghost", size: "sm", onClick: props.clearWorkspace }, t("clearWorkspace")) : null),
        props.workspace !== null ? React.createElement("p", { className: "clci-monospace" }, props.workspace) : null,
        React.createElement("ul", { className: "clci-checks" },
          ASSET_FIELDS.map((field) => {
            const items = (scanItems ?? []).filter((item) => item.kind === field.key);
            const isExpanded = expanded[field.key] === true;
            const toggle = () => {
              const next = { ...expanded };
              if (isExpanded) delete next[field.key];
              else next[field.key] = true;
              setExpanded(next);
            };
            return React.createElement("li", { key: field.key, className: "clci-check-row" },
              React.createElement("div", { className: "clci-check-line" },
                React.createElement("label", { className: "clci-check" },
                  React.createElement("input", {
                    type: "checkbox",
                    checked: props.selections[field.key],
                    onChange: (event) => {
                      const next = { ...props.selections };
                      next[field.key] = event.target.checked;
                      props.setSelections(next);
                    },
                  }),
                  React.createElement("span", null, t(field.labelKey))),
                scanItems === null
                  ? React.createElement("span", { className: "clci-count" }, t("counting"))
                  : React.createElement("span", { className: `clci-count${items.length === 0 ? " clci-count-zero" : ""}` }, t("itemCount", { count: items.length })),
                items.length > 0 ? React.createElement("button", {
                  type: "button",
                  className: "clci-expand",
                  "aria-expanded": isExpanded,
                  onClick: toggle,
                }, isExpanded ? "▾" : "▸") : null),
              isExpanded ? React.createElement("ul", { className: "clci-scan-list" },
                items.map((item) => React.createElement("li", { key: item.key, className: "clci-scan-item" },
                  React.createElement("span", { className: "clci-scan-name" }, assetDisplayName(item)),
                  React.createElement("span", { className: "clci-scope" }, item.scope === "user" ? t("scopeUser") : t("scopeProject")),
                  item.files !== undefined ? React.createElement("span", { className: "clci-scan-size" }, t("fileCount", { files: item.files, bytes: formatBytes(item.bytes ?? 0) })) : null,
                  React.createElement("span", { className: "clci-monospace" }, item.source)))) : null);
          })));
    }

    function PreviewStep(props) {
      const { t, preview } = props;
      const d = preview.destinations;
      return React.createElement("div", { className: "clci-step" },
        React.createElement("p", { className: "clci-section" }, t("destinationsTitle")),
        React.createElement("div", { className: "clci-dest" },
          React.createElement("div", { className: "clci-dest-row" }, React.createElement("span", { className: "clci-dest-label" }, t("scopeUser")), React.createElement("span", { className: "clci-monospace" }, d.userSkillsDir), " + ", React.createElement("span", { className: "clci-monospace" }, d.userInstructionFile)),
          d.projectSkillsDir !== null ? React.createElement("div", { className: "clci-dest-row" }, React.createElement("span", { className: "clci-dest-label" }, t("scopeProject")), React.createElement("span", { className: "clci-monospace" }, d.projectSkillsDir), " + ", React.createElement("span", { className: "clci-monospace" }, d.projectInstructionFile)) : null),
        preview.items.length === 0 ? React.createElement("p", { className: "clci-hint" }, t("noItems")) : null,
        React.createElement("p", { className: "clci-section" }, `${t("itemsTitle")}（${preview.items.length}）`),
        React.createElement("ul", { className: "clci-items" },
          preview.items.map((item) => React.createElement(PreviewItem, {
            key: item.key,
            t,
            item,
            strategy: props.strategies[item.key] ?? "skip",
            onStrategy: (value) => {
              const next = { ...props.strategies };
              next[item.key] = value;
              props.setStrategies(next);
            },
          }))));
    }

    function PreviewItem(props) {
      const { t, item } = props;
      const strategyEditable = item.status !== "identical" && item.status !== "present-unmarked" && item.status !== "unsupported" && item.status !== "empty" && item.status !== "unclosed";
      return React.createElement("li", { className: "clci-item" },
        React.createElement("div", { className: "clci-item-head" },
          React.createElement("span", { className: "clci-kind" }, t(KIND_LABEL[item.kind] ?? "assetSkills")),
          React.createElement("span", { className: `clci-badge ${STATUS_CLASS[item.status] ?? "clci-status-muted"}` }, t(`status_${item.status}`)),
          React.createElement("span", { className: "clci-scope" }, item.scope === "user" ? t("scopeUser") : t("scopeProject"))),
        React.createElement("p", { className: "clci-monospace clci-path" }, `${item.source}  →  ${item.target}`),
        React.createElement("p", { className: "clci-summary" }, item.summary),
        React.createElement("div", { className: "clci-item-foot" },
          React.createElement("select", {
            className: "clci-select",
            disabled: !strategyEditable,
            value: props.strategy,
            onChange: (event) => props.onStrategy(event.target.value),
          },
            React.createElement("option", { value: "overwrite" }, t("strategy_overwrite")),
            React.createElement("option", { value: "merge" }, t("strategy_merge")),
            React.createElement("option", { value: "skip" }, t("strategy_skip")))));
    }

    function DoneStep(props) {
      const { t, results } = props;
      return React.createElement("div", { className: "clci-step" },
        React.createElement("p", { className: "clci-summary" }, t("doneSummary", { imported: props.importedCount, skipped: props.skippedCount, failed: props.failedCount })),
        React.createElement("ul", { className: "clci-items" },
          results.map((item) => React.createElement("li", { key: item.key, className: "clci-item" },
            React.createElement("div", { className: "clci-item-head" },
              React.createElement("span", { className: "clci-kind" }, item.key),
              React.createElement("span", { className: `clci-badge ${RESULT_STATUS_CLASS[item.status] ?? "clci-status-muted"}` }, t(`result_${item.status}`))),
            React.createElement("p", { className: "clci-summary" }, item.message)))));
    }

    const zh = {
      cardTitle: "Claude 配置导入",
      cardDescription: "把 Claude Code 的用户级与项目级 skills / rules / CLAUDE.md / AGENTS.md 导入 DeepSeek Harness 对应落点，支持落点预览、冲突三策略与重复导入幂等。",
      openButton: "导入 Claude 配置",
      modalTitle: "导入 Claude 配置",
      modalDescription: "勾选要导入的资产，选择用户级或项目工作区，预览落点后逐项选择冲突策略再导入。",
      close: "关闭",
      backButton: "返回调整",
      previewButton: "预览落点",
      previewing: "预览中…",
      importButton: "开始导入",
      importing: "导入中…",
      rePreviewButton: "重新预览",
      scopeHint: "不选择工作区时只导入用户级资产（~/.claude）。选择工作区后追加导入该工作区 .claude 目录下的项目级资产。",
      scopeUser: "用户级（全局）",
      scopeProject: "项目级",
      chooseWorkspace: "选择工作区…",
      clearWorkspace: "清除工作区",
      picking: "等待选择…",
      assetSkills: "Skills（技能）",
      assetRules: "Rules（规则）",
      assetCommands: "Commands（斜杠命令）",
      assetClaudeMd: "CLAUDE.md",
      assetAgentsMd: "AGENTS.md",
      counting: "统计中…",
      itemCount: "{count} 项",
      fileCount: "{files} 个文件 / {bytes}",
      destinationsTitle: "落点一览",
      itemsTitle: "逐项计划",
      noItems: "没有可导入的资产：所选范围与勾选项下未发现任何源文件。",
      status_new: "新增",
      status_identical: "已一致",
      status_conflict: "冲突",
      status_empty: "不可用",
      status_unsupported: "暂不支持",
      "status_present-unmarked": "已有等效内容",
      status_updated: "源已更新",
      status_unclosed: "块损坏",
      strategy_overwrite: "覆盖",
      strategy_merge: "合并",
      strategy_skip: "跳过",
      doneSummary: "导入完成：成功 {imported} 项、跳过 {skipped} 项、失败 {failed} 项。",
      result_imported: "已导入",
      result_merged: "已合并",
      result_skipped: "已跳过",
      result_identical: "无改动",
      result_unsupported: "暂不支持",
      result_error: "失败",
    };

    const en = {
      cardTitle: "Claude config import",
      cardDescription: "Import Claude Code skills, rules, CLAUDE.md, and AGENTS.md (user-level and project-level) into their DeepSeek Harness destinations, with destination preview, three conflict strategies, and idempotent re-imports.",
      openButton: "Import Claude config",
      modalTitle: "Import Claude config",
      modalDescription: "Pick assets to import, choose user-level or a project workspace, preview destinations, then choose a conflict strategy per item before importing.",
      close: "Close",
      backButton: "Back",
      previewButton: "Preview destinations",
      previewing: "Previewing…",
      importButton: "Import",
      importing: "Importing…",
      rePreviewButton: "Preview again",
      scopeHint: "Without a workspace only user-level assets (~/.claude) are imported. Picking a workspace additionally imports project-level assets from its .claude directory.",
      scopeUser: "User-level (global)",
      scopeProject: "Project-level",
      chooseWorkspace: "Choose workspace…",
      clearWorkspace: "Clear workspace",
      picking: "Waiting for picker…",
      assetSkills: "Skills",
      assetRules: "Rules",
      assetCommands: "Commands (slash)",
      assetClaudeMd: "CLAUDE.md",
      assetAgentsMd: "AGENTS.md",
      counting: "Counting…",
      itemCount: "{count} items",
      fileCount: "{files} files / {bytes}",
      destinationsTitle: "Destinations",
      itemsTitle: "Per-item plan",
      noItems: "Nothing to import: no source files found for the selected scope and assets.",
      status_new: "New",
      status_identical: "Identical",
      status_conflict: "Conflict",
      status_empty: "Unavailable",
      status_unsupported: "Unsupported",
      "status_present-unmarked": "Equivalent content exists",
      status_updated: "Source updated",
      status_unclosed: "Broken block",
      strategy_overwrite: "Overwrite",
      strategy_merge: "Merge",
      strategy_skip: "Skip",
      doneSummary: "Import finished: {imported} imported, {skipped} skipped, {failed} failed.",
      result_imported: "Imported",
      result_merged: "Merged",
      result_skipped: "Skipped",
      result_identical: "No change",
      result_unsupported: "Unsupported",
      result_error: "Failed",
    };

    const styles = `
.clci-card{list-style:none;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:12px}
.clci-card-body{padding:16px;display:flex;align-items:center;gap:16px}
.clci-head{flex:1;min-width:0;display:flex;flex-direction:column;gap:4px}
.clci-name{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:600;line-height:1.4}
.clci-description{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.5}
.clci-modal-content{display:flex;flex-direction:column;gap:12px}
.clci-step{display:flex;flex-direction:column;gap:10px}
.clci-hint{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.6;margin:0}
.clci-section{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary);margin:2px 0 0}
.clci-scope-row{display:flex;align-items:center;gap:8px}
.clci-scope-chip{white-space:nowrap;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);border-radius:999px;padding:1px 8px;font-size:11px;font-weight:500;line-height:17px}
.clci-checks{display:flex;flex-direction:column;gap:6px;padding:2px 0}
.clci-check-row{display:flex;flex-direction:column;gap:4px}
.clci-check-line{display:flex;align-items:center;gap:8px}
.clci-check{display:flex;align-items:center;gap:8px;font-size:13px;color:var(--dsw-alias-label-primary);cursor:pointer}
.clci-count{white-space:nowrap;color:var(--dsw-alias-label-secondary);font-size:12px}
.clci-count-zero{color:var(--dsw-alias-label-tertiary)}
.clci-expand{appearance:none;border:0;background:none;cursor:pointer;color:var(--dsw-alias-label-tertiary);font-size:12px;padding:0 4px}
.clci-expand:hover{color:var(--dsw-alias-label-primary)}
.clci-scan-list{list-style:none;margin:2px 0 2px 22px;padding:4px 8px;border-left:1px solid var(--dsw-alias-border-l2);display:flex;flex-direction:column;gap:2px}
.clci-scan-item{display:flex;align-items:baseline;gap:8px;font-size:12px;color:var(--dsw-alias-label-secondary);flex-wrap:wrap}
.clci-scan-name{font-weight:500;color:var(--dsw-alias-label-primary)}
.clci-scan-size{color:var(--dsw-alias-label-tertiary);font-size:11px;white-space:nowrap}
.clci-dest{display:flex;flex-direction:column;gap:4px;padding:8px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-3)}
.clci-dest-row{display:flex;align-items:baseline;gap:6px;font-size:12px;color:var(--dsw-alias-label-secondary);flex-wrap:wrap}
.clci-dest-label{white-space:nowrap;color:var(--dsw-alias-label-tertiary)}
.clci-items{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px;max-height:340px;overflow:auto}
.clci-item{border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:10px 12px;display:flex;flex-direction:column;gap:6px;background:var(--dsw-alias-bg-layer-3)}
.clci-item-head{display:flex;align-items:center;gap:8px}
.clci-kind{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary)}
.clci-scope{white-space:nowrap;color:var(--dsw-alias-label-tertiary);font-size:12px}
.clci-badge{white-space:nowrap;border-radius:999px;padding:1px 8px;font-size:11px;font-weight:500;line-height:17px}
.clci-status-new{background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary)}
.clci-status-ok{background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary)}
.clci-status-conflict{background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-error)}
.clci-status-muted{color:var(--dsw-alias-label-tertiary);background:var(--dsw-alias-bg-layer-2)}
.clci-path{font-size:11px;color:var(--dsw-alias-label-tertiary);margin:0;word-break:break-all;line-height:1.5}
.clci-summary{font-size:12px;color:var(--dsw-alias-label-secondary);margin:0;line-height:1.6}
.clci-item-foot{display:flex;justify-content:flex-end}
.clci-select{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);height:28px;font:inherit;color:var(--dsw-alias-label-primary);border-radius:8px;padding:0 8px;font-size:12px}
.clci-monospace{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11px;color:var(--dsw-alias-label-secondary);margin:0;word-break:break-all;line-height:1.5}
.clci-error{color:var(--dsw-alias-label-error);font-size:12px;margin:0;line-height:1.6}
`;

    return { apply, inject };
  },
});
