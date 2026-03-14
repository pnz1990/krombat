// Journey 5: Status Effects — Poison, Burn, Stun
// UI-ONLY: no kubectl, no fetch/api, no execSync
// Strategy: fight against boss (25% burn, 15% stun) and monsters (20% poison)
// until effects are naturally inflicted, then verify badge display and tick behaviour.
const { chromium } = require('playwright');
const { createDungeonUI, waitForCombatResult, dismissLootPopup, navigateHome, deleteDungeon } = require('./helpers');

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const TIMEOUT = 15000;
let passed = 0, failed = 0, warnings = 0;
function ok(msg)   { console.log(`  ✅ ${msg}`); passed++; }
function fail(msg) { console.log(`  ❌ ${msg}`); failed++; }
function warn(msg) { console.log(`  ⚠️  ${msg}`); warnings++; }

async function getBodyText(page) { return page.textContent('body'); }

// Click first alive monster (not boss) attack button; returns combat text or null
async function attackMonster(page) {
  const btn = page.locator('.arena-entity.monster-entity:not(.dead) .arena-atk-btn.btn-primary').first();
  if (await btn.count() === 0) return null;
  await btn.click({ force: true });
  const result = await waitForCombatResult(page);
  await dismissLootPopup(page);
  return result;
}

// Click boss attack button; returns combat text or null
async function attackBoss(page) {
  const btn = page.locator('.arena-entity.boss-entity .arena-atk-btn.btn-primary');
  if (await btn.count() === 0) return null;
  await btn.click({ force: true });
  const result = await waitForCombatResult(page);
  await dismissLootPopup(page);
  return result;
}

// Attack any alive target; returns combat text or null
async function attackAny(page) {
  const r = await attackMonster(page);
  if (r !== null) return r;
  return attackBoss(page);
}

// Count status badges of class "effect" (poison / burn / stun)
async function effectBadgeCount(page) {
  return page.locator('.status-badge.effect').count();
}

// Return the current status badge numbers as { poison, burn, stun } by data-effect attribute
async function readEffectBadges(page) {
  const result = { poison: 0, burn: 0, stun: 0 };
  for (const effect of ['poison', 'burn', 'stun']) {
    const badge = page.locator(`.status-badge.effect[data-effect="${effect}"]`);
    if (await badge.count() > 0) {
      const text = await badge.locator('span').textContent().catch(() => '0');
      result[effect] = parseInt(text || '0', 10);
    }
  }
  return result;
}

// Fight until the enemy action mentions a keyword, for up to maxAttacks rounds.
// Returns the combat text that contained the keyword, or null.
async function fightUntilEffect(page, keyword, maxAttacks, useMonsters = true) {
  for (let i = 0; i < maxAttacks; i++) {
    const r = useMonsters ? await attackAny(page) : await attackBoss(page);
    if (r === null) return null; // no targets
    if (r.toUpperCase().includes(keyword.toUpperCase())) return r;
  }
  return null;
}

