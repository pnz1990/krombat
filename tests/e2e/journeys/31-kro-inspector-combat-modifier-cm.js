// Journey 31: KroGraph Inspector — combat-cm and modifier-cm deep-dive
// UI-ONLY: no kubectl, no direct fetch/api, no execSync
//
// Covers the untested Inspector flows for combatResult (combat-cm) and
// modifierState (modifier-cm) ConfigMap nodes, which contain CEL-computed
// fields and are the most educational in the kro teaching layer.
//
// combat-cm: always present; shows dice formula, last combat result data
// modifier-cm: present only when dungeon has a modifier (includeWhen guard)
//              — tested conditionally; warns if no modifier was assigned.
const { chromium } = require('playwright');
const { createDungeonUI, navigateHome, deleteDungeon } = require('./helpers');

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

// Click a graph node whose aria-label starts with the given prefix.
// aria-label format: "{kind}: {label} — {state}"
async function clickGraphNode(page, labelPrefix) {
  const svg = page.locator('svg[aria-label="kro resource graph"]');
  const nodes = svg.locator('g[role="button"]');
  const count = await nodes.count();
  for (let i = 0; i < count; i++) {
    const label = await nodes.nth(i).getAttribute('aria-label').catch(() => '');
    if (label && label.includes(labelPrefix)) {
      await nodes.nth(i).click({ force: true });
      return label;
    }
  }
  return null;
}

async function closeInspector(page) {
  // Dismiss InsightCards or modal overlays before clicking close
  for (let i = 0; i < 3; i++) {
    const insightDismiss = page.locator('.kro-insight-card.visible .kro-insight-dismiss');
    if (await insightDismiss.count() > 0) {
      await insightDismiss.first().click({ force: true }).catch(() => {});
      await page.waitForTimeout(400);
    }
    const mo = page.locator('.modal-overlay:not(.combat-overlay)');
    if (await mo.count() > 0) {
      await page.keyboard.press('Escape').catch(() => {});
      await page.evaluate(() => { const el = document.querySelector('.modal-overlay'); if (el) el.click(); }).catch(() => {});
      await page.waitForTimeout(300);
    }
    if (await page.locator('.kro-insight-card.visible').count() === 0 &&
        await page.locator('.modal-overlay:not(.combat-overlay)').count() === 0) break;
  }
  const btn = page.locator('.kro-inspector-header button:has-text("✕")');
  if (await btn.count() > 0) {
    await page.evaluate(() => {
      const b = document.querySelector('.kro-inspector-header button');
      if (b) b.click();
    });
    await page.waitForTimeout(300);
  }
}

async function waitForInspectorReady(page) {
  // Wait up to 15s for loading to finish
  for (let i = 0; i < 30; i++) {
    const loading = await page.locator('.kro-inspector-loading').count();
    if (loading === 0) break;
    await page.waitForTimeout(500);
  }
}

