// 用本机已缓存的 Playwright Chromium 打开 DSH GUI，探查设置页入口与插件卡片。
// 用法: node gui-verify.js <step>
const { chromium } = require("C:/Users/TimeCraker/AppData/Local/npm-cache/_npx/86170c4cd1c5da32/node_modules/playwright-core");

const EXE = "C:/Users/TimeCraker/AppData/Local/ms-playwright/chromium-1223/chrome-win64/chrome.exe";
const URL = "http://127.0.0.1:3080/";

(async () => {
  const step = process.argv[2] ?? "explore";
  const browser = await chromium.launch({ executablePath: EXE, headless: true });
  const page = await browser.newPage();
  page.on("console", (msg) => {
    if (msg.type() === "error") console.log("[console.error]", msg.text().slice(0, 200));
  });
  await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(6000);

  if (step === "explore") {
    const texts = await page.$$eval("button, a, [role=button]", (els) =>
      els.map((e) => e.textContent.trim()).filter((t) => t && t.length < 40).slice(0, 60));
    console.log("BUTTONS:", JSON.stringify(texts, null, 2));
    await page.screenshot({ path: "shot-explore.png", fullPage: false });
    console.log("screenshot: shot-explore.png");
  }

  if (step === "card") {
    // 设置 → 插件
    await page.evaluate(() => {
      const btn = [...document.querySelectorAll("button, a")].find((e) => /^设置$/.test(e.textContent.trim()));
      if (btn) btn.click();
    });
    await page.waitForTimeout(3000);
    const pluginsClicked = await page.evaluate(() => {
      const btn = [...document.querySelectorAll("button, a")].find((e) => /^插件$/.test(e.textContent.trim()));
      if (!btn) return false;
      btn.click();
      return true;
    });
    console.log("plugins tab click:", pluginsClicked);
    await page.waitForTimeout(3000);
    await page.screenshot({ path: "shot-plugins.png", fullPage: false });
    const cardTexts = await page.$$eval("li, [class*=card]", (els) =>
      els.map((e) => e.textContent.trim().slice(0, 200)).filter((t) => t && t.length > 5).slice(0, 30));
    console.log("CARDS:", JSON.stringify(cardTexts, null, 2));
    // 打开导入 modal
    const opened = await page.evaluate(() => {
      const btn = [...document.querySelectorAll("button")].find((e) => e.textContent.includes("导入 Claude 配置"));
      if (!btn) return false;
      btn.click();
      return true;
    });
    console.log("import button click:", opened);
    await page.waitForTimeout(2500);
    await page.screenshot({ path: "shot-modal.png", fullPage: false });
    const modalTexts = await page.$$eval("[role=dialog] *, button, label", (els) =>
      els.map((e) => e.textContent.trim()).filter((t) => t && t.length < 60).slice(0, 60));
    console.log("MODAL:", JSON.stringify(modalTexts, null, 2));
  }

  if (step === "run") {
    // 设置 → 插件 → modal → 预览 → 开始导入 → 结果
    await page.evaluate(() => {
      const btn = [...document.querySelectorAll("button, a")].find((e) => /^设置$/.test(e.textContent.trim()));
      if (btn) btn.click();
    });
    await page.waitForTimeout(2500);
    await page.evaluate(() => {
      const btn = [...document.querySelectorAll("button, a")].find((e) => /^插件$/.test(e.textContent.trim()));
      if (btn) btn.click();
    });
    await page.waitForTimeout(2000);
    await page.evaluate(() => {
      const btn = [...document.querySelectorAll("button")].find((e) => e.textContent.includes("导入 Claude 配置"));
      if (btn) btn.click();
    });
    await page.waitForTimeout(1500);
    await page.evaluate(() => {
      const btn = [...document.querySelectorAll("button")].find((e) => /预览落点/.test(e.textContent));
      if (btn) btn.click();
    });
    await page.waitForTimeout(3500);
    const importClicked = await page.evaluate(() => {
      const btn = [...document.querySelectorAll("button")].find((e) => /开始导入/.test(e.textContent));
      if (!btn || btn.disabled) return { clicked: false, disabled: btn?.disabled ?? null };
      btn.click();
      return { clicked: true };
    });
    console.log("import button:", JSON.stringify(importClicked));
    await page.waitForTimeout(5000);
    await page.screenshot({ path: "shot-done.png", fullPage: false });
    const doneTexts = await page.$$eval("[class*=clci-item], [class*=clci-summary]", (els) =>
      els.map((e) => e.textContent.trim().replace(/\s+/g, " ").slice(0, 140)).slice(0, 20));
    console.log("DONE PHASE:", JSON.stringify(doneTexts, null, 2));
  }
  if (step === "scan") {
    // 设置 → 插件 → 打开 modal → 检查勾选行计数与展开明细
    await page.evaluate(() => {
      const btn = [...document.querySelectorAll("button, a")].find((e) => /^设置$/.test(e.textContent.trim()));
      if (btn) btn.click();
    });
    await page.waitForTimeout(2500);
    await page.evaluate(() => {
      const btn = [...document.querySelectorAll("button, a")].find((e) => /^插件$/.test(e.textContent.trim()));
      if (btn) btn.click();
    });
    await page.waitForTimeout(2000);
    await page.evaluate(() => {
      const btn = [...document.querySelectorAll("button")].find((e) => e.textContent.includes("导入 Claude 配置"));
      if (btn) btn.click();
    });
    await page.waitForTimeout(3500);
    const rows = await page.$$eval("li.clci-check-row", (els) =>
      els.map((e) => ({
        label: e.querySelector("label span")?.textContent.trim(),
        count: e.querySelector("[class*=clci-count]")?.textContent.trim(),
        hasExpand: e.querySelector("[class*=clci-expand]") !== null,
      })));
    console.log("CHECK ROWS:", JSON.stringify(rows, null, 2));
    // 展开 Skills 行
    const expandClicked = await page.evaluate(() => {
      const rows = [...document.querySelectorAll("li.clci-check-row")];
      const skills = rows.find((e) => e.textContent.includes("Skills"));
      const btn = skills?.querySelector("[class*=clci-expand]");
      if (!btn) return false;
      btn.click();
      return true;
    });
    console.log("expand skills:", expandClicked);
    await page.waitForTimeout(800);
    await page.screenshot({ path: "shot-scan.png", fullPage: false });
    const scanItems = await page.$$eval("li.clci-scan-item", (els) =>
      els.map((e) => e.textContent.trim().replace(/\s+/g, " ").slice(0, 130)));
    console.log("SCAN ITEMS:", JSON.stringify(scanItems, null, 2));
  }

  if (step === "conflict") {
    // 设置 → 插件 → modal → 预览 → 把 e2e-gui-skill 的策略改为“覆盖” → 开始导入
    await page.evaluate(() => {
      const btn = [...document.querySelectorAll("button, a")].find((e) => /^设置$/.test(e.textContent.trim()));
      if (btn) btn.click();
    });
    await page.waitForTimeout(2500);
    await page.evaluate(() => {
      const btn = [...document.querySelectorAll("button, a")].find((e) => /^插件$/.test(e.textContent.trim()));
      if (btn) btn.click();
    });
    await page.waitForTimeout(2000);
    await page.evaluate(() => {
      const btn = [...document.querySelectorAll("button")].find((e) => e.textContent.includes("导入 Claude 配置"));
      if (btn) btn.click();
    });
    await page.waitForTimeout(1500);
    await page.evaluate(() => {
      const btn = [...document.querySelectorAll("button")].find((e) => /预览落点/.test(e.textContent));
      if (btn) btn.click();
    });
    await page.waitForTimeout(3500);
    // 找到 e2e-gui-skill 的行，读取其状态与当前策略
    const rowInfo = await page.evaluate(() => {
      const items = [...document.querySelectorAll("li.clci-item")];
      const row = items.find((e) => e.textContent.includes("e2e-gui-skill"));
      if (!row) return null;
      const badge = row.querySelector("[class*=clci-badge]")?.textContent.trim();
      const select = row.querySelector("select");
      const before = select?.value ?? null;
      if (select) {
        const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set;
        setter.call(select, "overwrite");
        select.dispatchEvent(new Event("change", { bubbles: true }));
      }
      return { badge, before, after: select?.value ?? null };
    });
    console.log("conflict row:", JSON.stringify(rowInfo));
    await page.waitForTimeout(800);
    const importClicked = await page.evaluate(() => {
      const btn = [...document.querySelectorAll("button")].find((e) => /开始导入/.test(e.textContent));
      if (!btn || btn.disabled) return { clicked: false, disabled: btn?.disabled ?? null };
      btn.click();
      return { clicked: true };
    });
    console.log("import button:", JSON.stringify(importClicked));
    await page.waitForTimeout(5000);
    await page.screenshot({ path: "shot-conflict-done.png", fullPage: false });
    const doneTexts = await page.$$eval("[class*=clci-item]", (els) =>
      els.map((e) => e.textContent.trim().replace(/\s+/g, " ").slice(0, 140)).filter((t) => t.includes("e2e-gui-skill")).slice(0, 4));
    console.log("CONFLICT DONE:", JSON.stringify(doneTexts, null, 2));
  }
  if (step === "preview") {
    // 设置 → 插件 → 打开 modal → 预览落点
    await page.evaluate(() => {
      const btn = [...document.querySelectorAll("button, a")].find((e) => /^设置$/.test(e.textContent.trim()));
      if (btn) btn.click();
    });
    await page.waitForTimeout(2500);
    await page.evaluate(() => {
      const btn = [...document.querySelectorAll("button, a")].find((e) => /^插件$/.test(e.textContent.trim()));
      if (btn) btn.click();
    });
    await page.waitForTimeout(2000);
    await page.evaluate(() => {
      const btn = [...document.querySelectorAll("button")].find((e) => e.textContent.includes("导入 Claude 配置"));
      if (btn) btn.click();
    });
    await page.waitForTimeout(2000);
    const previewClicked = await page.evaluate(() => {
      const btn = [...document.querySelectorAll("button")].find((e) => /预览落点/.test(e.textContent));
      if (!btn) return false;
      btn.click();
      return true;
    });
    console.log("preview button click:", previewClicked);
    await page.waitForTimeout(4000);
    await page.screenshot({ path: "shot-preview.png", fullPage: false });
    const itemTexts = await page.$$eval("[class*=clci-item]", (els) =>
      els.map((e) => e.textContent.trim().replace(/\s+/g, " ").slice(0, 160)).slice(0, 20));
    console.log("PREVIEW ITEMS:", JSON.stringify(itemTexts, null, 2));
  }

  await browser.close();
})().catch((error) => {
  console.error("FATAL", error);
  process.exit(1);
});
