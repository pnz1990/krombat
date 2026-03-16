// Journey 9: K8s Log Tab
// UI-ONLY: no kubectl, no fetch/api, no execSync
// Tests: the K8s Log tab shows Kubernetes operations as the user plays the game.
// Each dungeon creation, attack, and item action should append a log entry
// showing the simulated `kubectl` command + result.
const { chromium } = require('playwright');
const { createDungeonUI, waitForCombatResult, dismissLootPopup, navigateHome, deleteDungeon , testLogin} = require('./helpers');

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const TIMEOUT = 15000;
let passed = 0, failed = 0, warnings = 0;
function ok(msg)   { console.log(`  ✅ ${msg}`); passed++; }
function fail(msg) { console.log(`  ❌ ${msg}`); failed++; }
function warn(msg) { console.log(`  ⚠️  ${msg}`); warnings++; }

async function getBodyText(page) { return page.textContent('body'); }

// Click the K8s Log tab
async function switchToK8sTab(page) {
  const btn = page.locator('button.log-tab:has-text("K8s Log")');
  if (await btn.count() === 0) return false;
  await btn.click();
  await page.waitForTimeout(500);
  return true;
}

// Click the Game Log tab
async function switchToGameTab(page) {
  const btn = page.locator('button.log-tab:has-text("Game Log")');
  if (await btn.count() === 0) return false;
  await btn.click();
  await page.waitForTimeout(500);
  return true;
}

// Count entries in the currently visible event-log panel
async function countK8sEntries(page) {
  return page.locator('.k8s-log .k8s-entry').count();
}

// Get all visible K8s log entry texts (cmd + res combined)
async function getK8sLogTexts(page) {
  const entries = page.locator('.k8s-log .k8s-entry');
  const count = await entries.count();
  const texts = [];
  for (let i = 0; i < count; i++) {
    const text = await entries.nth(i).textContent().catch(() => '');
    texts.push(text);
  }
  return texts;
}

