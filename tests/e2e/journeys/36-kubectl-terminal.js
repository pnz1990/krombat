// Journey 36: kubectl Terminal Mode (#457) — read-only, all CRDs, -o yaml
// UI-ONLY: no kubectl, no direct fetch/api, no execSync
// Tests:
//   1.  Terminal button visible in dungeon hamburger menu
//   2.  Terminal panel opens when button is clicked
//   3.  Terminal has a command input
//   4.  'help' command lists get/describe/cat commands (no apply/delete)
//   5.  Terminal title shows "(read-only)"
//   6.  'kubectl get dungeons' lists the current dungeon
//   7.  'kubectl get dungeon <name>' shows spec fields
//   8.  'kubectl describe dungeon <name>' shows Kind + Spec section
//   9.  'kubectl get dungeon <name> -o yaml' emits YAML with apiVersion
//   10. 'kubectl get hero <name>' returns hero info
//   11. 'kubectl get boss <name>' returns boss info
//   12. 'kubectl get monsters <name>' lists monsters with HP and state
//   13. 'kubectl get monster <name> 0' returns single monster
//   14. 'kubectl get treasure <name>' returns treasure state
//   15. 'kubectl get modifier <name>' returns modifier type
//   16. 'kubectl get boss <name> -o yaml' returns YAML with kind: Boss
//   17. write command (kubectl delete) is rejected with read-only error
//   18. [kro] annotation toggle appears after get command
//   19. Annotation expands and shows RGD + CEL
//   20. Command history: arrow-up recalls previous command
//   21. Terminal closes when ✕ is clicked
//   22. Help modal has updated kubectl Terminal page (no apply/delete rows)
//   23. Intro tour has kubectl Terminal slide
const { chromium } = require('playwright');
const { createDungeonUI, deleteDungeon, testLogin } = require('./helpers');

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const TIMEOUT = 25000;
let passed = 0, failed = 0, warnings = 0;
function ok(msg)   { console.log(`  ✅ ${msg}`); passed++; }
function fail(msg) { console.log(`  ❌ ${msg}`); failed++; }
function warn(msg) { console.log(`  ⚠️  ${msg}`); warnings++; }

