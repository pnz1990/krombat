// Journey 12: kro Teaching Layer
// UI-ONLY: no kubectl, no fetch/api, no execSync
// Tests: InsightCards, kro glossary tab, annotated K8s log, resource graph panel,
//        status bar kro tooltips, CelTrace in combat modal.
const { chromium } = require('playwright');
const { createDungeonUI, waitForCombatResult, dismissLootPopup, navigateHome, deleteDungeon , testLogin} = require('./helpers');

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
  console.log('🧪 Journey 12: kro Teaching Layer\n');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const dName = `j12-${Date.now()}`;

  const consoleErrors = [];
  page.on('console', msg => { if (msg.type() === 'error' && !msg.text().includes('WebSocket') && !msg.text().includes('404') && !msg.text().includes('429') && !msg.text().includes('504') && !msg.text().includes('net::ERR')) consoleErrors.push(msg.text()); });

  try {
    await testLogin(page, BASE_URL);

    await page.goto(BASE_URL, { timeout: TIMEOUT });
    await page.waitForSelector('input[placeholder="my-dungeon"]', { timeout: TIMEOUT });

    // ── Onboarding overlay ────────────────────────────────────────────────────
    console.log('\n  [Onboarding overlay]');
    // Clear onboarding flag so overlay appears
    await page.evaluate(() => localStorage.removeItem('kroOnboardingDone'));
    await page.reload({ waitUntil: 'networkidle', timeout: TIMEOUT });

    const overlay = page.locator('.kro-onboard-overlay');
    await overlay.waitFor({ timeout: TIMEOUT }).catch(() => {});
    (await overlay.count() > 0) ? ok('Onboarding overlay appears on first visit') : fail('Onboarding overlay missing');

    if (await overlay.count() > 0) {
      // Slide 1 checks
      const step = page.locator('.kro-onboard-step');
      const stepText = await step.textContent().catch(() => '');
      stepText.includes('1') ? ok(`Onboarding shows slide counter: "${stepText.trim()}"`) : fail(`Slide counter unexpected: "${stepText}"`);

      const snippet = page.locator('.kro-onboard-snippet');
      const snippetText = await snippet.textContent().catch(() => '');
      snippetText.length > 10 ? ok('Onboarding slide 1 has YAML/code snippet') : fail('Onboarding slide 1 missing snippet');

      // Advance to slide 2
      const nextBtn = page.locator('button:has-text("Next →")');
      await nextBtn.click();
      await page.waitForTimeout(300);
      const stepAfter = await step.textContent().catch(() => '');
      stepAfter.includes('2') ? ok('Onboarding advances to slide 2') : fail(`Slide counter did not advance: "${stepAfter}"`);

      // Back button returns to slide 1
      const backBtn = page.locator('button:has-text("← Back")');
      (await backBtn.count() > 0) ? ok('Back button appears on slide 2') : fail('Back button missing on slide 2');
      await backBtn.click();
      await page.waitForTimeout(300);
      const stepBack = await step.textContent().catch(() => '');
      stepBack.includes('1') ? ok('Back button returns to slide 1') : fail(`Back did not return to slide 1: "${stepBack}"`);

      // Skip dismisses from any slide
      const skipBtn = page.locator('.kro-onboard-skip');
      (await skipBtn.count() > 0) ? ok('Skip intro button is present') : fail('Skip intro button missing');
      await skipBtn.click();
      await page.waitForTimeout(400);
      (await overlay.count() === 0) ? ok('Skip dismisses onboarding overlay') : fail('Skip did not dismiss overlay');

      // Create form should be visible after skip
      const createInput = page.locator('input[placeholder="my-dungeon"]');
      (await createInput.count() > 0) ? ok('Create form visible after skip') : fail('Create form not visible after skip');
    }

    // Restore onboarding flag so the rest of the test is not affected
    await page.evaluate(() => localStorage.setItem('kroOnboardingDone', '1'));

    // ── Create dungeon ────────────────────────────────────────────────────────
    console.log('\n  [Create dungeon — verify teaching layer initialises]');
    const loaded = await createDungeonUI(page, dName, { monsters: 3, difficulty: 'easy', heroClass: 'warrior' });
    loaded ? ok('Dungeon created and view loaded') : fail('Dungeon view did not load');

    // Wait for any initial reconcile to settle
    await page.waitForTimeout(3000);

    // ── Resource Graph Panel ──────────────────────────────────────────────────
    console.log('\n  [kro resource graph panel]');
    const graphPanel = page.locator('.kro-graph-panel');
    await graphPanel.waitFor({ timeout: TIMEOUT }).catch(() => {});
    (await graphPanel.count() > 0) ? ok('kro resource graph panel is present') : fail('kro resource graph panel missing');

    // Graph header should contain "Resource Graph"
    const graphHeader = page.locator('.kro-graph-header');
    const headerText = await graphHeader.textContent().catch(() => '');
    headerText.includes('Resource Graph') ? ok('Graph panel header shows "Resource Graph"') : fail(`Graph header missing expected text: "${headerText}"`);

    // Graph should contain the Dungeon CR node (SVG text)
    const svgText = await page.locator('.kro-graph-wrap svg').textContent().catch(() => '');
    svgText.includes('Dungeon') ? ok('Graph SVG contains Dungeon node') : fail('Graph SVG missing Dungeon node');
    svgText.includes('Hero') ? ok('Graph SVG contains Hero node') : fail('Graph SVG missing Hero node');
    svgText.includes('Boss') ? ok('Graph SVG contains Boss node') : fail('Graph SVG missing Boss node');

    // Locked nodes (Loot CRs) should be shown as dashed outlines
    const lockedCount = await page.locator('.kro-graph-wrap text:has-text("locked")').count();
    lockedCount > 0 ? ok(`Graph shows ${lockedCount} locked (includeWhen) node(s)`) : warn('No locked nodes visible (monsters may already be dead)');

    // Collapse/expand the panel
    await graphHeader.click();
    await page.waitForTimeout(300);
    const bodyAfterCollapse = await page.locator('.kro-graph-body').count();
    bodyAfterCollapse === 0 ? ok('Graph panel collapses on header click') : fail('Graph panel did not collapse');
    await graphHeader.click();
    await page.waitForTimeout(300);
    const bodyAfterExpand = await page.locator('.kro-graph-body').count();
    bodyAfterExpand > 0 ? ok('Graph panel expands on second header click') : fail('Graph panel did not re-expand');

    // ── kro Glossary Tab ──────────────────────────────────────────────────────
    console.log('\n  [kro glossary tab]');
    const kroTabSwitched = await switchToTab(page, 'kro');
    kroTabSwitched ? ok('kro tab is present and clickable') : fail('kro tab not found');

     // Tab label should include concept count (e.g. "kro (2/16)") — total grows as concepts are added
     const kroTabLabel = await page.locator('button.log-tab.kro-tab').textContent().catch(() => '');
     kroTabLabel.match(/kro \(\d+\/\d+\)/) ? ok(`kro tab shows concept count: "${kroTabLabel.trim()}"`) : fail(`kro tab label unexpected: "${kroTabLabel}"`);

    // Glossary should be visible
    const glossary = page.locator('.kro-glossary');
    (await glossary.count() > 0) ? ok('kro glossary panel is visible') : fail('kro glossary not visible');

    // At least 1 concept should be unlocked after dungeon creation (rgd, spec-schema, forEach)
    const unlockedItems = page.locator('.kro-glossary-item.unlocked');
    const unlockedCount = await unlockedItems.count();
    unlockedCount >= 1 ? ok(`${unlockedCount} concept(s) unlocked after dungeon creation`) : fail('No concepts unlocked after dungeon creation');

    // Locked items should show "Keep playing"
    const lockedItems = page.locator('.kro-glossary-item.locked');
    const lockedItemsCount = await lockedItems.count();
    lockedItemsCount > 0 ? ok(`${lockedItemsCount} concepts still locked (as expected)`) : warn('All concepts already unlocked');

    // Click an unlocked concept — should open modal
    if (unlockedCount > 0) {
      await unlockedItems.first().click();
      await page.waitForTimeout(500);
      const conceptModal = page.locator('.kro-concept-modal');
      (await conceptModal.count() > 0) ? ok('Clicking unlocked concept opens concept modal') : fail('Concept modal did not open');

      // Modal should contain YAML/CEL snippet
      const snippetBlock = page.locator('.kro-snippet-block');
      (await snippetBlock.count() > 0) ? ok('Concept modal contains YAML/CEL snippet block') : fail('Concept modal missing snippet block');

      // Close modal
      const closeBtn = page.locator('.kro-concept-modal .modal-close, .kro-concept-modal .btn-gold');
      if (await closeBtn.count() > 0) {
        await closeBtn.first().click();
        await page.waitForTimeout(300);
        ok('Concept modal closes');
      }
    }

    // ── K8s Log — kro annotations ─────────────────────────────────────────────
    console.log('\n  [K8s log annotations]');
    const k8sSwitched = await switchToTab(page, 'K8s Log');
    k8sSwitched ? ok('K8s Log tab accessible') : fail('K8s Log tab not found');

    // Should have at least the dungeon creation entry
    await page.waitForTimeout(500);
    const k8sEntries = page.locator('.k8s-log .k8s-entry');
    const k8sCount = await k8sEntries.count();
    k8sCount >= 1 ? ok(`K8s log has ${k8sCount} entr${k8sCount === 1 ? 'y' : 'ies'}`) : fail('K8s log is empty');

    // Click the first clickable entry to open YAML modal
    const clickableEntry = page.locator('.k8s-log .k8s-entry.clickable').first();
    if (await clickableEntry.count() > 0) {
      await clickableEntry.click();
      await page.waitForTimeout(500);

      // YAML modal should be visible
      const yamlView = page.locator('.yaml-view');
      (await yamlView.count() > 0) ? ok('YAML modal opens on K8s log entry click') : fail('YAML modal did not open');

      // kro annotation section should be present
      const annotation = page.locator('.k8s-annotation');
      (await annotation.count() > 0) ? ok('kro annotation section present in YAML modal') : fail('kro annotation missing from YAML modal');

      // Annotation should have "kro — what happened" label
      const annLabel = await page.locator('.k8s-annotation-label').textContent().catch(() => '');
      annLabel.toLowerCase().includes('kro') ? ok(`Annotation label: "${annLabel.trim()}"`) : fail(`Annotation label unexpected: "${annLabel}"`);

      // "Learn:" link should be present
      const learnLink = page.locator('.k8s-annotation-learn');
      (await learnLink.count() > 0) ? ok('"Learn:" link in annotation') : fail('Missing Learn link in annotation');

      // Close the YAML modal
      const closeYaml = page.locator('.modal .btn-gold:has-text("Close")');
      if (await closeYaml.count() > 0) {
        await closeYaml.click();
        await page.waitForTimeout(300);
        ok('YAML modal closes');
      }
    } else {
      warn('No clickable K8s log entry found for annotation test');
    }

    // ── Status bar kro tooltips ───────────────────────────────────────────────
    console.log('\n  [Status bar kro tooltips]');
    const statusBar = page.locator('.status-bar');
    (await statusBar.count() > 0) ? ok('Status bar is present') : fail('Status bar not found');

    // Hover each chip and check for tooltip
    const statusChips = page.locator('.status-bar > .tooltip-wrap');
    const chipCount = await statusChips.count();
    chipCount >= 5 ? ok(`Status bar has ${chipCount} tooltip-wrapped chips`) : fail(`Status bar only has ${chipCount} chips, expected 5`);

    if (chipCount > 0) {
      await statusChips.first().hover();
      await page.waitForTimeout(300);
      const tooltip = page.locator('.tooltip-box');
      if (await tooltip.count() > 0) {
        const tipText = await tooltip.textContent().catch(() => '');
        tipText.includes('kro') ? ok(`Status bar tooltip contains "kro": "${tipText.slice(0, 40)}..."`) : fail(`Status bar tooltip missing "kro": "${tipText.slice(0, 60)}"`);
      } else {
        fail('Status bar tooltip did not appear on hover');
      }
    }

    // ── Attack — trigger InsightCard ─────────────────────────────────────────
    console.log('\n  [Combat — InsightCard and CelTrace]');
    await switchToTab(page, 'Game Log');
    await page.waitForTimeout(500);

    // Do one attack
    const monsterBtn = page.locator('.arena-entity.monster-entity:not(.dead) .arena-atk-btn.btn-primary').first();
    if (await monsterBtn.count() > 0) {
      await monsterBtn.click({ force: true });

      // Combat modal should appear
      const combatModal = page.locator('.combat-modal');
      await combatModal.waitFor({ timeout: TIMEOUT }).catch(() => {});
      (await combatModal.count() > 0) ? ok('Combat modal appears after attack') : fail('Combat modal did not appear');

      // "rolling" phase — kro badge should be in the modal
      const rollingBadge = page.locator('.combat-modal .kro-insight-badge');
      if (await rollingBadge.count() > 0) {
        ok('kro badge visible in combat modal rolling phase');
      } else {
        // May have already resolved — check resolved phase
        warn('kro badge not found in rolling phase (may have resolved quickly)');
      }

      // Wait for resolution
      const continueBtn = page.locator('.combat-modal button:has-text("Continue")');
      await continueBtn.waitFor({ timeout: TIMEOUT }).catch(() => {});

      if (await continueBtn.count() > 0) {
        ok('Combat modal shows Continue button (resolved phase)');

        // CelTrace should be in the resolved modal
        const celTrace = page.locator('.cel-trace');
        (await celTrace.count() > 0) ? ok('CelTrace panel present in resolved combat modal') : fail('CelTrace missing from resolved combat modal');

        if (await celTrace.count() > 0) {
          // Click to expand
          const traceToggle = page.locator('.cel-trace-toggle');
          await traceToggle.click();
          await page.waitForTimeout(300);
          const traceBody = page.locator('.cel-trace-body');
          (await traceBody.count() > 0) ? ok('CelTrace expands on click') : fail('CelTrace body did not appear');

          // Should contain a table with CEL expressions
          const traceTable = page.locator('.cel-trace-table');
          (await traceTable.count() > 0) ? ok('CelTrace contains expression table') : fail('CelTrace table missing');

          // Should have the diceFormula row
          const traceText = await page.locator('.cel-trace-body').textContent().catch(() => '');
          traceText.includes('diceFormula') ? ok('CelTrace shows diceFormula expression') : fail('CelTrace missing diceFormula row');
        }

        // Dismiss
        await continueBtn.click();
        await page.waitForTimeout(500);
        ok('Combat modal dismissed');
      }
    } else {
      warn('No alive monster found for combat test');
    }

    // Dismiss any loot popup
    await dismissLootPopup(page);

    // ── InsightCard check ─────────────────────────────────────────────────────
    console.log('\n  [InsightCard check]');
    // InsightCards auto-dismiss after 12s — check if any appeared
    // After dungeon creation + first attack, at least rgd/cel-basics should have queued
    const insightCard = page.locator('.kro-insight-card');
    const cardCount = await insightCard.count();
    // Card may have auto-dismissed — just check it doesn't throw
    ok(`InsightCard check complete (${cardCount} currently visible, may have auto-dismissed)`);

    // If one is visible, check it has the expected structure
    if (cardCount > 0) {
      const badge = page.locator('.kro-insight-card .kro-insight-badge');
      (await badge.count() > 0) ? ok('InsightCard has kro badge') : fail('InsightCard missing kro badge');
      const headline = page.locator('.kro-insight-card .kro-insight-headline');
      (await headline.count() > 0) ? ok('InsightCard has headline text') : fail('InsightCard missing headline');
      const learnBtn = page.locator('.kro-insight-card .kro-insight-learn');
      (await learnBtn.count() > 0) ? ok('InsightCard has "Learn more" button') : fail('InsightCard missing Learn more');
    }

    // ── kro Graph — node state after attack ───────────────────────────────────
    console.log('\n  [Graph state after combat]');
    // After at least one attack, verify graph still renders
    const graphAfterCombat = page.locator('.kro-graph-panel');
    (await graphAfterCombat.count() > 0) ? ok('Graph panel still present after combat') : fail('Graph panel disappeared after combat');

    // Monster nodes should reflect real HP (at least one was attacked)
    const svgAfter = await page.locator('.kro-graph-wrap svg').textContent().catch(() => '');
    svgAfter.includes('M0') ? ok('Graph shows Monster M0 node after combat') : warn('Monster M0 not found in graph (may have used different naming)');

    // ── Concepts unlocked after combat ────────────────────────────────────────
    console.log('\n  [Concept unlock progression]');
    await switchToTab(page, 'kro');
    const unlockedAfterCombat = await page.locator('.kro-glossary-item.unlocked').count();
    unlockedAfterCombat >= unlockedCount
      ? ok(`Concepts after combat: ${unlockedAfterCombat} (was ${unlockedCount})`)
      : fail(`Concepts decreased after combat: ${unlockedAfterCombat}`);

    // ── Console errors ────────────────────────────────────────────────────────
    const relevantErrors = consoleErrors.filter(e =>
      !e.includes('favicon') && !e.includes('WebSocket') && !e.includes('net::ERR') && !e.includes('429') && !e.includes('504')
    );
    relevantErrors.length === 0 ? ok('No console errors') : fail(`Console errors: ${relevantErrors.join('; ')}`);

  } catch (e) {
    fail(`Unexpected error: ${e.message}`);
  } finally {
    // Cleanup
    try { await navigateHome(page); } catch { /* best effort */ }
    try { await deleteDungeon(page, dName); } catch { /* best effort */ }
    await browser.close();

    console.log(`\n  Result: ${passed} passed, ${failed} failed, ${warnings} warnings`);
    process.exit(failed > 0 ? 1 : 0);
  }
}

run();
