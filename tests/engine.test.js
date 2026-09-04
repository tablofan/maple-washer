// Tests for the MapleWasher engine.
//
// Run: `node tests/engine.test.js` (from repo root)
//
// No test framework — plain Node. The harness loads classes.js and engine.js
// via `eval` so we don't need module wrapping in the source files (they're
// loaded as plain <script> tags in the browser).
//
// Reference values for the calibration tests come from Krythan's per-class
// MapleLegends washing sheets (see CONTEXT.md for the spreadsheet IDs). Where
// his sheet allows a user-tunable input that our optimizer picks automatically
// (e.g. Target Base INT), we assert on the output ranges his sheets show across
// reasonable user choices, not on a single fixed number.

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const classesSrc = fs.readFileSync(path.join(ROOT, 'classes.js'), 'utf-8');
const engineSrc = fs.readFileSync(path.join(ROOT, 'engine.js'), 'utf-8');
const workerSrc = fs.readFileSync(path.join(ROOT, 'wash-worker.js'), 'utf-8');
const indexSrc = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf-8');

// Load via a tmp CommonJS module so V8 JIT-optimises the hot loops the same way it does
// for normal require()'d code. (Top-level `eval` keeps the eval'd code in interpreted mode
// indefinitely, which is ~5× slower for the brute-force optimizer.)
const tmpModule = path.join(os.tmpdir(), `maplewasher-test-${process.pid}.js`);
const exportList = [
  'CLASSES', 'CLASS_ORDER', 'MAPLE_WARRIOR_LEVELS',
  'BEGINNER_HP_PER_LEVEL', 'BEGINNER_MP_PER_LEVEL',
  'STARTING_HP', 'STARTING_MP', 'STARTING_MAIN_STAT',
  'NX_PER_AP_RESET', 'MAX_NX_PER_DAY_PER_ACCOUNT',
  'MAX_HP', 'MAX_MP',
  'optimize', 'evaluateStrategy', 'phasePlan', 'levelTable',
  'minMPAtLevel', 'minHPAtLevel', 'prepareInputs',
  'runPhase1', 'runPhase2', 'runPhase3', 'runCleanup',
  'washCycleMP', 'freshHPWashYield', 'staleHPWashYield', 'washCycleMPCost',
  'naturalMPGainAtLevel',
  'freshAPAtLevel', 'freshAPInRange', 'firstJobAPNeeded',
  'firstJobRequirementAPAtLevel', 'usableFreshAPAtLevel', 'usableFreshAPInRange',
  'nonIntPool', 'nonIntStatFloor', 'precomputeRanges',
];
fs.writeFileSync(tmpModule, classesSrc + '\n' + engineSrc + '\n' + `module.exports = { ${exportList.join(', ')} };`);
process.on('exit', () => { try { fs.unlinkSync(tmpModule); } catch {} });
const mod = require(tmpModule);
const { CLASSES, CLASS_ORDER, optimize, phasePlan, levelTable, prepareInputs } = mod;
const { nonIntPool, nonIntStatFloor } = mod;
globalThis.mod = mod;

// ────────────────────────── tiny harness ──────────────────────────

let passed = 0, failed = 0;
const failures = [];

function test(name, fn) {
  const t0 = Date.now();
  try {
    fn();
    const ms = Date.now() - t0;
    passed++;
    const tag = ms > 1000 ? ` (${ms}ms)` : '';
    console.log('  \x1b[32m✓\x1b[0m ' + name + tag);
  } catch (err) {
    failed++;
    failures.push({ name, err });
    console.log('  \x1b[31m✗\x1b[0m ' + name);
    console.log('    \x1b[31m' + (err.message || err) + '\x1b[0m');
  }
}

function describe(name, fn) {
  console.log('\n\x1b[1m' + name + '\x1b[0m');
  fn();
}

function assertEq(actual, expected, msg) {
  if (actual !== expected) throw new Error((msg ? msg + ': ' : '') + 'expected ' + expected + ', got ' + actual);
}

function assertInRange(actual, min, max, msg) {
  if (actual < min || actual > max) throw new Error((msg ? msg + ': ' : '') + 'expected in [' + min + ', ' + max + '], got ' + actual);
}

function assertTrue(condition, msg) {
  if (!condition) throw new Error(msg || 'condition was false');
}

function assertFeasible(result) {
  if (!result.feasible) throw new Error('expected feasible plan, got infeasibility: ' + result.reason);
}

function assertInfeasible(result, reasonSubstring) {
  if (result.feasible) throw new Error('expected infeasible plan, but got feasible result with ' + result.apResets + ' AP Resets');
  if (reasonSubstring && !result.reason.toLowerCase().includes(reasonSubstring.toLowerCase())) {
    throw new Error('expected reason to mention "' + reasonSubstring + '", got: "' + result.reason + '"');
  }
}

// Convenience builder for `optimize` arguments.
// Supports both the new 4-stat shape (str/dex/luk/baseInt) and the legacy { mainStat: N } shorthand.
// When `mainStat` is supplied for a non-Mage class, it's mapped onto the class's main stat field.
function plan(opts) {
  const classData = CLASSES[opts.class];
  if (!classData) throw new Error('unknown class: ' + opts.class);
  const currentState = Object.assign(
    { level: 1, hp: 50, mp: 5, str: 4, dex: 4, luk: 4, baseInt: 4 },
    opts.current || {}
  );
  if (opts.current && opts.current.mainStat !== undefined && classData.mainStat !== 'INT') {
    currentState[classData.mainStat.toLowerCase()] = opts.current.mainStat;
  }
  // Most tests exercise washing mechanics rather than malformed historical characters. Keep
  // their mid-progress fixtures legal unless a test calls optimize() directly to check rejection.
  const requirement = classData.firstJobRequirement;
  if (requirement && currentState.level >= requirement.level) {
    const key = requirement.stat === 'INT' ? 'baseInt' : requirement.stat.toLowerCase();
    currentState[key] = Math.max(currentState[key], requirement.minimum);
  }
  delete currentState.mainStat;
  // Swap Level defaults to Target Level (the degenerate case where everything collapses at the
  // goal level). Tests that exercise a realistic plan pass an explicit swapLevel.
  const goals = Object.assign(
    { hpGoal: 30000, mpGoal: 5000, targetLevel: 180, swapLevel: null },
    opts.goals || {}
  );
  if (goals.swapLevel === null) goals.swapLevel = goals.targetLevel;
  const gearInt = opts.gearInt ?? 40;
  const mwMultiplier = opts.mwMultiplier ?? 1.0;
  // Memoised on the resolved inputs. Many tests assert different facets of the same plan, and a
  // full 1->180 search costs tens of seconds — recomputing it per assertion was about half the
  // suite's runtime. No test mutates a result, so sharing the object between them is safe.
  const key = JSON.stringify([opts.class, currentState, goals, gearInt, mwMultiplier]);
  if (planCache.has(key)) return planCache.get(key);
  const r = optimize(classData, currentState, goals, gearInt, mwMultiplier);
  // Stash the className / inputs back into the result for tests that need them.
  if (r && r.params) {
    r.params.className = opts.class;
    r.__state = currentState;
    r.__goals = goals;
  }
  planCache.set(key, r);
  return r;
}

const planCache = new Map();

// ────────────────────────── reference cases ──────────────────────────
// Calibrated against Krythan's published sheet defaults.

describe('Reference cases (Krythan-aligned)', () => {
  test('Assassin fresh start to 30k HP / 5k MP at lvl 180', () => {
    const r = plan({ class: 'Assassin', goals: { hpGoal: 30000, mpGoal: 5000, targetLevel: 180, swapLevel: 160 } });
    assertFeasible(r);
    assertEq(r.finalHP, 30000, 'HP at cap');
    assertTrue(r.finalMP >= 5000, 'MP meets goal');
    // Krythan's NL sheet defaults give ~2121 AP Resets; tightened from 1900-2500.
    assertInRange(r.apResets, 2000, 2400, 'AP Resets within ±10% of Krythan default ~2121');
    assertInRange(r.params.targetBaseInt, 300, 600, 'Target Base INT in Krythan-style range');
    const rows = levelTable(CLASSES['Assassin'], r.__state, r.__goals, 40, 1.0, r);
    assertEq(rows.find(row => row.level === 10).firstJobStatValue, 25,
      'the level schedule reaches the permanent 25 DEX thief requirement');
    assertTrue(phasePlan(CLASSES['Assassin'], r.__state, r.__goals, r)
      .some(phase => phase.phase === 'First Job Requirement' && /25 DEX/.test(phase.action)),
    'the phase plan tells the user about the thief requirement');
  });

  test('Fighter (Warrior) fresh start to 30k HP / 2k MP at lvl 180', () => {
    const r = plan({ class: 'Fighter', goals: { hpGoal: 30000, mpGoal: 2000, targetLevel: 180, swapLevel: 120 } });
    assertFeasible(r);
    assertEq(r.finalHP, 30000);
    assertTrue(r.finalMP >= 2000);
    // Warriors use fresh HP wash (52 HP/AP). Fresh AP that is not needed for INT or MP washing can
    // go directly to STR before the user-selected swap, bringing this close to Krythan's ~470-reset
    // baseline rather than incorrectly forcing MP Wash cycles on every pre-swap level.
    assertInRange(r.apResets, 400, 700, 'Warrior AP Resets at swap 120');
  });

  test('Magician fresh start to 5k HP / 10k MP at lvl 180', () => {
    const r = plan({ class: 'Magician', goals: { hpGoal: 5000, mpGoal: 10000, targetLevel: 180 } });
    assertFeasible(r);
    assertTrue(r.finalHP >= 5000, 'HP meets goal');
    assertTrue(r.finalMP >= 10000, 'MP meets goal');
    assertEq(r.breakdown.intReset, 0, 'Mages do not reset INT');
  });

  test('Magician result is independent of any submitted Swap Level', () => {
    const early = plan({ class: 'Magician', goals: { hpGoal: 5000, mpGoal: 10000, targetLevel: 180, swapLevel: 2 } });
    const late = plan({ class: 'Magician', goals: { hpGoal: 5000, mpGoal: 10000, targetLevel: 180, swapLevel: 200 } });
    assertFeasible(early);
    assertFeasible(late);
    assertEq(early.apResets, late.apResets);
    assertEq(early.finalHP, late.finalHP);
    assertEq(early.finalMP, late.finalMP);
    assertEq(early.params.targetBaseInt, late.params.targetBaseInt);
  });
});

describe('Maple Warrior multiplier', () => {
  const baseInputs = {
    class: 'Assassin',
    goals: { hpGoal: 30000, mpGoal: 5000, targetLevel: 180 },
  };
  test('MW30 plan uses no more AP Resets than MW0', () => {
    const mw0 = plan(Object.assign({}, baseInputs, { mwMultiplier: 1.00 }));
    const mw30 = plan(Object.assign({}, baseInputs, { mwMultiplier: 1.15 }));
    assertFeasible(mw0);
    assertFeasible(mw30);
    // MW boosts natural MP gain from INT, so the optimizer can use a lower Target Base INT for
    // the same MP goal — fewer total resets (or at least no worse).
    assertTrue(mw30.apResets <= mw0.apResets, `MW30 (${mw30.apResets}) should be ≤ MW0 (${mw0.apResets})`);
  });
  test('MW20 is between MW0 and MW30', () => {
    const mw0  = plan(Object.assign({}, baseInputs, { mwMultiplier: 1.00 }));
    const mw20 = plan(Object.assign({}, baseInputs, { mwMultiplier: 1.10 }));
    const mw30 = plan(Object.assign({}, baseInputs, { mwMultiplier: 1.15 }));
    assertTrue(mw20.apResets <= mw0.apResets);
    assertTrue(mw30.apResets <= mw20.apResets);
  });
});

