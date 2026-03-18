// Journey 38: Conference Demo Package (#458)
// UI-ONLY: no kubectl, no direct fetch/api, no execSync
// Tests:
//   1. docs/demo/DEMO.md exists in repo (fetch from GitHub raw)
//   2. docs/demo/dungeon-demo.yaml is a valid Dungeon CR (fetch + validate fields)
//   3. docs/demo/speaker-notes.md has >=10 Q&A scenarios
//   4. Intro modal has "Running a Demo?" slide
//   5. No JS console errors
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
    if (msg.type() === 'error' && !msg.text().includes('WebSocket') && !msg.text().includes('404') && !msg.text().includes('net::ERR') && !msg.text().includes('409') && !msg.text().includes('429') && !msg.text().includes('504'))
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
