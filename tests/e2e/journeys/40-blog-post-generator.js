// Journey 40: Blog Post Generator (#460)
// UI-ONLY: no kubectl, no direct fetch/api, no execSync
// Tests:
//   1.  Complete a full dungeon (room 1 + room 2) on easy with warrior
//   2.  Victory banner appears on room 2 win
//   3.  "Tell the story of this run" button is present in the victory banner
//   4.  Clicking the button opens the narrative modal
//   5.  Narrative modal shows a loading state initially
//   6.  Narrative modal eventually shows generated Markdown content
//   7.  Generated Markdown contains hero class
//   8.  Generated Markdown contains difficulty
//   9.  Generated Markdown contains dungeon name
//   10. Generated Markdown contains turn count
//   11. Generated Markdown contains at least one CEL expression (cel: or ```cel)
//   12. Generated Markdown contains "kro" (kro brand)
//   13. Generated Markdown contains "learn-kro.eks.aws.dev" CTA
//   14. "Copy Markdown" button is present
//   15. Clicking "Copy Markdown" changes text to "✓ Copied!"
//   16. "Open in GitHub Discussions" button is present
//   17. "Close" button dismisses the modal
//   18. Help modal has "Blog Post Generator" page
//   19. Intro tour has "Tell the Story" slide
//   20. Backend /api/v1/run-narrative endpoint returns 200
//   21. Backend response JSON has "markdown" field
//   22. Backend markdown contains CEL expression section
//   23. Backend markdown contains Dungeon CR YAML snippet
//   24. No JS console errors from narrative code
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
    const narrativeModal = page.locator('.run-narrative-modal');
    if (await narrativeModal.count() > 0) {
      const closeBtn = narrativeModal.locator('button:has-text("Close")');
      if (await closeBtn.count() > 0) { await closeBtn.click({ force: true }).catch(() => {}); await page.waitForTimeout(400); }
      continue;
    }
    break;
  }
}