describe('Mid-progress shift mechanic', () => {
  test('Mid-progress with low INT and high Main Stat picks a positive shift when beneficial', () => {
    // Lvl 100 Assassin with LUK 400 but only 4 Base INT — should convert some LUK→INT.
    const r = plan({
      class: 'Assassin',
      current: { level: 100, hp: 4000, mp: 1500, baseInt: 4, mainStat: 400 },
      goals: { hpGoal: 30000, mpGoal: 5000, targetLevel: 180 },
    });
    assertFeasible(r);
    assertTrue(r.breakdown.shift > 0, 'shift should be > 0 (Main Stat → INT)');
    assertEq(r.breakdown.shiftDir, 'up', 'shift direction should be `up`');
  });
  test('Existing Base INT is retained through pre-Swap Fresh HP Wash when MP Washing is unnecessary', () => {
    // Keeping the 110 Base INT supplies enough natural INT-based MP to meet the goal, so the
    // optimizer can skip MP Washing and use a short pre-Swap Fresh HP Wash suffix instead.
    const r = plan({
      class: 'Fighter',
      current: { level: 40, hp: 1500, mp: 800, baseInt: 110, mainStat: 4 },
      goals: { hpGoal: 12000, mpGoal: 3000, targetLevel: 180, swapLevel: 160 },
    });
    assertFeasible(r);
    assertEq(r.breakdown.shift, 0, 'Base INT should not be shifted down before levelling');
    assertEq(r.breakdown.mpWash, 0, 'natural INT-based MP already meets the MP Goal');
    assertEq(r.params.mpWashFirstLevel, null, 'summary should report that MP Wash is not needed');
    assertEq(r.breakdown.intReset, 106, 'all Base INT is moved to STR at the Swap Level');
    assertEq(r.breakdown.phase3Fresh, 25, 'five pre-Swap levels supply the remaining HP');
    assertEq(r.breakdown.staleHPWash, 0, 'fresh washes remove the stale-wash cleanup');
    assertEq(r.apResets, 131, 'only INT reset and pre-Swap Fresh HP Wash resets are needed');
    const phases = phasePlan(CLASSES['Fighter'], r.__state, r.__goals, r);
    assertTrue(phases.some(p => p.phase === 'Pre-Swap Fresh HP Wash' && /Keep Base INT/.test(p.action)),
      'phase plan should retain INT through the pre-Swap Fresh HP Wash');
    const rows = levelTable(CLASSES['Fighter'], r.__state, r.__goals, 40, 1.0, r);
    const beforeSwap = rows.find(row => row.level === 159);
    assertEq(beforeSwap.baseInt, 110, 'Base INT remains available for level-up MP gain');
    assertTrue(beforeSwap.mainStat > 4, 'paired AP Resets build STR before the swap');
  });
  test('Joint INT and fresh-wash search includes Target Base INT gain thresholds', () => {
    const r = plan({
      class: 'Fighter',
      current: { level: 100, hp: 4000, mp: 1500, baseInt: 4, mainStat: 1000 },
      goals: { hpGoal: 25000, mpGoal: 2000, targetLevel: 180, swapLevel: 120 },
    });
    assertFeasible(r);
    assertEq(r.apResets, 572, 'threshold-aware search uses the mixed advancement-level boundary');
    assertEq(r.params.targetBaseInt, 120, 'Target Base INT lands on an MP-gain threshold');
  });
  test('Shift-to-INT search includes distant Base INT gain thresholds', () => {
    const r = plan({
      class: 'Brawler',
      current: { level: 100, hp: 4000, mp: 1500, baseInt: 4, luk: 1000 },
      goals: { hpGoal: 20000, mpGoal: 4000, targetLevel: 180, swapLevel: 120 },
    });
    assertFeasible(r);
    assertEq(r.apResets, 1384, 'complete threshold search keeps the cheaper mixed-boundary strategy');
    assertEq(r.breakdown.shift, 476, 'Base INT lands on the optimal distant threshold');
  });
});

describe('Engine invariants', () => {
  test('Total AP Resets equals sum of breakdown parts', () => {
    const r = plan({ class: 'Assassin', goals: { hpGoal: 30000, mpGoal: 5000, targetLevel: 180 } });
    assertFeasible(r);
    const b = r.breakdown;
    const sum = b.shift + b.mpWash + b.phase3Fresh + b.intReset + b.staleHPWash;
    assertEq(r.apResets, sum, `apResets ${r.apResets} != sum ${sum}`);
  });
  test('Invariant holds for Fighter (Warrior-style plan with fresh HP wash dominant)', () => {
    const r = plan({ class: 'Fighter', goals: { hpGoal: 30000, mpGoal: 2000, targetLevel: 180 } });
    assertFeasible(r);
    const b = r.breakdown;
    assertEq(r.apResets, b.shift + b.mpWash + b.phase3Fresh + b.intReset + b.staleHPWash);
  });
  test('Invariant holds for Magician (no intReset, mostly MP wash)', () => {
    const r = plan({ class: 'Magician', goals: { hpGoal: 5000, mpGoal: 10000, targetLevel: 180 } });
    assertFeasible(r);
    const b = r.breakdown;
    assertEq(r.apResets, b.shift + b.mpWash + b.phase3Fresh + b.intReset + b.staleHPWash);
  });
  test('mpWashStart ≤ mpWashEnd ≤ mpWashStop ≤ targetLevel always', () => {
    const r = plan({ class: 'Assassin', goals: { hpGoal: 30000, mpGoal: 5000, targetLevel: 180 } });
    assertFeasible(r);
    assertTrue(r.params.mpWashStart <= r.params.mpWashStop, 'mpWashStart ≤ mpWashStop');
    assertTrue((r.params.mpWashEnd ?? r.params.mpWashStop) >= r.params.mpWashStart,
      'mpWashStart ≤ mpWashEnd');
    assertTrue((r.params.mpWashEnd ?? r.params.mpWashStop) <= r.params.mpWashStop,
      'mpWashEnd ≤ mpWashStop');
    assertTrue(r.params.mpWashStop <= 180, 'mpWashStop ≤ targetLevel');
  });
  test('Feasible plan with zero INT Gear', () => {
    const r = plan({
      class: 'Assassin',
      goals: { hpGoal: 30000, mpGoal: 5000, targetLevel: 180 },
      gearInt: 0,
    });
    assertFeasible(r);
    assertEq(r.finalHP, 30000);
    assertTrue(r.finalMP >= 5000);
  });
});

describe('Unit tests for helpers', () => {
  test('minMPAtLevel matches Nise per class', () => {
    assertEq(mod.minMPAtLevel(CLASSES['Assassin'], 180), 14 * 180 + 135);
    assertEq(mod.minMPAtLevel(CLASSES['Fighter'], 180), 4 * 180 + 55);
    assertEq(mod.minMPAtLevel(CLASSES['Magician'], 180), 22 * 180 + 449);
    assertEq(mod.minMPAtLevel(CLASSES['Beginner'], 100), 10 * 100 - 5);
  });
  test('minHPAtLevel matches Nise per class', () => {
    assertEq(mod.minHPAtLevel(CLASSES['Assassin'], 180), 20 * 180 + 378);
    assertEq(mod.minHPAtLevel(CLASSES['Fighter'], 180), 24 * 180 + 472);
    assertEq(mod.minHPAtLevel(CLASSES['Spearman'], 180), 24 * 180 + 172);
    assertEq(mod.minHPAtLevel(CLASSES['Magician'], 180), 10 * 180 + 64);
    assertEq(mod.minHPAtLevel(CLASSES['Beginner'], 100), 12 * 100 + 50);
  });

  test('Only 1st and 2nd job advancements grant HP/MP bonuses', () => {
    for (const className of CLASS_ORDER) {
      for (const bonus of CLASSES[className].jaBonuses) {
        assertTrue(bonus.level <= 30, `${className} has no 3rd/4th-job HP/MP bonus`);
      }
    }
  });

  test('3rd and 4th job advancements grant five extra allocatable AP', () => {
    assertEq(mod.freshAPAtLevel(CLASSES['Fighter'], 69), 5, 'ordinary level');
    assertEq(mod.freshAPAtLevel(CLASSES['Fighter'], 70), 10, '3rd job advancement');
    assertEq(mod.freshAPAtLevel(CLASSES['Fighter'], 120), 10, '4th job advancement');
    assertEq(mod.freshAPInRange(CLASSES['Fighter'], 69, 120), 265,
      'range includes both five-AP advancement awards');
    assertEq(mod.freshAPInRange(CLASSES['Beginner'], 69, 120), 255,
      'Beginners do not receive job-advancement AP');
  });

  test('Every first-job family has the MapleLegends level and permanent stat requirement', () => {
    const expected = {
      'Assassin': [10, 'DEX', 25], 'Bandit': [10, 'DEX', 25],
      'Hunter': [10, 'DEX', 25], 'Crossbowman': [10, 'DEX', 25],
      'Gunslinger': [10, 'DEX', 20], 'Brawler': [10, 'DEX', 20],
      'Fighter': [10, 'STR', 35], 'Spearman': [10, 'STR', 35],
      'Page': [10, 'STR', 35], 'Magician': [8, 'INT', 20],
    };
    for (const [className, values] of Object.entries(expected)) {
      const requirement = CLASSES[className].firstJobRequirement;
      assertEq(requirement.level, values[0], `${className} advancement level`);
      assertEq(requirement.stat, values[1], `${className} advancement stat`);
      assertEq(requirement.minimum, values[2], `${className} advancement minimum`);
    }
    assertEq(CLASSES.Beginner.firstJobRequirement, null, 'Beginner has no requirement');
  });

  test('Required non-INT AP is reserved before washing while required Mage INT remains useful', () => {
    const fresh = { level: 1, hp: 50, mp: 5, str: 4, dex: 4, luk: 4, baseInt: 13 };
    const cases = [
      ['Assassin', 21, 24],
      ['Hunter', 21, 24],
      ['Brawler', 16, 29],
      ['Fighter', 31, 14],
    ];
    for (const [className, requiredAP, usableThroughAdvancement] of cases) {
      const cls = CLASSES[className];
      const advancementLevel = cls.firstJobRequirement.level;
      const scheduled = Array.from({ length: advancementLevel - 1 }, (_, i) => i + 2)
        .reduce((sum, level) => sum
          + mod.firstJobRequirementAPAtLevel(cls, fresh, level), 0);
      assertEq(mod.firstJobAPNeeded(cls, fresh), requiredAP, `${className} AP needed`);
      assertEq(scheduled, requiredAP, `${className} AP scheduled by advancement`);
      assertEq(mod.usableFreshAPInRange(cls, fresh, 1, advancementLevel),
        usableThroughAdvancement, `${className} remaining AP budget`);
    }
    assertEq(mod.firstJobAPNeeded(CLASSES.Magician, fresh), 7, 'Mage needs 7 more INT');
    assertEq(mod.usableFreshAPInRange(CLASSES.Magician, fresh, 1, 8), 35,
      'Mage job INT remains part of the usable Base INT build');
  });

  test('An advanced character below its permanent first-job stat floor is rejected', () => {
    const cases = [
      ['Assassin', { dex: 24 }, 'DEX cannot be below 25'],
      ['Hunter', { dex: 24 }, 'DEX cannot be below 25'],
      ['Brawler', { dex: 19 }, 'DEX cannot be below 20'],
      ['Fighter', { str: 34 }, 'STR cannot be below 35'],
      ['Magician', { baseInt: 19 }, 'INT cannot be below 20'],
    ];
    for (const [className, stat, reason] of cases) {
      const current = Object.assign(
        { level: 30, hp: 1000, mp: 1000, str: 4, dex: 4, luk: 4, baseInt: 20 },
        stat
      );
      const result = optimize(CLASSES[className], current,
        { hpGoal: 10000, mpGoal: 5000, targetLevel: 180, swapLevel: 120 },
        40, 1.0);
      assertInfeasible(result, reason);
    }
  });
});

describe('phasePlan output shape', () => {
  test('Assassin plan emits Build Base INT → MP Wash → Stale HP Wash → Reset Base INT', () => {
    const r = plan({ class: 'Assassin', goals: { hpGoal: 30000, mpGoal: 5000, targetLevel: 180 } });
    assertFeasible(r);
    const phases = phasePlan(r.params && CLASSES[r.params.className || 'Assassin'] || CLASSES['Assassin'], { level: 1, hp: 50, mp: 5, baseInt: 4, mainStat: 4 }, { hpGoal: 30000, mpGoal: 5000, targetLevel: 180 }, r);
    const phaseNames = phases.map(p => p.phase);
    assertTrue(phaseNames.includes('Build Base INT'), 'has Build Base INT phase');
    assertTrue(phaseNames.includes('MP Wash'), 'has MP Wash phase');
    assertTrue(phaseNames.some(name => name === 'Reset Base INT' || /Reset INT$/.test(name)),
      'has a Base INT reset phase');
  });
  test('Magician plan does not have a Reset Base INT phase', () => {
    const r = plan({ class: 'Magician', goals: { hpGoal: 5000, mpGoal: 10000, targetLevel: 180 } });
    assertFeasible(r);
    const phases = phasePlan(CLASSES['Magician'], { level: 1, hp: 50, mp: 5, baseInt: 4, mainStat: 4 }, { hpGoal: 5000, mpGoal: 10000, targetLevel: 180 }, r);
    const phaseNames = phases.map(p => p.phase);
    assertTrue(!phaseNames.includes('Reset Base INT'), 'Mages should not Reset Base INT');
  });

  test('Magician uses the correct pre-2nd-job MP floor', () => {
    assertEq(mod.minMPAtLevel(CLASSES.Magician, 20), 22 * 20 - 1,
      '1st-job Mage minimum MP');
    assertEq(mod.minMPAtLevel(CLASSES.Magician, 30), 22 * 30 + 449,
      '2nd-job Mage minimum MP');
  });

  test('Magician early MaxMP correction matches Krythan projection', () => {
    assertEq(mod.naturalMPGainAtLevel(CLASSES.Magician, 9), 33);
    assertEq(mod.naturalMPGainAtLevel(CLASSES.Magician, 11), 33);
    assertEq(mod.naturalMPGainAtLevel(CLASSES.Magician, 12), 43);
  });
});

