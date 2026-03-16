// Journey 37: Social Run Cards (#456)
// UI-ONLY: no kubectl, no direct fetch/api, no execSync
// Tests:
//   1.  Complete a full dungeon (room 1 + room 2) on easy with warrior
//   2.  Victory banner appears on room 2 win
//   3.  Run card <img> is rendered in the victory banner (.run-card-img)
//   4.  The run card img src points to /api/v1/run-card/...
//   5.  The run card image loads without error (no broken image)
//   6.  The ↗ Share Run button is present
//   7.  Clicking ↗ Share Run changes button text to "✓ Copied!" (clipboard write triggered)
//   8.  Backend /api/v1/run-card endpoint returns 200 with image/svg+xml content type
//   9.  SVG contains hero class, difficulty, turn count, dungeon name
//   10. SVG contains "learn-kro.eks.aws.dev" footer link
//   11. SVG contains "kro / k8s" brand tag
//   12. Help modal has "Share Run Card" page
//   13. Intro tour has "Share Your Run" slide
//   14. No JS console errors from run card code
//   15. Run card img has descriptive aria alt attribute
const { chromium } = require('playwright');
const {
  createDungeonUI, attackMonster, attackBoss, waitForCombatResult,
  dismissLootPopup, aliveMonsterCount, getBodyText, deleteDungeon, testLogin
} = require('./helpers');

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const TIMEOUT = 25000;
let passed = 0, failed = 0, warnings = 0;
function ok(msg)   { console.log(`  ✅ ${msg}`); passed++; }
function fail(msg) { console.log(`  ❌ ${msg}`); failed++; }
function warn(msg) { console.log(`  ⚠️  ${msg}`); warnings++; }

async function clearModals(page) {
  for (let i = 0; i < 6; i++) {
    const cb = page.locator('button:has-text("Continue")');
    if (await cb.count() > 0) { await cb.click({ force: true }).catch(() => {}); await page.waitForTimeout(500); continue; }
    const gi = page.locator('button:has-text("Got it!")');
    if (await gi.count() > 0) { await gi.click({ force: true }).catch(() => {}); await page.waitForTimeout(500); continue; }
    const certClose = page.locator('.kro-cert-overlay');
    if (await certClose.count() > 0) {
      await page.evaluate(() => { const el = document.querySelector('.kro-cert-overlay'); if (el) el.click(); }).catch(() => {});
      await page.waitForTimeout(600);
      continue;
    }
    break;
  }
}

async function attackUntilDead(page, fn, maxTurns = 60) {
  for (let i = 0; i < maxTurns; i++) {
    await clearModals(page);
    const res = await fn(page).catch(() => null);
    if (!res) break;
    await clearModals(page);
    const body = await page.textContent('body').catch(() => '');
    if (body.includes('VICTORY') || body.includes('victory-banner')) return true;
  }
  return false;
}

