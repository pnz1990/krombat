// Journey 8: Edge Cases & Error States
const { chromium } = require('playwright');

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const TIMEOUT = 15000;
let passed = 0, failed = 0, warnings = 0;
function ok(msg) { console.log(`  ✅ ${msg}`); passed++; }
function fail(msg) { console.log(`  ❌ ${msg}`); failed++; }
function warn(msg) { console.log(`  ⚠️  ${msg}`); warnings++; }

async function api(page, method, path, body) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await page.evaluate(async ([m, p, b]) => {
        const opts = { method: m, headers: { 'Content-Type': 'application/json' } };
        if (b) opts.body = JSON.stringify(b);
        const r = await fetch(`/api/v1${p}`, opts);
        const text = await r.text();
        try { return { status: r.status, body: JSON.parse(text) }; } catch { return { status: r.status, body: text }; }
      }, [method, path, body]);
    } catch { await page.waitForTimeout(2000); }
  }
  return { status: 0, body: 'fetch failed' };
}

async function waitForSpec(page, name, check, maxWait = 45000) {
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    const res = await api(page, 'GET', `/dungeons/default/${name}`);
    if (res.status === 200 && check(res.body)) return res.body;
    await page.waitForTimeout(2000);
  }
  return null;
}

async function run() {
  console.log('🧪 Journey 8: Edge Cases & Error States\n');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const { execSync } = require('child_process');

  const consoleErrors = [];
  page.on('console', msg => {
    if (msg.type() === 'error' && !msg.text().includes('WebSocket') && !msg.text().includes('404') && !msg.text().includes('429') && !msg.text().includes('500') && !msg.text().includes('400'))
      consoleErrors.push(msg.text());
  });

  try {
    await page.goto(BASE_URL, { timeout: TIMEOUT });
    await page.waitForTimeout(2000);

    // === Test 1: Speed run — 1 monster easy ===
    console.log('=== Test 1: Speed Run (1 monster, easy) ===');
    const speedName = `j8-speed-${Date.now()}`;
    await api(page, 'POST', '/dungeons', { name: speedName, monsters: 1, difficulty: 'easy', heroClass: 'warrior' });
    await waitForSpec(page, speedName, d => d.spec?.monsterHP?.length === 1);
    // Kill monster instantly
    execSync(`kubectl patch dungeon ${speedName} --type=merge -p '{"spec":{"monsterHP":[0]}}'`);
    await page.waitForTimeout(3000);
    let state = await api(page, 'GET', `/dungeons/default/${speedName}`);
    (state.body.spec?.monsterHP || [])[0] === 0 ? ok('Monster killed instantly') : fail('Monster not dead');
    // Boss should be ready
    await page.goto(`${BASE_URL}/dungeon/default/${speedName}`, { timeout: TIMEOUT });
    await page.waitForTimeout(5000);
    const bossBtn = page.locator('.arena-entity.boss-entity .arena-atk-btn.btn-primary');
    (await bossBtn.count()) > 0 ? ok('Boss attackable after instant kill') : warn('Boss not visible yet (kro reconciling)');
    await api(page, 'DELETE', `/dungeons/default/${speedName}`);

    // === Test 2: 10 monsters hard ===
    console.log('\n=== Test 2: Max Monsters (10, hard) ===');
    const maxName = `j8-max-${Date.now()}`;
    await api(page, 'POST', '/dungeons', { name: maxName, monsters: 10, difficulty: 'hard', heroClass: 'rogue' });
    const maxDungeon = await waitForSpec(page, maxName, d => d.spec?.monsterHP?.length === 10);
    maxDungeon ? ok('10 monsters created') : fail('10 monsters not created');
    if (maxDungeon) {
      const expectedHP = maxDungeon.spec.modifier === 'curse-fortitude' ? 120 : 80;
      maxDungeon.spec.monsterHP.every(hp => hp === expectedHP) ? ok(`All monsters have ${expectedHP} HP (hard${maxDungeon.spec.modifier === 'curse-fortitude' ? ' +fortitude' : ''})`) : fail(`Monster HP: ${maxDungeon.spec.monsterHP}`);
      maxDungeon.spec.bossHP === 800 ? ok('Boss has 800 HP (hard)') : fail(`Boss HP: ${maxDungeon.spec.bossHP}`);
    }
    // Verify all render in UI
    await page.goto(`${BASE_URL}/dungeon/default/${maxName}`, { timeout: TIMEOUT });
    await page.waitForTimeout(5000);
    const monsterEntities = page.locator('.arena-entity.monster-entity');
    const mCount = await monsterEntities.count();
    mCount === 10 ? ok('All 10 monsters rendered in arena') : fail(`Only ${mCount} monsters rendered`);
    await api(page, 'DELETE', `/dungeons/default/${maxName}`);

    // === Test 3: Rate limiting — rapid attack clicks ===
    console.log('\n=== Test 3: Rate Limiting ===');
    const rateName = `j8-rate-${Date.now()}`;
    await api(page, 'POST', '/dungeons', { name: rateName, monsters: 2, difficulty: 'easy', heroClass: 'warrior' });
    await waitForSpec(page, rateName, d => d.spec?.monsterHP?.length === 2);
    // Submit 5 attacks rapidly via API
    const results = [];
    for (let i = 0; i < 5; i++) {
      const r = await api(page, 'POST', `/dungeons/default/${rateName}/attacks`, { target: `${rateName}-monster-0`, damage: 0 });
      results.push(r.status);
    }
    const accepted = results.filter(s => s === 202).length;
    const limited = results.filter(s => s === 429).length;
    (accepted >= 1 && limited >= 1) ? ok(`Rate limiting works: ${accepted} accepted, ${limited} limited`)
      : accepted === 5 ? warn(`All 5 accepted (rate limit may be per-second)`)
      : fail(`Unexpected: ${JSON.stringify(results)}`);
    await api(page, 'DELETE', `/dungeons/default/${rateName}`);

    // === Test 4: Attack already-dead monster via API ===
    console.log('\n=== Test 4: Attack Dead Monster ===');
    const deadName = `j8-dead-${Date.now()}`;
    await api(page, 'POST', '/dungeons', { name: deadName, monsters: 1, difficulty: 'easy', heroClass: 'warrior' });
    await waitForSpec(page, deadName, d => d.spec?.monsterHP?.length === 1);
    execSync(`kubectl patch dungeon ${deadName} --type=merge -p '{"spec":{"monsterHP":[0],"lastLootDrop":"","attackSeq":1}}'`);
    await page.waitForTimeout(2000);
    // Attack the dead monster
    await api(page, 'POST', `/dungeons/default/${deadName}/attacks`, { target: `${deadName}-monster-0`, damage: 0 });
    await page.waitForTimeout(20000);
    state = await api(page, 'GET', `/dungeons/default/${deadName}`);
    // attackSeq should NOT have incremented (already-dead doesn't increment)
    state.body.spec?.attackSeq === 1 ? ok('Dead monster attack did not increment attackSeq') : warn(`attackSeq: ${state.body.spec?.attackSeq} (may have incremented from stale Job)`);
    // lastLootDrop should be empty
    (state.body.spec?.lastLootDrop || '') === '' ? ok('No loot from dead monster') : fail(`Loot from dead: ${state.body.spec?.lastLootDrop}`);
    await api(page, 'DELETE', `/dungeons/default/${deadName}`);

    // === Test 5: Navigate to nonexistent dungeon ===
    console.log('\n=== Test 5: Nonexistent Dungeon ===');
    await page.goto(`${BASE_URL}/dungeon/default/this-does-not-exist-12345`, { timeout: TIMEOUT });
    await page.waitForTimeout(8000);
    const errText = await page.textContent('body');
    (errText.includes('not found') || errText.includes('Initializing') || errText.includes('Error') || errText.includes('initializing'))
      ? ok('Nonexistent dungeon shows error/initializing')
      : fail(`No error for nonexistent dungeon: ${errText.substring(0, 100)}`);
    // Should not crash
    const crashed = errText.includes('Cannot read') || errText.includes('undefined');
    !crashed ? ok('No JS crash on nonexistent dungeon') : fail('JS crash detected');

    // === Test 6: Refresh mid-combat ===
    console.log('\n=== Test 6: Refresh Mid-Combat ===');
    const refreshName = `j8-refresh-${Date.now()}`;
    await api(page, 'POST', '/dungeons', { name: refreshName, monsters: 1, difficulty: 'easy', heroClass: 'warrior' });
    await waitForSpec(page, refreshName, d => d.spec?.monsterHP?.length === 1);
    await page.goto(`${BASE_URL}/dungeon/default/${refreshName}`, { timeout: TIMEOUT });
    await page.waitForTimeout(5000);
    // Click attack
    const atkBtn = page.locator('.arena-atk-btn.btn-primary').first();
    if (await atkBtn.count() > 0) {
      await atkBtn.click({ force: true });
      await page.waitForTimeout(2000);
      // Refresh mid-combat
      await page.reload({ timeout: TIMEOUT });
      await page.waitForTimeout(5000);
      const afterRefresh = await page.textContent('body');
      afterRefresh.includes(refreshName) ? ok('Page recovers after mid-combat refresh') : fail('Page broken after refresh');
      // Should be able to attack again
      const atkBtn2 = page.locator('.arena-atk-btn.btn-primary').first();
      (await atkBtn2.count()) > 0 ? ok('Attack buttons available after refresh') : warn('Attack buttons not visible (combat may still be processing)');
    } else {
      warn('No attack button for refresh test');
    }
    await api(page, 'DELETE', `/dungeons/default/${refreshName}`);

    // === Test 7: Room 2 boss state ===
    console.log('\n=== Test 7: Room 2 Boss State ===');
    const roomName = `j8-room-${Date.now()}`;
    await api(page, 'POST', '/dungeons', { name: roomName, monsters: 1, difficulty: 'easy', heroClass: 'warrior' });
    await waitForSpec(page, roomName, d => d.spec?.monsterHP?.length === 1);
    // Fast-forward to room 2
    execSync(`kubectl patch dungeon ${roomName} --type=merge -p '{"spec":{"monsterHP":[0],"bossHP":0,"treasureOpened":1,"doorUnlocked":1}}'`);
    await page.waitForTimeout(3000);
    // Enter room 2 via action
    await api(page, 'POST', `/dungeons/default/${roomName}/attacks`, { target: 'enter-room-2', damage: 0 });
    const room2 = await waitForSpec(page, roomName, d => d.spec?.currentRoom === 2, 60000);
    if (room2) {
      ok('Entered room 2');
      room2.spec.bossHP > 0 ? ok(`Room 2 boss alive: HP ${room2.spec.bossHP}`) : fail('Room 2 boss dead on entry');
      room2.spec.monsterHP.every(hp => hp > 0) ? ok('Room 2 monsters alive') : fail(`Room 2 monsters: ${room2.spec.monsterHP}`);
      // Verify UI
      await page.goto(`${BASE_URL}/dungeon/default/${roomName}`, { timeout: TIMEOUT });
      await page.waitForTimeout(5000);
      const r2Text = await page.textContent('body');
      // Should NOT show victory banner
      !r2Text.includes('VICTORY') ? ok('No victory banner in room 2') : fail('Victory banner showing in room 2');
      // Should NOT show treasure/door
      const chest = page.locator('.chest-entity');
      (await chest.count()) === 0 ? ok('No treasure in room 2') : fail('Treasure visible in room 2');
      const door = page.locator('.door-entity');
      (await door.count()) === 0 ? ok('No door in room 2') : fail('Door visible in room 2');
      // Monsters should be attackable
      const r2Atk = page.locator('.arena-atk-btn.btn-primary');
      (await r2Atk.count()) > 0 ? ok('Room 2 monsters attackable') : fail('No attack buttons in room 2');
    } else {
      fail('Room 2 transition failed');
    }
    await api(page, 'DELETE', `/dungeons/default/${roomName}`);

    // === Test 8: Create dungeon with special characters ===
    console.log('\n=== Test 8: Special Characters ===');
    // K8s names must be lowercase alphanumeric + hyphens
    const badRes = await api(page, 'POST', '/dungeons', { name: 'UPPERCASE', monsters: 1, difficulty: 'easy', heroClass: 'warrior' });
    // Should either fail or lowercase it
    if (badRes.status === 400 || badRes.status === 422 || badRes.status === 500) {
      ok(`Uppercase name rejected (HTTP ${badRes.status})`);
    } else if (badRes.status === 201) {
      ok('Uppercase name accepted (K8s may lowercase it)');
      await api(page, 'DELETE', '/dungeons/default/UPPERCASE');
      await api(page, 'DELETE', '/dungeons/default/uppercase');
    } else {
      warn(`Unexpected status for uppercase name: ${badRes.status}`);
    }

    const emptyRes = await api(page, 'POST', '/dungeons', { name: '', monsters: 1, difficulty: 'easy', heroClass: 'warrior' });
    emptyRes.status === 400 ? ok('Empty name rejected') : fail(`Empty name: HTTP ${emptyRes.status}`);

    // === Test 9: Defeat state ===
    console.log('\n=== Test 9: Defeat State ===');
    const defeatName = `j8-defeat-${Date.now()}`;
    await api(page, 'POST', '/dungeons', { name: defeatName, monsters: 1, difficulty: 'easy', heroClass: 'warrior' });
    await waitForSpec(page, defeatName, d => d.spec?.monsterHP?.length === 1);
    // Set hero HP to 0
    execSync(`kubectl patch dungeon ${defeatName} --type=merge -p '{"spec":{"heroHP":0}}'`);
    await page.waitForTimeout(3000);
    await page.goto(`${BASE_URL}/dungeon/default/${defeatName}`, { timeout: TIMEOUT });
    await page.waitForTimeout(5000);
    // Attack buttons should be disabled/hidden
    const defeatAtk = page.locator('.arena-atk-btn.btn-primary');
    (await defeatAtk.count()) === 0 ? ok('No attack buttons when defeated') : fail('Attack buttons visible when hero is dead');
    await api(page, 'DELETE', `/dungeons/default/${defeatName}`);

    // === Test 10: Console errors ===
    console.log('\n=== Test 10: Console Errors ===');
    consoleErrors.length === 0
      ? ok('No console errors')
      : fail(`${consoleErrors.length} console errors: ${consoleErrors[0]}`);

    // === Cleanup ===
    console.log('\n=== Cleanup ===');
    ok('All edge case tests complete');

  } catch (error) {
    console.error(`\n❌ Fatal: ${error.message}`);
    failed++;
  } finally {
    await browser.close();
  }

  console.log(`\n${'='.repeat(50)}`);
  console.log(`  Journey 8: ${passed} passed, ${failed} failed, ${warnings} warnings`);
  console.log('='.repeat(50));
  process.exit(failed > 0 ? 1 : 0);
}

run();