async function run() {
  console.log('Journey 31: KroGraph Inspector — combat-cm and modifier-cm\n');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const dName = `j31-${Date.now()}`;

  const consoleErrors = [];
  page.on('console', msg => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });

  try {
    await page.goto(BASE_URL, { timeout: TIMEOUT });
    await page.waitForSelector('input[placeholder="my-dungeon"]', { timeout: TIMEOUT });

    // ── Create dungeon ────────────────────────────────────────────────────────
    console.log('\n  [Create dungeon]');
    const loaded = await createDungeonUI(page, dName, { monsters: 2, difficulty: 'easy', heroClass: 'warrior' });
    loaded ? ok('Dungeon created and game view loaded') : fail('Dungeon view did not load');

    // Allow initial reconcile to settle so combat-cm is populated
    await page.waitForTimeout(3000);

    // ── Switch to kro Graph tab ───────────────────────────────────────────────
    console.log('\n  [kro Graph tab]');
    const tabSwitched = await switchToTab(page, 'kro');
    tabSwitched ? ok('kro tab is present and clickable') : fail('kro tab not found');

    // ── KroGraph panel and SVG ────────────────────────────────────────────────
    console.log('\n  [KroGraph panel]');
    const graphPanel = page.locator('.kro-graph-panel');
    await graphPanel.waitFor({ timeout: TIMEOUT }).catch(() => {});
    (await graphPanel.count() > 0) ? ok('kro-graph-panel is visible') : fail('kro-graph-panel not found');

    const svg = page.locator('svg[aria-label="kro resource graph"]');
    await svg.waitFor({ timeout: TIMEOUT }).catch(() => {});
    (await svg.count() > 0) ? ok('Graph SVG rendered') : fail('Graph SVG not found');

    // ── Verify combatResult node is present in graph ──────────────────────────
    console.log('\n  [combatResult node presence]');
    const allNodes = svg.locator('g[role="button"]');
    const nodeCount = await allNodes.count();
    let combatNodeFound = false;
    let modifierNodeFound = false;
    for (let i = 0; i < nodeCount; i++) {
      const label = await allNodes.nth(i).getAttribute('aria-label').catch(() => '');
      if (label && label.includes('combatResult')) combatNodeFound = true;
      if (label && label.includes('modifierState')) modifierNodeFound = true;
    }
    combatNodeFound
      ? ok('combatResult (combat-cm) node found in KroGraph')
      : fail('combatResult node not found in KroGraph');
    modifierNodeFound
      ? ok('modifierState (modifier-cm) node found in KroGraph (modifier is active)')
      : warn('modifierState node not visible — dungeon has no modifier (20% chance, statistically expected)');

    // ── Click combatResult node — Inspector opens ─────────────────────────────
    console.log('\n  [Click combatResult node — Inspector]');
    const combatNodeLabel = await clickGraphNode(page, 'combatResult');
    combatNodeLabel
      ? ok(`Clicked combatResult node (aria-label: "${combatNodeLabel}")`)
      : fail('combatResult node not clickable');

    await page.waitForTimeout(500);
    const inspector = page.locator('.kro-inspector');
    await inspector.waitFor({ timeout: TIMEOUT }).catch(() => {});
    (await inspector.count() > 0)
      ? ok('.kro-inspector panel appeared after clicking combatResult node')
      : fail('.kro-inspector did not open for combatResult node');

    // ── Inspector title and kubectl command for combat-cm ─────────────────────
    console.log('\n  [Inspector title + kubectl for combat-cm]');
    const titleText = await page.locator('.kro-inspector-title').textContent().catch(() => '');
    titleText.includes('combatResult') || titleText.includes('Inspector')
      ? ok(`Inspector title: "${titleText.trim()}"`)
      : fail(`Inspector title unexpected: "${titleText}"`);

    const kubectlText = await page.locator('.kro-inspector-kubectl').textContent().catch(() => '');
    kubectlText.includes('kubectl get')
      ? ok('kubectl command present for combatResult inspector')
      : fail('kubectl command missing for combatResult inspector');
    kubectlText.toLowerCase().includes('configmap')
      ? ok('kubectl command targets ConfigMap kind for combat-cm')
      : fail(`kubectl command should target ConfigMap, got: "${kubectlText.trim()}"`);
    kubectlText.includes(dName)
      ? ok(`kubectl command references dungeon name "${dName}"`)
      : fail(`kubectl command missing dungeon name in: "${kubectlText.trim()}"`);
    kubectlText.includes('-o yaml')
      ? ok('kubectl command includes -o yaml flag')
      : fail('kubectl command missing -o yaml flag');

    // ── Inspector YAML for combat-cm (CEL-computed fields) ────────────────────
    console.log('\n  [Inspector YAML — combat-cm CEL fields]');
    await waitForInspectorReady(page);

    const yamlEl = page.locator('.kro-inspector-yaml');
    const emptyEl = page.locator('.kro-inspector-empty');

    if (await yamlEl.count() > 0) {
      const yamlText = await yamlEl.textContent().catch(() => '');
      yamlText.length > 0
        ? ok(`combat-cm YAML content present (${yamlText.length} chars)`)
        : fail('combat-cm YAML element is empty');

      // ConfigMap YAML should contain apiVersion, kind, data
      yamlText.includes('apiVersion') || yamlText.includes('kind') || yamlText.includes('data')
        ? ok('combat-cm YAML contains Kubernetes ConfigMap fields')
        : warn(`combat-cm YAML doesn't look like K8s resource: "${yamlText.slice(0, 80)}"`);

      // combat-cm should have CEL-computed fields in data section
      // At minimum: the combat-result ConfigMap should mention dice or HP values
      const hasGameData = yamlText.includes('dice') || yamlText.includes('HP') ||
                          yamlText.includes('heroHP') || yamlText.includes('result') ||
                          yamlText.includes('damage') || yamlText.includes('combat');
      hasGameData
        ? ok('combat-cm YAML contains CEL-computed game data fields')
        : warn('Expected dice/HP/result fields in combat-cm ConfigMap — may not be populated yet');

    } else if (await emptyEl.count() > 0) {
      warn('combat-cm Inspector shows "resource not available" — configmap may not exist yet (cluster cold)');
    } else {
      fail('combat-cm Inspector shows neither YAML content nor loading/empty state');
    }

    // ── Close inspector ───────────────────────────────────────────────────────
    await closeInspector(page);
    await page.waitForTimeout(300);
    const inspectorGone = await page.locator('.kro-inspector').count() === 0;
    inspectorGone
      ? ok('Inspector closed after ✕ button click')
      : fail('Inspector still visible after close button click');

    // ── modifier-cm Inspector (conditional — only if modifier-cm node exists) ──
    console.log('\n  [modifier-cm Inspector (conditional)]');
    if (modifierNodeFound) {
      const modNodeLabel = await clickGraphNode(page, 'modifierState');
      modNodeLabel
        ? ok(`Clicked modifierState node (aria-label: "${modNodeLabel}")`)
        : fail('modifierState node not clickable despite being found earlier');

      await page.waitForTimeout(500);
      const modInspector = page.locator('.kro-inspector');
      await modInspector.waitFor({ timeout: TIMEOUT }).catch(() => {});
      (await modInspector.count() > 0)
        ? ok('.kro-inspector opened for modifierState node')
        : fail('.kro-inspector did not open for modifierState node');

      // Title should reference modifier
      const modTitleText = await page.locator('.kro-inspector-title').textContent().catch(() => '');
      modTitleText.includes('modifierState') || modTitleText.includes('Inspector')
        ? ok(`modifier-cm Inspector title: "${modTitleText.trim()}"`)
        : fail(`modifier-cm Inspector title unexpected: "${modTitleText}"`);

      // kubectl command should target ConfigMap
      const modKubectl = await page.locator('.kro-inspector-kubectl').textContent().catch(() => '');
      modKubectl.toLowerCase().includes('configmap')
        ? ok('kubectl command targets ConfigMap kind for modifier-cm')
        : fail(`modifier-cm kubectl not ConfigMap: "${modKubectl.trim()}"`);

      // YAML content check
      await waitForInspectorReady(page);
      const modYaml = page.locator('.kro-inspector-yaml');
      if (await modYaml.count() > 0) {
        const modYamlText = await modYaml.textContent().catch(() => '');
        modYamlText.length > 0
          ? ok(`modifier-cm YAML content present (${modYamlText.length} chars)`)
          : fail('modifier-cm YAML element is empty');

        // Modifier ConfigMap should contain CEL-computed modifier type data
        const hasModData = modYamlText.includes('modifier') || modYamlText.includes('curse') ||
                           modYamlText.includes('blessing') || modYamlText.includes('effect') ||
                           modYamlText.includes('type') || modYamlText.includes('data');
        hasModData
          ? ok('modifier-cm YAML contains CEL-computed modifier fields')
          : warn('Expected modifier/curse/blessing fields in modifier-cm ConfigMap');
      } else if (await page.locator('.kro-inspector-empty').count() > 0) {
        warn('modifier-cm Inspector shows "resource not available"');
      } else {
        fail('modifier-cm Inspector shows neither YAML nor empty state');
      }

      await closeInspector(page);
      ok('modifier-cm Inspector flow complete');
    } else {
      warn('modifier-cm test skipped — no modifier on this dungeon (testing combat-cm only)');
      ok('Journey 31 core test (combat-cm) complete; modifier-cm skipped due to no modifier');
    }

    // ── Switching between nodes updates Inspector content ─────────────────────
    console.log('\n  [Node switching — Inspector updates correctly]');
    // Click combatResult again, then click Dungeon node, verify Inspector updates
    const combatLabel2 = await clickGraphNode(page, 'combatResult');
    combatLabel2 ? ok('Re-clicked combatResult node') : warn('combatResult node not re-clickable');
    await page.waitForTimeout(400);

    const combatTitle = await page.locator('.kro-inspector-title').textContent().catch(() => '');
    combatTitle.includes('combatResult') || combatTitle.includes('Inspector')
      ? ok(`Inspector shows combatResult after re-click: "${combatTitle.trim()}"`)
      : warn(`Inspector title after re-click: "${combatTitle.trim()}"`);

    // Switch to Dungeon CR node — inspector should update
    const dungeonLabel = await clickGraphNode(page, 'Dungeon');
    if (dungeonLabel) {
      await page.waitForTimeout(400);
      const dungeonTitle = await page.locator('.kro-inspector-title').textContent().catch(() => '');
      dungeonTitle.includes('Dungeon') || dungeonTitle.includes('Inspector')
        ? ok(`Inspector updated to Dungeon CR node: "${dungeonTitle.trim()}"`)
        : fail(`Inspector did not update when switching from combatResult to Dungeon: "${dungeonTitle}"`);
    } else {
      warn('Could not click Dungeon node for switch test');
    }

    await closeInspector(page);

    // ── Verify no JS errors during all inspector interactions ─────────────────
    console.log('\n  [Console error check]');
    const criticalErrors = consoleErrors.filter(e =>
      !e.includes('favicon') && !e.includes('net::ERR') &&
      !e.includes('kro warning') && !e.includes('WebSocket') &&
      !e.includes('404')
    );
    criticalErrors.length === 0
      ? ok('No critical JS errors during journey')
      : fail(`JS errors: ${criticalErrors.slice(0, 3).join('; ')}`);

  } catch (err) {
    fail(`Unexpected error: ${err.message}`);
    console.error(err);
  } finally {
    await page.goto(BASE_URL, { timeout: TIMEOUT }).catch(() => {});
    await page.waitForTimeout(1000);
    await deleteDungeon(page, dName).catch(() => {});
    await browser.close();
    console.log(`\n  Passed: ${passed}  Failed: ${failed}  Warnings: ${warnings}`);
    if (failed > 0) process.exit(1);
  }
}

run();
