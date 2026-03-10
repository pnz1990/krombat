// Journey 1: Warrior Easy — Full UI Playthrough (UI-ONLY, no kubectl, no API)
const { chromium } = require('playwright');
const { createDungeonUI, attackMonster, attackBoss, dismissLootPopup, aliveMonsterCount, deadMonsterCount, getBodyText, waitForCombatResult } = require('./helpers');

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const TIMEOUT = 15000;
let passed = 0, failed = 0, warnings = 0;
function ok(msg) { console.log(`  ✅ ${msg}`); passed++; }
function fail(msg) { console.log(`  ❌ ${msg}`); failed++; }
function warn(msg) { console.log(`  ⚠️  ${msg}`); warnings++; }

// Dismiss any modal that's blocking (combat Continue, loot Got it!)
async function clearModals(page) {
  for (let i = 0; i < 5; i++) {
    const cb = page.locator('button:has-text("Continue")');
    if (await cb.count() > 0) { await cb.click().catch(() => {}); await page.waitForTimeout(500); continue; }
    const gi = page.locator('button:has-text("Got it!")');
    if (await gi.count() > 0) { await gi.click().catch(() => {}); await page.waitForTimeout(500); continue; }
    break;
  }
}

async function run() {
  console.log('🧪 Journey 1: Warrior Easy — Full UI Playthrough\n');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const dName = `j1-${Date.now()}`;
  const consoleErrors = [];
  page.on('console', msg => {
    if (msg.type() === 'error' && !msg.text().includes('WebSocket') && !msg.text().includes('404'))
      consoleErrors.push(msg.text());
  });

  try {
    // === STEP 1: Create dungeon via UI ===
    console.log('=== Step 1: Create Dungeon ===');
    await page.goto(BASE_URL, { timeout: TIMEOUT });
    await page.waitForTimeout(2000);
    const created = await createDungeonUI(page, dName, { monsters: 2, difficulty: 'easy', heroClass: 'warrior' });
    created ? ok('Dungeon created and loaded') : fail('Dungeon did not load');

    // === STEP 2: Verify initial state ===
    console.log('\n=== Step 2: Initial State ===');
    let body = await getBodyText(page);
    body.includes('200') ? ok('Hero HP: 200') : fail('Hero HP not 200');
    body.includes('WARRIOR') ? ok('Hero class: WARRIOR') : fail('Class not shown');

    let alive = await aliveMonsterCount(page);
    alive === 2 ? ok('2 alive monsters') : fail(`Expected 2 alive, got ${alive}`);

    const bossAtk = page.locator('.arena-entity.boss-entity .arena-atk-btn.btn-primary');
    (await bossAtk.count()) === 0 ? ok('Boss not attackable (pending)') : warn('Boss visible early');

    // === STEP 3: Attack monsters until all dead ===
    console.log('\n=== Step 3: Kill All Monsters ===');
    let attackCount = 0;
    while (await aliveMonsterCount(page) > 0 && attackCount < 30) {
      const result = await attackMonster(page);
      attackCount++;
      if (!result) { fail(`Attack ${attackCount} did not resolve`); break; }
      // Dismiss any loot popup
      await dismissLootPopup(page);
      await page.waitForTimeout(1000);
    }
    alive = await aliveMonsterCount(page);
    alive === 0 ? ok(`All monsters dead (${attackCount} attacks)`) : fail(`${alive} still alive`);

    // === STEP 4: Boss should become attackable ===
    console.log('\n=== Step 4: Boss Unlocked ===');
    let bossReady = false;
    for (let i = 0; i < 30; i++) {
      await clearModals(page);
      const btn = page.locator('.arena-entity.boss-entity .arena-atk-btn.btn-primary');
      if (await btn.count() > 0) { bossReady = true; break; }
      await page.waitForTimeout(2000);
    }
    bossReady ? ok('Boss is attackable') : fail('Boss did not become attackable');

    // === STEP 5: Kill the boss ===
    console.log('\n=== Step 5: Kill Boss ===');
    let bossAttacks = 0;
    while (bossAttacks < 40) {
      await clearModals(page);
      body = await getBodyText(page);
      if (body.includes('VICTORY') || body.includes('Victory')) break;

      const bossBtn = page.locator('.arena-entity.boss-entity .arena-atk-btn.btn-primary');
      if (await bossBtn.count() === 0) {
        // Boss might be dead already or modal blocking
        await page.waitForTimeout(2000);
        body = await getBodyText(page);
        if (body.includes('VICTORY') || body.includes('Victory')) break;
        // Check if hero is dead
        if (body.includes('DEFEAT') || body.includes('Defeat') || body.includes('fallen')) {
          warn('Hero defeated before killing boss');
          break;
        }
        continue;
      }

      await bossBtn.click({ force: true });
      bossAttacks++;
      const result = await waitForCombatResult(page);
      if (!result) {
        body = await getBodyText(page);
        if (body.includes('VICTORY') || body.includes('Victory')) break;
        warn(`Boss attack ${bossAttacks} timeout`);
      }
      await dismissLootPopup(page);
      await page.waitForTimeout(1000);
    }
    body = await getBodyText(page);
    (body.includes('VICTORY') || body.includes('Victory'))
      ? ok(`Boss killed (${bossAttacks} attacks)`)
      : fail('Boss not killed');

    // === STEP 6: Post-boss auto-sequence ===
    console.log('\n=== Step 6: Post-Boss Sequence ===');
    // Clear any remaining modals from boss kill
    await clearModals(page);

    // Wait for treasure + door auto-trigger
    let doorReady = false;
    for (let i = 0; i < 45; i++) {
      await clearModals(page);
      body = await getBodyText(page);
      if (body.includes('Enter')) { doorReady = true; break; }
      await page.waitForTimeout(2000);
    }
    doorReady ? ok('Door ready (Enter visible)') : fail('Door did not unlock');

    // === STEP 7: Enter Room 2 ===
    console.log('\n=== Step 7: Enter Room 2 ===');
    await clearModals(page);
    const doorEntity = page.locator('.arena-entity.door-entity');
    if (await doorEntity.count() > 0) {
      await doorEntity.click({ force: true });
      for (let i = 0; i < 45; i++) {
        body = await getBodyText(page);
        if (body.includes('Room 2') || body.includes('Room: 2')) break;
        await page.waitForTimeout(2000);
      }
      body = await getBodyText(page);
      (body.includes('Room 2') || body.includes('Room: 2')) ? ok('Room 2 loaded') : fail('Room 2 did not load');

      // Wait for monsters to appear
      for (let i = 0; i < 15; i++) {
        alive = await aliveMonsterCount(page);
        if (alive > 0) break;
        await page.waitForTimeout(2000);
      }
      alive = await aliveMonsterCount(page);
      alive > 0 ? ok(`${alive} monsters in room 2`) : warn('No monsters visible yet');
    } else {
      fail('Door not found');
    }

    // === STEP 8: Play room 2 to completion ===
    console.log('\n=== Step 8: Room 2 ===');
    let r2 = 0;
    while (r2 < 60) {
      await clearModals(page);
      body = await getBodyText(page);
      if (body.includes('VICTORY') || body.includes('Victory') || body.includes('Dungeon Complete')) break;
      if (body.includes('DEFEAT') || body.includes('fallen')) { warn('Hero defeated in room 2'); break; }

      alive = await aliveMonsterCount(page);
      if (alive > 0) {
        const result = await attackMonster(page);
        r2++;
        if (!result) { await page.waitForTimeout(2000); continue; }
      } else {
        const bossBtn = page.locator('.arena-entity.boss-entity .arena-atk-btn.btn-primary');
        if (await bossBtn.count() > 0) {
          await bossBtn.click({ force: true });
          r2++;
          const result = await waitForCombatResult(page);
          if (!result) {
            body = await getBodyText(page);
            if (body.includes('VICTORY') || body.includes('Victory')) break;
          }
        } else {
          await page.waitForTimeout(3000);
          r2++;
        }
      }
      await dismissLootPopup(page);
      await page.waitForTimeout(1000);
    }
    body = await getBodyText(page);
    (body.includes('VICTORY') || body.includes('Victory') || body.includes('Dungeon Complete'))
      ? ok(`Room 2 complete (${r2} attacks)`)
      : fail(`Room 2 not complete after ${r2} attacks`);

    // === STEP 9: Console errors ===
    console.log('\n=== Step 9: Console Errors ===');
    consoleErrors.length === 0
      ? ok('No console errors')
      : fail(`${consoleErrors.length} console errors: ${consoleErrors[0]}`);

  } catch (error) {
    console.error(`\n❌ Fatal: ${error.message}`);
    failed++;
  } finally {
    await browser.close();
  }

  console.log(`\n${'='.repeat(50)}`);
  console.log(`  Journey 1: ${passed} passed, ${failed} failed, ${warnings} warnings`);
  console.log('='.repeat(50));
  process.exit(failed > 0 ? 1 : 0);
}

run();