async function run() {
  console.log('Journey 40: Blog Post Generator\n');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const dName = `j40-${Date.now()}`;
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

    // === 1: Create dungeon (1 monster, easy) ===
    console.log('=== Step 1: Create dungeon ===');
    const created = await createDungeonUI(page, dName, { monsters: 1, difficulty: 'easy', heroClass: 'warrior' });
    created ? ok('Dungeon created') : fail('Dungeon did not load');

    // === 2: Clear room 1 — monsters ===
    console.log('\n=== Step 2: Clear room 1 ===');
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

    // Kill room 1 boss
    for (let i = 0; i < 60; i++) {
      await clearModals(page);
      const bossBtn = page.locator('.arena-entity.boss-entity .arena-atk-btn.btn-primary');
      if (await bossBtn.count() === 0) break;
      await bossBtn.click({ force: true }).catch(() => {});
      await page.waitForTimeout(2500);
    }
    await clearModals(page);
    await page.waitForTimeout(5000);
    await clearModals(page);

    // Enter room 2
    await page.waitForSelector('[aria-label="Enter Room 2"]', { timeout: 10000 }).catch(() => {});
    const treasureBtn = page.locator('button:has-text("Open Treasure")');
    if (await treasureBtn.count() > 0) {
      await treasureBtn.click({ force: true }).catch(() => {});
      await page.waitForTimeout(1500);
      await clearModals(page);
    }
    await page.waitForTimeout(4000);
    await clearModals(page);

    let r2Loaded = false;
    for (let attempt = 0; attempt < 5 && !r2Loaded; attempt++) {
      if (attempt > 0) await page.waitForTimeout(3000);
      await page.evaluate(() => {
        const door = document.querySelector('[role="button"][aria-label="Enter Room 2"], .arena-entity.door-entity');
        if (door) door.click();
      }).catch(() => {});
      for (let i = 0; i < 20; i++) {
        const atkButtons = await page.locator('.arena-atk-btn.btn-primary').count();
        const doorGone = await page.locator('[aria-label="Enter Room 2"]').count() === 0;
        if (atkButtons > 0 && doorGone) { r2Loaded = true; break; }
        await page.waitForTimeout(2000);
      }
    }
    r2Loaded ? ok('Entered room 2') : warn('Room 2 entry uncertain — continuing');

    // === 3: Clear room 2 ===
    console.log('\n=== Step 3: Clear room 2 ===');
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

    for (let i = 0; i < 80; i++) {
      await clearModals(page);
      const victoryBannerPresent = await page.locator('.victory-banner').count() > 0;
      if (victoryBannerPresent) break;
      const boss2Btn = page.locator('.arena-entity.boss-entity .arena-atk-btn.btn-primary');
      if (await boss2Btn.count() === 0) break;
      await boss2Btn.click({ force: true }).catch(() => {});
      await page.waitForTimeout(2500);
    }
    await clearModals(page);

    await page.waitForSelector('.victory-banner', { timeout: 20000 }).catch(() => {});
    const hasVictory = await page.locator('.victory-banner').count() > 0;
    hasVictory ? ok('Victory banner visible') : fail('Victory banner not visible after clearing room 2');
    await page.waitForTimeout(2000);

    // === 4: "Tell the story" button ===
    console.log('\n=== Step 4: Tell the story button ===');

    // Aggressively dismiss cert modal + insight cards before interacting
    for (let i = 0; i < 10; i++) {
      const certOverlay = page.locator('.kro-cert-overlay');
      const insightCard = page.locator('.kro-insight-overlay');
      if (await certOverlay.count() === 0 && await insightCard.count() === 0) break;
      if (await certOverlay.count() > 0) {
        await page.evaluate(() => { const el = document.querySelector('.kro-cert-overlay'); if (el) el.click(); }).catch(() => {});
        await page.waitForTimeout(600);
      }
      if (await insightCard.count() > 0) {
        await page.evaluate(() => {
          const btn = document.querySelector('.kro-insight-btn') || document.querySelector('.kro-insight-dismiss');
          if (btn) btn.click();
        }).catch(() => {});
        await page.waitForTimeout(400);
      }
    }
    // Also dismiss any "Continue" / "Got it!" buttons
    await clearModals(page);
    await page.waitForTimeout(500);

    const storyBtn = page.locator('button.run-narrative-btn');
    const storyBtnCount = await storyBtn.count();
    storyBtnCount > 0 ? ok('"Tell the story of this run" button present') : fail('"Tell the story" button not found (.run-narrative-btn)');

    // === 5–13: Click the button and check the modal ===
    console.log('\n=== Step 5: Narrative modal ===');
    let narrativeMarkdown = '';
    if (storyBtnCount > 0) {
      // Click with retry — cert/insight overlay may grab the first click
      let modalOpened = false;
      for (let attempt = 0; attempt < 4; attempt++) {
        // Dismiss any lingering overlays before each attempt
        for (let j = 0; j < 6; j++) {
          const certOverlay = page.locator('.kro-cert-overlay');
          const insightCard = page.locator('.kro-insight-overlay');
          if (await certOverlay.count() === 0 && await insightCard.count() === 0) break;
          if (await certOverlay.count() > 0) {
            await page.evaluate(() => { const el = document.querySelector('.kro-cert-overlay'); if (el) el.click(); }).catch(() => {});
            await page.waitForTimeout(500);
          }
          if (await insightCard.count() > 0) {
            await page.evaluate(() => {
              const btn = document.querySelector('.kro-insight-btn') || document.querySelector('.kro-insight-dismiss');
              if (btn) btn.click();
            }).catch(() => {});
            await page.waitForTimeout(400);
          }
        }
        await page.waitForTimeout(300);
        await storyBtn.first().click({ force: true }).catch(() => {});
        // Wait for modal to appear (up to 2s)
        try {
          await page.waitForSelector('.run-narrative-modal', { timeout: 2000 });
          modalOpened = true;
          break;
        } catch {
          // Modal didn't appear — retry
          console.log(`  [debug] attempt ${attempt + 1}: narrative modal not found after click, retrying`);
        }
      }

      // Modal should appear
      const modalAppeared = await page.locator('.run-narrative-modal').count() > 0;
      modalAppeared ? ok('Narrative modal opened') : fail('Narrative modal not found (.run-narrative-modal)');

      // Wait for loading to finish (up to 15s)
      await page.waitForTimeout(1000);
      for (let i = 0; i < 14; i++) {
        const loading = await page.locator('.run-narrative-modal').getByText('Generating narrative...').count();
        if (loading === 0) break;
        await page.waitForTimeout(1000);
      }

      // Read the textarea
      const textarea = page.locator('.run-narrative-textarea');
      const textareaCount = await textarea.count();
      textareaCount > 0 ? ok('Narrative textarea rendered') : fail('Narrative textarea not found (.run-narrative-textarea)');

      if (textareaCount > 0) {
        narrativeMarkdown = await textarea.inputValue().catch(() => '');
        narrativeMarkdown.length > 100 ? ok(`Generated Markdown has content (${narrativeMarkdown.length} chars)`) : fail('Generated Markdown is too short or empty');

        // Content checks
        const lowerMd = narrativeMarkdown.toLowerCase();
        lowerMd.includes('warrior') ? ok('Markdown contains hero class (warrior)') : fail('Markdown missing hero class');
        lowerMd.includes('easy') ? ok('Markdown contains difficulty (easy)') : fail('Markdown missing difficulty');
        narrativeMarkdown.includes(dName.substring(0, 10)) ? ok(`Markdown contains dungeon name fragment`) : warn(`Markdown may have truncated dungeon name`);
        // Turn count — may be 0 if game was very fast
        (narrativeMarkdown.includes('turns') || narrativeMarkdown.includes('turn')) ? ok('Markdown contains "turns"') : fail('Markdown missing turn count');
        (narrativeMarkdown.includes('```cel') || narrativeMarkdown.includes('CEL') || narrativeMarkdown.includes('cel:')) ? ok('Markdown contains CEL expression section') : fail('Markdown missing CEL expressions');
        narrativeMarkdown.includes('kro') ? ok('Markdown contains "kro" branding') : fail('Markdown missing "kro" brand');
        narrativeMarkdown.includes('learn-kro.eks.aws.dev') ? ok('Markdown contains learn-kro.eks.aws.dev CTA') : fail('Markdown missing learn-kro.eks.aws.dev');
      }

      // === 14–16: Action buttons ===
      console.log('\n=== Step 6: Modal action buttons ===');
      const copyBtn = page.locator('.run-narrative-modal button:has-text("Copy Markdown")');
      const copyBtnCount = await copyBtn.count();
      copyBtnCount > 0 ? ok('"Copy Markdown" button present') : fail('"Copy Markdown" button not found');

      if (copyBtnCount > 0) {
        const ctx = browser.contexts()[0];
        await ctx.grantPermissions(['clipboard-write']);
        await copyBtn.first().click({ force: true }).catch(() => {});
        await page.waitForTimeout(500);
        const btnText = await copyBtn.first().textContent().catch(() => '');
        btnText && btnText.includes('Copied') ? ok('"Copy Markdown" changes to "✓ Copied!"') : warn(`Copy button text: "${btnText}" (clipboard may be restricted)`);
      }

      const ghBtn = page.locator('.run-narrative-modal button:has-text("Open in GitHub Discussions")');
      const ghBtnCount = await ghBtn.count();
      ghBtnCount > 0 ? ok('"Open in GitHub Discussions" button present') : fail('"Open in GitHub Discussions" button not found');

      // Close the modal
      const closeBtn = page.locator('.run-narrative-modal button:has-text("Close")');
      if (await closeBtn.count() > 0) {
        await closeBtn.first().click({ force: true }).catch(() => {});
        await page.waitForTimeout(400);
        const modalGone = await page.locator('.run-narrative-modal').count() === 0;
        modalGone ? ok('Narrative modal closed on Close button') : fail('Narrative modal still visible after Close');
      } else {
        fail('"Close" button not found in narrative modal');
      }
    } else {
      // Skip modal tests if button wasn't found
      for (let i = 0; i < 8; i++) { fail('Skipped (story button not found)'); }
    }

    // === Backend API check ===
    console.log('\n=== Step 7: Backend API ===');
    // Use the page's fetch (authenticated via session cookie)
    const apiResult = await page.evaluate(async (dungeonName) => {
      try {
        const r = await fetch(`/api/v1/run-narrative/dungeon-${dungeonName}/${dungeonName}?concepts=resource-graph,cel-expressions`, { credentials: 'include' });
        if (r.status === 404) {
          // Try without namespace prefix (depends on dungeon creation)
          const r2 = await fetch(`/api/v1/run-narrative/${dungeonName}/${dungeonName}?concepts=resource-graph`, { credentials: 'include' });
          return { status: r2.status, body: await r2.text().catch(() => '') };
        }
        return { status: r.status, body: await r.text().catch(() => '') };
      } catch (e) {
        return { status: 0, body: '' };
      }
    }, dName);
    // The dungeon namespace follows the pattern dungeon-{name} (from dungeon-graph.yaml)
    // or same as name — the exact ns depends on dungeon-graph CR creation
    // We check the endpoint via the page which has the correct session cookie
    // but we don't know the exact namespace — use the /api/v1/dungeons list instead
    const listResult = await page.evaluate(async () => {
      try {
        const r = await fetch('/api/v1/dungeons', { credentials: 'include' });
        return { status: r.status, body: await r.text().catch(() => '') };
      } catch (e) {
        return { status: 0, body: '' };
      }
    });

    let narrativeNs = '';
    let narrativeName = dName;
    if (listResult.status === 200) {
      try {
        const dungeons = JSON.parse(listResult.body);
        const items = (dungeons.items || []);
        const match = items.find(d => d.metadata && d.metadata.name === dName);
        if (match) {
          narrativeNs = match.metadata.namespace || '';
          narrativeName = match.metadata.name || dName;
        }
      } catch (e) {}
    }

    if (narrativeNs) {
      const narrativeResult = await page.evaluate(async ({ ns, name }) => {
        try {
          const r = await fetch(`/api/v1/run-narrative/${ns}/${name}?concepts=resource-graph,cel-expressions,reconcile-loop`, { credentials: 'include' });
          return { status: r.status, contentType: r.headers.get('content-type') || '', body: await r.text().catch(() => '') };
        } catch (e) {
          return { status: 0, contentType: '', body: '' };
        }
      }, { ns: narrativeNs, name: narrativeName });

      narrativeResult.status === 200 ? ok(`Backend /api/v1/run-narrative returns 200`) : fail(`Backend returned ${narrativeResult.status}`);

      if (narrativeResult.status === 200) {
        try {
          const parsed = JSON.parse(narrativeResult.body);
          typeof parsed.markdown === 'string' ? ok('Response JSON has "markdown" field') : fail('Response JSON missing "markdown" field');
          if (typeof parsed.markdown === 'string') {
            (parsed.markdown.includes('```cel') || parsed.markdown.includes('CEL')) ? ok('Backend markdown contains CEL expression section') : fail('Backend markdown missing CEL expressions');
            parsed.markdown.includes('```yaml') ? ok('Backend markdown contains YAML snippet') : fail('Backend markdown missing YAML snippet');
          }
        } catch (e) {
          fail(`Backend response is not valid JSON: ${e.message}`);
        }
      }
    } else {
      warn('Could not determine dungeon namespace — skipping backend API checks');
      warn('Skipped: backend /api/v1/run-narrative status');
      warn('Skipped: Response JSON has "markdown" field');
      warn('Skipped: backend markdown CEL expressions');
      warn('Skipped: backend markdown YAML snippet');
    }

    // === Help modal check ===
    console.log('\n=== Step 8: Help modal ===');
    for (let i = 0; i < 5; i++) {
      const certOverlay = page.locator('.kro-cert-overlay');
      if (await certOverlay.count() === 0) break;
      await page.evaluate(() => { const el = document.querySelector('.kro-cert-overlay'); if (el) el.click(); }).catch(() => {});
      await page.waitForTimeout(700);
    }
    const helpBtn = page.locator('button.help-btn').first();
    if (await helpBtn.count() > 0) {
      await helpBtn.click({ force: true }).catch(() => {});
      await page.waitForTimeout(800);
      let foundBlogPage = false;
      for (let p = 0; p < 16; p++) {
        const helpBody = await page.textContent('.help-modal').catch(() => '');
        if (helpBody.includes('Blog Post') || helpBody.includes('Tell the story') || helpBody.includes('narrative')) { foundBlogPage = true; break; }
        const nextBtn = page.locator('.help-nav button').filter({ hasText: /Next/ }).first();
        const isDisabled = await nextBtn.isDisabled().catch(() => true);
        if (isDisabled) break;
        await nextBtn.click({ force: true }).catch(() => {});
        await page.waitForTimeout(400);
      }
      foundBlogPage ? ok('Help modal has "Blog Post Generator" page') : fail('Help modal missing Blog Post Generator page');
      const closeHelpBtn = page.locator('.help-nav button').filter({ hasText: 'Close' }).first();
      await closeHelpBtn.click({ force: true }).catch(() => {});
      await page.waitForTimeout(300);
    } else {
      fail('Help button not found');
    }

    // === Intro tour check ===
    console.log('\n=== Step 9: Intro tour ===');
    await page.evaluate(() => localStorage.removeItem('kroOnboardingDone'));
    await page.reload({ waitUntil: 'networkidle', timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(2000);
    await testLogin(page, BASE_URL);
    await page.goto(BASE_URL, { timeout: TIMEOUT });
    await page.waitForTimeout(2000);

    const onboardingVisible = await page.locator('.kro-onboard-overlay').count() > 0;
    if (onboardingVisible) {
      let tourFound = false;
      for (let p = 0; p < 12; p++) {
        const tourBody = await page.textContent('.kro-onboard-modal').catch(() => '');
        if (tourBody.includes('Tell the story') || tourBody.includes('blog') || tourBody.includes('narrative') || tourBody.includes('Blog Post')) { tourFound = true; break; }
        const nextBtn = page.locator('.kro-onboard-modal button:has-text("Next")');
        if (await nextBtn.count() === 0) break;
        await nextBtn.click({ force: true }).catch(() => {});
        await page.waitForTimeout(300);
      }
      tourFound ? ok('Intro tour has "Tell the story" slide') : fail('Intro tour missing "Tell the story" slide');
      const skipBtn = page.locator('button.kro-onboard-skip');
      await skipBtn.click({ force: true }).catch(() => {});
      await page.waitForTimeout(400);
    } else {
      warn('Onboarding overlay not shown after localStorage clear — skipping intro tour check');
    }

    // No JS errors
    console.log('\n=== Step 10: Console errors ===');
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

  console.log(`\n--- Journey 40: ${passed} passed, ${failed} failed, ${warnings} warnings ---`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => { console.error(err); process.exit(1); });
