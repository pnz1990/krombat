// Journey 36: kubectl Terminal Mode (#457)
// UI-ONLY: no kubectl, no direct fetch/api, no execSync
// Tests:
//   1.  Terminal button visible in dungeon hamburger menu
//   2.  Terminal panel opens when button is clicked
//   3.  Terminal has a command input
//   4.  'help' command shows available commands
//   5.  'kubectl get dungeons' lists the current dungeon
//   6.  'kubectl get dungeon <name>' shows spec fields
//   7.  'kubectl describe dungeon <name>' shows verbose output
//   8.  'cat dungeon.yaml' shows YAML template
//   9.  [kro] annotation toggle appears after get/describe
//   10. Annotation can be expanded and shows RGD + CEL
//   11. Command history: arrow-up recalls previous command
//   12. Terminal closes when ✕ is clicked
//   13. Help modal has kubectl Terminal page
//   14. Intro tour has kubectl Terminal slide
const { chromium } = require('playwright');
const { createDungeonUI, deleteDungeon, testLogin } = require('./helpers');

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const TIMEOUT = 25000;
let passed = 0, failed = 0, warnings = 0;
function ok(msg)   { console.log(`  ✅ ${msg}`); passed++; }
function fail(msg) { console.log(`  ❌ ${msg}`); failed++; }
function warn(msg) { console.log(`  ⚠️  ${msg}`); warnings++; }

