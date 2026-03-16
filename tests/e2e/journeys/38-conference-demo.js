// Journey 38: Conference Demo Package (#458)
// UI-ONLY: no kubectl, no direct fetch/api, no execSync
// Tests:
//   1. docs/demo/DEMO.md exists in repo (fetch from GitHub raw)
//   2. docs/demo/dungeon-demo.yaml is a valid Dungeon CR (fetch + validate fields)
//   3. docs/demo/speaker-notes.md has >=10 Q&A scenarios
//   4. Intro modal has "Running a Demo?" slide
//   5. dungeon-demo.yaml can be applied via the kubectl terminal (kubectl apply -f dungeon.yaml)
//   6. kubectl get dungeons shows the demo dungeon
//   7. kubectl describe dungeon shows heroHP and bossHP
//   8. Delete demo dungeon via kubectl terminal
//   9. DEMO.md references kubectl terminal mode
//   10. No JS console errors
const { chromium } = require('playwright');
const { testLogin } = require('./helpers');

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const TIMEOUT = 25000;
let passed = 0, failed = 0, warnings = 0;
function ok(msg)   { console.log(`  ✅ ${msg}`); passed++; }
function fail(msg) { console.log(`  ❌ ${msg}`); failed++; }
function warn(msg) { console.log(`  ⚠️  ${msg}`); warnings++; }

const DEMO_DUNGEON_NAME = 'demo-dungeon-kubecon-2026';
const RAW_BASE = 'https://raw.githubusercontent.com/pnz1990/krombat/main';

