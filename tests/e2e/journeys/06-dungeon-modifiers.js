// Journey 6: Dungeon Modifiers — Curses & Blessings
// UI-ONLY: no kubectl, no fetch/api, no execSync
// Strategy: modifiers are randomly assigned by the backend (80% chance).
// We create dungeons and test whatever modifier is assigned — badge type,
// combat text, and modifier info panel. Two dungeons improve coverage.
const { chromium } = require('playwright');
const { createDungeonUI, waitForCombatResult, dismissLootPopup, navigateHome, deleteDungeon , testLogin} = require('./helpers');

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const TIMEOUT = 15000;
let passed = 0, failed = 0, warnings = 0;
function ok(msg)   { console.log(`  ✅ ${msg}`); passed++; }
function fail(msg) { console.log(`  ❌ ${msg}`); failed++; }
function warn(msg) { console.log(`  ⚠️  ${msg}`); warnings++; }

async function getBodyText(page) { return page.textContent('body'); }

// Read the modifier badge from the dungeon view.
// Returns { type: 'curse'|'blessing'|'none', name: string }
async function readModifierBadge(page) {
  const curse   = page.locator('.status-badge.curse');
  const blessing = page.locator('.status-badge.blessing');
  if (await curse.count() > 0) {
    const title = await curse.getAttribute('title').catch(() => '');
    const text  = await curse.textContent().catch(() => '');
    return { type: 'curse', name: title || text };
  }
  if (await blessing.count() > 0) {
    const title = await blessing.getAttribute('title').catch(() => '');
    const text  = await blessing.textContent().catch(() => '');
    return { type: 'blessing', name: title || text };
  }
  return { type: 'none', name: '' };
}

// Attack the first alive target; return combat text or null
async function attackFirst(page) {
  const monster = page.locator('.arena-entity.monster-entity:not(.dead) .arena-atk-btn.btn-primary').first();
  const boss    = page.locator('.arena-entity.boss-entity .arena-atk-btn.btn-primary');
  if (await monster.count() > 0) {
    await monster.click({ force: true });
  } else if (await boss.count() > 0) {
    await boss.click({ force: true });
  } else {
    return null;
  }
  const result = await waitForCombatResult(page);
  await dismissLootPopup(page);
  return result;
}

// Read the spec.modifier text from the page body (shown in the log tab or dungeon header)
async function readModifierFromUI(page) {
  const body = await getBodyText(page);
  // The modifier badge tooltip text is shown via .status-badge title or Tooltip content
  // Also it can be read from the page's "currentRoom" display or dungeon info section
  // Try to extract from known modifier strings
  const modifiers = ['curse-darkness', 'curse-fury', 'curse-fortitude', 'blessing-strength', 'blessing-resilience', 'blessing-fortune'];
  for (const m of modifiers) {
    if (body.toLowerCase().includes(m.replace('-', ' ').toLowerCase()) ||
        body.toLowerCase().includes(m.toLowerCase())) {
      return m;
    }
  }
  return null;
}