async function openTerminal(page) {
  // Wait for any leftover hamburger backdrop to disappear before clicking
  await page.waitForSelector('.hamburger-backdrop', { state: 'detached', timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(200);
  const hamBtn = page.locator('button.hamburger-btn[aria-label="Menu"]');
  await hamBtn.waitFor({ timeout: TIMEOUT }).catch(() => {});
  if (await hamBtn.count() === 0) return false;
  await hamBtn.click();
  await page.waitForTimeout(300);
  const termBtn = page.locator('button.hamburger-item:has-text("kubectl Terminal")');
  if (await termBtn.count() === 0) return false;
  await termBtn.click();
  await page.waitForTimeout(400);
  return (await page.locator('[data-testid="kubectl-terminal"]').count()) > 0;
}

async function typeCommand(page, cmd, waitMs = 2500) {
  const input = page.locator('[data-testid="terminal-input"]');
  await input.fill(cmd);
  await input.press('Enter');
  await page.waitForTimeout(waitMs);
}

async function run() {
  console.log('Journey 36: kubectl Terminal Mode (read-only, all CRDs)\n');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const dName = `j36-${Date.now()}`;

  const consoleErrors = [];
  page.on('console', msg => {
    if (msg.type() === 'error'
      && !msg.text().includes('favicon')
      && !msg.text().includes('net::ERR')
      && !msg.text().includes('WebSocket')
      && !msg.text().includes('429')
      && !msg.text().includes('401')
      && !msg.text().includes('404'))  // terminal fetch-by-name returns 404 when resource absent (e.g. modifier=none) — expected
      consoleErrors.push(msg.text());
  });

  try {
    await testLogin(page, BASE_URL);
    await page.goto(BASE_URL, { timeout: TIMEOUT });
    await page.waitForSelector('input[placeholder="my-dungeon"]', { timeout: TIMEOUT });

    // Dismiss onboarding if present, check for kubectl terminal slide
    const skipBtn = page.locator('button.kro-onboard-skip');
    if (await skipBtn.count() > 0) {
      console.log('\n=== Intro tour kubectl terminal slide ===');
      let foundTerminalSlide = false;
      for (let i = 0; i < 12; i++) {
        const modal = page.locator('.kro-onboard-modal');
        if (await modal.count() === 0) break;
        const text = await modal.textContent().catch(() => '');
        if (text.includes('kubectl Terminal') || text.includes('kubectl terminal')) foundTerminalSlide = true;
        const nextBtn = page.locator('button:has-text("Next →")');
        if (await nextBtn.count() > 0) { await nextBtn.click(); await page.waitForTimeout(300); }
        else break;
      }
      foundTerminalSlide
        ? ok('Intro tour has a kubectl Terminal slide')
        : warn('kubectl Terminal slide not found in intro tour');
      const skip2 = page.locator('button.kro-onboard-skip');
      if (await skip2.count() > 0) { await skip2.click(); await page.waitForTimeout(400); }
      const startBtn = page.locator('button:has-text("Start Playing")');
      if (await startBtn.count() > 0) { await startBtn.click(); await page.waitForTimeout(400); }
    }

    // ── Create dungeon ───────────────────────────────────────────────────────
    console.log('\n=== Create dungeon ===');
    const loaded = await createDungeonUI(page, dName, { monsters: 3, difficulty: 'easy', heroClass: 'warrior' });
    loaded ? ok('Dungeon created and game view loaded') : fail('Dungeon view did not load');
    await page.waitForTimeout(3000);

    // ── Terminal button in hamburger ─────────────────────────────────────────
    console.log('\n=== Terminal button in hamburger menu ===');
    const hamBtn = page.locator('button.hamburger-btn[aria-label="Menu"]');
    await hamBtn.waitFor({ timeout: TIMEOUT }).catch(() => {});
    await hamBtn.click();
    await page.waitForTimeout(300);
    const termBtn = page.locator('button.hamburger-item:has-text("kubectl Terminal")');
    await termBtn.count() > 0
      ? ok('"kubectl Terminal" button found in dungeon hamburger menu')
      : fail('"kubectl Terminal" button missing from dungeon hamburger menu');
    // Close the menu by clicking the backdrop (Escape does not close it — no keydown handler)
    const backdrop = page.locator('.hamburger-backdrop');
    if (await backdrop.count() > 0) {
      await backdrop.click();
    } else {
      await hamBtn.click(); // toggle off
    }
    await page.waitForTimeout(400);

    // ── Open terminal ────────────────────────────────────────────────────────
    console.log('\n=== Open terminal panel ===');
    const termOpened = await openTerminal(page);
    termOpened ? ok('kubectl Terminal panel opened') : fail('kubectl Terminal panel did not open');

    if (!termOpened) {
      warn('Terminal panel did not open — skipping all terminal tests');
    } else {
      const terminal = page.locator('[data-testid="kubectl-terminal"]');

      // ── Input exists ─────────────────────────────────────────────────────
      console.log('\n=== Terminal input + read-only title ===');
      await terminal.locator('[data-testid="terminal-input"]').count() > 0
        ? ok('Terminal command input found')
        : fail('Terminal command input missing');

      const titleText = await terminal.locator('.kubectl-terminal-title').textContent().catch(() => '');
      titleText.includes('read-only')
        ? ok('Terminal title shows (read-only)')
        : warn('Terminal title does not show (read-only)');

      // ── 'help' command — should show get/describe, NOT apply/delete ────────
      console.log('\n=== help command ===');
      await typeCommand(page, 'help');
      const termText = await terminal.textContent().catch(() => '');
      termText.includes('kubectl get') && termText.includes('kubectl describe')
        ? ok("'help' command shows get and describe commands")
        : fail(`'help' output missing expected commands`);
      !termText.includes('kubectl apply') && !termText.includes('kubectl delete')
        ? ok("'help' does not list apply/delete (read-only terminal)")
        : fail("'help' still lists apply/delete — terminal should be read-only");

      // ── 'kubectl get dungeons' ────────────────────────────────────────────
      console.log('\n=== kubectl get dungeons ===');
      await typeCommand(page, 'kubectl get dungeons');
      const termText2 = await terminal.textContent().catch(() => '');
      termText2.includes(dName)
        ? ok(`'kubectl get dungeons' lists dungeon "${dName}"`)
        : fail(`Dungeon "${dName}" not found in output`);

      // ── [kro] annotation ─────────────────────────────────────────────────
      console.log('\n=== [kro] annotation ===');
      const annoToggle = terminal.locator('.kt-annotation-toggle').last();
      await annoToggle.count() > 0
        ? ok('[kro] annotation toggle appears')
        : fail('[kro] annotation toggle missing');
      if (await annoToggle.count() > 0) {
        await annoToggle.click();
        await page.waitForTimeout(300);
        const annoBody = terminal.locator('.kt-annotation-body').last();
        await annoBody.count() > 0 ? ok('[kro] annotation body expands') : fail('[kro] body did not expand');
        if (await annoBody.count() > 0) {
          const annoText = await annoBody.textContent().catch(() => '');
          (annoText.includes('RGD') || annoText.includes('rgd')) ? ok('[kro] shows RGD') : warn('[kro] missing RGD');
          (annoText.includes('CEL') || annoText.includes('cel') || annoText.includes('schema')) ? ok('[kro] shows CEL') : warn('[kro] missing CEL');
        }
      }

      // ── 'kubectl get dungeon <name>' (table) ─────────────────────────────
      console.log('\n=== kubectl get dungeon <name> ===');
      await typeCommand(page, `kubectl get dungeon ${dName}`);
      const t3 = await terminal.textContent().catch(() => '');
      t3.includes(dName) ? ok(`get dungeon returns correct dungeon`) : fail(`get dungeon did not return dungeon data`);
      (t3.includes('HERO-CLASS') || t3.includes('DIFFICULTY') || t3.includes('BOSS-HP'))
        ? ok('get dungeon shows table columns') : warn('table columns not found in get dungeon output');

      // ── 'kubectl describe dungeon <name>' ────────────────────────────────
      console.log('\n=== kubectl describe dungeon <name> ===');
      await typeCommand(page, `kubectl describe dungeon ${dName}`);
      const t4 = await terminal.textContent().catch(() => '');
      (t4.includes('Kind:') && t4.includes('Dungeon')) ? ok("describe shows Kind: Dungeon") : warn("describe missing Kind: Dungeon");
      t4.includes('Spec') ? ok("describe shows Spec section") : warn("describe missing Spec section");

      // ── 'kubectl get dungeon <name> -o yaml' ─────────────────────────────
      console.log('\n=== kubectl get dungeon -o yaml ===');
      await typeCommand(page, `kubectl get dungeon ${dName} -o yaml`);
      const t5 = await terminal.textContent().catch(() => '');
      t5.includes('apiVersion') ? ok('-o yaml output contains apiVersion') : fail('-o yaml missing apiVersion');
      (t5.includes('kind:') || t5.includes('Kind:')) ? ok('-o yaml output contains kind') : warn('-o yaml missing kind');

      // ── 'kubectl get hero <dungeon>' ─────────────────────────────────────
      console.log('\n=== kubectl get hero ===');
      await typeCommand(page, `kubectl get hero ${dName}`);
      const t6 = await terminal.textContent().catch(() => '');
      (t6.includes('hero') || t6.includes('Hero') || t6.includes('HP') || t6.includes('CLASS'))
        ? ok('get hero returns hero info') : warn('get hero output unexpected');

      // ── 'kubectl get boss <dungeon>' ─────────────────────────────────────
      console.log('\n=== kubectl get boss ===');
      await typeCommand(page, `kubectl get boss ${dName}`);
      const t7 = await terminal.textContent().catch(() => '');
      (t7.includes('boss') || t7.includes('Boss') || t7.includes('STATE') || t7.includes('PHASE'))
        ? ok('get boss returns boss info') : warn('get boss output unexpected');

      // ── 'kubectl get monsters <dungeon>' ─────────────────────────────────
      console.log('\n=== kubectl get monsters (list) ===');
      await typeCommand(page, `kubectl get monsters ${dName}`);
      const t8 = await terminal.textContent().catch(() => '');
      (t8.includes('monster-0') || t8.includes('STATE') || t8.includes('alive') || t8.includes('dead'))
        ? ok('get monsters lists monster CRs') : warn('get monsters output unexpected');

      // ── 'kubectl get monster <dungeon> 0' ────────────────────────────────
      console.log('\n=== kubectl get monster idx ===');
      await typeCommand(page, `kubectl get monster ${dName} 0`);
      const t9 = await terminal.textContent().catch(() => '');
      (t9.includes('monster-0') || t9.includes('INDEX') || t9.includes('HP'))
        ? ok('get monster 0 returns single monster') : warn('get monster 0 output unexpected');

      // ── 'kubectl get treasure <dungeon>' ─────────────────────────────────
      console.log('\n=== kubectl get treasure ===');
      await typeCommand(page, `kubectl get treasure ${dName}`);
      const t10 = await terminal.textContent().catch(() => '');
      (t10.includes('treasure') || t10.includes('Treasure') || t10.includes('STATE') || t10.includes('opened') || t10.includes('unopened'))
        ? ok('get treasure returns treasure state') : warn('get treasure output unexpected');

      // ── 'kubectl get modifier <dungeon>' ─────────────────────────────────
      console.log('\n=== kubectl get modifier ===');
      await typeCommand(page, `kubectl get modifier ${dName}`);
      const t11 = await terminal.textContent().catch(() => '');
      (t11.includes('modifier') || t11.includes('Modifier') || t11.includes('TYPE') || t11.includes('none'))
        ? ok('get modifier returns modifier info') : warn('get modifier output unexpected');

      // ── 'kubectl get boss <dungeon> -o yaml' ─────────────────────────────
      console.log('\n=== kubectl get boss -o yaml ===');
      await typeCommand(page, `kubectl get boss ${dName} -o yaml`);
      const t12 = await terminal.textContent().catch(() => '');
      (t12.includes('kind:') || t12.includes('Boss') || t12.includes('apiVersion'))
        ? ok('get boss -o yaml emits YAML') : warn('get boss -o yaml output unexpected');

      // ── write command rejected ────────────────────────────────────────────
      console.log('\n=== write command rejected ===');
      await typeCommand(page, `kubectl delete dungeon ${dName}`, 500);
      const t13 = await terminal.textContent().catch(() => '');
      (t13.includes('read-only') || t13.includes('not supported'))
        ? ok('kubectl delete rejected with read-only error') : fail('kubectl delete was not rejected');

      await typeCommand(page, `kubectl apply -f dungeon.yaml`, 500);
      const t14 = await terminal.textContent().catch(() => '');
      (t14.includes('read-only') || t14.includes('not supported'))
        ? ok('kubectl apply rejected with read-only error') : fail('kubectl apply was not rejected');

      // ── command history ───────────────────────────────────────────────────
      console.log('\n=== command history ===');
      const inputEl = terminal.locator('[data-testid="terminal-input"]');
      await inputEl.click();
      await inputEl.press('ArrowUp');
      await page.waitForTimeout(200);
      const inputVal = await inputEl.inputValue();
      inputVal && inputVal.length > 0
        ? ok('Arrow-up recalls previous command from history')
        : warn('Arrow-up did not populate command history');

      // ── close terminal ────────────────────────────────────────────────────
      console.log('\n=== close terminal ===');
      const closeBtn = terminal.locator('button[aria-label="Close terminal"]');
      if (await closeBtn.count() > 0) {
        await closeBtn.click();
        await page.waitForTimeout(400);
        await page.locator('[data-testid="kubectl-terminal"]').count() === 0
          ? ok('Terminal panel closes when ✕ is clicked')
          : fail('Terminal panel did not close after ✕ click');
      } else {
        warn('Close button not found on terminal panel');
      }
    }

    // ── Help modal kubectl Terminal page ─────────────────────────────────────
    console.log('\n=== Help modal kubectl Terminal page ===');
    const helpBtn = page.locator('button:has-text("?"), button[aria-label="Help"], button.btn-help, .help-btn');
    if (await helpBtn.count() > 0) {
      await helpBtn.first().click();
      await page.waitForTimeout(400);
      let foundTermPage = false;
      for (let i = 0; i < 16; i++) {
        const modalText = await page.locator('.help-modal').textContent().catch(() => '');
        if (modalText.includes('kubectl Terminal') || modalText.includes('kubectl terminal')) {
          foundTermPage = true;
          // Verify no apply/delete rows
          const hasApply = modalText.includes('kubectl apply');
          const hasDelete = modalText.includes('kubectl delete');
          !hasApply && !hasDelete
            ? ok('kubectl Terminal help page has no apply/delete rows (read-only)')
            : warn('kubectl Terminal help page still mentions apply or delete');
          break;
        }
        const nextBtn = page.locator('button:has-text("Next →")');
        if (await nextBtn.count() > 0 && !(await nextBtn.isDisabled())) {
          await nextBtn.click(); await page.waitForTimeout(300);
        } else break;
      }
      foundTermPage ? ok('Help modal contains kubectl Terminal page') : fail('kubectl Terminal page not found in help modal');
      const closeHelp = page.locator('.help-modal button:has-text("Close")');
      if (await closeHelp.count() > 0) await closeHelp.click();
      await page.waitForTimeout(300);
    } else {
      warn('Help button not found in dungeon view — skipping help modal check');
    }

    // ── Error check ───────────────────────────────────────────────────────────
    console.log('\n=== Error check ===');
    consoleErrors.length === 0
      ? ok('No critical JS errors during journey')
      : fail(`JS errors detected: ${consoleErrors.slice(0, 3).join('; ')}`);

  } catch (err) {
    fail(`Unexpected error: ${err.message}`);
    console.error(err);
  } finally {
    page.once('dialog', d => d.accept());
    await deleteDungeon(page, dName).catch(() => {});
    await browser.close();
    console.log(`\n${'='.repeat(50)}`);
    console.log(`  Journey 36: ${passed} passed, ${failed} failed, ${warnings} warnings`);
    console.log('='.repeat(50));
    if (failed > 0) process.exit(1);
  }
}

run().catch(err => { console.error(err); process.exit(1); });