describe('levelTable output', () => {
  test('Has one row per level from current to target inclusive', () => {
    const r = plan({ class: 'Assassin', goals: { hpGoal: 30000, mpGoal: 5000, targetLevel: 180 } });
    assertFeasible(r);
    const rows = levelTable(CLASSES['Assassin'], { level: 1, hp: 50, mp: 5, baseInt: 4, mainStat: 4 }, { hpGoal: 30000, mpGoal: 5000, targetLevel: 180 }, 40, 1.0, r);
    assertEq(rows.length, 180, '180 rows for levels 1-180');
    assertEq(rows[0].level, 1);
    assertEq(rows[rows.length - 1].level, 180);
  });
  test('Cumulative AP Resets monotone non-decreasing', () => {
    const r = plan({ class: 'Assassin', goals: { hpGoal: 30000, mpGoal: 5000, targetLevel: 180 } });
    assertFeasible(r);
    const rows = levelTable(CLASSES['Assassin'], { level: 1, hp: 50, mp: 5, baseInt: 4, mainStat: 4 }, { hpGoal: 30000, mpGoal: 5000, targetLevel: 180 }, 40, 1.0, r);
    for (let i = 1; i < rows.length; i++) {
      assertTrue(rows[i].cumulativeResets >= rows[i-1].cumulativeResets, `non-decreasing at row ${i}`);
    }
  });
  test('HP is monotone non-decreasing across levels', () => {
    const r = plan({ class: 'Assassin', goals: { hpGoal: 30000, mpGoal: 5000, targetLevel: 180 } });
    assertFeasible(r);
    const rows = levelTable(CLASSES['Assassin'], { level: 1, hp: 50, mp: 5, baseInt: 4, mainStat: 4 }, { hpGoal: 30000, mpGoal: 5000, targetLevel: 180 }, 40, 1.0, r);
    for (let i = 1; i < rows.length; i++) {
      assertTrue(rows[i].hp >= rows[i-1].hp, `HP non-decreasing at row ${i}`);
    }
  });
  test('Final-row HP matches the summary finalHP exactly (analytical and per-level paths unified)', () => {
    const r = plan({ class: 'Assassin', goals: { hpGoal: 30000, mpGoal: 5000, targetLevel: 180 } });
    assertFeasible(r);
    const rows = levelTable(CLASSES['Assassin'], { level: 1, hp: 50, mp: 5, baseInt: 4, mainStat: 4 }, { hpGoal: 30000, mpGoal: 5000, targetLevel: 180 }, 40, 1.0, r);
    const lastRow = rows[rows.length - 1];
    // Both code paths now go through the same per-level math — no tolerance needed.
    assertEq(lastRow.hp, r.finalHP, `last row HP ${lastRow.hp} vs summary ${r.finalHP}`);
  });
  test('Final-row MP matches the summary finalMP exactly', () => {
    const r = plan({ class: 'Assassin', goals: { hpGoal: 30000, mpGoal: 5000, targetLevel: 180 } });
    assertFeasible(r);
    const rows = levelTable(CLASSES['Assassin'], { level: 1, hp: 50, mp: 5, baseInt: 4, mainStat: 4 }, { hpGoal: 30000, mpGoal: 5000, targetLevel: 180 }, 40, 1.0, r);
    const lastRow = rows[rows.length - 1];
    assertEq(lastRow.mp, r.finalMP, `last row MP ${lastRow.mp} vs summary ${r.finalMP}`);
  });
});

describe('Optimizer determinism', () => {
  test('Same inputs yield identical results on re-run', () => {
    const inputs = { class: 'Assassin', goals: { hpGoal: 30000, mpGoal: 5000, targetLevel: 180 } };
    const r1 = plan(inputs);
    const r2 = plan(inputs);
    assertEq(r1.apResets, r2.apResets);
    assertEq(r1.params.targetBaseInt, r2.params.targetBaseInt);
    assertEq(r1.params.mpWashStart, r2.params.mpWashStart);
    assertEq(r1.params.mpWashStop, r2.params.mpWashStop);
  });
});

// ────────────────────────── boundary cases ──────────────────────────

describe('Boundary cases', () => {
  test('Final HP equals exactly 30,000 when HP Goal is 30k (cap saturates)', () => {
    const r = plan({ class: 'Assassin', goals: { hpGoal: 30000, mpGoal: 5000, targetLevel: 180 } });
    assertFeasible(r);
    assertEq(r.finalHP, 30000, 'finalHP must equal the cap');
  });

  test('Final MP is capped at 30,000', () => {
    const r = plan({ class: 'Magician', goals: { hpGoal: 2200, mpGoal: 25000, targetLevel: 180 } });
    assertFeasible(r);
    assertTrue(r.finalMP <= 30000, 'finalMP must not exceed cap');
    assertTrue(r.params.mpEndPhase3 <= 30000, 'intermediate MP also respects cap');
  });

  test('MP Goal exactly at Min MP is feasible', () => {
    // Min MP for NL at lvl 180 = 14*180 + 135 = 2655.
    const r = plan({ class: 'Assassin', goals: { hpGoal: 5000, mpGoal: 2655, targetLevel: 180 } });
    assertFeasible(r);
    assertTrue(r.finalMP >= 2655);
  });

  test('Current Level == Target Level is infeasible', () => {
    const r = plan({ class: 'Assassin', current: { level: 135, hp: 10000, mp: 2000 }, goals: { hpGoal: 30000, mpGoal: 5000, targetLevel: 135 } });
    assertInfeasible(r, 'target level');
  });

  test('Mid-progress current state typically costs less than a fresh start', () => {
    // Mid-progress at lvl 100 with some existing HP/MP/INT should be ≤ fresh-start cost.
    const fresh = plan({ class: 'Assassin', goals: { hpGoal: 30000, mpGoal: 5000, targetLevel: 180 } });
    const mid = plan({
      class: 'Assassin',
      current: { level: 100, hp: 5000, mp: 3000, baseInt: 200, mainStat: 300 },
      goals: { hpGoal: 30000, mpGoal: 5000, targetLevel: 180 },
    });
    assertFeasible(fresh);
    assertFeasible(mid);
    assertTrue(mid.apResets <= fresh.apResets * 1.1, 'mid-progress shouldnt explode the cost');
  });
});

// ────────────────────────── infeasibility cases ──────────────────────────

describe('Infeasibility detection', () => {
  test('Magician requesting 30k HP at lvl 50 hits the HP ceiling', () => {
    // mpGoal must clear the class MP floor at lvl 50 (1549), or the MP-floor branch fires first and
    // this becomes a duplicate of the Brawler test below rather than an HP-ceiling test.
    const r = plan({ class: 'Magician', goals: { hpGoal: 30000, mpGoal: 1600, targetLevel: 50 }, gearInt: 0 });
    assertInfeasible(r, 'most HP reachable');
  });

  test('HP Goal below the class Min HP is rejected with the floor named', () => {
    const r = plan({ class: 'Fighter', goals: { hpGoal: 100, mpGoal: 2000, targetLevel: 180 } });
    assertInfeasible(r, 'below the minimum possible HP');
  });

  test('A character too far past the first job advancement to meet its requirement is rejected', () => {
    // Lvl 9 with 4 STR: one level of AP left (5) against the 31 STR the Warrior advancement needs.
    const r = plan({
      class: 'Fighter',
      current: { level: 9, hp: 400, mp: 100, str: 4, dex: 4, luk: 4, baseInt: 4 },
      goals: { hpGoal: 5000, mpGoal: 500, targetLevel: 60 },
    });
    assertInfeasible(r, 'not enough AP remaining to reach 35 STR');
  });

  test('An unreachable HP Goal names the HP reached, not a negative MP', () => {
    // Regression: the cleanup wash count is what the HP Goal *demands*, so an unreachable goal used
    // to surface as "Final MP (-18963) would be below Min MP (1115)" — a symptom, and the number
    // was nonsense. Every candidate must now report the HP its MP can actually pay for.
    const r = plan({ class: 'Assassin', goals: { hpGoal: 30000, mpGoal: 4000, targetLevel: 70 } });
    assertInfeasible(r, 'most HP reachable');
    assertTrue(!/Final MP/.test(r.reason), `should not surface a per-candidate MP failure: "${r.reason}"`);
    const reached = Number(r.reason.match(/is about ([\d,]+)/)[1].replace(/,/g, ''));
    assertInRange(reached, 1, 30000, 'the reported HP ceiling is a real HP value');
  });

  test('An MP Goal beyond what the plan can generate reports the MP reached', () => {
    const r = plan({ class: 'Fighter', goals: { hpGoal: 20000, mpGoal: 25000, targetLevel: 120 } });
    assertInfeasible(r, 'most MP reachable');
  });

  test('MP Goal below class Min MP is infeasible with explicit reason', () => {
    // Brawler Min MP at lvl 180 = 18*180 + 95 = 3335.
    const r = plan({ class: 'Brawler', goals: { hpGoal: 30000, mpGoal: 1000, targetLevel: 180 } });
    assertInfeasible(r, 'minimum possible MP');
  });

  test('Target Level less than Current Level is infeasible', () => {
    const r = plan({
      class: 'Hunter',
      current: { level: 100 },
      goals: { hpGoal: 30000, mpGoal: 5000, targetLevel: 80 },
    });
    assertInfeasible(r);
  });

  test('HP Goal > 30,000 is rejected upfront', () => {
    const r = plan({ class: 'Assassin', goals: { hpGoal: 35000, mpGoal: 5000, targetLevel: 180 } });
    assertInfeasible(r, '30,000 HP cap');
  });

  test('MP Goal > 30,000 is rejected upfront', () => {
    const r = plan({ class: 'Magician', goals: { hpGoal: 5000, mpGoal: 35000, targetLevel: 180 } });
    assertInfeasible(r, '30,000 MP cap');
  });

  test('Negative HP Goal is rejected', () => {
    const r = plan({ class: 'Assassin', goals: { hpGoal: -1, mpGoal: 5000, targetLevel: 180 } });
    assertInfeasible(r, '≥ 0');
  });

  test('Negative MP Goal is rejected', () => {
    const r = plan({ class: 'Assassin', goals: { hpGoal: 30000, mpGoal: -1, targetLevel: 180 } });
    assertInfeasible(r, '≥ 0');
  });

  test('Out-of-range Current Level is rejected', () => {
    const r = plan({ class: 'Assassin', current: { level: 0 }, goals: { hpGoal: 5000, mpGoal: 3000, targetLevel: 180 } });
    assertInfeasible(r, 'Current Level');
  });

  test('Out-of-range Target Level is rejected', () => {
    const r = plan({ class: 'Assassin', goals: { hpGoal: 5000, mpGoal: 3000, targetLevel: 250 } });
    assertInfeasible(r, 'Target Level');
  });

  test('A candidate whose peak MP breaches the 30k cap is rejected by name', () => {
    // Driven through evaluateStrategy rather than optimize: the whole point of the filter is that
    // optimize never returns such a candidate, so the only way to see the rejection is to hand it
    // one. Target Base INT 400 on an Assassin washing 20->180 peaks at ~34.3k MP.
    const cd = CLASSES['Assassin'];
    const cur = { level: 1, hp: 50, mp: 5, str: 4, dex: 4, luk: 4, baseInt: 4 };
    const goals = { hpGoal: 5000, mpGoal: 3000, targetLevel: 180, swapLevel: 180 };
    const ranges = mod.precomputeRanges(cd, cur.level, goals.targetLevel);
    const params = {
      targetBaseInt: 400, mpWashStart: 20, mpWashEnd: 180, mpWashStop: 180, shift: 0,
      preSwapFreshAtBoundary: 0, swapSeedFreshHPResets: 0,
      phase3FreshHPResets: 0, staleHPPerLevelPhase3: 0,
    };
    const over = mod.evaluateStrategy(cd, cur, goals, 40, 1.0, params, ranges);
    assertTrue(!over.feasible, 'the over-cap candidate must be rejected');
    assertTrue(/overshoots the 30,000 MP cap/.test(over.reason),
      `expected the MP-cap reason, got: "${over.reason}"`);
    // Same shape at a Target Base INT that fits: the filter is selective, not blanket.
    const under = mod.evaluateStrategy(cd, cur, goals, 40, 1.0,
      Object.assign({}, params, { targetBaseInt: 200 }), ranges);
    assertTrue(under.feasible, `the in-cap candidate should survive, got: "${under.reason}"`);
  });

  test('Plans overshooting the 30k MP cap are filtered out', () => {
    // A Mage with low HP goal (just at Min HP) and small MP goal — high INT would overshoot MP cap.
    // Mage Min HP at lvl 180 is 1864, so use 2000.
    const r = plan({ class: 'Magician', goals: { hpGoal: 2000, mpGoal: 5000, targetLevel: 180 } });
    assertFeasible(r);
    assertTrue(r.params.mpEndPhase3 <= 30000, 'mpEndPhase3 must respect 30k cap');
  });
});