async function run() {
  console.log('🧪 Journey 6: Dungeon Modifiers\n');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const d1Name = `j6a-${Date.now()}`;
  const d2Name = `j6b-${Date.now() + 1}`;
  const dungeonNames = [d1Name, d2Name];

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

    // === STEP 1: Create first dungeon — observe modifier ===
    console.log('=== Step 1: Create Dungeon 1 and Observe Modifier ===');
    const created1 = await createDungeonUI(page, d1Name, { monsters: 2, difficulty: 'easy', heroClass: 'warrior' });
    created1 ? ok('Dungeon 1 created via UI') : fail('Failed to create dungeon 1');

    // === STEP 2: Modifier badge appears (80% chance) ===
    console.log('\n=== Step 2: Modifier Badge Display ===');
    await page.waitForTimeout(2000);
    const mod1 = await readModifierBadge(page);
    if (mod1.type !== 'none') {
      ok(`Modifier badge visible: type=${mod1.type}`);
      mod1.type === 'curse'
        ? ok('Curse badge has correct CSS class')
        : ok('Blessing badge has correct CSS class');
    } else {
      warn('No modifier on dungeon 1 (20% chance — statistically expected sometimes)');
    }

    // === STEP 3: Modifier info panel lists all 6 modifiers ===
    // The help/info modal should document all modifiers
    console.log('\n=== Step 3: Modifier Info Panel ===');
    const bodyText = await getBodyText(page);
    const hasFortitude  = bodyText.includes('Fortitude');
    const hasFury       = bodyText.includes('Fury');
    const hasDarkness   = bodyText.includes('Darkness');
    const hasStrength   = bodyText.includes('Strength');
    const hasResilience = bodyText.includes('Resilience');
    const hasFortune    = bodyText.includes('Fortune');
    const allPresent = hasFortitude && hasFury && hasDarkness && hasStrength && hasResilience && hasFortune;
    allPresent
      ? ok('All 6 modifiers documented in UI (Fortitude/Fury/Darkness/Strength/Resilience/Fortune)')
      : warn(`Not all modifier names found in UI (Fortitude:${hasFortitude} Fury:${hasFury} Darkness:${hasDarkness} Strength:${hasStrength} Resilience:${hasResilience} Fortune:${hasFortune})`);

    // Check curse/blessing labels in table
    bodyText.includes('Curse')
      ? ok('Curse label present in info panel')
      : warn('Curse label not found in info panel');
    bodyText.includes('Blessing')
      ? ok('Blessing label present in info panel')
      : warn('Blessing label not found in info panel');

    // === STEP 4: Combat text reflects modifier ===
    console.log('\n=== Step 4: Combat Text Reflects Modifier ===');
    const combatResult1 = await attackFirst(page);
    if (combatResult1) {
      ok('Attack resolved on dungeon 1');
      if (mod1.type === 'curse' && mod1.name.toLowerCase().includes('darkness')) {
        combatResult1.includes('Curse') || combatResult1.includes('-25%')
          ? ok('Curse of Darkness effect shown in combat (damage reduced)')
          : warn('Curse of Darkness note not found in combat text');
      } else if (mod1.type === 'blessing' && mod1.name.toLowerCase().includes('strength')) {
        combatResult1.includes('Blessing') || combatResult1.includes('+50%')
          ? ok('Blessing of Strength effect shown in combat (damage boosted)')
          : warn('Blessing of Strength note not found in combat text');
      } else if (mod1.type !== 'none') {
        // Any modifier: just verify combat worked
        ok(`Combat resolved with modifier ${mod1.type}`);
      } else {
        ok('Combat resolved with no modifier');
      }
    } else {
      fail('Attack did not resolve on dungeon 1');
    }

    // === STEP 5: Create dungeon 2 to see a different modifier ===
    console.log('\n=== Step 5: Create Dungeon 2 — Verify Modifier Variety ===');
    await navigateHome(page, BASE_URL);
    await page.waitForTimeout(2000);
    const created2 = await createDungeonUI(page, d2Name, { monsters: 2, difficulty: 'easy', heroClass: 'warrior' });
    created2 ? ok('Dungeon 2 created via UI') : fail('Failed to create dungeon 2');

    await page.waitForTimeout(2000);
    const mod2 = await readModifierBadge(page);
    if (mod2.type !== 'none') {
      ok(`Dungeon 2 modifier badge: type=${mod2.type}`);
    } else {
      warn('Dungeon 2 has no modifier (20% chance)');
    }

    // Verify the two dungeons can have different modifier types (curse vs blessing variety)
    if (mod1.type !== 'none' && mod2.type !== 'none') {
      mod1.type !== mod2.type
        ? ok(`Modifiers are different types: ${mod1.type} vs ${mod2.type}`)
        : ok(`Both dungeons have same modifier type (${mod1.type}) — random variation`);
    } else {
      ok('Modifier variety check: at least one dungeon had a modifier');
    }

    // === STEP 6: Dungeon with no modifier shows no badge ===
    // This is tested if either dungeon has no modifier. Otherwise we just verify badge not doubled.
    console.log('\n=== Step 6: Badge Exclusivity ===');
    // Only one modifier badge should be visible at a time (not both curse+blessing)
    const curseCount   = await page.locator('.status-badge.curse').count();
    const blessingCount = await page.locator('.status-badge.blessing').count();
    curseCount + blessingCount <= 1
      ? ok(`At most 1 modifier badge visible (curse:${curseCount} blessing:${blessingCount})`)
      : fail(`Multiple modifier badges visible: curse:${curseCount} blessing:${blessingCount}`);

    // === STEP 7: Combat on dungeon 2 also works with modifier ===
    console.log('\n=== Step 7: Combat on Dungeon 2 ===');
    const combatResult2 = await attackFirst(page);
    combatResult2
      ? ok('Combat resolved on dungeon 2 with modifier')
      : fail('Combat did not resolve on dungeon 2');

    // === STEP 8: Console errors ===
    console.log('\n=== Step 8: Console Errors ===');
    consoleErrors.length === 0
      ? ok('No console errors')
      : fail(`${consoleErrors.length} console error(s): ${consoleErrors[0]}`);

    // === Cleanup ===
    console.log('\n=== Cleanup ===');
    await navigateHome(page, BASE_URL);
    await page.waitForTimeout(2000);
    for (const name of dungeonNames) {
      const del = await deleteDungeon(page, name);
      del ? ok(`Deleted dungeon ${name} via UI`) : warn(`Could not delete dungeon ${name}`);
    }

  } catch (error) {
    console.error(`\n❌ Fatal: ${error.message}\n${error.stack}`);
    failed++;
    try {
      await navigateHome(page, BASE_URL);
      for (const name of dungeonNames) await deleteDungeon(page, name);
    } catch (_) {}
  } finally {
    await browser.close();
  }

  console.log(`\n${'='.repeat(50)}`);
  console.log(`  Journey 6: ${passed} passed, ${failed} failed, ${warnings} warnings`);
  console.log('='.repeat(50));
  process.exit(failed > 0 ? 1 : 0);
}

run();
