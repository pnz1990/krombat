// Journey 15: ownerReferences Concept Trigger & Glossary Search Bar
// UI-ONLY: no kubectl, no fetch/api, no execSync
// Tests:
//   1. Delete a dungeon → dungeon-deleted event → ownerReferences InsightCard appears
//   2. Glossary search bar appears after 4+ concepts are unlocked
//   3. Search bar filters concepts, clear button restores all, empty state for nonsense query
//   4. Glossary header shows total of /27 concepts
const { chromium } = require('playwright');
const { createDungeonUI, attackMonster, waitForCombatResult, dismissLootPopup, navigateHome, deleteDungeon , testLogin} = require('./helpers');

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const TIMEOUT = 30000;
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
  console.log('🧪 Journey 15: ownerReferences Concept Trigger & Glossary Search Bar\n');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  const dNameDelete = `j15-del-${Date.now()}`;
  const dNameMain   = `j15-main-${Date.now()}`;

  const consoleErrors = [];
  page.on('console', msg => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });

  try {
    // Ensure onboarding is already done so it doesn't block the test
    await testLogin(page, BASE_URL);

    await page.goto(BASE_URL, { timeout: TIMEOUT });
    await page.evaluate(() => localStorage.setItem('kroOnboardingDone', '1'));
    await page.reload({ waitUntil: 'networkidle', timeout: TIMEOUT });
    await page.waitForSelector('input[placeholder="my-dungeon"]', { timeout: TIMEOUT });

    // ── Part 1: ownerReferences InsightCard on dungeon deletion ───────────────
    console.log('\n  [Part 1: ownerReferences InsightCard via dungeon deletion]');

    // Create a dungeon that we will immediately delete
    const loaded = await createDungeonUI(page, dNameDelete, { monsters: 1, difficulty: 'easy', heroClass: 'warrior' });
    loaded ? ok(`Dungeon "${dNameDelete}" created for deletion test`) : fail(`Dungeon "${dNameDelete}" did not load`);

    // Navigate back to the home / dungeon list
    await navigateHome(page, BASE_URL);
    await page.waitForSelector('input[placeholder="my-dungeon"]', { timeout: TIMEOUT });
    ok('Navigated back to home dungeon list');

    // The dungeon tile should be present — wait up to 10s for the list to load
    const tile = page.locator(`.dungeon-tile:has-text("${dNameDelete}")`);
    await tile.waitFor({ timeout: 10000 }).catch(() => {});
    const tileCount = await tile.count();
    tileCount > 0 ? ok(`Dungeon tile for "${dNameDelete}" is visible on home screen`) : fail(`Dungeon tile "${dNameDelete}" not found on home screen`);

    // Click the tile's delete button to trigger the dungeon-deleted event
    if (tileCount > 0) {
      const delBtn = tile.locator('.tile-delete-btn');
      const delBtnCount = await delBtn.count();
      delBtnCount > 0 ? ok('Delete button found on dungeon tile') : fail('Delete button (.tile-delete-btn) not found on tile');

      if (delBtnCount > 0) {
        // Accept the confirm() dialog that appears when deleting
        page.once('dialog', dialog => dialog.accept().catch(() => {}));
        await delBtn.click();
        // Wait for the ownerReferences InsightCard to appear — dungeon-deleted event triggers it.
        // Poll because a previous InsightCard (from creation) may still be showing.
        // Dismiss any non-ownerRef cards while waiting.
        let ownerCard = null;
        for (let attempts = 0; attempts < 20; attempts++) {
          await page.waitForTimeout(1000);
          const cards = page.locator('.kro-insight-card');
          const cardCount2 = await cards.count();
          if (cardCount2 > 0) {
            const cardText2 = await cards.first().textContent().catch(() => '');
            if (cardText2.includes('ownerReferences') || cardText2.includes('cascading')) {
              ownerCard = cardText2;
              break;
            }
            // Dismiss this card (it's a different insight) and keep waiting
            const dismissBtnPoll = cards.first().locator('.kro-insight-dismiss');
            if (await dismissBtnPoll.count() > 0) {
              await dismissBtnPoll.click({ force: true }).catch(() => {});
              await page.waitForTimeout(600);
            }
          }
        }
        const insightCard = page.locator('.kro-insight-card');
        const cardCount = await insightCard.count();
        cardCount > 0 ? ok('InsightCard appeared after dungeon deletion') : fail('InsightCard did not appear after dungeon deletion (dungeon-deleted event not triggered)');

        if (ownerCard !== null || cardCount > 0) {
          const cardText = ownerCard ?? await insightCard.textContent().catch(() => '');
          (cardText.includes('ownerReferences') || cardText.includes('cascading'))
            ? ok(`InsightCard text references ownerReferences/cascading: "${cardText.slice(0, 80)}..."`)
            : fail(`InsightCard text missing "ownerReferences" or "cascading": "${cardText.slice(0, 80)}"`);

          // InsightCard should have a kro badge
          const badge = insightCard.locator('.kro-insight-badge');
          (await badge.count() > 0) ? ok('InsightCard has kro badge') : fail('InsightCard missing kro badge');

          // InsightCard should have a headline
          const headline = insightCard.locator('.kro-insight-headline');
          (await headline.count() > 0) ? ok('InsightCard has headline element') : fail('InsightCard missing headline');

          // InsightCard should have a "Learn more" button
          const learnBtn = insightCard.locator('.kro-insight-learn');
          (await learnBtn.count() > 0) ? ok('InsightCard has "Learn more" button') : fail('InsightCard missing "Learn more" button');

          // Dismiss the InsightCard via the dismiss (✕) button
          const dismissBtn = insightCard.locator('.kro-insight-dismiss');
          if (await dismissBtn.count() > 0) {
            await dismissBtn.click({ force: true });
            await page.waitForTimeout(1200); // allow fade-out animation (350ms) + any pending cards
            // Dismiss any remaining InsightCards (multiple may queue)
            for (let d = 0; d < 5; d++) {
              const remaining = page.locator('.kro-insight-card.visible .kro-insight-dismiss');
              if (await remaining.count() === 0) break;
              await remaining.first().click({ force: true }).catch(() => {});
              await page.waitForTimeout(500);
            }
            const cardAfter = await page.locator('.kro-insight-card.visible').count();
            cardAfter === 0 ? ok('InsightCard dismissed successfully') : warn('InsightCard still visible after dismiss (may be auto-dismissed or another card queued)');
          } else {
            warn('Dismiss button not found — InsightCard may have auto-dismissed');
          }
        }
      }
    }

    // ── Part 2: Create main dungeon and do attacks to unlock 4+ concepts ──────
    console.log('\n  [Part 2: Create main dungeon and unlock multiple concepts]');

    const mainLoaded = await createDungeonUI(page, dNameMain, { monsters: 3, difficulty: 'easy', heroClass: 'warrior' });
    mainLoaded ? ok(`Main dungeon "${dNameMain}" created`) : fail(`Main dungeon "${dNameMain}" did not load`);

    // Wait for initial reconcile to settle
    await page.waitForTimeout(3000);

    // Do several attacks to trigger concept unlocks (each attack unlocks cel-basics, etc.)
    console.log('\n  [Combat — triggering concept unlocks]');
    let attacksDone = 0;
    for (let i = 0; i < 4; i++) {
      const result = await attackMonster(page);
      if (result !== null) {
        attacksDone++;
        await dismissLootPopup(page);
        // Dismiss any InsightCard that appeared
        const ic = page.locator('.kro-insight-card');
        if (await ic.count() > 0) {
          const db = ic.locator('.kro-insight-dismiss');
          if (await db.count() > 0) await db.click();
          await page.waitForTimeout(400);
        }
      }
    }
    attacksDone > 0 ? ok(`Completed ${attacksDone} attack(s) to unlock concepts`) : warn('No attacks succeeded (all monsters may be dead)');

    // ── Part 3: Glossary tab — /27 total, search bar, filtering ──────────────
    console.log('\n  [Part 3: kro Glossary tab — /27 count, search bar, filtering]');

    const kroTabSwitched = await switchToTab(page, 'kro');
    kroTabSwitched ? ok('Switched to kro tab') : fail('kro tab not found');

    // Glossary container should be visible
    const glossary = page.locator('.kro-glossary');
    (await glossary.count() > 0) ? ok('kro glossary panel is visible') : fail('kro glossary panel not found');

    // Header should show "/27" total concept count
    const glossaryHeader = page.locator('.kro-glossary-header');
    const headerText = await glossaryHeader.textContent().catch(() => '');
    (headerText.includes('/27') || headerText.includes('/ 27'))
      ? ok(`Glossary header shows total of 27: "${headerText.trim()}"`)
      : fail(`Glossary header does not show "/27": "${headerText.trim()}"`);

    // Count unlocked concepts
    const unlockedItems = page.locator('.kro-glossary-item.unlocked');
    const unlockedCount = await unlockedItems.count();
    unlockedCount >= 1 ? ok(`${unlockedCount} concept(s) unlocked in glossary`) : fail('No concepts unlocked in glossary');

    // All 27 grid items should be rendered (some locked, some unlocked)
    const allItems = page.locator('.kro-glossary-item');
    const allItemsCount = await allItems.count();
    allItemsCount === 27 ? ok('Glossary grid renders exactly 27 concept items') : fail(`Glossary grid has ${allItemsCount} items, expected 27`);

    // Locked items show "Keep playing to unlock"
    const lockedItems = page.locator('.kro-glossary-item.locked');
    const lockedCount = await lockedItems.count();
    lockedCount > 0 ? ok(`${lockedCount} locked concept(s) show "Keep playing" state`) : warn('All 27 concepts already unlocked (unusual at this stage)');

    // ── Part 4: Search bar — appears at 4+ unlocked concepts ─────────────────
    console.log('\n  [Part 4: Glossary search bar]');

    const searchBar = page.locator('.kro-glossary-search');
    if (unlockedCount >= 4) {
      (await searchBar.count() > 0)
        ? ok(`Search bar visible with ${unlockedCount} concepts unlocked (≥4 threshold)`)
        : fail(`Search bar missing despite ${unlockedCount} concepts unlocked (≥4 threshold)`);

      const searchInput = page.locator('.kro-glossary-search-input');
      if (await searchInput.count() > 0) {
        ok('Search input (.kro-glossary-search-input) found');

        // Count current visible items (should be all 27 before searching)
        const beforeSearch = await page.locator('.kro-glossary-item').count();
        beforeSearch === 27 ? ok(`All 27 concepts visible before search (no active filter)`) : fail(`Expected 27 items before search, got ${beforeSearch}`);

        // Type a known concept keyword — "ResourceGraph" / "RGD" / "cel" should narrow results
        await searchInput.fill('cel');
        await page.waitForTimeout(300);

        const afterSearch = await page.locator('.kro-glossary-item').count();
        afterSearch < 27
          ? ok(`Search "cel" narrowed results: ${afterSearch} item(s) shown (was 27)`)
          : fail(`Search "cel" did not narrow results (still showing ${afterSearch} items)`);

        // Clear button (×) should appear when search is non-empty
        const clearBtn = page.locator('.kro-glossary-search-clear');
        (await clearBtn.count() > 0) ? ok('Clear button (×) appears when search is non-empty') : fail('Clear button (×) missing while search is non-empty');

        // Click clear — all 27 items should reappear
        if (await clearBtn.count() > 0) {
          await clearBtn.click();
          await page.waitForTimeout(300);
          const afterClear = await page.locator('.kro-glossary-item').count();
          afterClear === 27
            ? ok(`Clear button restores all 27 concepts (was ${afterSearch} during filter)`)
            : fail(`After clearing, expected 27 items but got ${afterClear}`);

          // Clear button should disappear once search is empty
          const clearAfter = await page.locator('.kro-glossary-search-clear').count();
          clearAfter === 0 ? ok('Clear button disappears when search is empty') : fail('Clear button still visible after clearing search');
        }

        // Empty state — type a nonsense query
        await searchInput.fill('xyzzy-no-match-12345');
        await page.waitForTimeout(300);

        const emptyState = page.locator('.kro-glossary-empty');
        (await emptyState.count() > 0)
          ? ok('Empty state (.kro-glossary-empty) appears for nonsense search term')
          : fail('Empty state missing for nonsense search term');

        const emptyText = await emptyState.textContent().catch(() => '');
        emptyText.includes('no concepts match')
          ? ok(`Empty state message: "${emptyText.trim()}"`)
          : warn(`Empty state message unexpected: "${emptyText.trim()}"`);

        // No grid items should be visible in empty state
        const duringEmpty = await page.locator('.kro-glossary-item').count();
        duringEmpty === 0
          ? ok('No concept items rendered during nonsense search (filtered out)')
          : warn(`${duringEmpty} item(s) still showing during nonsense search`);

        // Clear again to restore state
        const clearBtnFinal = page.locator('.kro-glossary-search-clear');
        if (await clearBtnFinal.count() > 0) {
          await clearBtnFinal.click();
          await page.waitForTimeout(300);
        } else {
          await searchInput.fill('');
          await page.waitForTimeout(300);
        }
        const finalCount = await page.locator('.kro-glossary-item').count();
        finalCount === 27 ? ok('All 27 concepts restored after clearing nonsense search') : fail(`Expected 20 after restore, got ${finalCount}`);

      } else {
        fail('Search input (.kro-glossary-search-input) not found');
      }
    } else {
      warn(`Only ${unlockedCount} concept(s) unlocked — search bar requires 4+. Search bar tests skipped.`);
      if (await searchBar.count() > 0) {
        fail('Search bar is visible with fewer than 4 unlocked concepts (threshold violation)');
      } else {
        ok('Search bar correctly hidden when fewer than 4 concepts are unlocked');
      }
    }

    // ── Part 5: kro tab label reflects correct totals ─────────────────────────
    console.log('\n  [Part 5: kro tab label concept count format]');
    const kroTabLabel = await page.locator('button.log-tab.kro-tab').textContent().catch(() => '');
    kroTabLabel.match(/kro \(\d+\/27\)/)
      ? ok(`kro tab label shows correct format with /27: "${kroTabLabel.trim()}"`)
      : fail(`kro tab label format unexpected: "${kroTabLabel.trim()}"`);

    // ── Console errors ────────────────────────────────────────────────────────
    const relevantErrors = consoleErrors.filter(e =>
      !e.includes('favicon') && !e.includes('WebSocket') && !e.includes('net::ERR')
    );
    relevantErrors.length === 0
      ? ok('No console errors during journey')
      : fail(`Console errors: ${relevantErrors.join('; ')}`);

  } catch (e) {
    fail(`Unexpected error: ${e.message}`);
  } finally {
    // Cleanup
    try { await navigateHome(page, BASE_URL); } catch { /* best effort */ }
    try { await deleteDungeon(page, dNameMain); } catch { /* best effort */ }
    // dNameDelete was already deleted as part of the test
    await browser.close();

    console.log(`\n  Result: ${passed} passed, ${failed} failed, ${warnings} warnings`);
    process.exit(failed > 0 ? 1 : 0);
  }
}

run();