// ────────────────────────── wash-math primitives ──────────────────────────

describe('Wash-math primitives', () => {
  test('washCycleMP for NL at INT 200 = 28 - 12 = 8 MP per cycle', () => {
    // NL: freshAPMPBase=10, mpLossPerReset=12 → deficit=2. floor(200/10) - 2 = 18.
    assertEq(mod.washCycleMP(CLASSES['Assassin'], 200), 18);
  });
  test('washCycleMP for Mage at INT 300 = floor(30) + 8 = 38', () => {
    // Mage: freshAPMPBase=38, mpLossPerReset=30 → deficit=-8. floor(300/10) - (-8) = 38.
    assertEq(mod.washCycleMP(CLASSES['Magician'], 300), 38);
  });
  test('freshHPWashYield for Fighter (52 HP per fresh AP) × 10 = 520', () => {
    assertEq(mod.freshHPWashYield(CLASSES['Fighter'], 10), 520);
  });
  test('staleHPWashYield for Mage (6 HP per reset) × 100 = 600', () => {
    assertEq(mod.staleHPWashYield(CLASSES['Magician'], 100), 600);
  });
  test('washCycleMPCost for NL (12 MP per reset) × 50 = 600', () => {
    assertEq(mod.washCycleMPCost(CLASSES['Assassin'], 50), 600);
  });
});

// ────────────────────────── phase steps in isolation ──────────────────────────

describe('Phase steps in isolation', () => {
  test('runPhase1 builds INT from currentBaseInt+shift to phase1EndInt over fresh AP', () => {
    const cur = { level: 4, hp: 50, mp: 5, str: 4, dex: 4, luk: 4, baseInt: 4 };
    const params = { mpWashStart: 14, shift: 0, targetBaseInt: 100 };  // 10 levels of Phase 1
    const p1 = mod.runPhase1(CLASSES['Assassin'], cur, params, 0, 1.0);
    // Of the 50 fresh AP, 21 must first raise DEX from 4 to the permanent thief floor of 25.
    // The remaining 29 build INT: 4 + 29 = 33.
    assertEq(p1.startBaseInt, 4);
    assertEq(p1.phase1EndInt, 33);
    assertTrue(p1.mpFromInt >= 0, 'INT-driven MP is non-negative');
  });
  test('runPhase2 includes the extra advancement AP at levels 70 and 120', () => {
    const params = { mpWashStart: 60, mpWashStop: 145, targetBaseInt: 300 };
    const phase1 = { phase1EndInt: 300 };  // already at target, plateau-only Phase 2
    const p2 = mod.runPhase2(CLASSES['Assassin'], params, phase1, 40, 1.0);
    assertEq(p2.phase2APResets, mod.freshAPInRange(CLASSES['Assassin'], 60, 145));
    assertEq(p2.intResetsInPhase2, 0, 'INT already at target');
    assertEq(p2.phase2PlateauLevels, 145 - 60, 'all Phase 2 is plateau');
  });
  test('Mage MP-wash start level AP is not also counted in the INT-build phase', () => {
    const cur = { level: 1, hp: 50, mp: 5, str: 4, dex: 4, luk: 4, baseInt: 13 };
    const params = { mpWashStart: 70, mpWashStop: 131, shift: 0, targetBaseInt: 918 };
    const p1 = mod.runPhase1(CLASSES.Magician, cur, params, 40, 1.0);
    assertEq(p1.phase1EndInt, 353,
      'level 70 fresh/advancement AP belongs only to the MP-wash phase');
    const p2 = mod.runPhase2(CLASSES.Magician, params, p1, 40, 1.0, cur);
    assertEq(p2.phase2APResets, 320,
      'levels 70-131 supply 320 fresh AP before a boundary split');
    assertEq(p2.phase2EndInt, 673,
      'all washed AP return to INT exactly once');
  });
  test('runPhase3 with both fresh and stale wash combines yields', () => {
    const params = { mpWashStop: 145, targetBaseInt: 300, phase3FreshHPResets: 105, staleHPPerLevelPhase3: 2 };
    const goals = { hpGoal: 30000, mpGoal: 5000, targetLevel: 180 };
    const p3 = mod.runPhase3(CLASSES['Assassin'], params, goals, 40, 1.0);
    assertEq(p3.phase3FreshHPResets, 35 * 3);  // 35 levels × 3 fresh per level
    assertEq(p3.phase3StaleHPResets, 35 * 2);  // 35 levels × 2 stale per level
    // NL freshAPHP=18, staleAPHP=16. Fresh yield = 105*18 = 1890. Stale yield = 70*16 = 1120.
    assertEq(p3.hpFromFresh, 105 * 18);
    assertEq(p3.hpFromStale, 70 * 16);
  });
  test('runCleanup fills HP gap with stale wash; skips INT reset for Mages', () => {
    const goals = { hpGoal: 5000, mpGoal: 4000, targetLevel: 180 };
    const mageCleanup = mod.runCleanup(CLASSES['Magician'], 2000, 10000, goals, 300);
    assertEq(mageCleanup.intResetAPResets, 0, 'Mage skips INT reset');
    // HP gap 3000 / staleAPHP 6 = 500 stale resets
    assertEq(mageCleanup.cleanupStaleHPWash, 500);
    const nlCleanup = mod.runCleanup(CLASSES['Assassin'], 2000, 10000, goals, 300);
    assertEq(nlCleanup.intResetAPResets, 300 - 4, 'NL resets INT back to 4');
  });
});

// ────────────────────────── prepareInputs clamping ──────────────────────────

describe('prepareInputs clamps Goals only (not Current HP/MP)', () => {
  test('HP Goal below Min HP at target is clamped to the floor with a note', () => {
    const cur = { level: 100, hp: 5000, mp: 2000, str: 4, dex: 4, luk: 4, baseInt: 4 };
    const goals = { hpGoal: 100, mpGoal: 5000, targetLevel: 180 };
    const notes = prepareInputs(CLASSES['Assassin'], cur, goals, 'Assassin');
    // NL Min HP at lvl 180 = 20*180 + 378 = 3978
    assertEq(goals.hpGoal, 3978, 'HP Goal clamped to Min HP at target');
    const note = notes.find(n => n.fieldId === 'i-hp-goal');
    assertTrue(note, 'note recorded for HP Goal');
    assertEq(note.clamped, 3978);
    assertEq(note.atLevel, 180);
  });
  test('MP Goal below Min MP at target is clamped to the floor with a note', () => {
    const cur = { level: 100, hp: 5000, mp: 2000, str: 4, dex: 4, luk: 4, baseInt: 4 };
    const goals = { hpGoal: 30000, mpGoal: 100, targetLevel: 180 };
    const notes = prepareInputs(CLASSES['Assassin'], cur, goals, 'Assassin');
    // NL Min MP at lvl 180 = 14*180 + 135 = 2655
    assertEq(goals.mpGoal, 2655, 'MP Goal clamped to Min MP at target');
    const note = notes.find(n => n.fieldId === 'i-mp-goal');
    assertTrue(note, 'note recorded for MP Goal');
    assertEq(note.clamped, 2655);
  });
  test('Current HP/MP below Min are NOT clamped (legitimate pre-2nd-JA state)', () => {
    // Lvl 1 NL: HP 50 / MP 5 from game start, well below NL's post-2nd-JA Min HP/MP formulas.
    // These values must pass through untouched — pre-advancement state is real.
    const cur = { level: 1, hp: 50, mp: 5, str: 4, dex: 4, luk: 4, baseInt: 4 };
    const goals = { hpGoal: 30000, mpGoal: 5000, targetLevel: 180 };
    const notes = prepareInputs(CLASSES['Assassin'], cur, goals, 'Assassin');
    assertEq(cur.hp, 50, 'Current HP unchanged');
    assertEq(cur.mp, 5, 'Current MP unchanged');
    assertTrue(!notes.find(n => n.fieldId === 'i-cur-hp'), 'no Current HP note');
    assertTrue(!notes.find(n => n.fieldId === 'i-cur-mp'), 'no Current MP note');
  });
  test('Above-Min values are not clamped and produce no notes', () => {
    const cur = { level: 100, hp: 5000, mp: 2000, str: 4, dex: 4, luk: 4, baseInt: 4 };
    const goals = { hpGoal: 30000, mpGoal: 5000, targetLevel: 180 };
    const notes = prepareInputs(CLASSES['Assassin'], cur, goals, 'Assassin');
    assertEq(notes.length, 0, 'no notes');
  });
});

// ────────────────────────── Mage MP-cap HP wash ──────────────────────────

describe('Mage MP-cap HP wash (Krythan endgame)', () => {
  test('Mage 30k MP + moderate HP is feasible (was wrongly rejected before)', () => {
    const r = plan({ class: 'Magician', goals: { hpGoal: 6000, mpGoal: 30000, targetLevel: 180 }, gearInt: 40 });
    assertFeasible(r);
    assertTrue(r.params.capWash === true, 'uses cap-wash path');
    assertTrue(r.finalMP >= 30000, 'reaches 30k MP');
    assertTrue(r.finalMP <= 30000, 'MP capped at 30k');
    assertTrue(r.finalHP >= 6000, 'HP goal met');
  });
  test('Mage 30k MP HP ceiling is ~8000 without equips/challenges (Krythan ~7700)', () => {
    const feasible = plan({ class: 'Magician', goals: { hpGoal: 8000, mpGoal: 30000, targetLevel: 180 }, gearInt: 40 });
    assertFeasible(feasible);
    // 10000 HP exceeds the Mage's natural+wash ceiling at 30k MP (only reachable with HP equips/challenges).
    const tooHigh = plan({ class: 'Magician', goals: { hpGoal: 10000, mpGoal: 30000, targetLevel: 180 }, gearInt: 40 });
    assertInfeasible(tooHigh, 'most HP reachable');
    // Pin the ceiling itself. A ±12% drift used to pass, because 8,000 feasible / 10,000 infeasible
    // is a 2,000 HP bracket. Krythan's sheet shows ~7,700 without gear INT; ours reports 8,998 with
    // 40 INT of gear, which is the same ballpark from a more generous starting point.
    const ceiling = Number(tooHigh.reason.match(/is about ([\d,]+)/)[1].replace(/,/g, ''));
    assertInRange(ceiling, 8900, 9100, 'reported Mage HP ceiling at 30k MP');
  });
  test('Cap-wash apResets = mpWash + capWashes + intReset(0 for Mage) + shift', () => {
    const r = plan({ class: 'Magician', goals: { hpGoal: 6000, mpGoal: 30000, targetLevel: 180 }, gearInt: 40 });
    assertFeasible(r);
    const b = r.breakdown;
    assertEq(b.intReset, 0, 'Mage never resets INT');
    assertEq(r.apResets, b.shift + b.mpWash + b.phase3Fresh + b.intReset + b.staleHPWash);
  });
  test('Post-cap fresh AP is MP-washed back into INT and counted as resets', () => {
    const r = plan({ class: 'Magician', goals: { hpGoal: 6000, mpGoal: 30000, targetLevel: 180 }, gearInt: 40 });
    assertFeasible(r);
    const expectedPostCap = mod.usableFreshAPInRange(CLASSES.Magician, r.__state,
      r.params.mpWashStop, r.__goals.targetLevel);
    assertEq(r.params.phase3MPWashResets, expectedPostCap,
      'every post-cap fresh AP is restored to INT');
    assertEq(r.breakdown.mpWash,
      r.params.phase2MPWashResets + r.params.phase3MPWashResets,
      'MP Wash breakdown includes both sides of the cap transition');
    const rows = levelTable(CLASSES.Magician, r.__state, r.__goals, 40, 1.0, r);
    const last = rows.at(-1);
    assertEq(last.baseInt, r.__state.baseInt + r.breakdown.shift
      + mod.usableFreshAPInRange(CLASSES.Magician, r.__state,
        r.__state.level, r.__goals.targetLevel),
    'all fresh AP and any pre-game shift finish in INT');
    assertEq(last.cumulativeResets, r.apResets,
      'level table schedules every Mage reset');
  });
  test('Cap-wash level table final row reconciles with the summary exactly', () => {
    const r = plan({ class: 'Magician', goals: { hpGoal: 6000, mpGoal: 30000, targetLevel: 180 }, gearInt: 40 });
    assertFeasible(r);
    const rows = levelTable(CLASSES['Magician'], { level: 1, hp: 50, mp: 5, str: 4, dex: 4, luk: 4, baseInt: 4 }, { hpGoal: 6000, mpGoal: 30000, targetLevel: 180 }, 40, 1.0, r);
    const last = rows[rows.length - 1];
    // Exact, not tolerant. `optimize` reports the walk's own numbers (see ADR 0001), so any drift
    // here means the summary and the table have come apart — the one thing that must never happen.
    // The old ±300 MP / ±2% HP slack would have hidden it; the measured delta is 0.
    assertEq(last.mp, r.finalMP, 'last row MP matches the summary');
    assertEq(last.hp, r.finalHP, 'last row HP matches the summary');
  });
});

