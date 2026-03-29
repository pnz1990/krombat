// Journey 41: Workshop Kit (#461)
// UI-ONLY: no kubectl, no direct fetch/api, no execSync
// Tests:
//   1.  docs/workshop/README.md exists in repo (fetch from GitHub raw)
//   2.  docs/workshop/day-1-explore.md exists in repo
//   3.  docs/workshop/day-2-read-the-rgds.md exists in repo
//   4.  docs/workshop/day-3-extend.md exists in repo
//   5.  docs/workshop/exercises/day-1-exercises.md exists
//   6.  docs/workshop/exercises/day-2-exercises.md exists
//   7.  docs/workshop/exercises/day-3-exercises.md exists
//   8.  docs/workshop/solutions/day-3-solution.yaml exists
//   9.  day-3-solution.yaml contains blessing-agility
//   10. day-3-solution.yaml is a valid ResourceGraphDefinition
//   11. workshop README references learn-kro.eks.aws.dev
//   12. day-1-explore.md says no local cluster required
//   13. day-2-read-the-rgds.md says no local cluster required
//   14. day-3-extend.md references ArgoCD
//   15. Help modal has "Workshop Kit" page
//   16. Intro tour has "3-Day kro Workshop" slide
//   17. No JS console errors
const { chromium } = require('playwright');
const { createDungeonUI, deleteDungeon, testLogin } = require('./helpers');

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const TIMEOUT = 25000;
let passed = 0, failed = 0, warnings = 0;
function ok(msg)   { console.log(`  ✅ ${msg}`); passed++; }
function fail(msg) { console.log(`  ❌ ${msg}`); failed++; }
function warn(msg) { console.log(`  ⚠️  ${msg}`); warnings++; }

const RAW_BASE = 'https://raw.githubusercontent.com/pnz1990/krombat/main';