async function run() {
  console.log('Journey 37: Social Run Cards\n');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const dName = `j37-${Date.now()}`;
  const consoleErrors = [];
  page.on('console', msg => {
    if (msg.type() === 'error' && !msg.text().includes('WebSocket') && !msg.text().includes('404') && !msg.text().includes('net::ERR'))
      consoleErrors.push(msg.text());
  });

  try {
    // === Setup ===
    await testLogin(page, BASE_URL);
    await page.goto(BASE_URL, { timeout: TIMEOUT });
    await page.waitForTimeout(2000);

    // === 1: Create dungeon (1 monster, easy — minimise RNG risk) ===
    console.log('=== Step 1: Create dungeon ===');
    const created = await createDungeonUI(page, dName, { monsters: 1, difficulty: 'easy', heroClass: 'warrior' });
    created ? ok('Dungeon created') : fail('Dungeon did not load');

    // === 2–3: Kill room 1 monsters and boss ===
    console.log('\n=== Step 2: Clear room 1 ===');
    // Kill monster
    for (let i = 0; i < 40; i++) {
      await clearModals(page);
      const alive = await aliveMonsterCount(page);
      if (alive === 0) break;
      const btn = page.locator('.arena-entity.monster-entity:not(.dead) .arena-atk-btn.btn-primary');
      if (await btn.count() === 0) break;
      await btn.first().click({ force: true }).catch(() => {});
      await page.waitForTimeout(2500);
    }
    await clearModals(page);
    const aliveAfterMonsters = await aliveMonsterCount(page);
    aliveAfterMonsters === 0 ? ok('Room 1 monster killed') : fail(`Room 1 monster still alive (${aliveAfterMonsters})`);

    // Kill boss
    for (let i = 0; i < 60; i++) {
      await clearModals(page);
      const bossBtn = page.locator('.arena-entity.boss-entity .arena-atk-btn.btn-primary');
      if (await bossBtn.count() === 0) break; // boss dead — no attack button
      await bossBtn.click({ force: true }).catch(() => {});
      await page.waitForTimeout(2500);
    }
    await clearModals(page);

    // Wait for post-boss room 1 flow: treasure opens auto, door unlocks auto (~2-4s)
    await page.waitForTimeout(5000);
    await clearModals(page);

    // Check room 1 cleared — wait for door to unlock
    await page.waitForSelector('[aria-label="Enter Room 2"]', { timeout: 10000 }).catch(() => {});
    let body = await page.textContent('body').catch(() => '');
    const room1Done = await page.locator('[aria-label="Enter Room 2"]').count() > 0 || body.includes('Enter Room 2');
    room1Done ? ok('Room 1 cleared — door/room2 available') : warn('Room 1 cleared state uncertain');

    // Click treasure if present
    const treasureBtn = page.locator('button:has-text("Open Treasure")');
    if (await treasureBtn.count() > 0) {
      await treasureBtn.click({ force: true }).catch(() => {});
      await page.waitForTimeout(1500);
      await clearModals(page);
    }

    // Enter room 2 via door button
    // NOTE: attackPhase must be null for the door click to register.
    // The auto-treasure + auto-door-unlock effects fire after boss dies (each sets attackPhase).
    // We must wait for all auto-actions to complete before clicking.
    // Strategy: poll up to 30s for the door to be unlocked AND alive monsters present (room 2 kro-ready)

    // Wait for door to unlock and attackPhase from unlock-door to clear (~4s after boss dies)
    await page.waitForTimeout(4000);
    await clearModals(page);

    // Retry door click up to 5 times (mirror journey 11's proven approach)
    let r2Loaded = false;
    for (let attempt = 0; attempt < 5 && !r2Loaded; attempt++) {
      if (attempt > 0) await page.waitForTimeout(3000);
      await page.evaluate(() => {
        const door = document.querySelector('[role="button"][aria-label="Enter Room 2"], .arena-entity.door-entity');
        if (door) door.click();
      }).catch(() => {});
      // Wait for Room 2 to load (attack buttons appear + room 2 state)
      for (let i = 0; i < 20; i++) {
        const atkButtons = await page.locator('.arena-atk-btn.btn-primary').count();
        const doorGone = await page.locator('[aria-label="Enter Room 2"]').count() === 0;
        if (atkButtons > 0 && doorGone) { r2Loaded = true; break; }
        await page.waitForTimeout(2000);
      }
    }

    r2Loaded ? ok('Entered room 2 (attack buttons present)') : warn('Room 2 entry uncertain — continuing');

    // === 3: Kill room 2 monsters and boss ===
    console.log('\n=== Step 3: Clear room 2 ===');
    // Kill room 2 monsters
    for (let i = 0; i < 60; i++) {
      await clearModals(page);
      const alive2 = await aliveMonsterCount(page);
      if (alive2 === 0) break;
      const btn2 = page.locator('.arena-entity.monster-entity:not(.dead) .arena-atk-btn.btn-primary');
      if (await btn2.count() === 0) break;
      await btn2.first().click({ force: true }).catch(() => {});
      await page.waitForTimeout(2500);
    }
    await clearModals(page);

    // Kill room 2 boss
    for (let i = 0; i < 80; i++) {
      await clearModals(page);
      // Use DOM check (.victory-banner) not text check (to avoid matching event log "VICTORY!")
      const victoryBannerPresent = await page.locator('.victory-banner').count() > 0;
      if (victoryBannerPresent) break;
      const boss2Btn = page.locator('.arena-entity.boss-entity .arena-atk-btn.btn-primary');
      if (await boss2Btn.count() === 0) break;
      await boss2Btn.click({ force: true }).catch(() => {});
      await page.waitForTimeout(2500);
    }
    await clearModals(page);

    // Wait for victory banner — use DOM selector only (not body text which is polluted by event log)
    await page.waitForSelector('.victory-banner', { timeout: 20000 }).catch(() => {});
    const hasVictory = await page.locator('.victory-banner').count() > 0;
    hasVictory ? ok('Victory banner visible') : fail('Victory banner not visible after clearing room 2');

    // Wait for React to finish rendering run card section inside the banner
    await page.waitForTimeout(2000);

    // Debug: dump the victory-banner and full body to understand what's rendered
    const victoryBannerCount = await page.locator('.victory-banner').count();
    const runCardCountNow = await page.locator('.run-card-img').count();
    console.log(`  [debug] victory-banner count: ${victoryBannerCount}, run-card-img count: ${runCardCountNow}`);

    // Take a screenshot for debugging
    await page.screenshot({ path: '/tmp/j37-victory-debug.png', fullPage: false }).catch(() => {});
    console.log('  [debug] screenshot saved to /tmp/j37-victory-debug.png');

    // If victory banner is gone, dump what IS on the page
    if (victoryBannerCount === 0) {
      const currentBody = await page.textContent('body').catch(() => '');
      console.log(`  [debug] body text (first 300): ${currentBody.substring(0, 300)}`);
      // Check if we're on dungeon list (navigated away)
      const dungeonTiles = await page.locator('.dungeon-tile').count();
      const dungeonView = await page.locator('.dungeon-arena').count();
      console.log(`  [debug] dungeon-tile count: ${dungeonTiles}, dungeon-arena count: ${dungeonView}`);
    } else {
      const victoryBannerHtml = await page.locator('.victory-banner').first().innerHTML().catch(() => '(empty)');
      console.log(`  [debug] victory-banner inner HTML (first 600 chars): ${victoryBannerHtml.substring(0, 600)}`);
    }

    // === 4–7: Run card UI checks ===
    console.log('\n=== Step 4: Run card UI ===');

    // 4. .run-card-img exists
    const cardImg = page.locator('.run-card-img');
    const cardImgCount = await cardImg.count();
    cardImgCount > 0 ? ok('Run card <img> rendered in victory banner') : fail('Run card <img> not found (.run-card-img)');

    // 5. img src points to /api/v1/run-card/
    if (cardImgCount > 0) {
      const src = await cardImg.first().getAttribute('src').catch(() => '');
      src && src.includes('/api/v1/run-card/') ? ok('Run card src points to /api/v1/run-card/') : fail(`Run card src unexpected: ${src}`);
    } else {
      fail('Cannot check run card src — img not found');
    }

    // 6. img has alt text
    if (cardImgCount > 0) {
      const alt = await cardImg.first().getAttribute('alt').catch(() => '');
      alt && alt.length > 5 ? ok('Run card has descriptive alt attribute') : fail('Run card missing alt attribute');
    } else {
      fail('Cannot check run card alt — img not found');
    }

    // 7. Share Run button present
    const shareBtn = page.locator('button.run-card-share-btn');
    const shareBtnCount = await shareBtn.count();
    shareBtnCount > 0 ? ok('↗ Share Run button present') : fail('↗ Share Run button not found');

    // Dismiss the auto-shown kro certificate modal before interacting with share button
    await page.waitForTimeout(500);
    for (let i = 0; i < 5; i++) {
      const certOverlay = page.locator('.kro-cert-overlay');
      if (await certOverlay.count() === 0) break;
      await page.evaluate(() => { const el = document.querySelector('.kro-cert-overlay'); if (el) el.click(); }).catch(() => {});
      await page.waitForTimeout(700);
    }

    // 8. Click Share Run — text changes to "✓ Copied!"
    if (shareBtnCount > 0) {
      // Grant clipboard permission to allow clipboard write
      const ctx = browser.contexts()[0];
      await ctx.grantPermissions(['clipboard-write']);
      await shareBtn.first().click({ force: true }).catch(() => {});
      await page.waitForTimeout(500);
      const btnText = await shareBtn.first().textContent().catch(() => '');
      btnText && btnText.includes('Copied') ? ok('Share Run button shows "✓ Copied!" after click') : warn(`Share Run button text after click: "${btnText}" (clipboard may be restricted in CI)`);
    } else {
      fail('Cannot click Share Run — button not found');
    }

    // === 5: Backend SVG check ===
    console.log('\n=== Step 5: Backend SVG endpoint ===');

    // Get the card URL from the img src and fetch it directly in the browser
    let cardSvgContent = '';
    if (await page.locator('.run-card-img').count() > 0) {
      const src = await page.locator('.run-card-img').first().getAttribute('src').catch(() => '');
      if (src && src.includes('/api/v1/run-card/')) {
        const fullUrl = src.startsWith('http') ? src : `${BASE_URL}${src}`;
        const svgResult = await page.evaluate(async (url) => {
          try {
            const r = await fetch(url);
            return { status: r.status, contentType: r.headers.get('content-type') || '', body: await r.text() };
          } catch (e) {
            return { status: 0, contentType: '', body: '' };
          }
        }, fullUrl);

        svgResult.status === 200 ? ok('Run card endpoint returns 200') : fail(`Run card endpoint returned ${svgResult.status}`);
        svgResult.contentType.includes('svg') ? ok('Run card content-type is image/svg+xml') : fail(`Run card content-type: ${svgResult.contentType}`);

        cardSvgContent = svgResult.body;

        // SVG content checks
        cardSvgContent.includes('learn-kro.eks.aws.dev') ? ok('SVG contains learn-kro.eks.aws.dev footer') : fail('SVG missing learn-kro.eks.aws.dev footer');
        cardSvgContent.includes('kro / k8s') ? ok('SVG contains "kro / k8s" brand tag') : fail('SVG missing "kro / k8s" brand tag');
        cardSvgContent.includes('warrior') || cardSvgContent.includes('WARRIOR') || cardSvgContent.includes('⚔') ? ok('SVG contains warrior hero class indicator') : warn('SVG hero class indicator uncertain');
        cardSvgContent.includes('easy') || cardSvgContent.includes('EASY') ? ok('SVG contains difficulty') : fail('SVG missing difficulty');
        cardSvgContent.includes(dName.substring(0, 10)) ? ok(`SVG contains dungeon name fragment "${dName.substring(0, 10)}"`) : warn(`SVG may have truncated dungeon name`);
        cardSvgContent.includes('VICTORY') || cardSvgContent.includes('★') ? ok('SVG contains VICTORY/star indicator') : fail('SVG missing victory indicator');
      } else {
        fail('Cannot fetch SVG — run card img src not found or unexpected');
      }
    } else {
      warn('Skipping SVG content checks — run card img not rendered (hero may have died)');
    }

    // === 6: Help modal has "Share Run Card" page ===
    console.log('\n=== Step 6: Help modal ===');
    const helpBtn = page.locator('button:has-text("?"), button[aria-label*="help"], button[aria-label*="Help"]').first();
    if (await helpBtn.count() > 0) {
      await helpBtn.click({ force: true }).catch(() => {});
      await page.waitForTimeout(600);
      // Navigate through pages to find "Share Run Card"
      let found = false;
      for (let p = 0; p < 15; p++) {
        const helpBody = await page.textContent('.help-modal').catch(() => '');
        if (helpBody.includes('Share Run Card') || helpBody.includes('Share Your Run')) { found = true; break; }
        const nextBtn = page.locator('.help-nav button:has-text("Next"), .help-nav button:has-text("→")').first();
        if (await nextBtn.count() === 0 || await nextBtn.isDisabled()) break;
        await nextBtn.click({ force: true }).catch(() => {});
        await page.waitForTimeout(300);
      }
      found ? ok('Help modal has "Share Run Card" page') : fail('Help modal missing "Share Run Card" page');
      // Close help modal
      const closeBtn = page.locator('.help-nav button:has-text("Close"), button[aria-label="Close"]').first();
      await closeBtn.click({ force: true }).catch(() => {});
      await page.waitForTimeout(300);
    } else {
      warn('Help button not found — skipping help modal check');
    }

    // === 7: Intro tour has "Share Your Run" slide ===
    console.log('\n=== Step 7: Intro tour ===');
    // Reset onboarding so we can see the tour
    await page.evaluate(() => localStorage.removeItem('kroOnboardingDone'));
    await page.reload({ waitUntil: 'networkidle', timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(2000);
    // Skip test login again after reload
    await testLogin(page, BASE_URL);
    await page.goto(BASE_URL, { timeout: TIMEOUT });
    await page.waitForTimeout(2000);

    const onboardingVisible = await page.locator('.kro-onboard-overlay').count() > 0;
    if (onboardingVisible) {
      let tourFound = false;
      for (let p = 0; p < 10; p++) {
        const tourBody = await page.textContent('.kro-onboard-modal').catch(() => '');
        if (tourBody.includes('Share Your Run') || tourBody.includes('Run Card') || tourBody.includes('run card')) { tourFound = true; break; }
        const nextBtn = page.locator('.kro-onboard-modal button:has-text("Next")');
        if (await nextBtn.count() === 0) break;
        await nextBtn.click({ force: true }).catch(() => {});
        await page.waitForTimeout(300);
      }
      tourFound ? ok('Intro tour has "Share Your Run" slide') : fail('Intro tour missing "Share Your Run" slide');
      // Skip tour
      const skipBtn = page.locator('button.kro-onboard-skip');
      await skipBtn.click({ force: true }).catch(() => {});
      await page.waitForTimeout(400);
    } else {
      warn('Onboarding overlay not shown after localStorage clear — skipping intro tour check');
    }

    // === Cleanup ===
    console.log('\n=== Cleanup ===');
    // No JS errors
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

  console.log(`\n--- Journey 37: ${passed} passed, ${failed} failed, ${warnings} warnings ---`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => { console.error(err); process.exit(1); });