// ────────────────────────── Phase 3 stale-wash absorption ──────────────────────────

describe('Phase 3 stale-wash and peak MP cap', () => {
  test('Optimizer can stop MP Washing early and Fresh HP Wash before the Swap Level', () => {
    const r = plan({
      class: 'Spearman',
      current: { level: 40, hp: 1000, mp: 300, str: 4, dex: 4, luk: 4, baseInt: 200 },
      goals: { hpGoal: 30000, mpGoal: 4000, targetLevel: 200, swapLevel: 135 },
    });
    assertFeasible(r);
    assertTrue(r.params.preSwapFreshHPResets > 0, 'uses pre-Swap Fresh HP Washes');
    assertTrue(r.params.mpWashEnd < r.params.mpWashStop, 'MP Wash ends before the swap');
    assertTrue(r.apResets < 708, 'pre-Swap fresh washes improve on the post-Swap-only plan');

    const rows = levelTable(CLASSES['Spearman'], r.__state, r.__goals, 40, 1.0, r);
    const firstPreSwap = rows.find(row => row.level > r.params.mpWashEnd && row.level <= 135);
    assertEq(firstPreSwap.phase, 'Pre-Swap Fresh HP Wash', 'Fresh HP Wash follows the MP Wash phase');
    assertEq(firstPreSwap.freshHPWashesThisLevel, 5, 'all five fresh AP go to HP');
    assertEq(firstPreSwap.baseInt, r.params.targetBaseInt, 'Base INT is retained during pre-Swap washing');
    assertEq(rows.find(row => row.level === 135).baseInt, 4, 'Base INT resets at the user Swap Level');
    assertEq(rows.at(-1).cumulativeResets, r.apResets, 'level walk reconciles all AP Resets');
  });

  test('Fresh HP Wash breakdown includes both pre- and post-Swap washes', () => {
    const r = plan({
      class: 'Spearman',
      current: { level: 40, hp: 1000, mp: 300, str: 4, dex: 4, luk: 4, baseInt: 200 },
      goals: { hpGoal: 30000, mpGoal: 4000, targetLevel: 200, swapLevel: 135 },
    });
    assertFeasible(r);
    assertEq(r.breakdown.phase3Fresh,
      r.params.preSwapFreshHPResets + r.params.phase3FreshHPResets,
      'summary counts every Fresh HP Wash');
    const phases = phasePlan(CLASSES['Spearman'], r.__state, r.__goals, r);
    assertTrue(phases.some(p => p.phase === 'Pre-Swap Fresh HP Wash'),
      'Phase Plan names the pre-Swap phase');
  });

  test('Spearman reference plan uses the exact pre-Swap Fresh HP Wash count', () => {
    const r = plan({
      class: 'Spearman',
      current: { level: 40, hp: 1000, mp: 300, str: 4, dex: 4, luk: 4, baseInt: 200 },
      goals: { hpGoal: 30000, mpGoal: 4000, targetLevel: 200, swapLevel: 135 },
    });
    assertFeasible(r);
    assertEq(r.apResets, 650, 'advancement AP and mixed-boundary washing reduce the plan cost');
    assertEq(r.breakdown.mpWash, 89, 'the exact MP-Wash AP count is used');
    assertEq(r.breakdown.phase3Fresh, 355, '71 levels of fresh AP are washed into HP');
    assertEq(r.breakdown.staleHPWash, 0, 'fresh washes remove the need for stale washes');

    const rows = levelTable(CLASSES['Spearman'], r.__state, r.__goals, 40, 1.0, r);
    const transition = rows.find(x => x.level === 70);
    assertEq(transition.phase, 'MP Wash + Pre-Swap Fresh HP Wash',
      'level 70 is the mixed transition level');
    assertEq(transition.mpWashesThisLevel, 4, 'four advancement-level AP go to MP');
    assertEq(transition.freshHPWashesThisLevel, 6, 'six advancement-level AP go to HP');
    for (let level = 71; level <= 134; level++) {
      const row = rows.find(x => x.level === level);
      assertEq(row.phase, 'Pre-Swap Fresh HP Wash', `lvl ${level} uses pre-Swap Fresh HP Wash`);
      assertEq(row.freshHPWashesThisLevel, mod.freshAPAtLevel(CLASSES['Spearman'], level),
        `lvl ${level} uses every available fresh AP`);
    }
    assertEq(rows.find(x => x.level === 135).freshHPWashesThisLevel, 5,
      'Swap Level also uses all 5 fresh AP before resetting INT');
    assertEq(rows.find(x => x.level === 135).phase, 'Fresh HP Wash + Reset INT',
      'Swap row shows both operations');
  });

  test('Fresh HP Washes wait when frontloading would cross Minimum MP', () => {
    const r = plan({
      class: 'Assassin',
      current: { baseInt: 13 },
      goals: { hpGoal: 8000, mpGoal: 2655, targetLevel: 180, swapLevel: 40 },
    });
    assertFeasible(r);
    const rows = levelTable(CLASSES['Assassin'], r.__state, r.__goals, 40, 1.0, r);
    for (const row of rows) {
      if (row.resetsThisLevel > 0 && row.level >= 30) {
        assertTrue(row.mp >= mod.minMPAtLevel(CLASSES['Assassin'], row.level),
          `lvl ${row.level} MP ${row.mp} stays above Minimum MP`);
      }
    }
    assertEq(rows.find(x => x.level === 70).freshHPWashesThisLevel, 9,
      'lvl 70 leaves one AP unwashed to preserve Minimum MP');
    assertEq(rows.find(x => x.level === 71).freshHPWashesThisLevel, 0,
      'lvl 71 waits because another wash would cross Minimum MP');
    assertEq(rows.find(x => x.level === 72).freshHPWashesThisLevel, 1,
      'lvl 72 schedules the final wash after natural MP restores headroom');
    assertEq(rows.reduce((sum, row) => sum + row.freshHPWashesThisLevel, 0),
      r.breakdown.phase3Fresh, 'every planned fresh wash is eventually scheduled');
  });

  test('Fresh-wash candidates include the count needed to absorb the MP cap', () => {
    const r = plan({
      class: 'Fighter',
      current: { level: 160, hp: 10000, mp: 29980 },
      goals: { hpGoal: 12100, mpGoal: 29000, targetLevel: 180, swapLevel: 160 },
    });
    assertFeasible(r);
    assertEq(r.breakdown.phase3Fresh, 40, 'fresh washes absorb otherwise capped MP growth');
    assertEq(r.finalMP, 30000, 'final MP respects the cap');
  });

  test('HP at Swap Level is clamped to 30,000', () => {
    const r = plan({
      class: 'Fighter',
      current: { level: 160, hp: 29900, mp: 10000 },
      goals: { hpGoal: 30000, mpGoal: 1000, targetLevel: 180, swapLevel: 170 },
    });
    assertFeasible(r);
    assertEq(r.params.hpAtSwap, 30000, 'summary HP is capped');
    const rows = levelTable(CLASSES['Fighter'], r.__state, r.__goals, 40, 1.0, r);
    assertEq(rows.find(x => x.level === 170).hp, 30000, 'table HP matches summary at swap');
  });

  test('Partial fresh-wash levels allocate remaining AP to Main Stat in the Phase Plan', () => {
    const r = plan({
      class: 'Assassin',
      current: { baseInt: 13 },
      goals: { hpGoal: 8000, mpGoal: 2655, targetLevel: 180, swapLevel: 40 },
    });
    assertFeasible(r);
    const phases = phasePlan(CLASSES['Assassin'], r.__state, r.__goals, r);
    const partial = phases.find(p => p.range === 'Lvl 72');
    assertTrue(Boolean(partial), 'partial wash level appears in Phase Plan');
    assertTrue(/4 remaining fresh AP per level → LUK/.test(partial.action),
      'partial wash level accounts for all five fresh AP');
  });

  test('Magician with moderate goals finds a feasible plan that respects peak MP cap', () => {
    const r = plan({
      class: 'Magician',
      goals: { hpGoal: 5000, mpGoal: 15000, targetLevel: 180 },
      gearInt: 40,
    });
    assertFeasible(r);
    assertTrue(r.params.mpEndPhase2 <= 30000, `peak MP at mpWashStop (${r.params.mpEndPhase2}) must respect 30k cap`);
    assertTrue(r.params.mpEndPhase3 <= 30000, `MP at target (${r.params.mpEndPhase3}) must respect 30k cap`);
    assertTrue(r.finalHP >= 5000, 'HP goal met');
    assertTrue(r.finalMP >= 15000, 'MP goal met');
  });

  test('Peak MP at end of Phase 2 stays ≤ 30k for every class', () => {
    // The engine's peak-MP check covers the boundary between Phase 2 and Phase 3.
    // Verify mpEndPhase2 is present in params and respects the cap for all classes.
    for (const className of CLASS_ORDER) {
      const goals = className === 'Magician' ? { hpGoal: 5000, mpGoal: 10000, targetLevel: 180 }
                  : className === 'Beginner' ? { hpGoal: 5000, mpGoal: 2000, targetLevel: 180 }
                  : { hpGoal: 30000, mpGoal: 5000, targetLevel: 180 };
      if (className === 'Fighter' || className === 'Spearman' || className === 'Page') {
        goals.mpGoal = 2000;
      }
      if (className === 'Brawler') goals.mpGoal = 4000;
      const r = plan({ class: className, goals });
      assertFeasible(r);
      assertTrue(typeof r.params.mpEndPhase2 === 'number', `${className}: mpEndPhase2 present in params`);
      assertTrue(r.params.mpEndPhase2 <= 30000, `${className}: peak MP (${r.params.mpEndPhase2}) ≤ 30k cap`);
    }
  });

  test('A Stale HP Wash with no fresh AP in the HP/MP Pool is rejected', () => {
    // Named for what it actually reaches. This fixture leaves no free AP at the swap level to seed
    // the pool, so every candidate fails the pool rule — not the MP cap, which the test above
    // covers directly.
    const r = plan({
      class: 'Fighter',
      current: { level: 160, hp: 22500, mp: 29400, baseInt: 500 },
      goals: { hpGoal: 30000, mpGoal: 29900, targetLevel: 180, swapLevel: 180 },
    });
    assertInfeasible(r, 'HP/MP Pool');
  });

  test('Stale-heavy plans search the exact MP Wash end needed for the MP Goal', () => {
    const r = plan({
      class: 'Assassin',
      current: { level: 169, hp: 7324, mp: 8585, baseInt: 504 },
      goals: { hpGoal: 16257, mpGoal: 9208, targetLevel: 200, swapLevel: 197 },
    });
    assertFeasible(r);
    assertEq(r.params.mpWashEnd, 189, 'finds the endpoint beyond the initial estimate');
    assertEq(r.apResets, 1109, 'returns the minimum-reset endpoint');
  });

  test('Stale HP Wash breakdown lumps Phase 3 stale + swap burst + cleanup stale into one count', () => {
    const r = plan({
      class: 'Assassin',
      goals: { hpGoal: 30000, mpGoal: 5000, targetLevel: 180, swapLevel: 160 },
    });
    assertFeasible(r);
    const phase3Stale = r.params.phase3StaleHPResets || 0;
    const swapBurst = r.params.swapBurst || 0;
    const cleanupStale = r.params.cleanupStaleHPWash || 0;
    assertEq(r.breakdown.staleHPWash, phase3Stale + swapBurst + cleanupStale,
      'breakdown.staleHPWash = Phase 3 stale + swap burst + cleanup stale');
  });

  test('Invariant: apResets equals sum of all reset categories', () => {
    const r = plan({
      class: 'Magician',
      goals: { hpGoal: 5000, mpGoal: 15000, targetLevel: 180 },
      gearInt: 40,
    });
    assertFeasible(r);
    const b = r.breakdown;
    const sum = b.shift + b.mpWash + b.phase3Fresh + b.intReset + b.staleHPWash;
    assertEq(r.apResets, sum, `apResets ${r.apResets} != sum ${sum}`);
  });
});