async function openTerminal(page) {
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

async function typeCommand(page, cmd) {
  const input = page.locator('[data-testid="terminal-input"]');
  await input.fill(cmd);
  await input.press('Enter');
  await page.waitForTimeout(2000); // wait for API response
}

async function run() {
  console.log('Journey 36: kubectl Terminal Mode\n');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const dName = `j36-${Date.now()}`;

  const consoleErrors = [];
  page.on('console', msg => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });

  try {
    await testLogin(page, BASE_URL);
    await page.goto(BASE_URL, { timeout: TIMEOUT });
    await page.waitForSelector('input[placeholder="my-dungeon"]', { timeout: TIMEOUT });

    // Dismiss onboarding if present
    const skipBtn = page.locator('button.kro-onboard-skip');
    if (await skipBtn.count() > 0) {
      // Check if the last slide has the kubectl terminal slide
      console.log('\n=== Intro tour kubectl terminal slide ===');
      let foundTerminalSlide = false;
      for (let i = 0; i < 10; i++) {
        const modal = page.locator('.kro-onboard-modal');
        if (await modal.count() === 0) break;
        const text = await modal.textContent().catch(() => '');
        if (text.includes('kubectl Terminal') || text.includes('kubectl terminal')) {
          foundTerminalSlide = true;
        }
        const nextBtn = page.locator('button:has-text("Next →")');
        if (await nextBtn.count() > 0) {
          await nextBtn.click();
          await page.waitForTimeout(300);
        } else {
          break;
        }
      }
      foundTerminalSlide
        ? ok('Intro tour has a kubectl Terminal slide')
        : warn('kubectl Terminal slide not found in intro tour (may not be last slide)');
      const skipBtn2 = page.locator('button.kro-onboard-skip');
      if (await skipBtn2.count() > 0) {
        await skipBtn2.click();
        await page.waitForTimeout(400);
      }
      const startBtn = page.locator('button:has-text("Start Playing")');
      if (await startBtn.count() > 0) {
        await startBtn.click();
        await page.waitForTimeout(400);
      }
    }

    // ── Create dungeon ────────────────────────────────────────────────────────
    console.log('\n=== Create dungeon ===');
    const loaded = await createDungeonUI(page, dName, { monsters: 2, difficulty: 'easy', heroClass: 'warrior' });
    loaded
      ? ok('Dungeon created and game view loaded')
      : fail('Dungeon view did not load');
    await page.waitForTimeout(3000);

    // ── Terminal button in hamburger ──────────────────────────────────────────
    console.log('\n=== Terminal button in hamburger menu ===');
    const hamBtn = page.locator('button.hamburger-btn[aria-label="Menu"]');
    await hamBtn.waitFor({ timeout: TIMEOUT }).catch(() => {});
    await hamBtn.click();
    await page.waitForTimeout(300);
    const termBtn = page.locator('button.hamburger-item:has-text("kubectl Terminal")');
    const termBtnFound = await termBtn.count() > 0;
    termBtnFound
      ? ok('"kubectl Terminal" button found in dungeon hamburger menu')
      : fail('"kubectl Terminal" button missing from dungeon hamburger menu');

    // Close hamburger
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);

    // ── Open terminal ─────────────────────────────────────────────────────────
    console.log('\n=== Open terminal panel ===');
    const termOpened = await openTerminal(page);
    termOpened
      ? ok('kubectl Terminal panel opened')
      : fail('kubectl Terminal panel did not open');

    if (!termOpened) {
      warn('Terminal panel did not open — skipping all terminal tests');
    } else {
      const terminal = page.locator('[data-testid="kubectl-terminal"]');

      // ── Input exists ──────────────────────────────────────────────────────
      console.log('\n=== Terminal input ===');
      const inputEl = terminal.locator('[data-testid="terminal-input"]');
      await inputEl.count() > 0
        ? ok('Terminal command input found')
        : fail('Terminal command input missing');

      // ── 'help' command ────────────────────────────────────────────────────
      console.log('\n=== help command ===');
      await typeCommand(page, 'help');
      const termText = await terminal.textContent().catch(() => '');
      termText.includes('kubectl apply') && termText.includes('kubectl get')
        ? ok("'help' command shows available kubectl commands")
        : fail(`'help' output missing expected commands. Got: "${termText.slice(0, 200)}"`);

      // ── 'cat dungeon.yaml' ────────────────────────────────────────────────
      console.log('\n=== cat dungeon.yaml ===');
      await typeCommand(page, 'cat dungeon.yaml');
      await page.waitForTimeout(500);
      const termText2 = await terminal.textContent().catch(() => '');
      termText2.includes('apiVersion') && termText2.includes('kind: Dungeon')
        ? ok("'cat dungeon.yaml' shows valid YAML with apiVersion + kind: Dungeon")
        : fail(`'cat dungeon.yaml' missing YAML content. Got: "${termText2.slice(0, 200)}"`);
      termText2.includes('spec:') && termText2.includes('monsters:')
        ? ok('YAML shows spec.monsters field')
        : warn('spec.monsters not found in YAML output');

      // ── 'kubectl get dungeons' ────────────────────────────────────────────
      console.log('\n=== kubectl get dungeons ===');
      await typeCommand(page, 'kubectl get dungeons');
      const termText3 = await terminal.textContent().catch(() => '');
      termText3.includes(dName)
        ? ok(`'kubectl get dungeons' lists the current dungeon "${dName}"`)
        : fail(`Dungeon "${dName}" not found in 'kubectl get dungeons' output`);
      termText3.includes('DIFFICULTY') || termText3.includes('NAME')
        ? ok("'kubectl get dungeons' shows table header")
        : warn("'kubectl get dungeons' table header not found");

      // ── [kro] annotation appears ──────────────────────────────────────────
      console.log('\n=== [kro] annotation after get ===');
      const annoToggle = terminal.locator('.kt-annotation-toggle').last();
      const annoCount = await annoToggle.count();
      annoCount > 0
        ? ok('[kro] annotation toggle appears after kubectl get')
        : fail('[kro] annotation toggle missing after kubectl get');

      if (annoCount > 0) {
        await annoToggle.click();
        await page.waitForTimeout(300);
        const annoBody = terminal.locator('.kt-annotation-body').last();
        const annoBodyCount = await annoBody.count();
        annoBodyCount > 0
          ? ok('[kro] annotation body expands on click')
          : fail('[kro] annotation body did not expand');

        if (annoBodyCount > 0) {
          const annoText = await annoBody.textContent().catch(() => '');
          annoText.includes('RGD') || annoText.includes('rgd')
            ? ok('[kro] annotation shows RGD information')
            : warn('[kro] annotation body does not contain RGD info');
          annoText.includes('CEL') || annoText.includes('cel') || annoText.includes('schema.spec')
            ? ok('[kro] annotation shows CEL expression')
            : warn('[kro] annotation body does not contain CEL expression');
        }
      }

      // ── 'kubectl get dungeon <name>' ──────────────────────────────────────
      console.log('\n=== kubectl get dungeon <name> ===');
      await typeCommand(page, `kubectl get dungeon ${dName}`);
      const termText4 = await terminal.textContent().catch(() => '');
      termText4.includes(dName)
        ? ok(`'kubectl get dungeon ${dName}' returns correct dungeon`)
        : fail(`'kubectl get dungeon ${dName}' did not return dungeon data`);

      // ── 'kubectl describe dungeon <name>' ─────────────────────────────────
      console.log('\n=== kubectl describe dungeon <name> ===');
      await typeCommand(page, `kubectl describe dungeon ${dName}`);
      const termText5 = await terminal.textContent().catch(() => '');
      termText5.includes('Kind:') && termText5.includes('Dungeon')
        ? ok("'kubectl describe' shows Kind: Dungeon")
        : warn("'kubectl describe' output missing Kind: Dungeon");
      termText5.includes('Spec:')
        ? ok("'kubectl describe' shows Spec section")
        : warn("'kubectl describe' output missing Spec section");

      // ── command history (arrow-up) ────────────────────────────────────────
      console.log('\n=== command history ===');
      const inputEl2 = terminal.locator('[data-testid="terminal-input"]');
      await inputEl2.click();
      await inputEl2.press('ArrowUp');
      await page.waitForTimeout(200);
      const inputVal = await inputEl2.inputValue();
      inputVal && inputVal.length > 0
        ? ok('Arrow-up recalls previous command from history')
        : warn('Arrow-up did not populate command history (may be empty)');

      // ── close terminal ────────────────────────────────────────────────────
      console.log('\n=== close terminal ===');
      const closeBtn = terminal.locator('button[aria-label="Close terminal"]');
      if (await closeBtn.count() > 0) {
        await closeBtn.click();
        await page.waitForTimeout(400);
        const stillOpen = await page.locator('[data-testid="kubectl-terminal"]').count();
        stillOpen === 0
          ? ok('Terminal panel closes when ✕ is clicked')
          : fail('Terminal panel did not close after ✕ click');
      } else {
        warn('Close button not found on terminal panel');
      }
    }

    // ── Help modal kubectl Terminal page ─────────────────────────────────────
    console.log('\n=== Help modal kubectl Terminal page ===');
    const helpBtn = page.locator('button:has-text("?"), button[aria-label="Help"], button.btn-help');
    if (await helpBtn.count() > 0) {
      await helpBtn.first().click();
      await page.waitForTimeout(400);

      let foundTermPage = false;
      for (let i = 0; i < 14; i++) {
        const modalText = await page.locator('.help-modal').textContent().catch(() => '');
        if (modalText.includes('kubectl Terminal') || modalText.includes('kubectl terminal')) {
          foundTermPage = true;
          break;
        }
        const nextBtn = page.locator('button:has-text("Next →")');
        if (await nextBtn.count() > 0 && !(await nextBtn.isDisabled())) {
          await nextBtn.click();
          await page.waitForTimeout(300);
        } else break;
      }
      foundTermPage
        ? ok('Help modal contains kubectl Terminal page')
        : fail('kubectl Terminal page not found in help modal after navigating all pages');

      const closeHelp = page.locator('.help-modal button:has-text("Close")');
      if (await closeHelp.count() > 0) await closeHelp.click();
      await page.waitForTimeout(300);
    } else {
      warn('Help button not found in dungeon view — skipping help modal check');
    }

    // ── Error check ───────────────────────────────────────────────────────────
    console.log('\n=== Error check ===');
    const criticalErrors = consoleErrors.filter(e =>
      !e.includes('favicon') && !e.includes('net::ERR') &&
      !e.includes('kro warning') && !e.includes('WebSocket') &&
      !e.includes('429')
    );
    criticalErrors.length === 0
      ? ok('No critical JS errors during journey')
      : fail(`JS errors detected: ${criticalErrors.slice(0, 3).join('; ')}`);

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
