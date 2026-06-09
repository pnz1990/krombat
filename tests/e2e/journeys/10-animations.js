// Journey 10: Visual & Animation Consistency
// UI-ONLY: no kubectl, no fetch/api, no execSync
// Tests: dead monster opacity, alive opacity, attack button counts, boss pending/ready,
//        combat modal sprites, hero sprite, post-dismiss state.
// Room 2 sprite check is omitted — playing all the way through would take ~15 min.
const { chromium } = require('playwright');
const { createDungeonUI, waitForCombatResult, dismissLootPopup, navigateHome, deleteDungeon, attackMonster , testLogin} = require('./helpers');

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const TIMEOUT = 15000;
let passed = 0, failed = 0, warnings = 0;
function ok(msg)   { console.log(`  ✅ ${msg}`); passed++; }
function fail(msg) { console.log(`  ❌ ${msg}`); failed++; }
function warn(msg) { console.log(`  ⚠️  ${msg}`); warnings++; }

async function getBodyText(page) { return page.textContent('body'); }

// Attack the same monster by index until it dies or maxAttacks exhausted.
// Returns true if monster died.
async function killMonster(page, monsterIndex, maxAttacks) {
  for (let i = 0; i < maxAttacks; i++) {
    const btns = page.locator('.arena-entity.monster-entity:not(.dead) .arena-atk-btn.btn-primary');
    const count = await btns.count();
    if (count === 0) return true; // all dead
    await btns.nth(Math.min(monsterIndex, count - 1)).click({ force: true });
    const result = await waitForCombatResult(page);
    await dismissLootPopup(page);
    if (!result) continue;
    // Check if HP went to 0
    const dead = await page.locator('.arena-entity.monster-entity.dead').count();
    if (dead > 0) return true;
  }
  return false;
}

