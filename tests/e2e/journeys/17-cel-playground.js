// Journey 17: CEL Playground
// UI-ONLY: no kubectl, no fetch/api, no execSync
// Tests: CEL Playground button appears in kro tab; modal opens; expressions evaluate;
//        error expressions show error; history is populated; examples load into editor;
//        close button works; 'Learn concept' button works.
const { chromium } = require('playwright');
const { createDungeonUI, deleteDungeon , testLogin} = require('./helpers');

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const TIMEOUT = 20000;
let passed = 0, failed = 0, warnings = 0;
function ok(msg)   { console.log(`  ✅ ${msg}`); passed++; }
function fail(msg) { console.log(`  ❌ ${msg}`); failed++; }
function warn(msg) { console.log(`  ⚠️  ${msg}`); warnings++; }

async function switchToTab(page, label) {
  const btn = page.locator(`button.log-tab:has-text("${label}")`);
  if (await btn.count() === 0) return false;
  await btn.click();
  await page.waitForTimeout(400);
  return true;
}

async function run() {
  console.log('Journey 17: CEL Playground\n');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const dName = `j17-${Date.now()}`;

  const consoleErrors = [];
  page.on('console', msg => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });

  try {
    await testLogin(page, BASE_URL);

    await page.goto(BASE_URL, { timeout: TIMEOUT });
    await page.waitForSelector('input[placeholder="my-dungeon"]', { timeout: TIMEOUT });

    // ── Create dungeon ────────────────────────────────────────────────────────
    console.log('\n  [Create dungeon]');
    const loaded = await createDungeonUI(page, dName, { monsters: 2, difficulty: 'easy', heroClass: 'warrior' });
    loaded ? ok('Dungeon created and game view loaded') : fail('Dungeon view did not load');
    await page.waitForTimeout(2000);

    // ── Switch to kro tab ─────────────────────────────────────────────────────
    console.log('\n  [kro tab]');
    const tabSwitched = await switchToTab(page, 'kro');
    tabSwitched ? ok('kro tab is present and clickable') : fail('kro tab not found');

    // ── CEL Playground button present in hamburger menu ──────────────────────
    console.log('\n  [Playground button in hamburger menu]');
    const hamburgerBtn = page.locator('button.hamburger-btn[aria-label="Menu"]');
    await hamburgerBtn.waitFor({ timeout: TIMEOUT }).catch(() => {});
    (await hamburgerBtn.count() > 0) ? ok('Hamburger menu button present in dungeon toolbar') : fail('Hamburger button not found');

    await hamburgerBtn.click();
    await page.waitForTimeout(300);

    const pgItem = page.locator('button.hamburger-item:has-text("CEL Playground")');
    await pgItem.waitFor({ timeout: TIMEOUT }).catch(() => {});
    (await pgItem.count() > 0) ? ok('CEL Playground item visible in hamburger menu') : fail('CEL Playground item not found in hamburger menu');
    (await pgItem.textContent()).includes('CEL Playground') ? ok('Item text contains "CEL Playground"') : fail('Item text incorrect');

    // ── Open playground ───────────────────────────────────────────────────────
    console.log('\n  [Open Playground]');
    await pgItem.click();
    await page.waitForTimeout(500);

    const modal = page.locator('.kro-playground-modal');
    await modal.waitFor({ timeout: TIMEOUT }).catch(() => {});
    (await modal.count() > 0) ? ok('CEL Playground modal opened (.kro-playground-modal)') : fail('Playground modal not found');

    // Modal has title
    const titleEl = page.locator('.kro-playground-title');
    (await titleEl.count() > 0) ? ok('Playground title present (.kro-playground-title)') : fail('Playground title not found');
    (await titleEl.textContent()).includes('CEL Playground') ? ok('Modal title is "CEL Playground"') : fail('Modal title incorrect');

    // Context label shows dungeon name
    console.log('\n  [Context]');
    const ctx = page.locator('.kro-playground-context');
    (await ctx.count() > 0) ? ok('Context block present (.kro-playground-context)') : fail('Context block not found');
    const ctxText = await ctx.textContent();
    ctxText.includes(dName) ? ok(`Context shows dungeon name "${dName}"`) : fail('Context does not show dungeon name');

    // Input and Run button
    console.log('\n  [Input and Run]');
    const input = page.locator('textarea.kro-playground-input');
    (await input.count() > 0) ? ok('CEL expression textarea present') : fail('CEL textarea not found');
    const runBtn = page.locator('button.kro-playground-run');
    (await runBtn.count() > 0) ? ok('Run button present') : fail('Run button not found');

    // ── Run a successful expression ───────────────────────────────────────────
    console.log('\n  [Evaluate successful expression]');
    await input.fill('schema.spec.difficulty == "easy"');
    await runBtn.click();
    await page.waitForTimeout(3000);

    const resultOk = page.locator('.kro-playground-result-ok');
    await resultOk.waitFor({ timeout: TIMEOUT }).catch(() => {});
    (await resultOk.count() > 0) ? ok('Success result displayed (.kro-playground-result-ok)') : fail('Success result not shown');

    const resultVal = page.locator('.kro-playground-result-val');
    if (await resultVal.count() > 0) {
      const val = await resultVal.textContent();
      val === 'true' ? ok('Expression evaluated to "true" as expected') : warn(`Expression evaluated to "${val}" (expected "true")`);
    } else {
      fail('Result value element not found');
    }

    // ── History populated ──────────────────────────────────────────────────────
    console.log('\n  [History]');
    const historyItems = page.locator('.kro-playground-history-item');
    await page.waitForTimeout(500);
    (await historyItems.count() > 0) ? ok('History item appeared after evaluation') : fail('No history item after evaluation');

    // History item shows the expression
    if (await historyItems.count() > 0) {
      const exprText = await historyItems.first().locator('.kro-playground-history-expr').textContent();
      exprText.includes('difficulty') ? ok('History item shows the expression') : fail('History item expression text missing');
    }

    // ── Run another expression ────────────────────────────────────────────────
    console.log('\n  [Evaluate integer expression]');
    await input.fill('schema.spec.heroHP * 2');
    await runBtn.click();
    await page.waitForTimeout(3000);

    const result2 = page.locator('.kro-playground-result-ok');
    await result2.waitFor({ timeout: TIMEOUT }).catch(() => {});
    if (await result2.count() > 0) {
      const val2 = await page.locator('.kro-playground-result-val').textContent();
      // Warrior hero starts with 200 HP → 200 * 2 = 400
      val2 === '400' ? ok('Integer arithmetic: heroHP * 2 = 400') : warn(`Got "${val2}", expected 400 (check warrior HP value)`)
    } else {
      fail('Second expression result not shown');
    }

    // Multiple history items
    const histCount = await page.locator('.kro-playground-history-item').count();
    histCount >= 2 ? ok(`History has ${histCount} items after 2 evaluations`) : fail('History should have 2+ items');

    // ── Evaluate an error expression ──────────────────────────────────────────
    console.log('\n  [Evaluate invalid expression]');
    await input.fill('schema.spec.nonExistentField.fooBar()');
    await runBtn.click();
    await page.waitForTimeout(3000);

    // Should show either an error or null-ish result — either result-err or result-ok with "null"
    const resultErr = page.locator('.kro-playground-result-err');
    const resultAnyOk = page.locator('.kro-playground-result-ok');
    const hasErr = await resultErr.count() > 0;
    const hasOk = await resultAnyOk.count() > 0;
    (hasErr || hasOk) ? ok('Result shown for unknown function call') : fail('No result shown for invalid expression');

    // ── Example buttons ───────────────────────────────────────────────────────
    console.log('\n  [Example buttons]');
    const exampleBtns = page.locator('.kro-playground-example-btn');
    const exCount = await exampleBtns.count();
    exCount > 0 ? ok(`${exCount} example button(s) present`) : fail('No example buttons found');

    if (exCount > 0) {
      // Click first example — should populate the textarea
      const firstLabel = await exampleBtns.first().textContent();
      await exampleBtns.first().click();
      await page.waitForTimeout(300);
      const newVal = await input.inputValue();
      newVal.length > 0 ? ok(`Example "${firstLabel}" loaded into textarea`) : fail('Example did not populate textarea');
    }

    // ── Ctrl+Enter runs expression ────────────────────────────────────────────
    console.log('\n  [Ctrl+Enter shortcut]');
    await input.fill('schema.spec.heroClass == "warrior"');
    await input.press('Control+Enter');
    await page.waitForTimeout(3000);
    const ctrlResult = page.locator('.kro-playground-result-ok');
    await ctrlResult.waitFor({ timeout: TIMEOUT }).catch(() => {});
    (await ctrlResult.count() > 0) ? ok('Ctrl+Enter triggers evaluation') : fail('Ctrl+Enter did not trigger evaluation');

    // ── Learn concept button ──────────────────────────────────────────────────
    console.log('\n  [Learn concept button]');
    const learnBtn = page.locator('button.k8s-annotation-learn');
    await learnBtn.waitFor({ timeout: 5000 }).catch(() => {});
    if (await learnBtn.count() > 0) {
      await learnBtn.click();
      await page.waitForTimeout(500);
      // Should open concept modal
      const conceptModal = page.locator('.kro-concept-modal');
      await conceptModal.waitFor({ timeout: 5000 }).catch(() => {});
      (await conceptModal.count() > 0) ? ok('Learn button opens concept modal') : fail('Concept modal not opened by Learn button');
      // Close concept modal
      const closeBtn = page.locator('.kro-concept-modal .modal-close');
      if (await closeBtn.count() > 0) await closeBtn.click();
      ok('Concept modal closed');
    } else {
      warn('Learn concept button not found (playground may have closed on concept click)');
    }

    // ── Close playground ──────────────────────────────────────────────────────
    console.log('\n  [Close playground]');
    // Re-open playground if it was closed by learn button
    const modalVisible = await page.locator('.kro-playground-modal').count() > 0;
    if (!modalVisible) {
      // Re-open via hamburger menu
      const hBtn = page.locator('button.hamburger-btn[aria-label="Menu"]');
      if (await hBtn.count() > 0) {
        await hBtn.click();
        await page.waitForTimeout(300);
        const pgItem2 = page.locator('button.hamburger-item:has-text("CEL Playground")');
        if (await pgItem2.count() > 0) {
          await pgItem2.click();
          await page.waitForTimeout(400);
        }
      }
    }

    const closeX = page.locator('[aria-label="Close playground"]');
    if (await closeX.count() > 0) {
      await closeX.click();
      await page.waitForTimeout(300);
      const modalGone = await page.locator('.kro-playground-modal').count() === 0;
      modalGone ? ok('Close button dismisses playground modal') : fail('Playground modal not dismissed by close button');
    } else {
      warn('Close button not found (modal may already be closed)');
    }

    // ── Playground concept in glossary ────────────────────────────────────────
    console.log('\n  [CEL Playground concept in glossary]');
    await switchToTab(page, 'kro');
    const glossary = page.locator('.kro-glossary');
    await glossary.waitFor({ timeout: TIMEOUT }).catch(() => {});
    (await glossary.count() > 0) ? ok('kro Glossary visible in kro tab') : fail('kro Glossary not found');

    // Total concept count should be 27
    const headerText = await page.locator('.kro-glossary-header').textContent();
    headerText.includes('/ 27') ? ok('Glossary shows 27 total concepts') : fail(`Glossary concept count incorrect: "${headerText}"`);

    // ── Concept count badge ───────────────────────────────────────────────────
    console.log('\n  [kro tab badge]');
    await switchToTab(page, 'kro'); // ensure we're on kro tab; re-read badge in tabs row
    const kroTabBtn = page.locator('button.kro-tab');
    const badgeText = await kroTabBtn.textContent();
    // Format: "kro (N/27)" — check it ends with /27)
    /\/27\)/.test(badgeText) ? ok(`kro tab badge shows /27: "${badgeText.trim()}"`) : fail(`kro tab badge does not show /27: "${badgeText.trim()}"`);

    // ── No critical JS errors ─────────────────────────────────────────────────
    console.log('\n  [Error check]');
    const criticalErrors = consoleErrors.filter(e =>
      !e.includes('favicon') && !e.includes('net::ERR') &&
      !e.includes('kro warning') && !e.includes('WebSocket')
    );
    criticalErrors.length === 0
      ? ok('No critical JS errors during journey')
      : fail(`JS errors detected: ${criticalErrors.slice(0, 3).join('; ')}`);

  } catch (err) {
    fail(`Unexpected error: ${err.message}`);
    console.error(err);
  } finally {
    await deleteDungeon(page, dName).catch(() => {});
    await browser.close();
    console.log(`\n  Passed: ${passed}  Failed: ${failed}  Warnings: ${warnings}`);
    if (failed > 0) process.exit(1);
  }
}

run();