// ────────────────────────── 4-stat shift budget ──────────────────────────

describe('Non-INT pool', () => {
  // Same mid-progress Assassin the Swap Level block uses: LUK is the only stat with surplus.
  const POOL_START = { level: 40, hp: 1500, mp: 800, str: 4, dex: 4, luk: 45, baseInt: 180 };

  test('The pool counts only AP above each stat floor', () => {
    // Ren's worked example: an Assassin at 10 STR / 30 DEX / 10 LUK. STR and LUK sit on the
    // universal floor of 4 (6 movable each); DEX is pinned at 25 by the Thief advancement, so
    // only 5 of its 30 can move. 6 + 5 + 6 = 17.
    assertEq(nonIntPool(CLASSES['Assassin'], { str: 10, dex: 30, luk: 10 }), 17);
    // Warriors pin STR at 35 instead, so the same three numbers give a different pool.
    assertEq(nonIntPool(CLASSES['Fighter'], { str: 10, dex: 30, luk: 10 }), 32);
    assertEq(nonIntStatFloor(CLASSES['Assassin'], 'DEX'), 25, 'Thief DEX floor');
    assertEq(nonIntStatFloor(CLASSES['Assassin'], 'LUK'), 4, 'unrestricted stats floor at 4');
    assertEq(nonIntStatFloor(CLASSES['Fighter'], 'STR'), 35, 'Warrior STR floor');
  });

  test('A stat below its floor never contributes (and never goes negative)', () => {
    assertEq(nonIntPool(CLASSES['Fighter'], { str: 4, dex: 4, luk: 4 }), 0);
    assertEq(nonIntPool(CLASSES['Magician'], { str: 4, dex: 4, luk: 4 }), 0);
  });

  test('The pool is the optimizer\'s shift budget', () => {
    const state = { level: 100, hp: 4000, mp: 1500, str: 4, dex: 400, luk: 4, baseInt: 4 };
    const r = plan({ class: 'Assassin', current: state,
      goals: { hpGoal: 30000, mpGoal: 5000, targetLevel: 180 } });
    assertFeasible(r);
    assertTrue(r.breakdown.shift <= nonIntPool(CLASSES['Assassin'], state),
      `shift ${r.breakdown.shift} cannot exceed the pool`);
  });

  test('Level table carries a Non-INT pool column', () => {
    const r = plan({
      class: 'Assassin',
      current: POOL_START,
      goals: { hpGoal: 30000, mpGoal: 4000, targetLevel: 200, swapLevel: 120 },
    });
    assertFeasible(r);
    const rows = levelTable(CLASSES['Assassin'], r.__state, r.__goals, 40, 1.0, r);
    assertTrue('nonIntPool' in rows[0], 'rows carry a nonIntPool field');
    assertTrue(rows.every(x => Number.isFinite(x.nonIntPool) && x.nonIntPool >= 0),
      'the pool is always a non-negative number');
    // The plan only ever adds AP to Main Stat, and Main Stat above its floor is movable, so the
    // pool never shrinks once levelling starts.
    assertTrue(rows.every((x, i) => i === 0 || x.nonIntPool >= rows[i - 1].nonIntPool),
      'the pool never shrinks over the plan');
  });

  test('The pre-game shift is charged to the pool, not to a stat column', () => {
    // Enough surplus DEX that the optimizer shifts before levelling. Main Stat (LUK) is untouched
    // by that shift, so only the pool records what it cost.
    const state = { level: 100, hp: 6000, mp: 3000, str: 60, dex: 120, luk: 400, baseInt: 13 };
    const goals = { hpGoal: 16000, mpGoal: 8000, targetLevel: 135, swapLevel: 135 };
    const r = plan({ class: 'Assassin', current: state, goals });
    assertFeasible(r);
    assertTrue(r.breakdown.shift > 0, 'this fixture should need a pre-game shift');
    const rows = levelTable(CLASSES['Assassin'], r.__state, r.__goals, 40, 1.0, r);
    assertEq(rows[0].nonIntPool,
      nonIntPool(CLASSES['Assassin'], r.__state) - r.breakdown.shift,
      'the first row shows the pool left after the shift');
    assertEq(rows[0].mainStat, state.luk, 'Main Stat is unchanged by the shift');
  });

  test('Mage pools hold steady — their Main Stat is INT, which is not in the pool', () => {
    const r = plan({
      class: 'Magician',
      current: { level: 10, hp: 400, mp: 900, str: 4, dex: 15, luk: 8, baseInt: 40 },
      goals: { hpGoal: 3000, mpGoal: 6000, targetLevel: 120, swapLevel: 120 },
    });
    assertFeasible(r);
    const rows = levelTable(CLASSES['Magician'], r.__state, r.__goals, 40, 1.0, r);
    const expected = nonIntPool(CLASSES['Magician'], r.__state) - r.breakdown.shift;
    assertTrue(rows.every(x => x.nonIntPool === expected),
      'every Mage row shows the same pool');
  });

  test('The UI shows the pool in the level table and on the review step', () => {
    // Attribute-tolerant: the header may carry scope="col" or a class without changing intent.
    assertTrue(/<th[^>]*>non-int pool<\/th>/.test(indexSrc),
      'the level table heads the column "non-int pool"');
    assertTrue(indexSrc.includes('<td>${fmt(r.nonIntPool)}</td>'),
      'the level table renders row.nonIntPool');
    assertTrue(!indexSrc.includes('lt-mainstat-head'),
      'the per-class Main Stat header is gone');
    assertTrue(indexSrc.includes('data-review="stats"') && indexSrc.includes('data-review="pool"'),
      'review keeps the raw stats and adds the pool alongside them');
    // Line-break tolerant: the call wraps once the null guard is inlined.
    assertTrue(/put\('pool',[\s\S]{0,120}?nonIntPool\(CLASSES\[classSelect\.value\]/.test(indexSrc),
      'the review pool is computed with the engine helper');
    assertTrue(indexSrc.includes("op: '-Non-INT +INT'"),
      'the breakdown names the pool as the shift source');
  });
});

describe('4-stat shift budget', () => {
  test('Mage with extra LUK can shift LUK into INT pre-game', () => {
    // Mage that accidentally built LUK (50). The optimizer can shift it into INT.
    // Before the 4-stat change, Mages had maxPositiveShift = 0 (since their "mainStat" was INT).
    const r = plan({
      class: 'Magician',
      current: { level: 50, hp: 1500, mp: 3000, str: 4, dex: 4, luk: 50, baseInt: 4 },
      goals: { hpGoal: 5000, mpGoal: 10000, targetLevel: 180 },
    });
    assertFeasible(r);
    // 50 LUK against a floor of 4 is a 46-point budget, and the shift is capped by it whether or
    // not this fixture spends any of it. (`shift >= 0` was unfalsifiable for an unsigned count.)
    assertEq(nonIntPool(CLASSES['Magician'], r.__state), 46, 'the LUK surplus is the shift budget');
    assertTrue(r.breakdown.shift <= 46, `shift ${r.breakdown.shift} within the LUK budget`);
    if (r.breakdown.shift > 0) assertEq(r.breakdown.shiftDir, 'up', 'a Mage only shifts into INT');
  });

  test('Optimizer can shift from a non-MainStat stat (e.g., DEX on a Assassin)', () => {
    // NL whose extras sit in DEX (not LUK). Only the amount above permanent 25 DEX is eligible.
    const r = plan({
      class: 'Assassin',
      current: { level: 100, hp: 4000, mp: 1500, str: 4, dex: 400, luk: 4, baseInt: 4 },
      goals: { hpGoal: 30000, mpGoal: 5000, targetLevel: 180 },
    });
    assertFeasible(r);
    assertTrue(r.breakdown.shift > 0, 'should shift some non-INT into INT');
    assertEq(r.breakdown.shiftDir, 'up');
    assertTrue(r.breakdown.shift <= 375, `shift ${r.breakdown.shift} ≤ DEX budget 375`);
  });

  test('Mage cannot do negative shift (INT-to-MainStat is a no-op for them)', () => {
    // Mage with over-built INT — should NOT shift down (no useful destination).
    const r = plan({
      class: 'Magician',
      current: { level: 100, hp: 4000, mp: 10000, str: 4, dex: 4, luk: 4, baseInt: 600 },
      goals: { hpGoal: 5000, mpGoal: 10000, targetLevel: 180 },
    });
    assertFeasible(r);
    // Unconditional: the guarded form silently asserted nothing whenever the fixture chose shift 0,
    // which is exactly what this Mage does. A down-shift must never appear, at any shift count.
    assertTrue(r.breakdown.shiftDir !== 'down', 'Mages should not shift INT down');
  });
});

// ────────────────────────── per-class smoke tests ──────────────────────────

describe('Per-class smoke tests (every class returns a sensible plan)', () => {
  const sensibleGoals = {
    'Assassin':  { hpGoal: 30000, mpGoal: 5000,  targetLevel: 180 },
    'Bandit':    { hpGoal: 30000, mpGoal: 5000,  targetLevel: 180 },
    'Hunter':   { hpGoal: 30000, mpGoal: 5000,  targetLevel: 180 },
    'Crossbowman':    { hpGoal: 30000, mpGoal: 5000,  targetLevel: 180 },
    'Gunslinger':     { hpGoal: 30000, mpGoal: 5000,  targetLevel: 180 },
    'Brawler':   { hpGoal: 30000, mpGoal: 4000,  targetLevel: 180 },
    'Fighter':        { hpGoal: 30000, mpGoal: 2000,  targetLevel: 180 },
    'Spearman': { hpGoal: 30000, mpGoal: 2000,  targetLevel: 180 },
    'Page':     { hpGoal: 30000, mpGoal: 2000,  targetLevel: 180 },
    'Magician':    { hpGoal: 5000,  mpGoal: 10000, targetLevel: 180 },
    'Beginner':    { hpGoal: 5000,  mpGoal: 2000,  targetLevel: 180 },  // Beginner Min MP at 180 = 1795
  };

  for (const className of CLASS_ORDER) {
    test(className, () => {
      const r = plan({ class: className, goals: sensibleGoals[className] });
      assertFeasible(r);
      assertTrue(r.finalHP >= sensibleGoals[className].hpGoal, 'HP goal met');
      assertTrue(r.finalMP >= sensibleGoals[className].mpGoal, 'MP goal met');
      assertTrue(r.apResets > 0, 'has some AP Resets');
      assertTrue(r.params.mpEndPhase3 <= 30000, 'never overshoots MP cap');
      assertTrue(r.finalHP <= 30000, 'never overshoots HP cap');
    });
  }
});

// ───────────────── Swap Level (ADR 0001) ─────────────────

describe('Swap Level', () => {
  const NL_START = { level: 40, hp: 1500, mp: 800, str: 4, dex: 4, luk: 45, baseInt: 180 };

  test('Base INT collapses to its starting value AT the Swap Level, not at Target Level', () => {
    const r = plan({
      class: 'Assassin',
      current: NL_START,
      goals: { hpGoal: 30000, mpGoal: 4000, targetLevel: 200, swapLevel: 120 },
    });
    assertFeasible(r);
    const rows = levelTable(CLASSES['Assassin'], r.__state, r.__goals, 40, 1.0, r);
    const preSwap = rows.find(x => x.level === 119);
    const atSwap = rows.find(x => x.level === 120);
    assertTrue(preSwap.baseInt > 4, 'Base INT is built up before the swap');
    assertEq(atSwap.baseInt, 4, 'Base INT resets to starting value AT the swap level');
  });

  test('Main Stat absorbs Base INT at the Swap Level', () => {
    const r = plan({
      class: 'Assassin',
      current: NL_START,
      goals: { hpGoal: 30000, mpGoal: 4000, targetLevel: 200, swapLevel: 120 },
    });
    assertFeasible(r);
    const rows = levelTable(CLASSES['Assassin'], r.__state, r.__goals, 40, 1.0, r);
    const preSwap = rows.find(x => x.level === 119);
    const atSwap = rows.find(x => x.level === 120);
    assertTrue(atSwap.mainStat > preSwap.mainStat, 'Main Stat jumps at the swap');
    // The jump equals the INT that was flushed (plus that level's own -MP +LUK cycles).
    assertTrue(atSwap.mainStat - preSwap.mainStat >= r.breakdown.intReset,
      'Main Stat gain covers the flushed Base INT');
  });

  test('Level table carries a Main Stat column', () => {
    const r = plan({
      class: 'Assassin',
      current: NL_START,
      goals: { hpGoal: 30000, mpGoal: 4000, targetLevel: 200, swapLevel: 120 },
    });
    assertFeasible(r);
    const rows = levelTable(CLASSES['Assassin'], r.__state, r.__goals, 40, 1.0, r);
    assertTrue('mainStat' in rows[0], 'rows carry a mainStat field');
    assertTrue(rows.every(x => Number.isFinite(x.mainStat)), 'mainStat is always numeric');
  });

  test('Swap burst front-loads HP at the swap level (free — total resets unchanged)', () => {
    const r = plan({
      class: 'Assassin',
      current: NL_START,
      goals: { hpGoal: 30000, mpGoal: 4000, targetLevel: 200, swapLevel: 120 },
    });
    assertFeasible(r);
    assertTrue(r.params.swapBurst > 0, 'a swap burst was scheduled');
    assertTrue(r.params.hpAtSwap > 5000, 'HP at the swap level is substantial');
    // Collapsing the swap onto Target Level gives the burst nowhere to go: the same conversion
    // happens, at the end, against far more banked HP. Note what is NOT asserted — that the early
    // swap costs no more. Moving the Swap Level changes the whole strategy, not just where the
    // burst lands, and its sibling test ('A later Swap Level can be cheaper...') pins the opposite
    // direction: retaining INT to level 200 here is 177 resets cheaper than swapping at 120.
    const late = plan({
      class: 'Assassin',
      current: NL_START,
      goals: { hpGoal: 30000, mpGoal: 4000, targetLevel: 200, swapLevel: 200 },
    });
    assertFeasible(late);
    assertTrue(late.params.swapBurst > 0, 'the collapsed plan still bursts, at Target Level');
    assertTrue(late.params.hpAtSwap > r.params.hpAtSwap,
      'the later swap arrives with more HP already banked');
  });

  test('Swap Level == Target Level is valid and collapses everything at the goal level', () => {
    const r = plan({
      class: 'Assassin',
      current: NL_START,
      goals: { hpGoal: 25000, mpGoal: 4000, targetLevel: 200, swapLevel: 200 },
    });
    assertFeasible(r);
    assertEq(r.params.mpWashStop, 200, 'Swap Level remains at the target level');
    assertTrue(r.finalHP >= 25000, 'HP goal still met');
    const phases = phasePlan(CLASSES['Assassin'], r.__state, r.__goals, r);
    const targetEvent = phases.find(p => p.range === 'At Lvl 200' && /Reset Base INT/.test(p.action));
    assertTrue(Boolean(targetEvent), 'target-level swap event includes the Base INT reset');
    if (r.params.swapBurst > 0) {
      assertTrue(/Stale HP Wash/.test(targetEvent.action), 'target-level swap event includes its stale-wash burst');
      assertTrue(targetEvent.action.indexOf('keeping the HP/MP Pool available')
        < targetEvent.action.indexOf('Stale HP Wash'),
      'fresh AP enters the pool before stale washing');
      assertTrue(targetEvent.action.indexOf('Stale HP Wash')
        < targetEvent.action.indexOf('reclaim the swap-level fresh AP'),
      'stale washing happens before the fresh AP is reclaimed');
    }
    const rows = levelTable(CLASSES['Assassin'], r.__state, r.__goals, 40, 1.0, r);
    assertEq(rows.at(-1).phase, 'Fresh + Stale HP Wash + Reset INT',
      'target row names every combined swap operation');
  });

  test('Swap Level above Target Level is rejected', () => {
    const r = plan({
      class: 'Assassin',
      current: NL_START,
      goals: { hpGoal: 25000, mpGoal: 4000, targetLevel: 180, swapLevel: 200 },
    });
    assertEq(r.feasible, false, 'rejected');
    assertTrue(/Swap Level/.test(r.reason), 'reason names the Swap Level');
  });

  test('Swap Level below Current Level is rejected', () => {
    const r = plan({
      class: 'Assassin',
      current: NL_START,
      goals: { hpGoal: 25000, mpGoal: 4000, targetLevel: 200, swapLevel: 20 },
    });
    assertEq(r.feasible, false, 'rejected');
    assertTrue(/Swap Level/.test(r.reason), 'reason names the Swap Level');
  });

  test('A later Swap Level can be cheaper by retaining INT through Fresh HP Washes', () => {
    const early = plan({
      class: 'Fighter',
      goals: { hpGoal: 30000, mpGoal: 2000, targetLevel: 180, swapLevel: 80 },
    });
    const late = plan({
      class: 'Fighter',
      goals: { hpGoal: 30000, mpGoal: 2000, targetLevel: 180, swapLevel: 180 },
    });
    assertFeasible(early);
    assertFeasible(late);
    assertTrue(late.apResets < early.apResets,
      `target-level swap (${late.apResets}) should beat level-80 swap (${early.apResets}) for a Warrior`);
    assertTrue(late.params.mpWashEnd < late.params.mpWashStop,
      'the later plan retains Base INT through a pre-Swap Fresh HP phase');
  });

  test('Magicians are unaffected — no swap burst, Main Stat tracks Base INT', () => {
    const r = plan({
      class: 'Magician',
      goals: { hpGoal: 5000, mpGoal: 15000, targetLevel: 180, swapLevel: 120 },
    });
    assertFeasible(r);
    assertEq(r.params.swapBurst, undefined, 'no swap burst for Mages');
    const rows = levelTable(CLASSES['Magician'], r.__state, r.__goals, 40, 1.0, r);
    assertTrue(rows.every(x => x.mainStat === x.baseInt),
      "Mage Main Stat (INT) tracks Base INT exactly");
  });
});

// ────────────────────────── exact fresh-AP scheduling regressions ──────────────────────────

describe('Exact fresh-AP scheduling', () => {
  test('A transition level can split one AP into MP and four AP into HP', () => {
    const r = plan({
      class: 'Fighter',
      current: { level: 50, hp: 5000, mp: 29940, str: 100, dex: 4, luk: 4, baseInt: 100 },
      goals: { hpGoal: 5274, mpGoal: 29950, targetLevel: 51, swapLevel: 51 },
    });
    assertFeasible(r);
    assertEq(r.apResets, 101, 'one MP wash + four fresh HP washes + 96 INT resets');
    assertEq(r.params.preSwapFreshAtBoundary, 4, 'four boundary AP switch to HP');
    const row = levelTable(CLASSES['Fighter'], r.__state, r.__goals, 40, 1.0, r).at(-1);
    assertEq(row.mpWashesThisLevel, 1, 'one boundary AP MP-washes');
    assertEq(row.freshHPWashesThisLevel, 4, 'four boundary AP fresh-HP-wash');
    assertEq(row.peakMPThisLevel, 29971, 'the legal order remains below the MP cap');
    assertEq(row.mp, 29951, 'the exact plan meets the MP goal');
  });

  test('A stale-wash plan first seeds the HP/MP Pool with a fresh HP allocation', () => {
    const r = plan({
      class: 'Fighter',
      current: { level: 50, hp: 5000, mp: 1000, str: 100, dex: 4, luk: 4, baseInt: 100 },
      goals: { hpGoal: 5100, mpGoal: 900, targetLevel: 51, swapLevel: 51 },
    });
    assertFeasible(r);
    assertEq(r.apResets, 97, 'one fresh wash and 96 INT resets beat two illegal stale washes');
    assertEq(r.breakdown.phase3Fresh, 1, 'one AP seeds the shared pool');
    assertEq(r.breakdown.staleHPWash, 0, 'no empty-pool stale wash is emitted');
    const rows = levelTable(CLASSES['Fighter'], r.__state, r.__goals, 40, 1.0, r);
    assertTrue(rows.every(row => row.hpMPPoolValid), 'every stale-wash row has a prior pool seed');
  });

  test('The level-70 advancement AP can supply eleven fresh washes over two levels', () => {
    const r = plan({
      class: 'Fighter',
      current: { level: 69, hp: 5000, mp: 1000, str: 100, dex: 4, luk: 4, baseInt: 4 },
      goals: { hpGoal: 5704, mpGoal: 900, targetLevel: 71, swapLevel: 69 },
    });
    assertFeasible(r);
    assertEq(r.apResets, 11, 'all required HP comes from fresh washes');
    assertEq(r.breakdown.phase3Fresh, 11, 'exact fresh-wash count');
    assertEq(r.breakdown.staleHPWash, 0, 'no lower-yield stale washes are needed');
    const rows = levelTable(CLASSES['Fighter'], r.__state, r.__goals, 40, 1.0, r);
    assertEq(rows.find(row => row.level === 70).freshHPWashesThisLevel, 10,
      'level 70 exposes five level-up AP plus five advancement AP');
    assertEq(rows.find(row => row.level === 71).freshHPWashesThisLevel, 1,
      'the final wash uses one AP from the next level');
  });
});

// ────────────────────────── UI calculation trigger ──────────────────────────

describe('UI calculation trigger', () => {
  test('Calculation runs only when the form is explicitly submitted', () => {
    assertTrue(/calcForm\.addEventListener\('submit', event => \{[\s\S]{0,240}?event\.preventDefault\(\);[\s\S]{0,240}?runCalc\(\);/.test(indexSrc),
      'the Calculate form should preventDefault and invoke runCalc on submit');
    assertEq((indexSrc.match(/\brunCalc\(/g) || []).length, 2,
      'runCalc should only appear in its declaration and the form submit handler');
    assertTrue(indexSrc.includes("classSelect.addEventListener('change', syncSwapVisibility);"),
      'changing class should still update class-specific field visibility');
    assertTrue(indexSrc.includes('swapInput.disabled = isMage;'),
      'Mage selection removes Swap Level from form and keyboard interaction');
    assertTrue(indexSrc.includes('.field[hidden] { display: none !important; }'),
      'the field layout rule cannot visually override hidden class-specific fields');
    assertTrue(indexSrc.includes("swapField.setAttribute('aria-hidden', String(isMage));"),
      'Mage selection removes Swap Level from the accessibility tree');
    assertTrue(/id="i-cur-int"[^>]*value="13"/.test(indexSrc),
      'the fresh-character defaults use the 13 INT MapleLegends starting roll');
    assertTrue(!indexSrc.includes('__calcDebounce'),
      'input changes should not schedule a debounced calculation');
  });
});

// ────────────────────────── Web Worker transport ──────────────────────────
// Node has no Worker, so these assert the *contract* wash-worker.js relies on rather than driving
// a real worker. The two things that actually break across the boundary are (a) a payload that
// cannot be structured-cloned, and (b) progress/result shapes drifting from what index.html reads.

describe('Web Worker transport', () => {
  const WORKER_PAYLOAD_KEYS = [
    'requestId', 'className', 'currentState', 'goals', 'gearInt', 'mwMultiplier',
  ];

  // Anything non-cloneable here would throw at postMessage time, in the browser only.
  function assertCloneable(value, path, seen = new Set()) {
    if (value === null || value === undefined) return;
    const type = typeof value;
    if (type === 'function') throw new Error(`${path} is a function — cannot be structured-cloned`);
    if (type === 'symbol') throw new Error(`${path} is a symbol — cannot be structured-cloned`);
    if (type !== 'object') return;
    if (seen.has(value)) throw new Error(`${path} contains a cycle — cannot be structured-cloned`);
    seen.add(value);
    if (Array.isArray(value)) value.forEach((v, i) => assertCloneable(v, `${path}[${i}]`, seen));
    else Object.keys(value).forEach(k => assertCloneable(value[k], `${path}.${k}`, seen));
  }

  test('The worker payload excludes classData, which carries non-cloneable formulas', () => {
    for (const className of CLASS_ORDER) {
      const classData = CLASSES[className];
      // The hazard this guards against: class entries hold minMPFormula/minHPFormula functions.
      assertTrue(typeof classData.minMPFormula === 'function',
        `${className}: expected a function formula to guard against`);
      const payload = {
        requestId: 42,
        className,
        currentState: { level: 40, hp: 1000, mp: 300, str: 4, dex: 4, luk: 4, baseInt: 200 },
        goals: { hpGoal: 30000, mpGoal: 4000, targetLevel: 200, swapLevel: 135 },
        gearInt: 40,
        mwMultiplier: 1,
      };
      assertCloneable(payload, `payload(${className})`);
    }
    // The literal above proves only that the literal is cloneable. Read the real builder out of
    // index.html: adding classData there is the regression this test exists to catch.
    const src = indexSrc.match(/function calcPayload\(input, requestId\) \{([\s\S]*?)\n    \}/);
    assertTrue(Boolean(src), 'found calcPayload in index.html');
    const keys = [...src[1].matchAll(/^\s{8}([A-Za-z]+)[,:]/gm)].map(m => m[1]);
    assertEq(JSON.stringify(keys.sort()), JSON.stringify([...WORKER_PAYLOAD_KEYS].sort()),
      'the real calcPayload sends exactly the expected keys');
  });

  test('The worker echoes the request ID on progress, result, and error messages', () => {
    const messages = [];
    const context = {
      importScripts() {},
      CLASSES: { Fighter: {} },
      optimize(classData, currentState, goals, gearInt, mwMultiplier, onProgress) {
        onProgress({ completed: 1, total: 2 });
        return { feasible: true, marker: goals.marker };
      },
      self: { postMessage(message) { messages.push(message); } },
    };
    vm.runInNewContext(workerSrc, context, { filename: 'wash-worker.js' });

    context.self.onmessage({
      data: {
        requestId: 17,
        className: 'Fighter',
        currentState: {},
        goals: { marker: 'newest' },
        gearInt: 0,
        mwMultiplier: 1,
      },
    });
    assertEq(messages.length, 2, 'progress and result were posted');
    assertTrue(messages.every(message => message.requestId === 17),
      'every success-path message echoes its request ID');
    assertEq(messages[1].result.marker, 'newest', 'result belongs to the identified request');

    context.self.onmessage({
      data: {
        requestId: 18,
        className: 'Missing',
        currentState: {},
        goals: {},
        gearInt: 0,
        mwMultiplier: 1,
      },
    });
    assertEq(messages.at(-1).type, 'error', 'unknown class uses the error path');
    assertEq(messages.at(-1).requestId, 18, 'error echoes its request ID');
  });

  test('The UI filters by echoed request ID and permanently disables a failed worker', () => {
    assertTrue(/msg\.requestId !== token \|\| token !== runToken/.test(indexSrc),
      'queued responses are matched to both the request and current run');
    assertTrue(/let calcWorker =/.test(indexSrc), 'worker reference is mutable');
    assertTrue(/calcWorker === worker\) calcWorker = null/.test(indexSrc),
      'worker errors clear the shared worker reference');
    assertTrue(/try \{\s*worker\.postMessage\(calcPayload\(input, token\)\)/.test(indexSrc),
      'synchronous postMessage failures are caught');
  });

  test('optimize reports progress over a bounded, monotone outer loop', () => {
    const updates = [];
    const r = optimize(CLASSES['Spearman'],
      { level: 40, hp: 1000, mp: 300, str: 35, dex: 4, luk: 4, baseInt: 200 },
      { hpGoal: 30000, mpGoal: 4000, targetLevel: 200, swapLevel: 135 },
      40, 1.0, p => updates.push(p));
    assertFeasible(r);
    assertTrue(updates.length > 0, 'progress callback fires at least once');
    assertTrue(updates.length < 500,
      `progress is reported per outer-loop step, not per candidate (got ${updates.length})`);
    const last = updates[updates.length - 1];
    assertEq(last.phase, 'searching', 'progress carries the expected phase label');
    assertTrue(last.total > 0, 'progress carries a positive total');
    assertTrue(last.completed < last.total, 'completed never exceeds total');
    for (let i = 1; i < updates.length; i++) {
      assertTrue(updates[i].completed > updates[i - 1].completed,
        'progress completed is strictly increasing');
      assertEq(updates[i].total, updates[i - 1].total, 'progress total is stable');
    }
  });

  test('optimize still works with no progress callback (Node tests and inline fallback)', () => {
    const r = optimize(CLASSES['Assassin'],
      { level: 1, hp: 50, mp: 5, str: 4, dex: 4, luk: 4, baseInt: 4 },
      { hpGoal: 30000, mpGoal: 5000, targetLevel: 180, swapLevel: 160 },
      40, 1.0);
    assertFeasible(r);
    assertTrue(r.apResets > 0, 'returns a plan without a callback');
  });

  test('optimize reports the infeasibility reason through the same return shape', () => {
    const r = optimize(CLASSES['Magician'],
      { level: 1, hp: 50, mp: 5, str: 4, dex: 4, luk: 4, baseInt: 4 },
      { hpGoal: 30000, mpGoal: 5000, targetLevel: 50, swapLevel: 50 },
      40, 1.0);
    assertInfeasible(r);
    // The worker posts this object back verbatim.
    assertCloneable(r, 'infeasibleResult');
  });
});

describe('Per-class constants', () => {
  // Every class reaches optimize() somewhere in this suite, but only a handful get anything past
  // "feasible" — so a typo in, say, Bandit's staleAPHP would not fail anything. This pins the
  // wash-relevant numbers for all eleven, straight from Nise's compilation. No search, no cost.
  const EXPECTED = {
    //              nHP nMP fHP sHP fMP loss  maxHP@lvl    maxMP@lvl
    'Assassin':    [ 22, 15, 18, 16, 10, 12,  0, null,     0, null],
    'Bandit':      [ 22, 15, 18, 16, 10, 12,  0, null,     0, null],
    'Hunter':      [ 22, 15, 18, 16, 10, 12,  0, null,     0, null],
    'Crossbowman': [ 22, 15, 18, 16, 10, 12,  0, null,     0, null],
    'Gunslinger':  [ 25, 20, 18, 18, 14, 16,  0, null,     0, null],
    'Brawler':     [ 25, 20, 38, 18, 14, 16, 30, 33,       0, null],
    'Fighter':     [ 26,  5, 52, 20,  2,  4, 40, 16,       0, null],
    'Spearman':    [ 26,  5, 52, 20,  2,  4, 40, 16,       0, null],
    'Page':        [ 26,  5, 52, 20,  2,  4, 40, 16,       0, null],
    'Magician':    [ 12, 23,  8,  6, 38, 30,  0, null,    20, 12],
    'Beginner':    [ 14, 11, 10,  8,  6,  8,  0, null,     0, null],
  };

  test('Every class carries the expected wash constants', () => {
    assertEq(Object.keys(EXPECTED).length, CLASS_ORDER.length, 'one expectation per class');
    for (const className of CLASS_ORDER) {
      const e = EXPECTED[className];
      assertTrue(Boolean(e), `${className}: has an expectation`);
      const c = CLASSES[className];
      assertEq(c.naturalHPPerLevel, e[0], `${className}.naturalHPPerLevel`);
      assertEq(c.naturalMPPerLevel, e[1], `${className}.naturalMPPerLevel`);
      assertEq(c.freshAPHP, e[2], `${className}.freshAPHP`);
      assertEq(c.staleAPHP, e[3], `${className}.staleAPHP`);
      assertEq(c.freshAPMPBase, e[4], `${className}.freshAPMPBase`);
      assertEq(c.mpLossPerReset, e[5], `${className}.mpLossPerReset`);
      assertEq(c.maxHPBonusPerLevel, e[6], `${className}.maxHPBonusPerLevel`);
      assertEq(c.maxHPActivatesAt, e[7], `${className}.maxHPActivatesAt`);
      assertEq(c.maxMPBonusPerLevel, e[8], `${className}.maxMPBonusPerLevel`);
      assertEq(c.maxMPActivatesAt, e[9], `${className}.maxMPActivatesAt`);
      // A Fresh HP Wash must never yield LESS HP than a Stale one, or the whole fresh/stale
      // distinction is inverted. Equality is real: a Gunslinger has no Max HP mastery, so both
      // washes pay the same 18.
      assertTrue(c.freshAPHP >= c.staleAPHP, `${className}: fresh AP yields at least stale HP`);
      // A wash cycle must be MP-positive at zero INT for washing to be possible at all.
      assertTrue(c.freshAPMPBase < c.mpLossPerReset || c.isMage,
        `${className}: a zero-INT wash cycle is net MP-negative, as the model assumes`);
      // maxHP/maxMP bonuses and their activation levels come as a pair.
      assertEq(c.maxHPBonusPerLevel > 0, c.maxHPActivatesAt !== null, `${className}: maxHP pair`);
      assertEq(c.maxMPBonusPerLevel > 0, c.maxMPActivatesAt !== null, `${className}: maxMP pair`);
    }
  });

  test('Maple Warrior levels match the multipliers the UI offers', () => {
    assertEq(JSON.stringify(mod.MAPLE_WARRIOR_LEVELS),
      JSON.stringify([
        { label: 'None', level: 0, multiplier: 1.00 },
        { label: 'MW 10', level: 10, multiplier: 1.05 },
        { label: 'MW 20', level: 20, multiplier: 1.10 },
        { label: 'MW 30', level: 30, multiplier: 1.15 },
      ]), 'the MW table is the one the tests calibrate against');
    // The dropdown is populated from the same constant rather than a parallel literal.
    assertTrue(/MAPLE_WARRIOR_LEVELS\.forEach/.test(indexSrc),
      'the UI builds its Maple Warrior options from MAPLE_WARRIOR_LEVELS');
  });
});

describe('Level-table invariants across plans', () => {
  // Every phase label the engine can emit. Pinned because CONTEXT.md's list silently fell five
  // labels behind the code; a new label now has to be added here (and there) deliberately.
  const PHASES = new Set([
    'Shift to INT', 'First Job Requirement',
    'Build Base INT', 'Build LUK', 'Build DEX', 'Build STR', 'Build INT',
    'MP Wash', 'MP Wash + Reset INT', 'MP Wash + Pre-Swap Fresh HP Wash',
    'MP Wash + Fresh HP Wash + Reset INT', 'MP + Fresh + Stale HP Wash + Reset INT',
    'Pre-Swap Fresh HP Wash', 'Fresh HP Wash', 'Fresh HP Wash + Reset INT',
    'Stale HP Wash', 'Stale HP Wash + Reset INT',
    'Fresh + Stale HP Wash', 'Fresh + Stale HP Wash + Reset INT',
    'MP-Cap HP Wash', 'Reset Base INT', 'Done',
  ]);

  const cases = [
    ['Assassin', { hpGoal: 30000, mpGoal: 5000, targetLevel: 180, swapLevel: 160 }, 40, 1.0],
    ['Fighter', { hpGoal: 25000, mpGoal: 2000, targetLevel: 140, swapLevel: 130 }, 40, 1.0],
    ['Magician', { hpGoal: 6000, mpGoal: 30000, targetLevel: 180 }, 40, 1.0],
    ['Brawler', { hpGoal: 20000, mpGoal: 4000, targetLevel: 120, swapLevel: 110 }, 0, 1.0],
  ];

  for (const [className, goals, gearInt, mwMultiplier] of cases) {
    test(`${className} plan: every level respects the caps, the floors and the phase vocabulary`, () => {
      const r = plan({ class: className, goals, gearInt, mwMultiplier });
      assertFeasible(r);
      const rows = levelTable(CLASSES[className], r.__state, r.__goals, gearInt, mwMultiplier, r);
      const secondJALevel = 30;
      for (const row of rows) {
        // Phase vocabulary, allowing the composite first-job prefix.
        const bare = row.phase.replace(/^[A-Z]+ for 1st Job \+ /, '');
        assertTrue(PHASES.has(bare), `lvl ${row.level}: unknown phase "${row.phase}"`);
        // Level-end values are hard-capped, always.
        assertTrue(row.hp <= 30000, `lvl ${row.level}: HP ${row.hp} over the 30k cap`);
        assertTrue(row.mp <= 30000, `lvl ${row.level}: MP ${row.mp} over the 30k cap`);
        // The transient peak is capped too, EXCEPT in a cap-wash phase whose MP goal is itself
        // 30,000: the model levels first and washes the excess down afterwards, where a player
        // would wash down first and then level. Same MP generated, same washes, different order —
        // so the peak reads a little over the cap. Bounded here at one level's worth of generation
        // (measured max 717 across the Mage plans) so a real modelling runaway still fails.
        const peakCap = r.params.capWash ? 31500 : 30000;
        assertTrue(row.peakMPThisLevel <= peakCap,
          `lvl ${row.level}: transient MP peak ${row.peakMPThisLevel} over ${peakCap}`);
        // Minimum MP is a post-2nd-job floor and only a reset can push MP down.
        if (row.level >= secondJALevel && row.mpResetsThisLevel > 0) {
          const floor = mod.minMPAtLevel(CLASSES[className], row.level);
          assertTrue(row.mp >= floor, `lvl ${row.level}: MP ${row.mp} below Min MP ${floor}`);
        }
        assertTrue(row.hpMPPoolValid, `lvl ${row.level}: stale wash with an unseeded HP/MP Pool`);
      }
      assertEq(rows.at(-1).cumulativeResets, r.apResets, 'the table schedules every reset');
    });
  }
});

// ────────────────────────── exit ──────────────────────────

console.log('\n──────────────');
console.log(`  ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const { name, err } of failures) {
    console.log('  - ' + name + ': ' + err.message);
  }
  process.exit(1);
}
process.exit(0);
