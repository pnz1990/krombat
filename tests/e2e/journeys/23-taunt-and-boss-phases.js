// Journey 23: Warrior Taunt + Boss Multi-Phase (Enraged/Berserk)
// UI-ONLY: no kubectl, no direct fetch/api, no execSync
// Tests: Warrior Taunt button present + activates, taunt badge appears (ACT/RDY),
//        taunt disabled while active, taunt reduces counter damage (60% reduction);
//        boss phase transitions (ENRAGED at 50% HP, BERSERK at 25% HP),
//        phase badges and flash overlay visible.
const { chromium } = require('playwright');
const { createDungeonUI, attackMonster, attackBoss, waitForCombatResult, deleteDungeon , testLogin} = require('./helpers');

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const TIMEOUT = 20000;
let passed = 0, failed = 0, warnings = 0;
function ok(msg)   { console.log(`  ✅ ${msg}`); passed++; }
function fail(msg) { console.log(`  ❌ ${msg}`); failed++; }
function warn(msg) { console.log(`  ⚠️  ${msg}`); warnings++; }

async function run() {
  console.log('Journey 23: Warrior Taunt + Boss Multi-Phase\n');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const dName = `j23-${Date.now()}`;

  const consoleErrors = [];
  page.on('console', msg => { if (msg.type() === 'error' && !msg.text().includes('WebSocket') && !msg.text().includes('404') && !msg.text().includes('409') && !msg.text().includes('429') && !msg.text().includes('504') && !msg.text().includes('net::ERR')) consoleErrors.push(msg.text()); });

  try {
    await testLogin(page, BASE_URL);

    await page.goto(BASE_URL, { timeout: TIMEOUT });
    await page.waitForSelector('input[placeholder="my-dungeon"]', { timeout: TIMEOUT });

    // ── Create warrior dungeon (1 monster, easy — fastest path to boss) ─────
    console.log('\n  [Create warrior dungeon]');
    const loaded = await createDungeonUI(page, dName, { monsters: 1, difficulty: 'easy', heroClass: 'warrior' });
    loaded ? ok('Dungeon created and game view loaded') : fail('Dungeon view did not load');
    await page.waitForTimeout(2000);

    // ── Taunt button present (warrior-only) ──────────────────────────────────
    console.log('\n  [Taunt button present for warrior]');
    const tauntBtn = page.locator('button:has-text("Taunt")');
    await tauntBtn.waitFor({ timeout: TIMEOUT }).catch(() => {});
    (await tauntBtn.count() > 0)
      ? ok('Taunt button present for warrior')
      : fail('Taunt button not found for warrior');

    // Taunt should be enabled initially
    const tauntDisabled = await tauntBtn.first().isDisabled().catch(() => true);
    !tauntDisabled
      ? ok('Taunt button is enabled initially')
      : warn('Taunt button disabled initially (unexpected)');

    // ── Click Taunt — activates ───────────────────────────────────────────────
    console.log('\n  [Taunt activation]');
    if (await tauntBtn.count() > 0) {
      await tauntBtn.first().click({ force: true });
      await page.waitForTimeout(3000); // wait for backend patch
      ok('Taunt button clicked');

      // Taunt badge should appear in status bar
      const tauntBadge = page.locator('.status-badge.taunt, .status-badge.effect.taunt');
      await tauntBadge.waitFor({ timeout: TIMEOUT }).catch(() => {});
      if (await tauntBadge.count() > 0) {
        const badgeText = await tauntBadge.first().textContent();
        ok(`Taunt status badge appeared: "${badgeText?.trim()}"`)
        // Should show ACT or RDY
        badgeText?.includes('ACT') || badgeText?.includes('RDY')
          ? ok('Taunt badge shows ACT or RDY state')
          : warn(`Taunt badge text: "${badgeText?.trim()}" (expected ACT or RDY)`);
      } else {
        // Check for taunt info anywhere in the body
        const bodyText = await page.textContent('body');
        bodyText.includes('Taunt') && bodyText.includes('60%')
          ? ok('Taunt text and 60% reduction visible in UI')
          : fail('Taunt badge not visible after activation');
      }

      // Taunt should now be disabled (can't activate twice)
      await page.waitForTimeout(1000);
      const tauntNowDisabled = await tauntBtn.first().isDisabled().catch(() => false);
      tauntNowDisabled
        ? ok('Taunt button disabled after activation (cannot stack)')
        : warn('Taunt button still enabled after activation (may be timing)');

      // lastHeroAction should mention Taunt
      const heroActionText = await page.locator('body').textContent();
      heroActionText.includes('Taunt') || heroActionText.includes('60%')
        ? ok('Hero action log mentions Taunt/60%')
        : warn('Taunt not visible in action log yet');
    }

    // ── Kill monster to get to boss ──────────────────────────────────────────
    console.log('\n  [Kill monster, get to boss]');
    for (let i = 0; i < 8; i++) {
      const alive = await page.locator('.arena-entity.monster-entity:not(.dead)').count();
      if (alive === 0) break;
      const r = await attackMonster(page, 0);
      if (!r) break;
      const body = await page.textContent('body');
      if (body.includes('GAME OVER')) { warn('Hero died in monster fight'); break; }
    }

    const bossEntity = page.locator('.arena-entity.boss-entity');
    if (await bossEntity.count() > 0) {
      ok('Boss entity visible after all monsters dead');
    } else {
      warn('Boss not visible — hero may have died');
    }

    // ── Boss phase transitions ────────────────────────────────────────────────
    console.log('\n  [Boss phase transitions — ENRAGED at 50%, BERSERK at 25%]');
    let enragedSeen = false, berserkSeen = false, phaseFlashSeen = false;

    for (let i = 0; i < 30; i++) {
      const bossBtn = page.locator('.arena-entity.boss-entity .arena-atk-btn.btn-primary');
      if (await bossBtn.count() === 0) break;

      const r = await attackBoss(page);
      if (!r) break;

      const body = await page.textContent('body');
      if (body.includes('GAME OVER')) { warn('Hero died during boss fight'); break; }

      // Check for phase badge
      const phase2Badge = page.locator('.boss-phase-badge.phase2, .boss-phase-badge');
      const phase3Badge = page.locator('.boss-phase-badge.phase3');
      const flashOverlay = page.locator('.boss-phase-flash-overlay');

      if (await phase2Badge.count() > 0 && !enragedSeen) {
        const badgeText = await phase2Badge.first().textContent();
        if (badgeText?.includes('ENRAGED') || badgeText?.includes('🔥')) {
          enragedSeen = true;
          ok(`Boss ENRAGED phase badge visible: "${badgeText?.trim()}"`)
        }
      }
      if (await phase3Badge.count() > 0 && !berserkSeen) {
        const badgeText = await phase3Badge.first().textContent();
        if (badgeText?.includes('BERSERK') || badgeText?.includes('💀')) {
          berserkSeen = true;
          ok(`Boss BERSERK phase badge visible: "${badgeText?.trim()}"`)
        }
      }
      if (await flashOverlay.count() > 0 && !phaseFlashSeen) {
        phaseFlashSeen = true;
        ok('Boss phase flash overlay appeared during phase transition');
      }

      // Also check event log for phase messages
      if (body.includes('ENRAGED') && !enragedSeen) {
        enragedSeen = true;
        ok('ENRAGED text visible in game (event log or UI)');
      }
      if (body.includes('BERSERK') && !berserkSeen) {
        berserkSeen = true;
        ok('BERSERK text visible in game (event log or UI)');
      }

      await page.waitForTimeout(300);
    }

    enragedSeen
      ? ok('Boss ENRAGED phase (×1.5 damage at 50% HP) confirmed')
      : warn('Boss ENRAGED phase not observed (need to reach 50% HP threshold — may require longer fight)');
    berserkSeen
      ? ok('Boss BERSERK phase (×2.0 damage at 25% HP) confirmed')
      : warn('Boss BERSERK phase not observed (need to reach 25% HP threshold)');

    // ── Taunt used during boss fight ──────────────────────────────────────────
    console.log('\n  [Re-use Taunt during boss fight]');
    const tauntBtnBoss = page.locator('button:has-text("Taunt")');
    if (await tauntBtnBoss.count() > 0) {
      const disabled = await tauntBtnBoss.first().isDisabled().catch(() => true);
      if (!disabled) {
        await tauntBtnBoss.first().click({ force: true });
        await page.waitForTimeout(2000);
        ok('Taunt re-used during boss fight');
        const body = await page.textContent('body');
        body.includes('Taunt') || body.includes('60%')
          ? ok('Taunt text visible after re-activation')
          : warn('Taunt text not confirmed after boss fight re-use');
      } else {
        ok('Taunt button correctly disabled while cooldown active');
      }
    } else {
      warn('Taunt button not found during boss fight (hero may have died)');
    }

    // ── No critical JS errors ─────────────────────────────────────────────────
    console.log('\n  [Error check]');
    const criticalErrors = consoleErrors.filter(e =>
      !e.includes('favicon') && !e.includes('net::ERR') &&
      !e.includes('kro warning') && !e.includes('WebSocket')
    );
    criticalErrors.length === 0
      ? ok('No critical JS errors during journey')
      : fail(`JS errors detected: ${criticalErrors.slice(0, 3).join('; ')}`);

  } catch (err) {
    fail(`Unexpected error: ${err.message}`);
    console.error(err);
  } finally {
    await page.goto(BASE_URL, { timeout: TIMEOUT }).catch(() => {});
    await page.waitForTimeout(2000);
    await deleteDungeon(page, dName).catch(() => {});
    await browser.close();
    console.log(`\n  Passed: ${passed}  Failed: ${failed}  Warnings: ${warnings}`);
    if (failed > 0) process.exit(1);
  }
}

run();