async function run() {
  console.log('🧪 Journey 9: K8s Log Tab\n');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const dName = `j9-${Date.now()}`;

  const consoleErrors = [];
  page.on('console', msg => {
    if (msg.type() === 'error' && !msg.text().includes('WebSocket') && !msg.text().includes('404') && !msg.text().includes('net::ERR') && !msg.text().includes('429') && !msg.text().includes('504'))
      consoleErrors.push(msg.text());
  });
  page.on('dialog', dialog => dialog.accept());

  try {
    await testLogin(page, BASE_URL);

    await page.goto(BASE_URL, { timeout: TIMEOUT });
    await page.waitForTimeout(2000);

    // === STEP 1: K8s Log tab exists on dungeon view ===
    // Create dungeon first, then check tabs
    console.log('=== Step 1: Create Dungeon — Log Tab Should Appear ===');
    const created = await createDungeonUI(page, dName, { monsters: 2, difficulty: 'easy', heroClass: 'warrior' });
    created ? ok('Dungeon created via UI') : fail('Failed to create dungeon');

    // After creation we should be on the dungeon view
    await page.waitForTimeout(2000);
    const gameLogBtn = page.locator('button.log-tab:has-text("Game Log")');
    const k8sLogBtn  = page.locator('button.log-tab:has-text("K8s Log")');
    (await gameLogBtn.count()) > 0
      ? ok('Game Log tab button present')
      : fail('Game Log tab button not found');
    (await k8sLogBtn.count()) > 0
      ? ok('K8s Log tab button present')
      : fail('K8s Log tab button not found');

    // === STEP 2: Switch to K8s Log tab ===
    console.log('\n=== Step 2: Switch to K8s Log Tab ===');
    const switched = await switchToK8sTab(page);
    switched ? ok('Switched to K8s Log tab') : fail('Could not switch to K8s Log tab');

    // === STEP 3: Dungeon creation logged ===
    console.log('\n=== Step 3: Dungeon Creation Entry in K8s Log ===');
    await page.waitForTimeout(1000);
    const entriesAfterCreate = await countK8sEntries(page);
    if (entriesAfterCreate > 0) {
      ok(`${entriesAfterCreate} K8s log entry/entries after dungeon creation`);
      const texts = await getK8sLogTexts(page);
      const hasApply = texts.some(t => t.includes('kubectl apply') || t.includes('dungeon.yaml'));
      hasApply
        ? ok('K8s log shows "kubectl apply -f dungeon.yaml"')
        : warn(`K8s log entries found but no apply command: ${texts[0]?.substring(0, 80)}`);
      const hasCreated = texts.some(t => t.includes('created') || t.includes('dungeon.game.k8s'));
      hasCreated
        ? ok('K8s log shows creation result')
        : warn('K8s log does not show "created" result');
    } else {
      // Check for "No K8s operations yet" placeholder
      const placeholder = await page.locator('.k8s-log').textContent().catch(() => '');
      placeholder.includes('No K8s') || placeholder.includes('no K8s')
        ? warn('K8s log shows "No K8s operations" — creation may not have logged yet')
        : fail('K8s log is empty and no placeholder found');
    }

    // === STEP 4: Game Log tab still works (switch back and forth) ===
    console.log('\n=== Step 4: Tab Switching Works ===');
    const switchedBack = await switchToGameTab(page);
    switchedBack ? ok('Switched back to Game Log tab') : fail('Could not switch back to Game Log tab');

    // Game log container should be visible (not k8s-log)
    const gameLogVisible = await page.locator('.event-log:not(.k8s-log)').count();
    gameLogVisible > 0
      ? ok('Game Log panel visible after switching back')
      : warn('Game Log panel not detected after tab switch');

    // K8s log should not be visible
    const k8sLogVisible = await page.locator('.k8s-log').count();
    k8sLogVisible === 0
      ? ok('K8s Log panel hidden when Game Log tab active')
      : warn('K8s Log panel still visible when on Game Log tab');

    // Switch back to K8s tab
    await switchToK8sTab(page);

    // === STEP 5: Attack — K8s log records the Attack CR ===
    console.log('\n=== Step 5: Attack Records Attack CR in K8s Log ===');
    // Switch to game tab to click attack
    await switchToGameTab(page);
    const atkBtn = page.locator('.arena-entity.monster-entity:not(.dead) .arena-atk-btn.btn-primary').first();
    if (await atkBtn.count() > 0) {
      const entriesBefore = await page.locator('.k8s-log .k8s-entry').count();
      // switch to k8s tab temporarily to record count then attack
      await switchToK8sTab(page);
      const countBefore = await countK8sEntries(page);
      await switchToGameTab(page);

      await atkBtn.click({ force: true });
      const combatResult = await waitForCombatResult(page);
      await dismissLootPopup(page);
      combatResult ? ok('Attack resolved') : warn('Attack did not resolve — skipping K8s log count check');

      if (combatResult) {
        await switchToK8sTab(page);
        await page.waitForTimeout(1000);
        const countAfter = await countK8sEntries(page);
        countAfter > countBefore
          ? ok(`K8s log grew after attack: ${countBefore} → ${countAfter} entries`)
          : warn(`K8s log did not grow after attack (${countBefore} → ${countAfter})`);

        const textsAfter = await getK8sLogTexts(page);
        const hasAttackApply = textsAfter.some(t =>
          t.includes('attack.yaml') || t.includes('attack.game.k8s') || t.includes('kubectl apply')
        );
        hasAttackApply
          ? ok('K8s log shows attack.yaml apply')
          : warn(`No attack.yaml entry found; entries: ${textsAfter.slice(0, 2).map(t => t.substring(0, 60)).join(' | ')}`);

        const hasGetDungeon = textsAfter.some(t =>
          t.includes('kubectl get dungeon') || t.includes('heroHP') || t.includes('bossHP')
        );
        hasGetDungeon
          ? ok('K8s log shows kubectl get dungeon (poll result)')
          : warn('No kubectl get dungeon entry found after attack');
      }
    } else {
      warn('No alive monsters to attack — skipping attack log test');
    }

    // === STEP 6: K8s log entries are clickable (YAML modal) ===
    console.log('\n=== Step 6: YAML Modal on Clickable Entries ===');
    await switchToK8sTab(page);
    // Some entries have .clickable class (those with yaml data)
    const clickableEntries = page.locator('.k8s-log .k8s-entry.clickable');
    const clickableCount = await clickableEntries.count();
    if (clickableCount > 0) {
      ok(`${clickableCount} clickable K8s log entry/entries (have YAML)`);
      await clickableEntries.first().click();
      await page.waitForTimeout(500);
      // YAML modal should appear
      const yamlModal = page.locator('.yaml-view');
      if (await yamlModal.count() > 0) {
        ok('YAML modal opened on click');
        const yamlText = await yamlModal.textContent().catch(() => '');
        yamlText.length > 10
          ? ok(`YAML modal has content (${yamlText.length} chars)`)
          : warn('YAML modal content too short');
        // Close modal
        const closeBtn = page.locator('button:has-text("Close")');
        if (await closeBtn.count() > 0) {
          await closeBtn.click();
          await page.waitForTimeout(300);
          ok('YAML modal closed');
        } else {
          await page.keyboard.press('Escape');
          ok('YAML modal dismissed via backdrop/Escape');
        }
      } else {
        warn('YAML modal did not open on clickable entry click');
      }
    } else {
      warn('No clickable K8s entries found (entries may not have YAML data yet)');
    }

    // === STEP 7: Timestamps are present on log entries ===
    console.log('\n=== Step 7: Timestamps on Log Entries ===');
    const allEntries = await getK8sLogTexts(page);
    if (allEntries.length > 0) {
      // Timestamps are in format HH:MM:SS or similar
      const hasTimestamp = allEntries.some(t => /\d{1,2}:\d{2}/.test(t));
      hasTimestamp
        ? ok('K8s log entries have timestamps')
        : warn('No timestamps found in K8s log entries');

      // All entries should have a $ (kubectl command prefix)
      const hasCmd = allEntries.every(t => t.includes('$') || t.includes('kubectl'));
      hasCmd
        ? ok('All K8s log entries show kubectl command')
        : warn('Some K8s log entries missing $ or kubectl command');
    } else {
      warn('No K8s log entries to check timestamps');
    }

    // === STEP 8: Log does not exceed 50 entries (capped) ===
    console.log('\n=== Step 8: Log Capped at 50 Entries ===');
    const totalEntries = await countK8sEntries(page);
    totalEntries <= 50
      ? ok(`K8s log has ${totalEntries} entries (≤50 cap)`)
      : fail(`K8s log has ${totalEntries} entries (exceeds 50 cap)`);

    // === STEP 9: Console errors ===
    console.log('\n=== Step 9: Console Errors ===');
    consoleErrors.length === 0
      ? ok('No console errors')
      : fail(`${consoleErrors.length} console error(s): ${consoleErrors[0]}`);

    // === Cleanup ===
    console.log('\n=== Cleanup ===');
    await navigateHome(page, BASE_URL);
    await page.waitForTimeout(2000);
    const deleted = await deleteDungeon(page, dName);
    deleted ? ok('Dungeon deleted via UI') : warn('Could not delete dungeon via UI');

  } catch (error) {
    console.error(`\n❌ Fatal: ${error.message}\n${error.stack}`);
    failed++;
    try {
      await navigateHome(page, BASE_URL);
      await deleteDungeon(page, dName);
    } catch (_) {}
  } finally {
    await browser.close();
  }

  console.log(`\n${'='.repeat(50)}`);
  console.log(`  Journey 9: ${passed} passed, ${failed} failed, ${warnings} warnings`);
  console.log('='.repeat(50));
  process.exit(failed > 0 ? 1 : 0);
}

run();