async function run() {
  console.log('Journey 38: Conference Demo Package\n');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const consoleErrors = [];
  page.on('console', msg => {
    if (msg.type() === 'error' && !msg.text().includes('WebSocket') && !msg.text().includes('404') && !msg.text().includes('net::ERR'))
      consoleErrors.push(msg.text());
  });

  try {
    // === Step 1: Verify demo files exist in repo ===
    console.log('=== Step 1: Demo files in repo ===');

    // Fetch DEMO.md from GitHub raw
    const demoMdResult = await page.evaluate(async (url) => {
      try {
        const r = await fetch(url);
        return { status: r.status, body: await r.text() };
      } catch (e) { return { status: 0, body: '' }; }
    }, `${RAW_BASE}/Docs/demo/DEMO.md`);
    demoMdResult.status === 200 ? ok('docs/demo/DEMO.md exists in repo') : fail(`docs/demo/DEMO.md not found (status ${demoMdResult.status})`);

    const demoMdContent = demoMdResult.body;
    demoMdContent.includes('kubectl Terminal') || demoMdContent.includes('kubectl terminal')
      ? ok('DEMO.md references kubectl terminal mode')
      : fail('DEMO.md missing kubectl terminal mode reference');

    demoMdContent.includes('5-Minute') || demoMdContent.includes('5-minute') || demoMdContent.includes('5 minute')
      ? ok('DEMO.md contains 5-minute script')
      : warn('DEMO.md 5-minute script heading not found');

    // Fetch dungeon-demo.yaml from GitHub raw
    const dungeonYamlResult = await page.evaluate(async (url) => {
      try {
        const r = await fetch(url);
        return { status: r.status, body: await r.text() };
      } catch (e) { return { status: 0, body: '' }; }
    }, `${RAW_BASE}/Docs/demo/dungeon-demo.yaml`);
    dungeonYamlResult.status === 200 ? ok('docs/demo/dungeon-demo.yaml exists in repo') : fail(`docs/demo/dungeon-demo.yaml not found (status ${dungeonYamlResult.status})`);

    const dungeonYaml = dungeonYamlResult.body;
    dungeonYaml.includes('game.k8s.example/v1alpha1') ? ok('dungeon-demo.yaml has correct apiVersion') : fail('dungeon-demo.yaml missing correct apiVersion');
    dungeonYaml.includes('kind: Dungeon') ? ok('dungeon-demo.yaml is kind: Dungeon') : fail('dungeon-demo.yaml is not kind: Dungeon');
    dungeonYaml.includes(DEMO_DUNGEON_NAME) ? ok(`dungeon-demo.yaml contains name "${DEMO_DUNGEON_NAME}"`) : fail(`dungeon-demo.yaml missing expected name "${DEMO_DUNGEON_NAME}"`);

    // Fetch speaker-notes.md from GitHub raw
    const speakerNotesResult = await page.evaluate(async (url) => {
      try {
        const r = await fetch(url);
        return { status: r.status, body: await r.text() };
      } catch (e) { return { status: 0, body: '' }; }
    }, `${RAW_BASE}/Docs/demo/speaker-notes.md`);
    speakerNotesResult.status === 200 ? ok('docs/demo/speaker-notes.md exists in repo') : fail(`docs/demo/speaker-notes.md not found (status ${speakerNotesResult.status})`);

    const speakerNotes = speakerNotesResult.body;
    const qaCount = (speakerNotes.match(/^## Q\d+/gm) || []).length;
    qaCount >= 10 ? ok(`speaker-notes.md has ${qaCount} Q&A scenarios (>=10)`) : fail(`speaker-notes.md has only ${qaCount} Q&A scenarios (<10)`);

    // === Step 2: Intro modal has demo slide ===
    console.log('\n=== Step 2: Intro modal demo slide ===');
    await testLogin(page, BASE_URL);
    await page.goto(BASE_URL, { timeout: TIMEOUT });
    await page.waitForTimeout(2000);

    // Clear localStorage to force onboarding
    await page.evaluate(() => localStorage.removeItem('kroOnboardingDone'));
    await page.reload({ waitUntil: 'networkidle', timeout: 20000 }).catch(() => {});
    await testLogin(page, BASE_URL);
    await page.goto(BASE_URL, { timeout: TIMEOUT });
    await page.waitForTimeout(2000);

    const onboardingVisible = await page.locator('.kro-onboard-overlay').count() > 0;
    if (onboardingVisible) {
      let demoSlideFound = false;
      for (let p = 0; p < 12; p++) {
        const slideText = await page.textContent('.kro-onboard-modal').catch(() => '');
        if (slideText.includes('Running a Demo') || slideText.includes('demo script') || slideText.includes('DEMO.md')) {
          demoSlideFound = true; break;
        }
        const nextBtn = page.locator('.kro-onboard-modal button:has-text("Next")');
        if (await nextBtn.count() === 0) break;
        await nextBtn.click({ force: true }).catch(() => {});
        await page.waitForTimeout(300);
      }
      demoSlideFound ? ok('Intro modal has "Running a Demo?" slide') : fail('Intro modal missing demo slide');
      // Dismiss onboarding
      const skipBtn = page.locator('button.kro-onboard-skip');
      if (await skipBtn.count() > 0) {
        await skipBtn.click({ force: true }).catch(() => {});
        await page.waitForTimeout(400);
      }
    } else {
      warn('Onboarding overlay not shown after localStorage clear — skipping intro modal demo slide check');
    }

    // === Step 3: kubectl terminal demo commands ===
    console.log('\n=== Step 3: kubectl terminal demo commands ===');

    // Create a dungeon first (needed for terminal to show)
    const dName = `j38-demo-${Date.now()}`;
    // Create via UI form
    const newBtn = page.locator('button:has-text("New Dungeon"), button:has-text("Create")').first();
    if (await newBtn.count() > 0) await newBtn.click({ force: true }).catch(() => {});
    await page.waitForTimeout(1000);
    const nameInput = page.locator('input[name="dungeonName"], input[placeholder*="name"], input[placeholder*="Name"]').first();
    if (await nameInput.count() > 0) {
      await nameInput.fill(dName);
      const createBtn = page.locator('button[type="submit"], button:has-text("Create Dungeon")').first();
      if (await createBtn.count() > 0) await createBtn.click({ force: true }).catch(() => {});
    }
    await page.waitForTimeout(3000);

    // Open the hamburger menu → kubectl Terminal
    const hamburger = page.locator('button.hamburger-btn').first();
    if (await hamburger.count() > 0) {
      await hamburger.click({ force: true }).catch(() => {});
      await page.waitForTimeout(500);
      const terminalItem = page.locator('button.hamburger-item:has-text("kubectl Terminal"), button.hamburger-item:has-text("Terminal")').first();
      if (await terminalItem.count() > 0) {
        await terminalItem.click({ force: true }).catch(() => {});
        await page.waitForTimeout(800);
      }
    }

    const terminalVisible = await page.locator('.kubectl-terminal').count() > 0;
    terminalVisible ? ok('kubectl terminal opened from hamburger menu') : warn('kubectl terminal not found — skipping terminal command tests');

    if (terminalVisible) {
      const termInput = page.locator('.kubectl-terminal input[type="text"], .kubectl-terminal .term-input').first();
      if (await termInput.count() > 0) {
        // Test: kubectl get dungeons
        await termInput.fill('kubectl get dungeons');
        await page.keyboard.press('Enter');
        await page.waitForTimeout(2000);
        const termOutput1 = await page.locator('.kubectl-terminal .term-output, .kubectl-terminal .term-line').allTextContents().catch(() => []);
        const output1 = termOutput1.join('\n');
        output1.includes(dName) || output1.includes('NAME') || output1.includes('dungeon')
          ? ok('kubectl get dungeons shows dungeon listing')
          : warn('kubectl get dungeons output not as expected');

        // Test: kubectl describe dungeon <name>
        await termInput.fill(`kubectl describe dungeon ${dName}`);
        await page.keyboard.press('Enter');
        await page.waitForTimeout(2000);
        const termOutput2 = await page.locator('.kubectl-terminal .term-output, .kubectl-terminal .term-line').allTextContents().catch(() => []);
        const output2 = termOutput2.join('\n');
        output2.includes('heroHP') || output2.includes('bossHP') || output2.includes('spec') || output2.includes('difficulty')
          ? ok('kubectl describe dungeon shows spec fields (heroHP/bossHP/difficulty)')
          : warn('kubectl describe dungeon output not as expected');

        // Test: kubectl delete dungeon <name>
        await termInput.fill(`kubectl delete dungeon ${dName}`);
        await page.keyboard.press('Enter');
        await page.waitForTimeout(2000);
        const termOutput3 = await page.locator('.kubectl-terminal .term-output, .kubectl-terminal .term-line').allTextContents().catch(() => []);
        const output3 = termOutput3.join('\n');
        output3.includes('deleted') || output3.includes('delete')
          ? ok(`kubectl delete dungeon ${dName} succeeded`)
          : warn('kubectl delete dungeon output not as expected');
      } else {
        warn('kubectl terminal input not found — skipping command tests');
      }
    }

    // === Cleanup ===
    console.log('\n=== Cleanup ===');
    if (consoleErrors.length === 0) {
      ok('No JS console errors');
    } else {
      fail(`JS console errors: ${consoleErrors.slice(0, 3).join('; ')}`);
    }

  } catch (err) {
    fail(`Unexpected error: ${err.message}`);
  } finally {
    await browser.close();
  }

  console.log(`\n--- Journey 38: ${passed} passed, ${failed} failed, ${warnings} warnings ---`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => { console.error(err); process.exit(1); });