async function run() {
  console.log('🧪 Journey 5: Status Effects\n');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const dName = `j5-${Date.now()}`;

  const consoleErrors = [];
  page.on('console', msg => {
    if (msg.type() === 'error' && !msg.text().includes('WebSocket') && !msg.text().includes('404') && !msg.text().includes('net::ERR'))
      consoleErrors.push(msg.text());
  });
  page.on('dialog', dialog => dialog.accept());

  try {
    // === Setup ===
    // Use easy difficulty + 6 monsters so we get many counter-attack opportunities.
    // Dragon boss inflicts Burn (25%) and Stun (15%).
    // Monsters inflict Poison (20%).
    // With 6 monsters we expect ~1.2 poison procs before they're all dead.
    // We keep attacking until we observe each effect (warn if not seen within budget).
    console.log('=== Setup: Create Warrior Easy Dungeon ===');
    await page.goto(BASE_URL, { timeout: TIMEOUT });
    await page.waitForTimeout(2000);
    const created = await createDungeonUI(page, dName, { monsters: 6, difficulty: 'easy', heroClass: 'warrior' });
    created ? ok('Dungeon created via UI') : fail('Failed to create dungeon');

    // === STEP 1: Verify no status effects on fresh dungeon ===
    console.log('\n=== Step 1: No Effects on New Dungeon ===');
    const initBadges = await effectBadgeCount(page);
    initBadges === 0
      ? ok('No status badges on fresh dungeon')
      : fail(`Expected 0 effect badges, found ${initBadges}`);
    const initBody = await getBodyText(page);
    !initBody.includes('Poison') && !initBody.includes('Burn') && !initBody.includes('Stunned')
      ? ok('No status-effect text in initial UI')
      : warn('Unexpected effect text on fresh dungeon');

    // === STEP 2: Fight until Poison inflicted ===
    // Monsters have 20% proc; with 6 monsters and up to 12 attacks: ~P(at least 1) ≈ 93%.
    console.log('\n=== Step 2: Trigger Poison via Monster Counter-Attack ===');
    const poisonResult = await fightUntilEffect(page, 'POISON', 12, true);
    if (poisonResult) {
      ok('Poison inflicted by monster counter-attack');
      poisonResult.includes('POISON') || poisonResult.includes('Poison')
        ? ok('Combat text mentions POISON')
        : warn('POISON keyword found but text unclear');
    } else {
      warn('Poison not triggered in 12 attacks (20% chance — statistically possible); skipping poison badge tests');
    }

    // === STEP 3: Poison badge appears and shows correct turn count ===
    console.log('\n=== Step 3: Poison Badge Visible ===');
    if (poisonResult) {
      await page.waitForTimeout(1000);
      const effects = await readEffectBadges(page);
      effects.poison > 0
        ? ok(`Poison badge visible with count ${effects.poison}`)
        : fail('Poison badge not visible after POISON was inflicted');
      effects.poison === 3
        ? ok('Poison badge shows 3 turns')
        : (effects.poison > 0 ? warn(`Poison badge shows ${effects.poison} (expected 3)`) : null);
    } else {
      warn('Skipping: poison was not triggered');
    }

    // === STEP 4: Poison ticks on next attack (badge decrements + heroAction has "Poison") ===
    console.log('\n=== Step 4: Poison Ticks Each Turn ===');
    if (poisonResult) {
      const beforeEffects = await readEffectBadges(page);
      const r = await attackAny(page);
      if (r) {
        r.includes('Poison') || r.includes('-5')
          ? ok('Combat result mentions Poison tick')
          : warn('Poison tick not explicitly mentioned in combat text');
        await page.waitForTimeout(1000);
        const afterEffects = await readEffectBadges(page);
        afterEffects.poison < beforeEffects.poison
          ? ok(`Poison badge decremented: ${beforeEffects.poison} → ${afterEffects.poison}`)
          : fail(`Poison badge did not decrement: still ${afterEffects.poison}`);
      } else {
        warn('No target to attack for poison tick test');
      }
    } else {
      warn('Skipping: poison was not triggered');
    }

    // === STEP 5: Fight until all monsters dead, then fight boss for Burn/Stun ===
    // Dragon: Burn 25%, Stun 15%. With up to 20 boss attacks: P(burn) ≈ 100%, P(stun) ≈ 97%.
    console.log('\n=== Step 5: Kill Remaining Monsters to Reach Boss ===');
    let killed = 0;
    for (let i = 0; i < 20; i++) {
      const alive = await page.locator('.arena-entity.monster-entity:not(.dead)').count();
      if (alive === 0) break;
      const r = await attackMonster(page);
      if (r) killed++;
    }
    ok(`Killed remaining monsters (${killed} attacks)`);

    // Wait for boss to become targetable
    await page.waitForTimeout(3000);
    const bossBtn = page.locator('.arena-entity.boss-entity .arena-atk-btn.btn-primary');
    (await bossBtn.count()) > 0
      ? ok('Boss is now targetable')
      : warn('Boss not yet visible (may still be pending)');

    // === STEP 6: Trigger Burn via Boss counter-attack ===
    console.log('\n=== Step 6: Trigger Burn via Boss Counter-Attack ===');
    const burnResult = await fightUntilEffect(page, 'BURN', 20, false);
    if (burnResult) {
      ok('Burn inflicted by boss counter-attack');
      const effects = await readEffectBadges(page);
      effects.burn > 0
        ? ok(`Burn badge visible with count ${effects.burn}`)
        : fail('Burn badge not visible after BURN was inflicted');
      effects.burn === 2
        ? ok('Burn badge shows 2 turns')
        : (effects.burn > 0 ? warn(`Burn badge shows ${effects.burn} (expected 2)`) : null);
    } else {
      warn('Burn not triggered in 20 boss attacks (25% chance); skipping burn badge tests');
    }

    // === STEP 7: Burn ticks on next attack ===
    console.log('\n=== Step 7: Burn Ticks Each Turn ===');
    if (burnResult) {
      const bBefore = await readEffectBadges(page);
      const r = await attackBoss(page);
      if (r) {
        r.includes('Burn') || r.includes('-8')
          ? ok('Combat result mentions Burn tick')
          : warn('Burn tick not explicitly mentioned in combat text');
        await page.waitForTimeout(1000);
        const bAfter = await readEffectBadges(page);
        bAfter.burn < bBefore.burn
          ? ok(`Burn badge decremented: ${bBefore.burn} → ${bAfter.burn}`)
          : fail(`Burn badge did not decrement: still ${bAfter.burn}`);
      } else {
        warn('No boss to attack for burn tick test');
      }
    } else {
      warn('Skipping: burn was not triggered');
    }

    // === STEP 8: Trigger Stun via Boss counter-attack ===
    console.log('\n=== Step 8: Trigger Stun via Boss Counter-Attack ===');
    // If already stunned from earlier boss attacks, skip triggering
    const preStun = await readEffectBadges(page);
    let stunResult = null;
    if (preStun.stun > 0) {
      stunResult = 'already-stunned';
      ok(`Stun already active (${preStun.stun} turns) from earlier boss attacks`);
    } else {
      stunResult = await fightUntilEffect(page, 'STUN', 20, false);
      if (stunResult) {
        ok('Stun inflicted by boss counter-attack');
      } else {
        warn('Stun not triggered in 20 boss attacks (15% chance); skipping stun tests');
      }
    }

    // === STEP 9: Stun badge visible and hero attack is skipped ===
    console.log('\n=== Step 9: Stun — Hero Cannot Attack ===');
    if (stunResult) {
      const sEffects = await readEffectBadges(page);
      sEffects.stun > 0
        ? ok(`Stun badge visible with count ${sEffects.stun}`)
        : fail('Stun badge not visible after STUN was inflicted');

      // When stunned: heroAction should contain "STUNNED!" and no damage dealt to boss
      const rStun = await attackBoss(page);
      if (rStun) {
        rStun.includes('STUNNED') || rStun.includes('Stun')
          ? ok('Combat modal shows STUNNED when hero attacks')
          : fail(`Stun not shown in combat modal: ${rStun.substring(0, 120)}`);
        await page.waitForTimeout(1000);
        const sAfter = await readEffectBadges(page);
        sAfter.stun < (sEffects.stun > 0 ? sEffects.stun : 1)
          ? ok(`Stun badge consumed: ${sEffects.stun} → ${sAfter.stun}`)
          : fail(`Stun badge did not decrement: still ${sAfter.stun}`);
      } else {
        warn('No boss to attack for stun test');
      }
    } else {
      warn('Skipping stun test: stun not triggered');
    }

    // === STEP 10: Status info panel ===
    console.log('\n=== Step 10: Status Effect Info Panel ===');
    // The info/help panel should describe status effects
    const bodyForInfo = await getBodyText(page);
    bodyForInfo.includes('Poison') && bodyForInfo.includes('Burn') && bodyForInfo.includes('Stun')
      ? ok('Status effect info (Poison/Burn/Stun) visible in UI')
      : warn('Status effect info not found in body text');

    // === STEP 11: Console errors ===
    console.log('\n=== Step 11: Console Errors ===');
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
    // Best-effort cleanup
    try {
      await navigateHome(page, BASE_URL);
      await deleteDungeon(page, dName);
    } catch (_) {}
  } finally {
    await browser.close();
  }

  console.log(`\n${'='.repeat(50)}`);
  console.log(`  Journey 5: ${passed} passed, ${failed} failed, ${warnings} warnings`);
  console.log('='.repeat(50));
  process.exit(failed > 0 ? 1 : 0);
}

run();