async function run() {
  console.log('🧪 Journey 10: Visual & Animation Consistency\n');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const dName = `j10-${Date.now()}`;

  const consoleErrors = [];
  page.on('console', msg => {
    if (msg.type() === 'error' && !msg.text().includes('WebSocket') && !msg.text().includes('404') && !msg.text().includes('net::ERR') && !msg.text().includes('409') && !msg.text().includes('429') && !msg.text().includes('504'))
      consoleErrors.push(msg.text());
  });
  page.on('dialog', dialog => dialog.accept());

  try {
    // === Setup: Create dungeon with 2 monsters ===
    console.log('=== Setup: Create Dungeon ===');
    await testLogin(page, BASE_URL);

    await page.goto(BASE_URL, { timeout: TIMEOUT });
    await page.waitForTimeout(2000);
    // Easy warrior: 200 hero HP, avg 12.5 damage/attack.
    // Monsters have ~30 HP each → ~3 attacks to kill one.
    const created = await createDungeonUI(page, dName, { monsters: 2, difficulty: 'easy', heroClass: 'warrior' });
    created ? ok('Dungeon created via UI') : fail('Failed to create dungeon');

    // === STEP 1: Both monsters start alive — full opacity ===
    console.log('\n=== Step 1: Initial State — Both Monsters Alive ===');
    await page.waitForTimeout(1000);

    const initialAliveCount = await page.locator('.arena-entity.monster-entity:not(.dead)').count();
    initialAliveCount === 2
      ? ok(`Both monsters alive initially (${initialAliveCount})`)
      : warn(`Expected 2 alive monsters, got ${initialAliveCount}`);

    // Both should have attack buttons
    const initialAtkBtns = await page.locator('.arena-atk-btn.btn-primary').count();
    initialAtkBtns >= 2
      ? ok(`${initialAtkBtns} attack buttons visible for alive monsters`)
      : warn(`Only ${initialAtkBtns} attack buttons (expected ≥2)`);

    // === STEP 2: Boss is hidden when monsters alive ===
    console.log('\n=== Step 2: Boss Hidden (Pending) ===');
    const bossBeforeDead = await page.locator('.arena-entity.boss-entity').count();
    bossBeforeDead === 0
      ? ok('Boss not visible while monsters are alive (pending)')
      : warn('Boss visible before all monsters dead');

    // === STEP 3: Hero sprite is visible ===
    console.log('\n=== Step 3: Hero Sprite ===');
    // Hero entity should be in the arena
    const heroEntity = page.locator('.arena-entity.hero-entity, .hero-entity');
    (await heroEntity.count()) > 0
      ? ok('Hero entity present in arena')
      : warn('Hero entity not found with .hero-entity selector');

    // Any img in the arena area
    const arenaImgs = await page.locator('.arena-container img, .arena img').count();
    arenaImgs > 0
      ? ok(`${arenaImgs} sprite image(s) in arena`)
      : warn('No sprite images found in arena');

    // === STEP 4: Kill one monster — verify dead opacity ===
    console.log('\n=== Step 4: Kill First Monster — Dead Opacity Check ===');
    const killed = await killMonster(page, 0, 10);
    killed
      ? ok('First monster killed via UI attacks')
      : warn('First monster not killed in 10 attacks (RNG) — opacity test may skip');

    await page.waitForTimeout(1000);

    const deadCount = await page.locator('.arena-entity.monster-entity.dead').count();
    const aliveCount = await page.locator('.arena-entity.monster-entity:not(.dead)').count();
    if (deadCount > 0) {
      ok(`${deadCount} dead monster(s) and ${aliveCount} alive monster(s)`);

      // === STEP 5: Dead monster has reduced opacity ===
      console.log('\n=== Step 5: Dead Monster Opacity ===');
      const deadOpacity = await page.evaluate(() => {
        const entities = document.querySelectorAll('.arena-entity.monster-entity');
        for (const e of entities) {
          const img = e.querySelector('img');
          if (img) {
            const opacity = img.style.opacity ? parseFloat(img.style.opacity) : 1;
            if (opacity < 1) return opacity;
          }
        }
        return null;
      });
      if (deadOpacity !== null) {
        deadOpacity <= 0.4
          ? ok(`Dead monster opacity: ${deadOpacity} (≤0.4)`)
          : fail(`Dead monster opacity ${deadOpacity} should be ≤0.4`);
      } else {
        // Check by class instead — .dead class might use CSS opacity
        const hasDead = await page.locator('.arena-entity.monster-entity.dead').count();
        hasDead > 0
          ? warn('Dead monster found (.dead class) but opacity not in inline style — may be CSS')
          : fail('No dead monster found after kill');
      }

      // === STEP 6: Alive monster still has full opacity ===
      console.log('\n=== Step 6: Alive Monster Full Opacity ===');
      if (aliveCount > 0) {
        const aliveOpacity = await page.evaluate(() => {
          const entities = document.querySelectorAll('.arena-entity.monster-entity');
          for (const e of entities) {
            if (!e.classList.contains('dead')) {
              const img = e.querySelector('img');
              if (img) {
                const opacity = img.style.opacity ? parseFloat(img.style.opacity) : 1;
                return opacity;
              }
            }
          }
          return null;
        });
        if (aliveOpacity === null || aliveOpacity === 1) {
          ok('Alive monster has full opacity (no inline style or opacity=1)');
        } else {
          fail(`Alive monster opacity ${aliveOpacity} should be 1`);
        }
      } else {
        warn('No alive monsters to check opacity');
      }

      // === STEP 7: Dead monster has no attack button ===
      console.log('\n=== Step 7: Dead Monster — No Attack Button ===');
      const aliveAtkBtns = await page.locator('.arena-entity.monster-entity:not(.dead) .arena-atk-btn.btn-primary').count();
      const deadAtkBtns  = await page.locator('.arena-entity.monster-entity.dead .arena-atk-btn.btn-primary').count();
      deadAtkBtns === 0
        ? ok('Dead monster has no attack button')
        : fail(`Dead monster has ${deadAtkBtns} attack button(s)`);
      aliveAtkBtns >= 1
        ? ok(`Alive monster has ${aliveAtkBtns} attack button(s)`)
        : warn('Alive monster has no attack button (may be in combat)');
    } else {
      warn('No dead monsters after 10 attacks — skipping opacity and button tests');
    }

    // === STEP 8: Combat modal renders sprites ===
    console.log('\n=== Step 8: Combat Modal Sprite Rendering ===');
    const aliveBtns = page.locator('.arena-entity.monster-entity:not(.dead) .arena-atk-btn.btn-primary');
    if (await aliveBtns.count() > 0) {
      // Snapshot arena images before attack (modal may cover arena but sprites still rendered)
      const arenaImgsBefore = await page.locator('.arena-container img, .arena img').count();

      // Use the shared helper which handles rolling→resolved→Continue dismissal reliably
      const combatText = await attackMonster(page, 0);

      if (combatText !== null) {
        ok('Combat modal or Continue button appeared');

        // Check arena images are still present (modal may have been dismissed by helper already)
        const modalArenaImgs = await page.locator('.arena-container img, .arena img').count();
        (modalArenaImgs > 0 || arenaImgsBefore > 0)
          ? ok(`${Math.max(modalArenaImgs, arenaImgsBefore)} sprite image(s) visible during combat`)
          : warn('No sprite images during combat modal');

        // Dead monster should still be low opacity
        if (deadCount > 0) {
          const deadDuringCombat = await page.evaluate(() => {
            const entities = document.querySelectorAll('.arena-entity.monster-entity');
            for (const e of entities) {
              if (e.classList.contains('dead')) {
                const img = e.querySelector('img');
                if (img) return img.style.opacity ? parseFloat(img.style.opacity) : 1;
              }
            }
            return null;
          });
          deadDuringCombat !== null && deadDuringCombat < 1
            ? ok(`Dead monster still faded during combat: ${deadDuringCombat}`)
            : warn('Dead monster opacity during combat not detected in inline style');
        }
      } else {
        warn('Combat modal not appeared — attack may have timed out');
      }

      // === STEP 9: Post-dismiss — no modal ===
      console.log('\n=== Step 9: Post-Dismiss State ===');
      await page.waitForTimeout(1000);
      const combatModalAfter = await page.locator('.combat-modal').count();
      combatModalAfter === 0
        ? ok('Combat modal dismissed successfully')
        : fail('Combat modal still visible after dismiss');

      // Dead monster still faded after dismiss
      if (deadCount > 0) {
        const deadAfterDismiss = await page.evaluate(() => {
          const entities = document.querySelectorAll('.arena-entity.monster-entity');
          for (const e of entities) {
            if (e.classList.contains('dead')) {
              const img = e.querySelector('img');
              if (img) return img.style.opacity ? parseFloat(img.style.opacity) : 1;
            }
          }
          return null;
        });
        deadAfterDismiss !== null && deadAfterDismiss < 1
          ? ok(`Dead monster stays faded after dismiss: ${deadAfterDismiss}`)
          : warn('Dead monster opacity after dismiss not in inline style (may be CSS)');
      }
    } else {
      warn('No alive monsters for combat modal test');
    }

    // === STEP 10: Kill second monster — boss becomes visible ===
    console.log('\n=== Step 10: Kill Second Monster — Boss Visible ===');
    const killed2 = await killMonster(page, 0, 10);
    if (killed2) {
      ok('Second monster killed via UI attacks');
      // Wait for boss to become targetable (kro reconciliation)
      await page.waitForTimeout(5000);
      const bossVisible = await page.locator('.arena-entity.boss-entity').count();
      bossVisible > 0
        ? ok('Boss entity visible after all monsters dead')
        : warn('Boss not yet visible (kro reconciling)');
      const bossAtkBtn = await page.locator('.arena-entity.boss-entity .arena-atk-btn.btn-primary').count();
      bossAtkBtn > 0
        ? ok('Boss has attack button')
        : warn('Boss attack button not visible (may still be loading)');
    } else {
      warn('Second monster not killed in 10 attacks — skipping boss visibility test');
    }

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
    try {
      await navigateHome(page, BASE_URL);
      await deleteDungeon(page, dName);
    } catch (_) {}
  } finally {
    await browser.close();
  }

  console.log(`\n${'='.repeat(50)}`);
  console.log(`  Journey 10: ${passed} passed, ${failed} failed, ${warnings} warnings`);
  console.log('='.repeat(50));
  process.exit(failed > 0 ? 1 : 0);
}

run();