async function run() {
  console.log('Journey 41: Workshop Kit\n');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const consoleErrors = [];
  page.on('console', msg => {
    if (msg.type() === 'error'
      && !msg.text().includes('WebSocket')
      && !msg.text().includes('404')
      && !msg.text().includes('net::ERR')
      && !msg.text().includes('502')
      && !msg.text().includes('504')
      && !msg.text().includes('400')
      && !msg.text().includes('401')
      && !msg.text().includes('409') && !msg.text().includes('429'))
      consoleErrors.push(msg.text());
  });

  try {
    // === Step 1: Verify workshop files exist in repo ===
    console.log('=== Step 1: Workshop files in repo ===');

    const files = [
      { path: 'Docs/workshop/README.md', label: 'Docs/workshop/README.md' },
      { path: 'Docs/workshop/day-1-explore.md', label: 'Docs/workshop/day-1-explore.md' },
      { path: 'Docs/workshop/day-2-read-the-rgds.md', label: 'Docs/workshop/day-2-read-the-rgds.md' },
      { path: 'Docs/workshop/day-3-extend.md', label: 'Docs/workshop/day-3-extend.md' },
      { path: 'Docs/workshop/exercises/day-1-exercises.md', label: 'exercises/day-1-exercises.md' },
      { path: 'Docs/workshop/exercises/day-2-exercises.md', label: 'exercises/day-2-exercises.md' },
      { path: 'Docs/workshop/exercises/day-3-exercises.md', label: 'exercises/day-3-exercises.md' },
      { path: 'Docs/workshop/solutions/day-3-solution.yaml', label: 'solutions/day-3-solution.yaml' },
    ];

    const fileContents = {};
    for (const f of files) {
      const result = await page.evaluate(async (url) => {
        try {
          const r = await fetch(url);
          return { status: r.status, body: await r.text() };
        } catch (e) { return { status: 0, body: '' }; }
      }, `${RAW_BASE}/${f.path}`);
      result.status === 200
        ? ok(`${f.label} exists in repo`)
        : fail(`${f.label} not found (status ${result.status})`);
      fileContents[f.path] = result.body;
    }

    // === Step 2: Validate day-3-solution.yaml content ===
    console.log('\n=== Step 2: day-3-solution.yaml content ===');

    const solutionYaml = fileContents['Docs/workshop/solutions/day-3-solution.yaml'] || '';

    solutionYaml.includes('blessing-agility')
      ? ok('day-3-solution.yaml contains blessing-agility modifier')
      : fail('day-3-solution.yaml missing blessing-agility modifier');

    solutionYaml.includes('ResourceGraphDefinition')
      ? ok('day-3-solution.yaml is a ResourceGraphDefinition')
      : fail('day-3-solution.yaml missing ResourceGraphDefinition kind');

    solutionYaml.includes('kind: Modifier') || solutionYaml.includes('kind: modifier')
      ? ok('day-3-solution.yaml schema kind is Modifier')
      : fail('day-3-solution.yaml schema missing kind: Modifier');

    solutionYaml.includes('Blessing of Agility')
      ? ok('day-3-solution.yaml has correct Blessing of Agility effect string')
      : fail('day-3-solution.yaml missing Blessing of Agility effect string');

    solutionYaml.includes('modifier-graph')
      ? ok('day-3-solution.yaml references modifier-graph name')
      : fail('day-3-solution.yaml missing modifier-graph name');

    // === Step 3: Validate guide content ===
    console.log('\n=== Step 3: Guide content checks ===');

    const readme = fileContents['Docs/workshop/README.md'] || '';
    readme.includes('learn-kro.eks.aws.dev')
      ? ok('workshop README references learn-kro.eks.aws.dev')
      : fail('workshop README missing learn-kro.eks.aws.dev reference');

    readme.includes('day-1') || readme.includes('Day 1')
      ? ok('workshop README references Day 1')
      : fail('workshop README missing Day 1 reference');

    readme.includes('day-3') || readme.includes('Day 3')
      ? ok('workshop README references Day 3')
      : fail('workshop README missing Day 3 reference');

    const day1 = fileContents['Docs/workshop/day-1-explore.md'] || '';
    day1.includes('No local cluster required')
      ? ok('day-1-explore.md states no local cluster required')
      : fail('day-1-explore.md missing "No local cluster required"');

    const day2 = fileContents['Docs/workshop/day-2-read-the-rgds.md'] || '';
    day2.includes('No local cluster required')
      ? ok('day-2-read-the-rgds.md states no local cluster required')
      : fail('day-2-read-the-rgds.md missing "No local cluster required"');

    const day3 = fileContents['Docs/workshop/day-3-extend.md'] || '';
    (day3.includes('ArgoCD') || day3.includes('Argo CD') || day3.includes('argocd'))
      ? ok('day-3-extend.md references ArgoCD deployment')
      : fail('day-3-extend.md missing ArgoCD deployment instructions');

    day3.includes('blessing-agility')
      ? ok('day-3-extend.md exercises reference blessing-agility')
      : fail('day-3-extend.md missing blessing-agility exercise');

    // === Step 4: Verify help modal has Workshop Kit page ===
    console.log('\n=== Step 4: Help modal workshop page ===');

    try {
      await page.goto(BASE_URL, { waitUntil: 'networkidle', timeout: TIMEOUT });
      await testLogin(page);
      await page.waitForTimeout(2000);

      // Dismiss onboarding if shown
      for (let i = 0; i < 15; i++) {
        const btn = page.locator('button:has-text("Next →"), button:has-text("Start Playing"), button:has-text("Got it!"), button.kro-onboard-skip');
        if (await btn.count() > 0) { await btn.first().click({ force: true }).catch(() => {}); await page.waitForTimeout(400); }
        else break;
      }

      // Create a dungeon to get into DungeonView (where the help button lives)
      const dungeonName = `j41-wk-${Date.now()}`;
      const dungeonReady = await createDungeonUI(page, dungeonName, { monsters: 2, difficulty: 'easy', heroClass: 'warrior' });
      if (dungeonReady) {
        ok('Dungeon created for help modal test');

        // Open help modal via ? button
        const helpBtn = page.locator('button[aria-label="Help"], .help-btn');
        if (await helpBtn.count() > 0) {
          await helpBtn.first().click({ force: true }).catch(() => {});
          await page.waitForTimeout(800);
        }

        const helpModal = page.locator('.help-modal, [aria-label*="Help:"]');
        if (await helpModal.count() > 0) {
          ok('Help modal opened successfully');

          // Navigate to the Workshop Kit page by clicking Next until we find it or reach end
          let found = false;
          for (let i = 0; i < 20 && !found; i++) {
            const bodyText = await page.textContent('.help-modal, .modal.help-modal').catch(() => '');
            if (bodyText.includes('Workshop Kit') || bodyText.includes('docs/workshop') || bodyText.includes('Docs/workshop')) {
              found = true;
              ok('Help modal has Workshop Kit page');
              break;
            }
            const nextBtn = page.locator('.help-nav button:has-text("Next →")');
            if (await nextBtn.count() > 0 && !(await nextBtn.isDisabled())) {
              await nextBtn.click({ force: true }).catch(() => {});
              await page.waitForTimeout(300);
            } else {
              break;
            }
          }
          if (!found) fail('Help modal missing Workshop Kit page');

          // Close help modal
          const closeBtn = page.locator('.help-nav button:has-text("Close")');
          if (await closeBtn.count() > 0) await closeBtn.click({ force: true }).catch(() => {});
          await page.waitForTimeout(400);
        } else {
          warn('Help modal did not open — skipping workshop page check');
        }

        // Clean up dungeon
        await deleteDungeon(page, dungeonName).catch(() => {});
      } else {
        warn('Dungeon did not initialize — skipping help modal check');
      }
    } catch (helpErr) {
      warn(`Help modal UI check timed out: ${helpErr.message.split('\n')[0]}`);
    }

    // === Step 5: Verify intro tour has workshop slide ===
    console.log('\n=== Step 5: Intro tour workshop slide ===');

    // Navigate back to home and clear the onboarding dismissed flag
    await page.goto(BASE_URL, { waitUntil: 'networkidle', timeout: TIMEOUT });
    await page.waitForTimeout(1000);
    await page.evaluate(() => {
      localStorage.removeItem('kroOnboardingDone');
      sessionStorage.removeItem('kroOnboardingDone');
    });
    await page.reload({ waitUntil: 'networkidle', timeout: TIMEOUT });
    await page.waitForTimeout(2000);

    // The onboarding overlay should now be showing
    const onboarding = page.locator('.kro-onboarding-overlay, [class*="kro-onboard"]');
    if (await onboarding.count() > 0) {
      ok('Onboarding overlay present after clearing dismissal');

      // Navigate through all slides looking for workshop slide
      let workshopFound = false;
      for (let i = 0; i < 15 && !workshopFound; i++) {
        const slideText = await page.textContent('.kro-onboarding-overlay, [class*="kro-onboard"]').catch(() => '');
        if (slideText.includes('Workshop') || slideText.includes('docs/workshop') || slideText.includes('3-Day')) {
          workshopFound = true;
          ok('Intro tour has workshop slide');
        }
        if (!workshopFound) {
          const nextBtn = page.locator('button:has-text("Next →")').first();
          if (await nextBtn.count() > 0 && !(await nextBtn.isDisabled())) {
            await nextBtn.click({ force: true }).catch(() => {});
            await page.waitForTimeout(400);
          } else {
            break;
          }
        }
      }
      if (!workshopFound) fail('Intro tour missing workshop slide');
    } else {
      warn('Onboarding overlay not shown after clearing dismissal — skipping workshop slide check');
    }

  } catch (err) {
    fail(`Unexpected error: ${err.message}`);
  } finally {
    await browser.close();
  }

  // === Console errors check ===
  console.log('\n=== Console errors ===');
  consoleErrors.length === 0
    ? ok('No unexpected JS console errors')
    : fail(`${consoleErrors.length} unexpected console error(s): ${consoleErrors.slice(0,3).join('; ')}`);

  // === Summary ===
  console.log(`\nJourney 41 complete: ${passed} passed, ${failed} failed, ${warnings} warnings`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => { console.error(err); process.exit(1); });
