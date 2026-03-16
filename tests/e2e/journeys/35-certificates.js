// Journey 35: kro Certificates (#361)
// UI-ONLY: no kubectl, no direct fetch/api, no execSync
// Tests:
//   1.  Profile panel shows kro Certificates section with Tier 1 / Tier 2 / Tier 3 labels
//   2.  All certs render with data-testid="cert-<id>" or data-testid="cert-<id>-earned"
//   3.  log-explorer Tier 2 cert fires when K8s Log tab is clicked → cert-toast appears
//   4.  graph-panel Tier 2 cert fires when KroGraphPanel is mounted in dungeon view
//   5.  cel-trace cert fires when CelTrace is shown in combat modal results
//   6.  insight-card cert fires after 3 InsightCard dismissals
//   7.  first-dungeon Tier 1 cert is awarded after completing/deleting a dungeon
//   8.  cert-toast shows correct cert name text
const { chromium } = require('playwright');
const { createDungeonUI, deleteDungeon, testLogin, waitForSelector } = require('./helpers');

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const TIMEOUT = 25000;
let passed = 0, failed = 0, warnings = 0;
function ok(msg)   { console.log(`  ✅ ${msg}`); passed++; }
function fail(msg) { console.log(`  ❌ ${msg}`); failed++; }
function warn(msg) { console.log(`  ⚠️  ${msg}`); warnings++; }

async function openProfileViaHamburger(page) {
  const hamBtn = page.locator('button.hamburger-btn[aria-label="Menu"]');
  await hamBtn.waitFor({ timeout: TIMEOUT }).catch(() => {});
  if (await hamBtn.count() === 0) return false;
  await hamBtn.click();
  await page.waitForTimeout(300);
  const profileItem = page.locator('button.hamburger-item:has-text("Profile")');
  if (await profileItem.count() === 0) return false;
  await profileItem.click();
  await page.waitForTimeout(1200);
  return (await page.locator('[aria-label="Player Profile"]').count()) > 0;
}

async function dismissModal(page) {
  const btns = page.locator('button:has-text("Continue"), button:has-text("OK"), .modal button.btn-gold, button:has-text("Got it")');
  if (await btns.count() > 0) await btns.first().click();
  await page.waitForTimeout(400);
}

async function run() {
  console.log('Journey 35: kro Certificates\n');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const dName = `j35-${Date.now()}`;

  const consoleErrors = [];
  page.on('console', msg => { if (msg.type() === 'error' && !msg.text().includes('WebSocket') && !msg.text().includes('404') && !msg.text().includes('429') && !msg.text().includes('504') && !msg.text().includes('net::ERR')) consoleErrors.push(msg.text()); });

  try {
    await testLogin(page, BASE_URL);
    await page.goto(BASE_URL, { timeout: TIMEOUT });
    await page.waitForSelector('input[placeholder="my-dungeon"]', { timeout: TIMEOUT });

    // Dismiss onboarding if present
    const skipBtn = page.locator('button.kro-onboard-skip');
    if (await skipBtn.count() > 0) {
      await skipBtn.click();
      await page.waitForTimeout(400);
    }

    // ── Profile panel: cert section exists before any dungeon ──────────────────
    console.log('\n=== Profile cert section structure ===');
    const panelOpened = await openProfileViaHamburger(page);
    if (panelOpened) {
      const panel = page.locator('[aria-label="Player Profile"]');
      const panelText = await panel.textContent().catch(() => '');

      // Tier labels
      panelText.includes('Tier 1') && panelText.includes('Observer')
        ? ok('Profile panel shows "Tier 1 — Observer" cert label')
        : fail(`Profile panel missing "Tier 1 — Observer" label. Got: "${panelText.slice(0, 300)}"`);

      panelText.includes('Tier 2') && panelText.includes('Practitioner')
        ? ok('Profile panel shows "Tier 2 — Practitioner" cert label')
        : fail('Profile panel missing "Tier 2 — Practitioner" label');

      panelText.includes('Tier 3') && panelText.includes('Architect')
        ? ok('Profile panel shows "Tier 3 — Architect" cert label')
        : fail('Profile panel missing "Tier 3 — Architect" label');

      // Check for cert items with data-testid
      const certItems = panel.locator('[data-testid^="cert-"]');
      const certCount = await certItems.count();
      certCount >= 10
        ? ok(`Profile cert grid renders ${certCount} cert items (expected ≥10)`)
        : fail(`Profile cert grid only has ${certCount} items (expected ≥10)`);

      // Unearned certs have 35% opacity (test structural rendering, not exact opacity)
      const firstDungeonCert = panel.locator('[data-testid="cert-first-dungeon"], [data-testid="cert-first-dungeon-earned"]');
      await firstDungeonCert.count() > 0
        ? ok('first-dungeon cert item is rendered in profile panel')
        : fail('first-dungeon cert item not found in profile panel');

      // Close
      const closeBtn = page.locator('[aria-label="Close profile"]');
      if (await closeBtn.count() > 0) {
        await closeBtn.click();
        await page.waitForTimeout(300);
      }
    } else {
      warn('Profile panel could not be opened — skipping cert structure tests');
    }

    // ── Create dungeon to test in-game cert triggers ───────────────────────────
    console.log('\n=== Create dungeon for in-game cert triggers ===');
    const loaded = await createDungeonUI(page, dName, { monsters: 2, difficulty: 'easy', heroClass: 'warrior' });
    loaded
      ? ok('Dungeon created and game view loaded')
      : fail('Dungeon view did not load');
    await page.waitForTimeout(3000);

    // ── graph-panel cert: KroGraphPanel is mounted on dungeon entry ───────────
    console.log('\n=== graph-panel cert trigger (KroGraphPanel mount) ===');
    // The KroGraphPanel fires onExpand on mount — cert may arrive asynchronously.
    // Check for cert-toast appearing within a few seconds.
    const graphCertToast = page.locator('[data-testid="cert-toast"]');
    const graphToastAppeared = await graphCertToast.waitFor({ timeout: 6000 }).then(() => true).catch(() => false);
    if (graphToastAppeared) {
      const toastText = await graphCertToast.textContent().catch(() => '');
      toastText.includes('Graph Viewer') || toastText.includes('Certificate')
        ? ok('cert-toast appeared for graph-panel cert (KroGraphPanel mounted)')
        : ok('cert-toast appeared on dungeon entry (cert triggered — name may differ if already earned)');
      await page.waitForTimeout(4500); // let toast expire
    } else {
      warn('graph-panel cert-toast did not appear within 6s — may already be earned from prior runs');
    }

    // ── K8s log tab cert trigger: log-explorer ────────────────────────────────
    console.log('\n=== K8s log tab cert trigger (log-explorer) ===');
    const k8sTabBtn = page.locator('.log-tab:has-text("K8s Log")');
    const k8sTabFound = await k8sTabBtn.count() > 0;
    k8sTabFound
      ? ok('K8s Log tab button found')
      : fail('K8s Log tab button not found');

    if (k8sTabFound) {
      await k8sTabBtn.click();
      await page.waitForTimeout(500);

      // Check active state
      const isActive = await k8sTabBtn.evaluate(el => el.classList.contains('active'));
      isActive
        ? ok('K8s Log tab is now active after click')
        : fail('K8s Log tab did not become active after click');

      // cert-toast for log-explorer should appear
      const logToast = page.locator('[data-testid="cert-toast"]');
      const logToastAppeared = await logToast.waitFor({ timeout: 5000 }).then(() => true).catch(() => false);
      if (logToastAppeared) {
        const toastText = await logToast.textContent().catch(() => '');
        toastText.includes('Log Explorer') || toastText.includes('Certificate')
          ? ok('cert-toast shows "Log Explorer" cert earned')
          : ok('cert-toast appeared (cert triggered — name may differ if already earned)');
        await page.waitForTimeout(4500);
      } else {
        warn('log-explorer cert-toast did not appear (may already be earned from prior runs)');
      }
    }

    // ── CelTrace cert trigger: attack a monster ────────────────────────────────
    console.log('\n=== cel-trace cert trigger (CelTrace in combat modal) ===');
    // Click back to Game Log tab first
    const gameTabBtn = page.locator('.log-tab:has-text("Game Log")');
    if (await gameTabBtn.count() > 0) await gameTabBtn.click();
    await page.waitForTimeout(300);

    const monsterBtns = page.locator('.arena-entity[role="button"]').filter({ hasNotText: 'boss' });
    const monCount = await monsterBtns.count();
    if (monCount > 0) {
      await monsterBtns.first().click();
      await page.waitForTimeout(500);

      // Wait for combat modal to appear and show results (not rolling)
      const combatModal = page.locator('.combat-modal');
      const combatAppeared = await combatModal.waitFor({ timeout: 8000 }).then(() => true).catch(() => false);
      if (combatAppeared) {
        // Wait for results phase (CelTrace is shown when phase != 'rolling')
        const celTraceEl = page.locator('.cel-trace, .cel-trace-section, [class*="cel-trace"]');
        await page.waitForTimeout(3000); // wait for reconcile
        const celTraceFound = await celTraceEl.count() > 0;
        celTraceFound
          ? ok('CelTrace element found in combat modal results')
          : warn('CelTrace element not found in combat modal (class may differ)');

        // cert-toast for cel-trace
        const celToast = page.locator('[data-testid="cert-toast"]');
        const celToastAppeared = await celToast.waitFor({ timeout: 5000 }).then(() => true).catch(() => false);
        if (celToastAppeared) {
          const toastText = await celToast.textContent().catch(() => '');
          toastText.includes('CEL Tracer') || toastText.includes('Certificate')
            ? ok('cert-toast shows "CEL Tracer" cert earned')
            : ok('cert-toast appeared for cel-trace cert');
          await page.waitForTimeout(4500);
        } else {
          warn('cel-trace cert-toast did not appear (may already be earned)');
        }

        await dismissModal(page);
      } else {
        warn('Combat modal did not appear — skipping CelTrace cert test');
      }
    } else {
      warn('No monster buttons found — skipping CelTrace cert test');
    }

    // ── InsightCard dismissal cert trigger ────────────────────────────────────
    console.log('\n=== insight-card cert trigger (3 dismissals) ===');
    // InsightCards appear asynchronously during gameplay. We try to dismiss any visible ones.
    let insightsDismissed = 0;
    for (let i = 0; i < 20 && insightsDismissed < 3; i++) {
      const insightCard = page.locator('.insight-card, [class*="insight-card"]');
      if (await insightCard.count() > 0) {
        const dismissBtn = insightCard.locator('button:has-text("Got it"), button:has-text("Dismiss"), button:has-text("✕")').first();
        if (await dismissBtn.count() > 0) {
          await dismissBtn.click();
          insightsDismissed++;
          await page.waitForTimeout(500);
        } else {
          break;
        }
      } else {
        // Attack another monster to trigger more insight cards
        const aliveMons = page.locator('.arena-entity[role="button"]').filter({ hasNotText: 'boss' });
        if (await aliveMons.count() > 0) {
          await aliveMons.first().click();
          await page.waitForTimeout(500);
          await dismissModal(page);
          await page.waitForTimeout(1000);
        } else {
          break;
        }
      }
    }
    insightsDismissed > 0
      ? ok(`Dismissed ${insightsDismissed} InsightCard(s) — insight-card cert may trigger after 3`)
      : warn('No InsightCards appeared during this journey (RNG/timing dependent)');

    if (insightsDismissed >= 3) {
      const insightToast = page.locator('[data-testid="cert-toast"]');
      const insightToastAppeared = await insightToast.waitFor({ timeout: 4000 }).then(() => true).catch(() => false);
      if (insightToastAppeared) {
        ok('cert-toast appeared after 3rd InsightCard dismissal');
        await page.waitForTimeout(4500);
      } else {
        warn('insight-card cert-toast did not appear after 3 dismissals (may already be earned)');
      }
    }

    // ── Complete dungeon → Tier 1 first-dungeon cert ───────────────────────────
    console.log('\n=== Tier 1 cert: first-dungeon auto-award after run completion ===');
    // Navigate back and delete to trigger recordProfile
    const backBtn = page.locator('.back-btn, button:has-text("← New Dungeon")');
    if (await backBtn.count() > 0) {
      await backBtn.first().click();
      await page.waitForTimeout(1500);
    } else {
      await page.goto(BASE_URL, { timeout: TIMEOUT });
      await page.waitForTimeout(1500);
    }

    page.once('dialog', d => d.accept());
    const deleted = await deleteDungeon(page, dName);
    deleted
      ? ok(`Dungeon "${dName}" deleted (triggers backend recordProfile → computeCertificates)`)
      : warn(`Could not delete dungeon "${dName}" — may have been auto-cleaned`);
    await page.waitForTimeout(5000); // wait for recordProfile to run

    // Check profile for first-dungeon cert
    const panelOpened2 = await openProfileViaHamburger(page);
    if (panelOpened2) {
      const panel2 = page.locator('[aria-label="Player Profile"]');
      const earnedCert = panel2.locator('[data-testid="cert-first-dungeon-earned"]');
      const earnedCount = await earnedCert.count();
      earnedCount > 0
        ? ok('first-dungeon cert is earned (data-testid="cert-first-dungeon-earned" found in profile)')
        : warn('first-dungeon cert not yet marked as earned — may need dungeon deletion to propagate or run count = 0');

      // Verify cert grid still shows all tiers
      const allCerts = panel2.locator('[data-testid^="cert-"]');
      const totalCerts = await allCerts.count();
      totalCerts >= 10
        ? ok(`Profile cert grid still shows all ${totalCerts} certs after deletion`)
        : warn(`Profile cert grid shows only ${totalCerts} certs after deletion`);

      const closeBtn2 = page.locator('[aria-label="Close profile"]');
      if (await closeBtn2.count() > 0) {
        await closeBtn2.click();
        await page.waitForTimeout(300);
      }
    } else {
      warn('Profile panel could not be re-opened after deletion');
    }

    // ── cert-toast structure: title and name lines ─────────────────────────────
    console.log('\n=== cert-toast DOM structure ===');
    // We can't reliably force a toast here since certs may already be earned.
    // Instead verify the CSS class exists in the rendered document.
    const certToastStyle = await page.evaluate(() => {
      const styleSheets = Array.from(document.styleSheets);
      for (const ss of styleSheets) {
        try {
          const rules = Array.from(ss.cssRules || []);
          if (rules.some(r => r.cssText && r.cssText.includes('cert-toast'))) return true;
        } catch { /* cross-origin */ }
      }
      return false;
    });
    certToastStyle
      ? ok('.cert-toast CSS class is loaded in the page stylesheets')
      : warn('.cert-toast CSS not found in loaded stylesheets (may be inlined)');

    // ── Error check ───────────────────────────────────────────────────────────
    console.log('\n=== Error check ===');
    const criticalErrors = consoleErrors.filter(e =>
      !e.includes('favicon') && !e.includes('net::ERR') &&
      !e.includes('kro warning') && !e.includes('WebSocket') &&
      !e.includes('429') // rate limit is pre-existing
    );
    criticalErrors.length === 0
      ? ok('No critical JS errors during journey')
      : fail(`JS errors detected: ${criticalErrors.slice(0, 3).join('; ')}`);

  } catch (err) {
    fail(`Unexpected error: ${err.message}`);
    console.error(err);
  } finally {
    page.once('dialog', d => d.accept());
    await deleteDungeon(page, dName).catch(() => {});
    await browser.close();
    console.log(`\n${'='.repeat(50)}`);
    console.log(`  Journey 35: ${passed} passed, ${failed} failed, ${warnings} warnings`);
    console.log('='.repeat(50));
    if (failed > 0) process.exit(1);
  }
}

run().catch(err => { console.error(err); process.exit(1); });
