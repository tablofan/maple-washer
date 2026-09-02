// MapleWasher calculator engine.
// Analytical (no level-by-level simulation in the hot loop) — mirrors Krythan's approach.

const GEAR_WORN_FROM_LEVEL = 10;  // Per spec: INT gear is treated as worn from lvl 10 onward.
const MAX_HP = 30000;
const MAX_MP = 30000;

function firstJALevel(classData) {
  return classData.jaBonuses.length > 0 ? classData.jaBonuses[0].level : 10;
}

// Level at which the character reaches 2nd job. Minimum MP / Minimum HP are post-2nd-JA floors
// (CONTEXT.md), so they must not be enforced below this level.
function secondJALevel(classData) {
  return classData.jaBonuses.length > 1 ? classData.jaBonuses[1].level : Infinity;
}

function naturalHPGainAtLevel(classData, L) {
  if (L <= firstJALevel(classData)) return BEGINNER_HP_PER_LEVEL;
  let gain = classData.naturalHPPerLevel;
  if (classData.maxHPActivatesAt !== null && L >= classData.maxHPActivatesAt) {
    gain += classData.maxHPBonusPerLevel;
  }
  return gain;
}

function naturalMPGainAtLevel(classData, L) {
  if (L <= firstJALevel(classData)) return BEGINNER_MP_PER_LEVEL;
  let gain = classData.naturalMPPerLevel;
  // NOTE: Mages don't have MaxMP active until ~lvl 16 (when the skill is typically maxed).
  // Pre-16 Magicians legitimately use the lower base. Matches Krythan's reference sheets.
  if (classData.maxMPActivatesAt !== null && L >= classData.maxMPActivatesAt) {
    gain += classData.maxMPBonusPerLevel;
  }
  return gain;
}

function cumulativeNaturalHP(classData, fromLevel, toLevel) {
  let total = 0;
  for (let L = fromLevel + 1; L <= toLevel; L++) {
    total += naturalHPGainAtLevel(classData, L);
  }
  return total;
}

function cumulativeNaturalMPBase(classData, fromLevel, toLevel) {
  let total = 0;
  for (let L = fromLevel + 1; L <= toLevel; L++) {
    total += naturalMPGainAtLevel(classData, L);
  }
  return total;
}

function jaHPBonusInRange(classData, fromLevel, toLevel) {
  let total = 0;
  for (const ja of classData.jaBonuses) {
    if (ja.level > fromLevel && ja.level <= toLevel) total += ja.hp;
  }
  return total;
}

function jaMPBonusInRange(classData, fromLevel, toLevel) {
  let total = 0;
  for (const ja of classData.jaBonuses) {
    if (ja.level > fromLevel && ja.level <= toLevel) total += ja.mp;
  }
  return total;
}

function minMPAtLevel(classData, level) {
  return Math.max(0, classData.minMPFormula(level));
}

function minHPAtLevel(classData, level) {
  // Per Nise's compilation, every class has an exact (coeff * level + intercept) Min HP formula.
  return Math.max(0, classData.minHPFormula(level));
}

// Clamp HP Goal and MP Goal up to their respective class+level Min HP/MP floors at the
// Target Level. At Target Level the character is in its post-2nd-JA state, where max HP/MP
// is game-enforced to be ≥ Min HP/MP — so a Goal below the floor is unreachable-NOT-to-meet,
// and we treat the user's typed Goal as the floor. The user's typed value stays visible in
// the input; the engine receives the floored value; the UI surfaces the returned `notes`.
//
// IMPORTANT: Current HP and Current MP are NOT clamped. Pre-2nd-JA states (e.g. lvl 1 with
// HP 50 / MP 5) legitimately sit below the Min HP/MP formula — the formulas describe the
// post-advancement floor, not a hard constraint on the user's actual current state.
//
// Mutates the input objects in place and returns the list of clamps applied. Each note carries
// { fieldId, label, stat, clamped, atLevel, className }.
function prepareInputs(classData, currentState, goals, className) {
  const notes = [];

  const minHPAtTgt = minHPAtLevel(classData, goals.targetLevel);
  if (goals.hpGoal < minHPAtTgt) {
    notes.push({ fieldId: 'i-hp-goal', label: 'HP Goal', stat: 'HP', clamped: minHPAtTgt, atLevel: goals.targetLevel, className });
    goals.hpGoal = minHPAtTgt;
  }
  const minMPAtTgt = minMPAtLevel(classData, goals.targetLevel);
  if (goals.mpGoal < minMPAtTgt) {
    notes.push({ fieldId: 'i-mp-goal', label: 'MP Goal', stat: 'MP', clamped: minMPAtTgt, atLevel: goals.targetLevel, className });
    goals.mpGoal = minMPAtTgt;
  }
  return notes;
}

// ─────────────────── Wash-math primitives ───────────────────
// Named domain operations from CONTEXT.md. Each is a single per-cycle / per-level formula —
// all consumers (evaluateStrategy, levelTable) should call these instead of inlining the math.

// MP gained per single MP-Wash cycle (Krythan/Nise): freshAPMPBase + floor(Base INT / 10) - mpLossPerReset.
// Uses Base INT only — Gear INT and Maple Warrior do NOT amplify this per-cycle yield (per Nise).
function washCycleMP(classData, baseInt) {
  const deficit = classData.mpLossPerReset - classData.freshAPMPBase;
  return Math.floor(baseInt / 10) - deficit;
}

// Per-level MP gained from INT after a level-up: floor((Base INT * MW + Gear INT) / 10).
// Gear INT contributes only if level ≥ GEAR_WORN_FROM_LEVEL. Class-independent (no classData).
function intMPPerLevel(baseInt, gearInt, mwMultiplier, level) {
  const gearActive = level >= GEAR_WORN_FROM_LEVEL ? gearInt : 0;
  return Math.floor((baseInt * mwMultiplier + gearActive) / 10);
}

// HP yield from Fresh HP Wash (N fresh APs allocated to HP at level-up).
function freshHPWashYield(classData, count) {
  return count * classData.freshAPHP;
}

// HP yield from Stale HP Wash (N -MP +HP AP Resets).
function staleHPWashYield(classData, count) {
  return count * classData.staleAPHP;
}

// MP cost (drain) of N -MP +X AP Resets — same per-reset cost regardless of destination.
function washCycleMPCost(classData, count) {
  return count * classData.mpLossPerReset;
}

// Sum of INT-driven MP contributions over levels (fromLevel, toLevel] (level-ups at L = fromLevel+1 … toLevel).
// Per Nise: MP Gained LvlUP includes Total INT/10. Per Krythan: MW multiplies the Base-INT portion only.
// Per spec: Gear INT is worn from level GEAR_WORN_FROM_LEVEL onward (lvl 10 by default).
// Per level L: gain = floor((Base_INT_at_L * MW + Gear_INT_at_L) / 10), via intMPPerLevel().
//
// For plateau ranges (startInt === endInt) the sum is computed as `levels * intMPPerLevel(...)`.
// For ramp ranges, this iterates per level using the same `+5 INT per level, capped at endInt`
// rule that levelTable() applies — so the analytical sum here and the per-level walk in
// levelTable always agree exactly. This is the contract that lets us drop the test tolerance.
function intMPContribution(fromLevel, toLevel, startInt, endInt, gearInt, mwMultiplier) {
  const levels = toLevel - fromLevel;
  if (levels <= 0) return 0;

  if (startInt === endInt) {
    // Plateau: INT constant across the range. Split at the gear threshold for one O(1) answer.
    if (toLevel < GEAR_WORN_FROM_LEVEL) {
      return levels * Math.floor((startInt * mwMultiplier) / 10);
    }
    if (fromLevel + 1 >= GEAR_WORN_FROM_LEVEL) {
      return levels * Math.floor((startInt * mwMultiplier + gearInt) / 10);
    }
    const preLevels = (GEAR_WORN_FROM_LEVEL - 1) - fromLevel;
    const postLevels = levels - preLevels;
    return preLevels * Math.floor((startInt * mwMultiplier) / 10)
         + postLevels * Math.floor((startInt * mwMultiplier + gearInt) / 10);
  }

  // Ramp: walk per level. At the START of level L (used for L's intMP gain), INT = the value
  // after level L-1's allocations. The per-level allocation is +5 INT (Phase 1: fresh AP all to
  // INT; Phase 2 build: 5 -MP +INT resets), capped so Base INT never exceeds endInt.
  let intAtL = startInt;
  let total = 0;
  for (let i = 1; i <= levels; i++) {
    const L = fromLevel + i;
    total += intMPPerLevel(intAtL, gearInt, mwMultiplier, L);
    intAtL = Math.min(endInt, intAtL + 5);
  }
  return total;
}

// ─────────────────── Phase steps ───────────────────
// Each phase is a pure computation taking the strategy params and producing the phase's outputs.
// `evaluateStrategy` chains them and runs cross-phase invariant checks between calls.

// Phase 1: before MP washing starts, use fresh AP to reach Target Base INT as early as possible,
// then put every remaining fresh AP into Main Stat. Keeping existing INT until the Swap Level is
// always at least as good as shifting it down early: the reset cost is identical and the retained
// INT generates weakly more MP along the way.
function runPhase1(classData, currentState, params, gearInt, mwMultiplier) {
  const { mpWashStart, shift, targetBaseInt } = params;
  const startBaseInt = currentState.baseInt + shift;
  const phase1Levels = mpWashStart - currentState.level;
  // For Mages Main Stat is INT, so there is no separate Main Stat destination to switch to.
  const phase1EndInt = classData.isMage
    ? startBaseInt + 5 * phase1Levels
    : Math.min(targetBaseInt, startBaseInt + 5 * phase1Levels);
  const freshAPToInt = Math.max(0, phase1EndInt - startBaseInt);
  const freshAPToMainStat = phase1Levels * 5 - freshAPToInt;
  const phase1BuildEndLevel = currentState.level + Math.ceil(freshAPToInt / 5);
  const mpFromInt = intMPContribution(currentState.level, mpWashStart, startBaseInt, phase1EndInt, gearInt, mwMultiplier);
  return { startBaseInt, phase1EndInt, freshAPToInt, freshAPToMainStat, phase1BuildEndLevel, mpFromInt };
}

// Phase 2: MP Wash from mpWashStart → mpWashEnd. 5 AP Resets/level: -MP +INT until Base INT
// reaches `targetBaseInt`, then -MP +MainStat for remaining plateau levels.
//
// Levels are (mpWashStart, mpWashEnd]. For non-Mages, mpWashEnd may precede mpWashStop (the user's
// Swap Level), leaving a suffix for pre-Swap Fresh HP Wash while Base INT is retained.
// Zero-length Phase 2: no MP wash, so no resets and no MP from washing.
function zeroPhase2(phase1EndInt, targetBaseInt) {
  return {
    phase2APResets: 0,
    intResetsInPhase2: Math.max(0, targetBaseInt - phase1EndInt),
    phase2BuildLevels: 0,
    phase2BuildEndLevel: 0,
    phase2PlateauLevels: 0,
    mpFromInt_build: 0, mpFromInt_plateau: 0,
    mpFromMPWash_build: 0, mpFromMPWash_plateau: 0,
  };
}

function runPhase2(classData, params, phase1, gearInt, mwMultiplier, currentLevel) {
  const { mpWashStart, mpWashStop, targetBaseInt } = params;
  const mpWashEnd = params.mpWashEnd ?? mpWashStop;
  const { phase1EndInt } = phase1;

  // MP Wash needs a level-up (fresh AP), so the level the character is ALREADY at yields nothing.
  // Wash levels are therefore (max(mpWashStart, currentLevel), mpWashEnd] — matching levelTable.
  // Count only levels that actually produce a level-up (and hence fresh AP). The character's
  // current level never yields AP, so when mpWashStart is at/below it the first washing level is
  // currentLevel+1. Span = [firstWashingLevel, mpWashEnd], inclusive. A zero-length Phase 2
  // (mpWashStart === mpWashEnd) contributes nothing.
  if (mpWashEnd <= mpWashStart) {
    const zero = { ...zeroPhase2(phase1EndInt, targetBaseInt) };
    return zero;
  }
  const firstWashingLevel = classData.isMage
    ? Math.max(mpWashStart, (currentLevel ?? mpWashStart) + 1)
    : Math.max(mpWashStart + 1, (currentLevel ?? mpWashStart) + 1);
  const phase2Levels = Math.max(0, mpWashEnd - firstWashingLevel + 1);
  const phase2APResets = phase2Levels * 5;
  const intResetsInPhase2 = Math.max(0, targetBaseInt - phase1EndInt);
  const phase2BuildLevels = Math.ceil(intResetsInPhase2 / 5);
  const phase2PlateauLevels = phase2Levels - phase2BuildLevels;
  const phase2BuildEndLevel = mpWashStart + phase2BuildLevels;

  const mpFromInt_build   = intMPContribution(mpWashStart, phase2BuildEndLevel, phase1EndInt, targetBaseInt, gearInt, mwMultiplier);
  const mpFromInt_plateau = intMPContribution(phase2BuildEndLevel, mpWashEnd, targetBaseInt, targetBaseInt, gearInt, mwMultiplier);

  const phase2BuildAvgInt = (phase1EndInt + targetBaseInt) / 2;
  const mpFromMPWash_build   = phase2BuildLevels   * 5 * washCycleMP(classData, phase2BuildAvgInt);
  const mpFromMPWash_plateau = phase2PlateauLevels * 5 * washCycleMP(classData, targetBaseInt);

  return {
    phase2APResets, intResetsInPhase2,
    phase2BuildLevels, phase2BuildEndLevel, phase2PlateauLevels,
    mpFromInt_build, mpFromInt_plateau,
    mpFromMPWash_build, mpFromMPWash_plateau,
  };
}

// After MP Washing ends, non-Mages can retain Base INT and use every fresh AP through the Swap
// Level for Fresh HP Wash. Each allocation is paired with -MP +MainStat, so the character gains HP
// and Main Stat while continuing to receive Base-INT level-up MP until the swap.
function runPreSwapFresh(classData, params, gearInt, mwMultiplier) {
  const { mpWashStop, targetBaseInt } = params;
  const mpWashEnd = params.mpWashEnd ?? mpWashStop;
  const levels = Math.max(0, mpWashStop - mpWashEnd);
  const preSwapFreshHPResets = levels * 5;
  return {
    preSwapFreshHPResets,
    hpFromFresh: freshHPWashYield(classData, preSwapFreshHPResets),
    mpFromInt: intMPContribution(mpWashEnd, mpWashStop,
      targetBaseInt, targetBaseInt, gearInt, mwMultiplier),
    mpFromResets: -washCycleMPCost(classData, preSwapFreshHPResets),
  };
}

// Phase 3: from mpWashStop (= Swap Level) → targetLevel. `phase3FreshHPResets` is the exact total
// number of fresh-AP-to-HP washes, frontloaded at up to 5 per level by levelTable. Each is paired
// with a `-MP +MainStat` reset (see CONTEXT.md: Post-Swap Fresh HP Wash). Phase 3 can also combine
// `staleHPPerLevelPhase3` -MP+HP resets. Both drain MP via reset cost.
//
// Base INT is STARTING_MAIN_STAT throughout Phase 3 — the reset to MainStat happened AT the swap.
function runPhase3(classData, params, goals, gearInt, mwMultiplier) {
  const { mpWashStop, phase3FreshHPResets = 0, staleHPPerLevelPhase3 = 0 } = params;
  const phase3Levels = goals.targetLevel - mpWashStop;
  const phase3StaleHPResets = phase3Levels * staleHPPerLevelPhase3;

  const hpFromFresh = freshHPWashYield(classData, phase3FreshHPResets);
  const hpFromStale = staleHPWashYield(classData, phase3StaleHPResets);
  const mpFromInt = intMPContribution(mpWashStop, goals.targetLevel, STARTING_MAIN_STAT, STARTING_MAIN_STAT, gearInt, mwMultiplier);
  const mpFromResets = -washCycleMPCost(classData, phase3FreshHPResets + phase3StaleHPResets);

  return {
    phase3FreshHPResets, phase3StaleHPResets,
    hpFromFresh, hpFromStale,
    mpFromInt, mpFromResets,
  };
}

// Swap-event burst: at Swap Level, convert as much banked MP into HP as possible via -MP +HP
// stale washes, before Base INT is flushed to MainStat.
//
// This is FREE: `clean = needWashes − burst`, so `burst + clean` is constant and total AP Resets
// are invariant to where in the schedule the washes happen (see ADR 0001). Maximising the burst
// therefore buys the player their HP as early as possible at no extra NX.
//
// `hpGrowthAfterSwap` (natural/JA growth + fresh HP wash from swap → target) is added AFTER the
// burst, so it must be reserved: bursting past `MAX_HP − hpGrowthAfterSwap` would push HP into the
// cap, wasting both the overflow washes AND the MP they drained. Cap on it rather than on MAX_HP.
//
// `mpNetAfterSwap` is the MP the plan still needs after the swap (post-swap growth minus the MP the
// Phase 3 resets will drain). After the burst, MP must still be able to reach the MP Goal:
// `mpAfterBurst + mpNetAfterSwap ≥ mpGoal`. Without this the burst would happily drain MP down to
// Min MP at the swap and leave the plan unable to meet the MP Goal at Target Level.
function runSwapBurst(classData, mpAtSwap, hpAtSwapNatural, needWashes, minMPAtSwap, hpGrowthAfterSwap, mpNetAfterSwap, mpGoal) {
  const affordable = Math.floor((mpAtSwap - minMPAtSwap) / classData.mpLossPerReset);
  const headroom = Math.max(0, MAX_HP - hpGrowthAfterSwap - hpAtSwapNatural);
  // ceil, not floor: the last wash is allowed to overshoot the cap slightly (HP is clamped to
  // MAX_HP afterwards), and needWashes is itself a ceil — using floor here makes the burst land one
  // wash short of the goal, which levelTable then has to reconcile, diverging from this count.
  // One spare wash is left unfilled because the per-level walk applies post-swap growth level by
  // level and the MAX_HP clip can cost a fraction of a wash, needing a reconciliation top-up that
  // this analytical count must not have claimed as spare MP.
  const capToMaxHP = Math.max(0, Math.ceil(headroom / classData.staleAPHP) - 1);
  const reserveForMPGoal = Math.floor((mpAtSwap + mpNetAfterSwap - mpGoal) / classData.mpLossPerReset);
  const burst = Math.max(0, Math.min(needWashes, affordable, capToMaxHP, reserveForMPGoal));
  // The remainder is what the target-level cleanup must still cover. When the headroom cap binds,
  // the burst delivers less HP than `needWashes` assumed, so the cleanup carries the difference —
  // keeping `burst + cleanup` equal to the washes the HP Goal actually needs.
  return { burst, mpAfterBurst: mpAtSwap - washCycleMPCost(classData, burst) };
}

// Cleanup at target level: cleanup Stale HP Wash (-MP +HP) tops up to HP Goal, then Base INT
// is reset back to MainStat (skipped for Mages — see classData.requiresIntResetAtTarget).
function runCleanup(classData, hpEndPhase3, mpEndPhase3Raw, goals, targetBaseInt) {
  const intResetAPResets = classData.requiresIntResetAtTarget ? Math.max(0, targetBaseInt - STARTING_MAIN_STAT) : 0;
  const hpGap = Math.max(0, goals.hpGoal - hpEndPhase3);
  const cleanupStaleHPWash = hpGap > 0 ? Math.ceil(hpGap / classData.staleAPHP) : 0;
  const finalHP = Math.min(MAX_HP, hpEndPhase3 + staleHPWashYield(classData, cleanupStaleHPWash));
  const finalMP = mpEndPhase3Raw - washCycleMPCost(classData, cleanupStaleHPWash);
  return { intResetAPResets, cleanupStaleHPWash, finalHP, finalMP };
}

// The strategy:
//   (Pre-game) Optional `shift`: AP-Reset `-<non-INT> +INT` (source is any of the user's non-INT stats).
//   Phase 1 (currentLevel → mpWashStart): Fresh AP → INT until Target Base INT, then → Main Stat.
//   Phase 2 (mpWashStart → mpWashEnd): MP Wash. Fresh AP → MP. 5 AP Resets/lvl: -MP +INT until targetBaseInt, then -MP +MainStat.
//   Pre-swap (mpWashEnd → mpWashStop): Fresh AP → HP, paired with -MP +MainStat, while retaining Base INT.
//   Phase 3 (mpWashStop → targetLevel): Frontload `phase3FreshHPResets` fresh-AP→HP washes at 5/level
//              (each paired with a -MP +MainStat reset), plus `staleHPPerLevelPhase3` -MP +HP resets
//              (drains MP into HP at the stale rate; required when peak MP would otherwise exceed 30k).
//   At targetLevel: Stale HP wash (-MP +HP) to fill remaining HP gap, then Reset Base INT (-INT +MainStat) to STARTING_MAIN_STAT (skipped for Mages).
//
// Returns { feasible, finalHP, finalMP, apResets, breakdown, params }.
function evaluateStrategy(classData, currentState, goals, gearInt, mwMultiplier, params, ranges, phase1Cache) {
  const { targetBaseInt, mpWashStart, mpWashStop, shift } = params;
  const mpWashEnd = params.mpWashEnd ?? mpWashStop;
  ranges = ranges || precomputeRanges(classData, currentState.level, goals.targetLevel);

  // --- Cross-phase parameter validation ---
  const startBaseInt = currentState.baseInt + shift;
  if (startBaseInt < STARTING_MAIN_STAT) return { feasible: false, reason: 'shift would drop Base INT below starting value' };
  if (startBaseInt > targetBaseInt)      return { feasible: false, reason: 'starting INT after shift exceeds target INT' };
  if (mpWashStart < currentState.level || mpWashEnd < mpWashStart
      || mpWashStop < mpWashEnd || mpWashStop > goals.targetLevel) {
    return { feasible: false, reason: 'invalid phase ordering' };
  }

  // --- Phase 1 (hoistable: depends only on currentState, mpWashStart, shift — not on mpWashStop / freshHP / staleHP)
  const p1 = phase1Cache || runPhase1(classData, currentState, params, gearInt, mwMultiplier);
  if (p1.phase1EndInt > targetBaseInt) return { feasible: false, reason: 'phase 1 overshoots target INT' };

  // --- Phase 2 ---
  const p2 = runPhase2(classData, params, p1, gearInt, mwMultiplier, currentState.level);
  // No reason: this is a per-candidate detail (a given Target Base INT simply doesn't fit the
  // window). Surfacing it would mask the real binding constraint reported by optimize().
  if (p2.intResetsInPhase2 > p2.phase2APResets) return { feasible: false };

  const preSwap = runPreSwapFresh(classData, params, gearInt, mwMultiplier);

  // --- Phase 3 ---
  const p3 = runPhase3(classData, params, goals, gearInt, mwMultiplier);

  // MP banked at the Swap Level (end of Phase 2) — before any swap burst.
  const minMPAtStop = minMPAtLevel(classData, mpWashStop);
  const mpAtMPWashEnd = currentState.mp
    + ranges.naturalMPInRange(currentState.level, mpWashEnd)
    + ranges.jaMPInRange(currentState.level, mpWashEnd)
    + p1.mpFromInt + p2.mpFromInt_build + p2.mpFromInt_plateau
    + p2.mpFromMPWash_build + p2.mpFromMPWash_plateau;
  const mpAtSwap = currentState.mp
    + ranges.naturalMPInRange(currentState.level, mpWashStop)
    + ranges.jaMPInRange(currentState.level, mpWashStop)
    + p1.mpFromInt + p2.mpFromInt_build + p2.mpFromInt_plateau
    + p2.mpFromMPWash_build + p2.mpFromMPWash_plateau
    + preSwap.mpFromInt + preSwap.mpFromResets;

  // Pre-Swap MP can peak before the endpoint or before that level's paired resets. MP gain is
  // piecewise linear here, so only formula-change boundaries and range endpoints need checking.
  const preSwapPeakLevels = new Set([mpWashEnd, mpWashStop]);
  const addPeakBoundary = level => {
    if (level >= mpWashEnd && level <= mpWashStop) preSwapPeakLevels.add(level);
  };
  for (const boundary of [GEAR_WORN_FROM_LEVEL, firstJALevel(classData) + 1,
    classData.maxMPActivatesAt, ...classData.jaBonuses.map(ja => ja.level)]) {
    if (boundary === null) continue;
    addPeakBoundary(boundary - 1);
    addPeakBoundary(boundary);
  }
  const preSwapPeakMP = Math.max(...[...preSwapPeakLevels].map(level =>
    mpAtMPWashEnd
      + ranges.naturalMPInRange(mpWashEnd, level)
      + ranges.jaMPInRange(mpWashEnd, level)
      + intMPContribution(mpWashEnd, level,
        targetBaseInt, targetBaseInt, gearInt, mwMultiplier)
      - washCycleMPCost(classData, Math.max(0, level - mpWashEnd) * 5)
      + (level > mpWashEnd ? washCycleMPCost(classData, 5) : 0)
  ));

  // HP accumulated by the swap from natural growth and the optional pre-Swap fresh phase.
  const hpAtSwapNatural = Math.min(MAX_HP, currentState.hp
    + cumulativeNaturalHP(classData, currentState.level, mpWashStop)
    + jaHPBonusInRange(classData, currentState.level, mpWashStop));
  const hpAtSwapBeforeBurst = Math.min(MAX_HP, hpAtSwapNatural + preSwap.hpFromFresh);

  // Natural HP/MP accrued over the whole plan, for the peak-MP and final checks below.
  const naturalMPInPhase3 = ranges.naturalMPInRange(mpWashStop, goals.targetLevel);
  const jaMPInPhase3 = ranges.jaMPInRange(mpWashStop, goals.targetLevel);

  // --- Swap burst: convert banked MP → HP at the swap (free — see runSwapBurst) ---
  // HP still needed from stale washes once fresh AP→HP and the swap burst have contributed.
  const hpEndPhase3 = Math.min(MAX_HP,
    currentState.hp + ranges.hpNatural + ranges.hpJA
    + preSwap.hpFromFresh + p3.hpFromFresh + p3.hpFromStale);
  const needWashes = Math.ceil(Math.max(0, goals.hpGoal - hpEndPhase3) / classData.staleAPHP);
  const hpGrowthAfterSwap = (currentState.hp + ranges.hpNatural + ranges.hpJA) - hpAtSwapNatural
    + p3.hpFromFresh + p3.hpFromStale;
  const mpNetAfterSwap = naturalMPInPhase3 + jaMPInPhase3 + p3.mpFromInt + p3.mpFromResets;
  const swapBurst = mpWashStop > currentState.level
    ? runSwapBurst(classData, mpAtSwap, hpAtSwapBeforeBurst, needWashes,
      minMPAtStop, hpGrowthAfterSwap, mpNetAfterSwap, goals.mpGoal)
    : { burst: 0, mpAfterBurst: mpAtSwap };
  const hpAtSwap = Math.min(MAX_HP,
    hpAtSwapBeforeBurst + staleHPWashYield(classData, swapBurst.burst));

  const mpEndPhase2 = swapBurst.mpAfterBurst;
  const mpEndPhase3Raw = swapBurst.mpAfterBurst
    + naturalMPInPhase3 + jaMPInPhase3 + p3.mpFromInt + p3.mpFromResets;

  // --- 30k caps + Min MP/HP invariant checks ---
  const peakMP = Math.max(mpAtMPWashEnd, preSwapPeakMP, mpEndPhase2, mpEndPhase3Raw);
  if (peakMP > MAX_MP) return { feasible: false, reason: `Plan overshoots the 30,000 MP cap (peak would reach ${Math.round(peakMP)})` };

  // The authoritative walk checks every MP-draining row. This aggregate check cheaply rejects a
  // strategy that already violates Minimum MP at a swap that itself drains MP.
  const mpResetsAtSwap = swapBurst.burst > 0 || (mpWashStop > currentState.level
    && (mpWashEnd < mpWashStop || (mpWashEnd === mpWashStop && mpWashEnd > mpWashStart)));
  if (mpResetsAtSwap && mpEndPhase2 < minMPAtStop) {
    return { feasible: false, reason: `MP at lvl ${mpWashStop} (${Math.round(mpEndPhase2)}) would be below Min MP (${minMPAtStop})` };
  }
  if (mpEndPhase3Raw < minMPAtLevel(classData, goals.targetLevel)) {
    return { feasible: false, reason: `MP at lvl ${goals.targetLevel} after Phase 3 washes (${Math.round(mpEndPhase3Raw)}) would be below Min MP (${minMPAtLevel(classData, goals.targetLevel)})` };
  }

  // --- Cleanup (at Target Level: only the stale washes the swap burst didn't already cover) ---
  // `clean = needWashes − burst` keeps `burst + clean` constant, so total resets are invariant to
  // where the washes happen. The INT reset is charged here but executes at the Swap Level (ADR 0001).
  // The swap burst lands at Swap Level, so its HP is carried forward through the swap→target
  // growth and is SUBJECT to the MAX_HP cap along the way — whereas `hpEndPhase3` assumes all
  // washes land at Target Level. Mirror the per-level walk exactly: cap at every step, then top up
  // at the target with whatever is still needed.
  const hpGrowthSwapToTarget = (currentState.hp + ranges.hpNatural + ranges.hpJA) - hpAtSwapNatural
    + p3.hpFromFresh + p3.hpFromStale;
  // levelTable applies post-swap growth level by level, clipping at MAX_HP at each step, so
  // growth arriving after the burst can be partially clipped away — leaving it a few washes short
  // even when the aggregate looks sufficient. Reserve a small margin so the cleanup booked here
  // covers what the walk actually needs to top up, keeping both paths in agreement on MP.
  const hpWithBurstAtSwap = Math.min(MAX_HP, hpAtSwap + hpGrowthSwapToTarget);
  const hpShortfall = Math.max(0, goals.hpGoal - hpWithBurstAtSwap);
  const cleanupStaleHPWash = Math.ceil(hpShortfall / classData.staleAPHP);
  const intResetAPResets = classData.requiresIntResetAtTarget ? Math.max(0, targetBaseInt - STARTING_MAIN_STAT) : 0;
  const finalHP = Math.min(MAX_HP, hpWithBurstAtSwap + staleHPWashYield(classData, cleanupStaleHPWash));
  const finalMP = mpEndPhase3Raw - washCycleMPCost(classData, cleanupStaleHPWash);
  const cleanup = { intResetAPResets, cleanupStaleHPWash, finalHP, finalMP };

  // --- Final goal checks ---
  const minMPAtTarget = minMPAtLevel(classData, goals.targetLevel);
  if (cleanup.finalMP < minMPAtTarget) {
    return { feasible: false, reason: `Final MP (${Math.round(cleanup.finalMP)}) would be below Min MP (${minMPAtTarget}) at lvl ${goals.targetLevel}` };
  }
  // No reason: the optimizer tracks these near-misses and reports the real ceiling. A per-candidate
  // message here would mask the binding constraint.
  if (cleanup.finalMP < goals.mpGoal) return { feasible: false, reach: { hp: cleanup.finalHP, mp: cleanup.finalMP } };
  const minHPAtTarget = minHPAtLevel(classData, goals.targetLevel);
  if (cleanup.finalHP < minHPAtTarget) {
    return { feasible: false, reason: `Final HP (${Math.round(cleanup.finalHP)}) would be below Min HP (${minHPAtTarget}) at lvl ${goals.targetLevel}` };
  }

  // --- Assemble result ---
  // burst + cleanupStaleHPWash is invariant (see runSwapBurst), so charging both here keeps the
  // total correct regardless of how the washes were split between the swap and the target level.
  const totalStaleHPWash = p3.phase3StaleHPResets + cleanup.cleanupStaleHPWash + swapBurst.burst;
  const apResets = p2.phase2APResets + preSwap.preSwapFreshHPResets
                 + p3.phase3FreshHPResets + p3.phase3StaleHPResets
                 + cleanup.intResetAPResets + cleanup.cleanupStaleHPWash + swapBurst.burst + Math.abs(shift);

  return {
    feasible: true,
    finalHP: Math.round(cleanup.finalHP),
    finalMP: Math.round(cleanup.finalMP),
    apResets,
    breakdown: {
      shift: Math.abs(shift),
      shiftDir: shift >= 0 ? 'up' : 'down',
      mpWash: p2.phase2APResets,
      phase3Fresh: preSwap.preSwapFreshHPResets + p3.phase3FreshHPResets,
      intReset: cleanup.intResetAPResets,
      staleHPWash: totalStaleHPWash,
    },
    params: {
      ...params,
      mpWashFirstLevel: p2.phase2APResets > 0 ? mpWashStart + 1 : null,
      phase1EndInt: p1.phase1EndInt,
      phase1BuildEndLevel: p1.phase1BuildEndLevel,
      phase1FreshAPToMainStat: p1.freshAPToMainStat,
      phase2BuildEndLevel: p2.phase2BuildEndLevel,
      preSwapFreshHPResets: preSwap.preSwapFreshHPResets,
      mpAtMPWashEnd: Math.round(mpAtMPWashEnd),
      preSwapPeakMP: Math.round(preSwapPeakMP),
      mpEndPhase2: Math.round(mpEndPhase2),
      mpEndPhase3: Math.round(mpEndPhase3Raw),
      hpEndPhase3: Math.round(hpEndPhase3),
      hpAtSwap: Math.round(hpAtSwap),
      swapBurst: swapBurst.burst,
      phase3StaleHPResets: p3.phase3StaleHPResets,
      cleanupStaleHPWash: cleanup.cleanupStaleHPWash,
    },
  };
}

// MP-cap HP wash strategy (the Mage endgame, per Krythan's sheet + Shivering's guide):
//   Phase 1 + Phase 2 drive MP up to (but not past) the goal/30k cap, building INT along the way.
//   Phase 3 (capLevel → targetLevel) then PINS MP at the goal: every level's MP inflow
//     [ 5 fresh AP → MP + natural level-up MP + INT/10 contribution ] is immediately stale-washed
//     (-MP +HP) back down. The inflow becomes HP at the stale rate; MP never exceeds the goal.
//   HP from conversion = (gross MP generated − MP goal) / mpLossPerReset × staleAPHP.
// This is the dominant HP-wash for high-INT classes: at INT 760 each fresh AP yields
// (38 + 76)/30 × 6 ≈ 23 HP, vs 8 HP from a direct Fresh HP Wash.
//
// Distinct from evaluateStrategy's Phase 3 (which DRAINS MP downward for non-cap plans). The
// optimizer evaluates both and keeps the cheaper feasible plan.
function evaluateCapWash(classData, currentState, goals, gearInt, mwMultiplier, params, ranges, phase1Cache) {
  const { targetBaseInt, mpWashStart, mpWashStop, shift } = params;
  ranges = ranges || precomputeRanges(classData, currentState.level, goals.targetLevel);

  // --- Validation (mirrors evaluateStrategy) ---
  const startBaseInt = currentState.baseInt + shift;
  if (startBaseInt < STARTING_MAIN_STAT) return { feasible: false, reason: 'shift would drop Base INT below starting value' };
  if (startBaseInt > targetBaseInt)      return { feasible: false, reason: 'starting INT after shift exceeds target INT' };
  if (mpWashStart < currentState.level || mpWashStop < mpWashStart || mpWashStop > goals.targetLevel) {
    return { feasible: false, reason: 'invalid phase ordering' };
  }

  const p1 = phase1Cache || runPhase1(classData, currentState, params, gearInt, mwMultiplier);
  if (p1.phase1EndInt > targetBaseInt) return { feasible: false, reason: 'phase 1 overshoots target INT' };
  const p2 = runPhase2(classData, params, p1, gearInt, mwMultiplier, currentState.level);
  // No reason: per-candidate detail. optimize() reports the real binding constraint.
  if (p2.intResetsInPhase2 > p2.phase2APResets) return { feasible: false };

  // MP at the cap level (end of Phase 2). Phase 2 builds INT, not HP — so it must NOT overshoot
  // the cap (you can't exceed 30k MP even momentarily; the conversion to HP only starts in Phase 3).
  const mpAtCap = currentState.mp
    + ranges.naturalMPInRange(currentState.level, mpWashStop)
    + ranges.jaMPInRange(currentState.level, mpWashStop)
    + p1.mpFromInt + p2.mpFromInt_build + p2.mpFromInt_plateau
    + p2.mpFromMPWash_build + p2.mpFromMPWash_plateau;
  if (mpAtCap > MAX_MP) {
    return { feasible: false, reason: `MP Wash reaches ${Math.round(mpAtCap)} before HP washing can begin — exceeds the 30,000 cap` };
  }
  // Min MP must hold at the MP-wash start.
  const mpAtMPWashStart = currentState.mp
    + ranges.naturalMPInRange(currentState.level, mpWashStart)
    + ranges.jaMPInRange(currentState.level, mpWashStart)
    + p1.mpFromInt;
  // Same 2nd-job gate as evaluateStrategy: a pre-2nd-JA character legitimately sits below the
  // Min MP formula, and Min MP only binds once -MP +X resets actually drain MP at that level.
  if (mpWashStart >= secondJALevel(classData) && mpAtMPWashStart < minMPAtLevel(classData, mpWashStart)) {
    return { feasible: false, reason: `MP at lvl ${mpWashStart} (${Math.round(mpAtMPWashStart)}) would be below Min MP (${minMPAtLevel(classData, mpWashStart)})` };
  }

  // --- Phase 3: cap HP wash. All Phase 3 MP inflow is generated then converted to HP. ---
  const phase3Levels = goals.targetLevel - mpWashStop;
  // Fresh AP → MP (5/level), gross gain per AP = freshAPMPBase + floor(Base INT / 10) (no gear/MW on AP assignment).
  const phase3FreshAPtoMP = phase3Levels * 5 * (classData.freshAPMPBase + Math.floor(targetBaseInt / 10));
  const phase3Natural = ranges.naturalMPInRange(mpWashStop, goals.targetLevel);
  const phase3Int = intMPContribution(mpWashStop, goals.targetLevel, targetBaseInt, targetBaseInt, gearInt, mwMultiplier);
  const grossMP = mpAtCap + phase3FreshAPtoMP + phase3Natural + phase3Int;

  if (grossMP < goals.mpGoal) {
    return { feasible: false, reason: `This build only generates ${Math.round(grossMP)} MP — short of the ${goals.mpGoal} MP goal` };
  }

  // Excess MP (above goal) is converted to HP. MP held at the goal throughout Phase 3.
  // Discrete 30-MP washes leave a sub-mpLossPerReset remainder above the goal; cap at MAX_MP so
  // we never report > 30k (the remainder is harmlessly "wasted" at the cap).
  const excessMP = grossMP - goals.mpGoal;
  const capWashes = Math.floor(excessMP / classData.mpLossPerReset);
  const hpFromCapWash = staleHPWashYield(classData, capWashes);
  const finalMP = Math.min(MAX_MP, grossMP - washCycleMPCost(classData, capWashes));

  const hpFromNaturalAndJA = currentState.hp + ranges.hpNatural + ranges.hpJA;
  const finalHP = Math.min(MAX_HP, hpFromNaturalAndJA + hpFromCapWash);

  if (finalMP < minMPAtLevel(classData, goals.targetLevel)) {
    return { feasible: false, reason: `Final MP (${Math.round(finalMP)}) would be below Min MP at lvl ${goals.targetLevel}` };
  }
  if (finalHP < minHPAtLevel(classData, goals.targetLevel)) {
    return { feasible: false, reason: `Final HP (${Math.round(finalHP)}) would be below Min HP at lvl ${goals.targetLevel}` };
  }
  // Note: the HP-goal check is left to the optimizer (so it can track the max reachable HP and
  // report it). A cap-wash plan that meets the MP goal is "feasible" here even if finalHP < hpGoal.

  const intResetAPResets = classData.requiresIntResetAtTarget ? Math.max(0, targetBaseInt - STARTING_MAIN_STAT) : 0;
  const apResets = p2.phase2APResets + capWashes + intResetAPResets + Math.abs(shift);

  return {
    feasible: true,
    finalHP: Math.round(finalHP),
    finalMP: Math.round(finalMP),
    apResets,
    breakdown: {
      shift: Math.abs(shift),
      shiftDir: shift >= 0 ? 'up' : 'down',
      mpWash: p2.phase2APResets,
      phase3Fresh: 0,
      intReset: intResetAPResets,
      staleHPWash: capWashes,
    },
    params: {
      ...params,
      capWash: true,
      mpWashFirstLevel: p2.phase2APResets > 0 ? mpWashStart : null,
      phase1EndInt: p1.phase1EndInt,
      phase1BuildEndLevel: p1.phase1BuildEndLevel,
      phase1FreshAPToMainStat: p1.freshAPToMainStat,
      phase2BuildEndLevel: p2.phase2BuildEndLevel,
      capLevel: mpWashStop,
      mpEndPhase2: Math.round(mpAtCap),
      grossMP: Math.round(grossMP),
      capWashes,
      mpEndPhase3: Math.round(finalMP),
      hpEndPhase3: Math.round(finalHP),
      // Phase-3 cap-wash fields (read by levelTable / phasePlan):
      phase3StaleHPResets: capWashes,
      cleanupStaleHPWash: 0,
      phase3FreshHPResets: 0,
      staleHPPerLevelPhase3: 0,
    },
  };
}

// Precompute level-range quantities that don't depend on strategy choice.
// (Called once outside the brute-force loop; each saves O(targetLevel) work per evaluation.)
// Builds prefix sums for O(1) range queries — partial ranges are pulled by subtraction.
function precomputeRanges(classData, fromLevel, toLevel) {
  const naturalMPPrefix = new Float64Array(toLevel + 2);
  const jaMPPrefix = new Float64Array(toLevel + 2);
  for (let L = 1; L <= toLevel; L++) {
    naturalMPPrefix[L] = naturalMPPrefix[L - 1] + naturalMPGainAtLevel(classData, L);
    jaMPPrefix[L] = jaMPPrefix[L - 1];
    for (const ja of classData.jaBonuses) {
      if (ja.level === L) jaMPPrefix[L] += ja.mp;
    }
  }
  return {
    hpNatural: cumulativeNaturalHP(classData, fromLevel, toLevel),
    mpNaturalBase: naturalMPPrefix[toLevel] - naturalMPPrefix[fromLevel],
    hpJA: jaHPBonusInRange(classData, fromLevel, toLevel),
    mpJA: jaMPPrefix[toLevel] - jaMPPrefix[fromLevel],
    naturalMPInRange: (from, to) => naturalMPPrefix[to] - naturalMPPrefix[from],
    jaMPInRange: (from, to) => jaMPPrefix[to] - jaMPPrefix[from],
  };
}

// Brute-force search across the parameter space; returns the minimum-AP-Reset feasible plan.
// `onProgress` is optional. When supplied it is called periodically with
// { phase, completed, total } so a caller running this off the main thread can report progress.
// It must stay cheap: it is invoked once per outer-loop iteration, not per candidate.
function optimize(classData, currentState, goals, gearInt, mwMultiplier, onProgress) {
  const reportProgress = typeof onProgress === 'function' ? onProgress : null;
  // Quick global feasibility prechecks.
  if (goals.hpGoal > MAX_HP) {
    return { feasible: false, reason: `HP Goal (${goals.hpGoal}) exceeds the 30,000 HP cap.` };
  }
  if (goals.mpGoal > MAX_MP) {
    return { feasible: false, reason: `MP Goal (${goals.mpGoal}) exceeds the 30,000 MP cap.` };
  }
  if (goals.hpGoal < 0 || goals.mpGoal < 0) {
    return { feasible: false, reason: 'HP and MP Goals must be ≥ 0.' };
  }
  if (currentState.level < 1 || currentState.level > 200) {
    return { feasible: false, reason: 'Current Level must be in [1, 200].' };
  }
  if (goals.targetLevel < 2 || goals.targetLevel > 200) {
    return { feasible: false, reason: 'Target Level must be in [2, 200].' };
  }
  if (currentState.level >= goals.targetLevel) {
    return { feasible: false, reason: `Target Level (${goals.targetLevel}) must be greater than Current Level (${currentState.level}).` };
  }
  const minMPAtTarget = minMPAtLevel(classData, goals.targetLevel);
  if (goals.mpGoal < minMPAtTarget) {
    return { feasible: false, reason: `MP Goal (${goals.mpGoal}) is below the minimum possible MP (${minMPAtTarget}) at level ${goals.targetLevel} for a ${classData.isMage ? 'Magician' : 'character of this class'}.` };
  }
  const minHPAtTarget = minHPAtLevel(classData, goals.targetLevel);
  if (goals.hpGoal < minHPAtTarget) {
    return { feasible: false, reason: `HP Goal (${goals.hpGoal}) is below the minimum possible HP (${minHPAtTarget}) at level ${goals.targetLevel}.` };
  }

  const isMage = classData.isMage;
  // Swap Level: user-supplied for non-Mages; Mages never swap (Main Stat IS INT — CONTEXT.md).
  const swapLevel = isMage ? goals.targetLevel : (goals.swapLevel ?? goals.targetLevel);
  if (!isMage) {
    if (swapLevel < currentState.level || swapLevel > goals.targetLevel) {
      return { feasible: false, reason: `Swap Level (${swapLevel}) must be between Current Level (${currentState.level}) and Target Level (${goals.targetLevel}).` };
    }
  }
  const remainingLevels = goals.targetLevel - currentState.level;
  // Positive-shift budget = sum of non-INT stats above starting. The optimizer doesn't care which specific
  // non-INT stat is the source — the player chooses (and accepts the consume-into-MainStat collapse at target).
  const str = currentState.str ?? STARTING_MAIN_STAT;
  const dex = currentState.dex ?? STARTING_MAIN_STAT;
  const luk = currentState.luk ?? STARTING_MAIN_STAT;
  const maxPositiveShift = Math.max(0,
    (str - STARTING_MAIN_STAT) + (dex - STARTING_MAIN_STAT) + (luk - STARTING_MAIN_STAT)
  );
  // Precompute range sums (these depend only on class + currentLevel + targetLevel, not strategy).
  const ranges = precomputeRanges(classData, currentState.level, goals.targetLevel);

  // Existing Base INT stays in place until the Swap Level. Moving it to Main Stat earlier costs
  // the same reset as the eventual swap while discarding its INT-based MP gain, so it is dominated.
  const intMin = currentState.baseInt;
  // Cap: largest INT we could reach via shift-up + all fresh AP. No reason to go higher.
  const intMax = Math.min(2000, currentState.baseInt + maxPositiveShift + 5 * remainingLevels);
  const intStep = 5;

  let best = null;
  // Shortlist of the cheapest candidates, kept so a winner that fails the per-level walk can be
  // replaced by the next-cheapest that survives it.
  const runners = [];
  // Cheapest-candidate shortlist bound. The walk rejects the analytical winner only near a goal
  // boundary, so the replacement is among the next-cheapest plans; a generous bound is enough.
  const MAX_RUNNERS = 500;
  let bestReason = 'No feasible strategy found.';
  // Track the highest HP reachable among plans that DO meet the MP goal. If no plan also meets
  // the HP goal, this lets us report "max reachable HP is X" instead of a confusing mid-search reason.
  let bestHPReach = -1;
  // Highest MP among plans that met the HP goal but missed the MP goal.
  let bestMPReach = -1;

  // Fold a candidate result into the running best / reason / max-HP-reach.
  //
  // Candidates are validated against the per-level walk before being accepted. The analytical sums
  // and levelTable agree to within a wash or two (level-by-level floor() on INT/10, and the MAX_HP
  // clip applied at each step rather than once at the end), and that residual can decide whether a
  // tight plan actually reaches its goals. levelTable is what the user sees, so it is authoritative.
  const consider = (result) => {
    if (!result.feasible) {
      if (!best && result.reason) bestReason = result.reason;
      // Track near-misses so optimize() can name the binding constraint.
      if (result.reach) {
        if (result.reach.hp >= goals.hpGoal && result.reach.mp > bestMPReach) bestMPReach = result.reach.mp;
        if (result.reach.mp >= goals.mpGoal && result.reach.hp > bestHPReach) bestHPReach = result.reach.hp;
      }
      return;
    }
    if (result.finalHP > bestHPReach) bestHPReach = result.finalHP;
    if (result.finalHP >= goals.hpGoal && result.finalMP >= goals.mpGoal) {
      // Keep a shortlist so a winner that fails the per-level walk can be replaced by the next
      // cheapest that survives it. Sized generously: the analytical sums and the walk can differ
      // enough near a goal boundary that the cheapest few analytical plans all miss.
      // Keep only the cheapest candidates: the walk rejects a winner only rarely, and when it
      // does, the replacement is one of the next-cheapest plans. Bounding this set keeps `consider`
      // (the optimizer's hot path) O(1) amortised instead of quadratic in the candidate count.
      // Keep a bounded ordered shortlist of the cheapest candidates. `best` alone is not enough:
      // the walk can reject the analytical winner, and the replacement must be the next-cheapest
      // plan, not an arbitrary one. The bound keeps this hot path from growing without limit.
      if (runners.length < MAX_RUNNERS) {
        const insertAt = runners.findIndex(x => x.apResets > result.apResets);
        if (insertAt === -1) runners.push(result);
        else runners.splice(insertAt, 0, result);
      } else if (result.apResets < runners[runners.length - 1].apResets) {
        const insertAt = runners.findIndex(x => x.apResets > result.apResets);
        runners.splice(insertAt, 0, result);
        runners.length = MAX_RUNNERS;
      }
      if (!best || result.apResets < best.apResets) best = result;
    } else if (result.finalHP >= goals.hpGoal && result.finalMP > bestMPReach) {
      bestMPReach = result.finalMP;
    }
  };

  // The analytical sums and levelTable agree to within a wash or two (level-by-level floor() on
  // INT/10, and the MAX_HP clip applied at each step rather than once at the end). That residual
  // can decide whether a tight plan actually reaches its goals, so re-check the winner against the
  // per-level walk and, if it falls short, keep searching with it excluded. levelTable is what the
  // user sees, so it is authoritative.
  const verifyWithWalk = (result) => {
    const rows = levelTable(classData, currentState, goals, gearInt, mwMultiplier, result);
    const last = rows[rows.length - 1];
    const respectsMinimumMP = rows.every(row => row.mpResetsThisLevel === 0
      || row.level < secondJALevel(classData)
      || row.mp >= minMPAtLevel(classData, row.level));
    const scheduledEveryReset = classData.isMage || last.cumulativeResets === result.apResets;
    const scheduledFresh = rows.reduce((sum, row) => sum + row.freshHPWashesThisLevel, 0);
    const scheduledEveryFreshWash = classData.isMage
      || scheduledFresh === (result.params.preSwapFreshHPResets || 0)
        + result.params.phase3FreshHPResets;
    const respectsCaps = rows.every(row => row.hp <= MAX_HP && row.mp <= MAX_MP
      && (result.params.capWash || row.peakMPThisLevel <= MAX_MP));
    return {
      valid: last.hp >= goals.hpGoal && last.mp >= goals.mpGoal
        && respectsMinimumMP && respectsCaps && scheduledEveryReset && scheduledEveryFreshWash,
      rows,
      last,
    };
  };

  const targetBaseIntCandidates = new Set();
  for (let targetBaseInt = intMin; targetBaseInt <= intMax; targetBaseInt += intStep) {
    targetBaseIntCandidates.add(targetBaseInt);
  }
  // The regular 5-INT grid is anchored to the user's current INT and may never land on a multiple
  // of 10. Include those MP-gain breakpoints explicitly.
  if (!isMage) {
    for (let targetBaseInt = Math.ceil(intMin / 10) * 10; targetBaseInt <= intMax; targetBaseInt += 10) {
      targetBaseIntCandidates.add(targetBaseInt);
    }
  }

  const targetBaseIntList = [...targetBaseIntCandidates].sort((a, b) => a - b);
  for (let intIndex = 0; intIndex < targetBaseIntList.length; intIndex++) {
    const targetBaseInt = targetBaseIntList[intIndex];
    if (reportProgress) {
      reportProgress({
        phase: 'searching',
        completed: intIndex,
        total: targetBaseIntList.length,
      });
    }
    // idealShift makes phase 1 zero-length (start at target INT already).
    const idealShift = targetBaseInt - currentState.baseInt;
    // shift ∈ [minShift, maxShift]. minShift covers "fit phase 1 within remainingLevels"; maxShift covers "fit phase 1 ≥ 0".
    const minShift = Math.max(0, idealShift - 5 * remainingLevels);
    const maxShift = Math.min(maxPositiveShift, idealShift);
    if (minShift > maxShift) continue;

    // Shift candidates: a handful of strategic values rather than a fine sweep.
    const shiftCandidateSet = new Set();
    shiftCandidateSet.add(minShift);
    shiftCandidateSet.add(maxShift);
    if (idealShift >= minShift && idealShift <= maxShift) shiftCandidateSet.add(idealShift);
    if (0 >= minShift && 0 <= maxShift) shiftCandidateSet.add(0);
    // A few intermediate points
    if (maxShift - minShift > 5) {
      shiftCandidateSet.add(Math.floor((minShift + maxShift) / 2));
      shiftCandidateSet.add(Math.floor(minShift + (maxShift - minShift) / 4));
      shiftCandidateSet.add(Math.floor(minShift + 3 * (maxShift - minShift) / 4));
    }
    // MP gains change discontinuously when Base INT crosses a multiple of 10. Include every
    // reachable threshold; sampling only thresholds near the coarse candidates can miss a cheaper
    // plan by dozens of downstream MP Wash cycles.
    const firstThresholdInt = Math.ceil((currentState.baseInt + minShift) / 10) * 10;
    for (let adjustedInt = firstThresholdInt; adjustedInt <= currentState.baseInt + maxShift; adjustedInt += 10) {
      shiftCandidateSet.add(adjustedInt - currentState.baseInt);
    }
    const shiftCandidates = [...shiftCandidateSet].filter(s => s >= minShift && s <= maxShift);

    for (const shift of shiftCandidates) {
      const adjustedStart = currentState.baseInt + shift;
      if (adjustedStart < STARTING_MAIN_STAT || adjustedStart > targetBaseInt) continue;

      // Phase 1 length needed via fresh AP (after shift).
      const phase1IntNeeded = targetBaseInt - adjustedStart;
      const phase1FreshLevels = Math.floor(phase1IntNeeded / 5);
      const naturalMPWashStart = currentState.level + phase1FreshLevels;

      // Search every possible start. Starts before the natural build end overlap MP washing with
      // the INT build via -MP +INT; later starts put the intervening fresh AP directly into Main
      // Stat and avoid MP Wash AP Resets that the MP Goal does not require.
      const mpWashStartCandidates = new Set();
      if (isMage) {
        // Mage strategy is unchanged: there is no pre-swap Main Stat gap because INT is Main Stat.
        mpWashStartCandidates.add(naturalMPWashStart);
        mpWashStartCandidates.add(currentState.level + Math.floor(phase1FreshLevels * 0.5));
        mpWashStartCandidates.add(Math.max(currentState.level, naturalMPWashStart - 10));
        mpWashStartCandidates.add(currentState.level);
      } else {
        for (let L = currentState.level; L <= swapLevel; L++) mpWashStartCandidates.add(L);
      }

      // mpWashStop is no longer searched — it is the user's Swap Level (ADR 0001). For Mages there is
      // no swap, so their stop level stays a search variable feeding the cap-wash endgame.
      const stopCandidates = isMage
        ? (() => { const s = []; for (let L = currentState.level; L <= goals.targetLevel; L++) s.push(L); return s; })()
        : [swapLevel];

      for (const mpWashStart of mpWashStartCandidates) {
        if (mpWashStart < currentState.level || mpWashStart > goals.targetLevel) continue;
        if (!isMage && mpWashStart > swapLevel) continue;

        // Hoist Phase 1 out of the inner loops — Phase 1 depends only on (currentState,
        // mpWashStart, shift).
        const phase1Cache = runPhase1(classData, currentState, { mpWashStart, shift, targetBaseInt }, gearInt, mwMultiplier);
        if (phase1Cache.phase1EndInt > targetBaseInt) continue;

        for (const mpWashStop of stopCandidates) {
          if (mpWashStop < mpWashStart || mpWashStop > goals.targetLevel) continue;

          if (isMage) {
            // Mage endgame: drive MP to the goal/30k cap by mpWashStop, then convert all further
            // inflow to HP (cap-wash). Fresh AP → MP throughout; fresh-AP-to-HP (8/AP) is too weak
            // to compete with converting high-INT MP, so Mages use cap-wash exclusively.
            consider(evaluateCapWash(classData, currentState, goals, gearInt, mwMultiplier, {
              targetBaseInt, mpWashStart, mpWashStop, shift,
            }, ranges, phase1Cache));
            continue;
          }

          // Non-Mages: MP Wash may end before the user-supplied Swap Level. The remaining levels
          // use all fresh AP for HP while retaining Base INT, then the post-swap phase uses the exact
          // number of additional Fresh HP Washes needed.
          const phase3Levels = goals.targetLevel - mpWashStop;
          const maxFresh = phase3Levels * 5;
          const maxStale = mpWashStop >= goals.targetLevel ? 0 : 5;
          const phase3IntMP = intMPContribution(mpWashStop, goals.targetLevel,
            STARTING_MAIN_STAT, STARTING_MAIN_STAT, gearInt, mwMultiplier);
          const buildLevelsNeeded = Math.ceil(Math.max(0,
            targetBaseInt - phase1Cache.phase1EndInt) / 5);
          const earliestMPWashEnd = mpWashStart + buildLevelsNeeded;
          if (earliestMPWashEnd > mpWashStop) continue;
          for (let staleHPPerLevelPhase3 = 0; staleHPPerLevelPhase3 <= maxStale; staleHPPerLevelPhase3++) {
            const phase3StaleHPResets = phase3Levels * staleHPPerLevelPhase3;
            const hpWithoutFresh = currentState.hp + ranges.hpNatural + ranges.hpJA
              + staleHPWashYield(classData, phase3StaleHPResets);
            const totalFreshNeeded = Math.max(0,
              Math.ceil((goals.hpGoal - hpWithoutFresh) / classData.freshAPHP));
            const hpBoundaryEnd = Math.max(earliestMPWashEnd,
              Math.min(mpWashStop, mpWashStop - Math.ceil(totalFreshNeeded / 5)));
            const endCandidates = new Set([earliestMPWashEnd, mpWashStop]);
            for (let delta = -3; delta <= 3; delta++) {
              const endpoint = hpBoundaryEnd + delta;
              if (endpoint >= earliestMPWashEnd && endpoint <= mpWashStop) {
                endCandidates.add(endpoint);
              }
            }

            // Once Target Base INT is built, replacing one pre-Swap Fresh HP level with one MP
            // Wash level adds this fixed MP amount. Estimate the endpoint that first reaches the MP
            // Goal, then inspect its neighbours to absorb floor() and cleanup-wash boundaries.
            const boundaryBase = {
              targetBaseInt, mpWashStart, mpWashEnd: hpBoundaryEnd, mpWashStop, shift,
            };
            const boundaryP2 = runPhase2(classData, boundaryBase,
              phase1Cache, gearInt, mwMultiplier, currentState.level);
            const boundaryPreSwap = runPreSwapFresh(classData, boundaryBase, gearInt, mwMultiplier);
            const boundaryPostFresh = Math.max(0, Math.min(maxFresh,
              totalFreshNeeded - boundaryPreSwap.preSwapFreshHPResets));
            const boundaryStaleNeeded = Math.ceil(Math.max(0, goals.hpGoal
              - hpWithoutFresh - boundaryPreSwap.hpFromFresh
              - freshHPWashYield(classData, boundaryPostFresh)) / classData.staleAPHP);
            const boundaryFinalMP = currentState.mp + ranges.mpNaturalBase + ranges.mpJA
              + phase1Cache.mpFromInt
              + boundaryP2.mpFromInt_build + boundaryP2.mpFromInt_plateau
              + boundaryP2.mpFromMPWash_build + boundaryP2.mpFromMPWash_plateau
              + boundaryPreSwap.mpFromInt + boundaryPreSwap.mpFromResets + phase3IntMP
              - washCycleMPCost(classData,
                phase3StaleHPResets + boundaryPostFresh + boundaryStaleNeeded);
            const freshAPMPGainPerLaterEnd = 5
              * (classData.freshAPMPBase + Math.floor(targetBaseInt / 10));
            const staleReplacementCost = boundaryPostFresh === maxFresh
              && boundaryStaleNeeded > 0
              ? washCycleMPCost(classData,
                Math.ceil(5 * classData.freshAPHP / classData.staleAPHP))
              : 0;
            const mpGainPerLaterEnd = Math.max(1,
              freshAPMPGainPerLaterEnd - staleReplacementCost);
            const mpBoundaryEnd = Math.max(earliestMPWashEnd, Math.min(mpWashStop,
              hpBoundaryEnd + Math.ceil(Math.max(0, goals.mpGoal - boundaryFinalMP)
                / mpGainPerLaterEnd)));
            for (let delta = -3; delta <= 3; delta++) {
              const endpoint = mpBoundaryEnd + delta;
              if (endpoint >= earliestMPWashEnd && endpoint <= mpWashStop) {
                endCandidates.add(endpoint);
              }
            }

            const evaluateEnd = mpWashEnd => {
              const strategyBase = { targetBaseInt, mpWashStart, mpWashEnd, mpWashStop, shift };
              const p2ForFreshCandidates = runPhase2(classData, strategyBase,
                phase1Cache, gearInt, mwMultiplier, currentState.level);
              const preSwap = runPreSwapFresh(classData, strategyBase, gearInt, mwMultiplier);
              const hpBeforeFresh = hpWithoutFresh + preSwap.hpFromFresh;
              const idealFresh = (goals.hpGoal - hpBeforeFresh) / classData.freshAPHP;
              const mpBeforePhase3Resets = currentState.mp + ranges.mpNaturalBase + ranges.mpJA
                + phase1Cache.mpFromInt
                + p2ForFreshCandidates.mpFromInt_build + p2ForFreshCandidates.mpFromInt_plateau
                + p2ForFreshCandidates.mpFromMPWash_build + p2ForFreshCandidates.mpFromMPWash_plateau
                + preSwap.mpFromInt + preSwap.mpFromResets
                + phase3IntMP - washCycleMPCost(classData, phase3StaleHPResets);
              const freshForMPCap = Math.ceil(Math.max(0, mpBeforePhase3Resets - MAX_MP)
                / classData.mpLossPerReset);
              const freshCandidates = new Set();
              for (let delta = -2; delta <= 2; delta++) {
                freshCandidates.add(Math.max(0, Math.min(maxFresh, Math.floor(idealFresh) + delta)));
                freshCandidates.add(Math.max(0, Math.min(maxFresh, Math.ceil(idealFresh) + delta)));
                freshCandidates.add(Math.max(0, Math.min(maxFresh, freshForMPCap + delta)));
              }
              for (const phase3FreshHPResets of freshCandidates) {
                const r = evaluateStrategy(classData, currentState, goals, gearInt, mwMultiplier, {
                  ...strategyBase, phase3FreshHPResets, staleHPPerLevelPhase3,
                }, ranges, phase1Cache);
                consider(r);
              }
            };
            for (const mpWashEnd of endCandidates) evaluateEnd(mpWashEnd);
          }
        }
      }
    }
  }

  // Accept the cheapest candidate that the per-level walk confirms actually reaches both goals.
  runners.sort((a, b) => a.apResets - b.apResets);
  for (const candidate of runners) {
    const walk = verifyWithWalk(candidate);
    if (walk.valid) {
      // Report the walk's numbers so the Summary and the level table always agree.
      candidate.finalHP = walk.last.hp;
      candidate.finalMP = walk.last.mp;
      candidate.params.phase3FreshSchedule = walk.rows
        .filter(row => row.level > candidate.params.mpWashStop
          && row.freshHPWashesThisLevel > 0)
        .map(row => ({ level: row.level, count: row.freshHPWashesThisLevel }));
      return candidate;
    }
  }
  // No plan met both goals. If some plan met the MP goal but fell short on HP, the binding
  // constraint is HP reachability — report the ceiling (clearer than a mid-search reason).
  const swapNote = !isMage && goals.swapLevel && goals.swapLevel < goals.targetLevel
    ? ` A later Swap Level (currently ${goals.swapLevel}) would leave more room to build MP.`
    : '';
  if (bestHPReach >= 0 && bestHPReach < goals.hpGoal) {
    return {
      feasible: false,
      reason: `The most HP reachable at ${goals.mpGoal} MP by level ${goals.targetLevel} is about ${bestHPReach.toLocaleString()} — short of the ${goals.hpGoal.toLocaleString()} HP goal.${swapNote} (Higher HP would need HP equips or HP Challenges, which this calculator doesn't model.)`,
    };
  }
  // Some plans were only rejected on the MP goal. Report how close the best of them got.
  if (bestMPReach >= 0 && bestMPReach < goals.mpGoal) {
    return {
      feasible: false,
      reason: `The most MP reachable at ${goals.hpGoal} HP by level ${goals.targetLevel} is about ${bestMPReach.toLocaleString()} — short of the ${goals.mpGoal.toLocaleString()} MP goal.${swapNote}`,
    };
  }
  return { feasible: false, reason: bestReason };
}

// Generate a Phase Plan description from a chosen strategy result.
function phasePlan(classData, currentState, goals, result) {
  const p = result.params;
  const mpWashEnd = p.mpWashEnd ?? p.mpWashStop;
  const b = result.breakdown;
  const phases = [];
  const apResets = count => `${count} AP Reset${count === 1 ? '' : 's'}`;
  const swapHasFreshAP = !p.capWash && p.mpWashStop > currentState.level;
  const swapUsesMPWash = swapHasFreshAP
    && mpWashEnd === p.mpWashStop && mpWashEnd > p.mpWashStart;
  const swapUsesFreshHP = swapHasFreshAP && mpWashEnd < p.mpWashStop;

  if (b.shift > 0 && b.shiftDir === 'up') {
    phases.push({
      range: `Before levelling`,
      action: `AP Reset ${b.shift} times: -<STR/DEX/LUK> +INT (mid-progress shift; you choose which non-INT stat(s) to draw from).`,
      phase: 'Shift to INT',
    });
  }
  const fromInt = currentState.baseInt + b.shift;
  if (p.phase1BuildEndLevel > currentState.level && p.phase1EndInt > fromInt) {
    phases.push({
      range: `Lvl ${currentState.level} → ${p.phase1BuildEndLevel}`,
      action: `Allocate fresh AP to INT until Base INT reaches ${p.phase1EndInt}; put any remaining AP into ${classData.mainStat}.`,
      phase: 'Build Base INT',
    });
  }
  if (p.phase1FreshAPToMainStat > 0) {
    phases.push({
      range: `Lvl ${Math.max(currentState.level, p.phase1BuildEndLevel)} → ${p.mpWashStart}`,
      action: `Base INT is already ${p.phase1EndInt}. Keep it until the swap and allocate fresh AP to ${classData.mainStat}.`,
      phase: `Build ${classData.mainStat}`,
    });
  }
  const mpWashPlanEnd = swapUsesMPWash ? mpWashEnd - 1 : mpWashEnd;
  if (p.mpWashFirstLevel !== null && mpWashPlanEnd >= p.mpWashFirstLevel) {
    phases.push({
      range: p.mpWashFirstLevel === mpWashPlanEnd
        ? `Lvl ${mpWashPlanEnd}` : `Lvl ${p.mpWashFirstLevel} → ${mpWashPlanEnd}`,
      action: `Allocate fresh AP to MP. 5 AP Resets per level: -MP +INT until Base INT = ${p.targetBaseInt}, then -MP +${classData.mainStat}.`,
      phase: 'MP Wash',
    });
  }
  const preSwapPlanStart = mpWashEnd + 1;
  const preSwapPlanEnd = swapUsesFreshHP ? p.mpWashStop - 1 : p.mpWashStop;
  if (!p.capWash && preSwapPlanStart <= preSwapPlanEnd) {
    phases.push({
      range: preSwapPlanStart === preSwapPlanEnd
        ? `Lvl ${preSwapPlanEnd}` : `Lvl ${preSwapPlanStart} → ${preSwapPlanEnd}`,
      action: `Keep Base INT at ${p.targetBaseInt}. Each level: allocate all 5 fresh AP to HP, then use 5 AP Resets: -MP +${classData.mainStat}.`,
      phase: 'Pre-Swap Fresh HP Wash',
    });
  }
  // === THE SWAP === One event at Swap Level: the MP→HP burst, then Reset Base INT → Main Stat.
  // The burst is free (see runSwapBurst / ADR 0001) — it just moves washes earlier on the schedule.
  if (!p.capWash) {
    const burst = p.swapBurst || 0;
    const intResets = b.intReset;
    // Cleanup lands at Target Level. When the Swap Level IS the target level, it executes in the
    // same row — and before the fresh AP is reclaimed, so the HP/MP Pool is still non-empty.
    const cleanupHere = p.mpWashStop >= goals.targetLevel
      ? (p.cleanupStaleHPWash || 0) : 0;
    const staleAtSwap = burst + cleanupHere;
    const parts = [];
    if (swapUsesMPWash) {
      parts.push('Allocate the first fresh AP to MP, keeping the HP/MP Pool available');
    } else if (swapUsesFreshHP) {
      parts.push('Allocate all 5 fresh AP to HP, keeping the HP/MP Pool available');
    }
    if (burst > 0) parts.push(`${apResets(burst)}: -MP +HP (Stale HP Wash — convert banked MP into HP now)`);
    if (cleanupHere > 0) parts.push(`${apResets(cleanupHere)}: -MP +HP (Stale HP Wash, fill remaining HP gap)`);
    if (swapUsesMPWash) {
      parts.push(`AP Reset -MP +INT/${classData.mainStat} for that AP, then complete the other 4 MP Wash cycles`);
    } else if (swapUsesFreshHP) {
      parts.push(`5 AP Resets: -MP +${classData.mainStat} (reclaim the swap-level fresh AP)`);
    }
    if (intResets > 0) parts.push(`${apResets(intResets)}: -INT +${classData.mainStat} (Reset Base INT — you are playable from here)`);
    if (parts.length > 0) {
      phases.push({
        range: `At Lvl ${p.mpWashStop}${p.mpWashStop < goals.targetLevel ? ' (swap)' : ''}`,
        action: parts.join(' · ') + '.',
        phase: swapUsesFreshHP && staleAtSwap > 0 && intResets > 0 ? 'Fresh + Stale HP Wash + Reset INT'
          : swapUsesFreshHP && intResets > 0 ? 'Fresh HP Wash + Reset INT'
          : swapUsesFreshHP && staleAtSwap > 0 ? 'Fresh + Stale HP Wash'
          : swapUsesFreshHP ? 'Pre-Swap Fresh HP Wash'
          : staleAtSwap > 0 && intResets > 0 ? 'Stale HP Wash + Reset INT'
          : staleAtSwap > 0 ? 'Stale HP Wash'
          : 'Reset Base INT',
      });
    }
  }
  if (p.capWash && goals.targetLevel > p.mpWashStop) {
    // Cap-wash: MP pinned at the goal; each level's inflow (fresh AP → MP + natural) is
    // immediately stale-washed into HP. Total cap washes spread across the phase.
    phases.push({
      range: `Lvl ${p.mpWashStop} → ${goals.targetLevel}`,
      action: `MP is at the cap. Each level: allocate fresh AP to MP, then AP Reset -MP +HP to convert all the level's MP gain into HP (holding MP at ${goals.mpGoal}). ~${p.capWashes} AP Resets total across this phase.`,
      phase: 'MP-Cap HP Wash',
    });
  } else if (goals.targetLevel > p.mpWashStop) {
    const stale = p.staleHPPerLevelPhase3 || 0;
    const phase3Start = p.mpWashStop + 1;
    const scheduledFresh = new Map((p.phase3FreshSchedule || []).map(x => [x.level, x.count]));
    if (scheduledFresh.size === 0 && p.phase3FreshHPResets > 0) {
      let remaining = p.phase3FreshHPResets;
      for (let level = phase3Start; level <= goals.targetLevel && remaining > 0; level++) {
        const count = Math.min(5, remaining);
        scheduledFresh.set(level, count);
        remaining -= count;
      }
    }
    const groups = [];
    for (let level = phase3Start; level <= goals.targetLevel; level++) {
      const count = scheduledFresh.get(level) || 0;
      const last = groups[groups.length - 1];
      if (last && last.count === count) last.end = level;
      else groups.push({ start: level, end: level, count });
    }
    for (const group of groups) {
      const parts = [];
      if (group.count > 0) {
        parts.push(`${group.count} fresh AP per level → HP (Fresh HP Wash)`);
        parts.push(`${apResets(group.count)} per level: -MP +${classData.mainStat}`);
        if (group.count < 5) {
          parts.push(`${5 - group.count} remaining fresh AP per level → ${classData.mainStat}`);
        }
      } else {
        parts.push(`Allocate fresh AP to ${classData.mainStat}`);
      }
      if (stale > 0) parts.push(`${apResets(stale)} per level: -MP +HP (Stale HP Wash, absorbs MP)`);
      const phase = group.count > 0 && stale > 0 ? 'Fresh + Stale HP Wash'
        : group.count > 0 ? 'Fresh HP Wash'
        : stale > 0 ? 'Stale HP Wash'
        : `Build ${classData.mainStat}`;
      phases.push({
        range: group.start === group.end ? `Lvl ${group.start}` : `Lvl ${group.start} → ${group.end}`,
        action: parts.join(' · ') + '.',
        phase,
      });
    }
  }
  // Cleanup stale wash at target level (separate from any Phase 3 stale wash; both count toward breakdown.staleHPWash).
  if (p.cleanupStaleHPWash > 0) {
    phases.push({
      range: `At Lvl ${goals.targetLevel}`,
      action: `${apResets(p.cleanupStaleHPWash)}: -MP +HP (Stale HP Wash, fill remaining HP gap).`,
      phase: 'Stale HP Wash',
    });
  }
  return phases;
}

// Generate a level-by-level table. Mirrors the analytical engine's math by sharing the same
// wash-math primitives (washCycleMP, intMPPerLevel, freshHPWashYield, staleHPWashYield,
// washCycleMPCost). Each per-level value is computed with the same formula evaluateStrategy
// used to compute its analytical sum, so the two paths agree.
function levelTable(classData, currentState, goals, gearInt, mwMultiplier, result) {
  const p = result.params;
  const mpWashEnd = p.mpWashEnd ?? p.mpWashStop;
  const rows = [];

  let hp = currentState.hp;
  let mp = currentState.mp;
  let baseInt = currentState.baseInt + (result.breakdown.shiftDir === 'down' ? -result.breakdown.shift : result.breakdown.shift);
  // Main Stat starts at the user's current value and absorbs Base INT at the Swap Level.
  // For Mages the Main Stat IS INT, so the two columns track each other exactly.
  let mainStat = classData.isMage
    ? baseInt
    : (currentState[classData.mainStat.toLowerCase()] ?? STARTING_MAIN_STAT);
  let cumulativeResets = result.breakdown.shift;  // pre-game shift counted at level 0
  let phase3FreshRemaining = p.phase3FreshHPResets || 0;

  for (let L = currentState.level; L <= goals.targetLevel; L++) {
    let resetsThisLevel = 0;
    let mpResetsThisLevel = 0;
    let freshHPWashesThisLevel = 0;
    let phase = '';
    let peakMPThisLevel = mp;

    if (L > currentState.level) {
      // Natural HP/MP gain on level-up to L. Gear is worn iff L >= GEAR_WORN_FROM_LEVEL.
      // INT reset happens AT target level AFTER this level-up's MP gain, so use baseInt and full gearInt here.
      hp += naturalHPGainAtLevel(classData, L);
      mp += naturalMPGainAtLevel(classData, L);
      mp += intMPPerLevel(baseInt, gearInt, mwMultiplier, L);
      // JA bonus this level
      for (const ja of classData.jaBonuses) {
        if (ja.level === L) {
          hp += ja.hp;
          mp += ja.mp;
        }
      }
      hp = Math.min(MAX_HP, hp);
      peakMPThisLevel = Math.max(peakMPThisLevel, mp);
    }

    // Phase classification + actions
    const inPhase1 = classData.isMage ? L < p.mpWashStart : L <= p.mpWashStart;
    if (inPhase1 && L < p.mpWashStop) {
      if (L > currentState.level) {
        const freshToInt = Math.min(5, Math.max(0, p.targetBaseInt - baseInt));
        baseInt += freshToInt;
        mainStat += 5 - freshToInt;
        phase = freshToInt > 0 ? 'Build Base INT' : `Build ${classData.mainStat}`;
      } else {
        phase = baseInt < p.targetBaseInt ? 'Build Base INT' : `Build ${classData.mainStat}`;
      }
    } else if (L < p.mpWashStop && L <= mpWashEnd) {
      phase = 'MP Wash';
      // (Mages keep mainStat === baseInt, handled below.)
      // MP Wash cycles only happen on a level-up (fresh AP), never at the current level.
      if (L > currentState.level) {
        const resetsToInt = Math.min(5, Math.max(0, p.targetBaseInt - baseInt));
        baseInt += resetsToInt;
        // Remaining cycles/lvl go -MP +MainStat once INT is at target.
        mainStat += 5 - resetsToInt;
        // 5 cycles/lvl, each cycle gain = washCycleMP(class, current baseInt).
        const grossWashMP = classData.freshAPMPBase + Math.floor(baseInt / 10);
        peakMPThisLevel = Math.max(peakMPThisLevel,
          mp + grossWashMP + Math.max(0, 4 * washCycleMP(classData, baseInt)));
        mp += 5 * washCycleMP(classData, baseInt);
        resetsThisLevel = 5;
        mpResetsThisLevel = 5;
      }
    } else if (!p.capWash && L < p.mpWashStop) {
      phase = 'Pre-Swap Fresh HP Wash';
      if (L > currentState.level) {
        hp = Math.min(MAX_HP, hp + freshHPWashYield(classData, 5));
        mp -= washCycleMPCost(classData, 5);
        mainStat += 5;
        freshHPWashesThisLevel = 5;
        resetsThisLevel = 5;
        mpResetsThisLevel = 5;
      }
    } else if (!p.capWash && L === p.mpWashStop && L < goals.targetLevel) {
      // === THE SWAP === One event: MP→HP burst, then Reset Base INT → Main Stat (ADR 0001).
      // Its fresh AP follow whichever strategy reaches the boundary: MP Wash when mpWashEnd equals
      // the Swap Level, otherwise pre-Swap Fresh HP Wash.
      let swapFresh = 0;
      let pendingSwapMPResets = 0;
      let postBurstMPWashNet = 0;
      if (L > currentState.level) {
        if (mpWashEnd === p.mpWashStop && mpWashEnd > p.mpWashStart) {
          const resetsToInt = Math.min(5, Math.max(0, p.targetBaseInt - baseInt));
          baseInt += resetsToInt;
          mainStat += 5 - resetsToInt;
          const gross = classData.freshAPMPBase + Math.floor(baseInt / 10);
          const totalNet = 5 * washCycleMP(classData, baseInt);
          // First cycle: fresh AP enters the pool and is drained by the burst below. Remaining
          // cycles run after the burst, so they contribute only their net gain.
          mp += gross;
          peakMPThisLevel = Math.max(peakMPThisLevel, mp);
          pendingSwapMPResets = 1;
          postBurstMPWashNet = totalNet - gross + classData.mpLossPerReset;
          // Track the running peak across all five cycles: cycle 1 is at `mp` (drained by the
          // burst), cycles 2..5 each add `gross` before their own reset.
          let cycleMP = mp;
          for (let cycle = 1; cycle < 5; cycle++) {
            cycleMP += gross;
            peakMPThisLevel = Math.max(peakMPThisLevel, cycleMP);
            cycleMP -= classData.mpLossPerReset;
          }
          resetsThisLevel = 5;
          mpResetsThisLevel = 5;
        } else if (mpWashEnd < p.mpWashStop) {
          swapFresh = 5;
          hp = Math.min(MAX_HP, hp + freshHPWashYield(classData, swapFresh));
          pendingSwapMPResets = swapFresh;
          mainStat += swapFresh;
          freshHPWashesThisLevel = swapFresh;
          resetsThisLevel = swapFresh;
          mpResetsThisLevel = swapFresh;
        } else {
          const freshToInt = Math.min(5, Math.max(0, p.targetBaseInt - baseInt));
          baseInt += freshToInt;
          mainStat += 5 - freshToInt;
        }
      }
      const burst = p.swapBurst || 0;
      const intResets = result.breakdown.intReset;
      if (burst > 0) {
        hp = Math.min(MAX_HP, hp + staleHPWashYield(classData, burst));
        mp -= washCycleMPCost(classData, burst);
      }
      mp -= washCycleMPCost(classData, pendingSwapMPResets);
      mp += postBurstMPWashNet;
      peakMPThisLevel = Math.max(peakMPThisLevel, mp);
      mainStat += intResets;
      baseInt = classData.requiresIntResetAtTarget ? STARTING_MAIN_STAT : baseInt;
      resetsThisLevel += burst + intResets;
      mpResetsThisLevel += burst;
      phase = swapFresh > 0 && burst > 0 && intResets > 0 ? 'Fresh + Stale HP Wash + Reset INT'
        : swapFresh > 0 && intResets > 0 ? 'Fresh HP Wash + Reset INT'
        : swapFresh > 0 && burst > 0 ? 'Fresh + Stale HP Wash'
        : swapFresh > 0 ? 'Pre-Swap Fresh HP Wash'
        : burst > 0 && intResets > 0 ? 'Stale HP Wash + Reset INT'
        : burst > 0 ? 'Stale HP Wash'
        : intResets > 0 ? 'Reset Base INT'
        : 'Done';
    } else if (p.capWash && L < goals.targetLevel) {
      // Cap-wash: fresh AP → MP this level (natural + INT already added above), then convert all
      // MP above the goal into HP via -MP +HP, holding MP at the cap.
      phase = 'MP-Cap HP Wash';
      if (L > currentState.level) {
        mp += 5 * (classData.freshAPMPBase + Math.floor(baseInt / 10));
        peakMPThisLevel = Math.max(peakMPThisLevel, mp);
        if (mp > goals.mpGoal) {
          const washes = Math.floor((mp - goals.mpGoal) / classData.mpLossPerReset);
          hp = Math.min(MAX_HP, hp + staleHPWashYield(classData, washes));
          mp = Math.min(MAX_MP, mp - washCycleMPCost(classData, washes));  // never display above the cap
          resetsThisLevel = washes;
          mpResetsThisLevel = washes;
        }
      }
    } else if (L < goals.targetLevel) {
      const stale = p.staleHPPerLevelPhase3 || 0;
      const affordableResets = L < secondJALevel(classData)
        ? Number.POSITIVE_INFINITY
        : Math.max(0, Math.floor((mp - minMPAtLevel(classData, L)) / classData.mpLossPerReset));
      const fresh = Math.min(5, phase3FreshRemaining, Math.max(0, affordableResets - stale));
      if (fresh > 0 || stale > 0) {
        phase = (fresh > 0 && stale > 0) ? 'Fresh + Stale HP Wash'
              : fresh > 0 ? 'Fresh HP Wash'
              : 'Stale HP Wash';
        if (L > currentState.level) {
          hp = Math.min(MAX_HP, hp + freshHPWashYield(classData, fresh) + staleHPWashYield(classData, stale));
          phase3FreshRemaining -= fresh;
          freshHPWashesThisLevel = fresh;
          // `fresh` AP went to HP; the rest of the level's AP goes to Main Stat. The `fresh`
          // -MP +MainStat resets are the pair described in CONTEXT.md (Post-Swap Fresh HP Wash).
          mainStat += (5 - fresh) + fresh;
          mp -= washCycleMPCost(classData, fresh + stale);
          resetsThisLevel = fresh + stale;
          mpResetsThisLevel = fresh + stale;
        }
      } else {
        phase = `Build ${classData.mainStat}`;
        if (L > currentState.level) mainStat += 5;
      }
    } else if (p.capWash) {
      // Target level under cap-wash: final level's inflow → HP. No INT reset for Mages.
      phase = 'MP-Cap HP Wash';
      if (L > currentState.level) {
        mp += 5 * (classData.freshAPMPBase + Math.floor(baseInt / 10));
        peakMPThisLevel = Math.max(peakMPThisLevel, mp);
        if (mp > goals.mpGoal) {
          const washes = Math.floor((mp - goals.mpGoal) / classData.mpLossPerReset);
          hp = Math.min(MAX_HP, hp + staleHPWashYield(classData, washes));
          mp = Math.min(MAX_MP, mp - washCycleMPCost(classData, washes));  // never display above the cap
          resetsThisLevel = washes;
          mpResetsThisLevel = washes;
        }
      }
    } else {
      // L == targetLevel. Phase 3 spans (mpWashStop, targetLevel] — 80 levels for a 120→200 plan —
      // so the target level's OWN fresh AP and paired resets belong here, not just the levels
      // below it.
      const stale = p.staleHPPerLevelPhase3 || 0;
      const affordableResets = L < secondJALevel(classData)
        ? Number.POSITIVE_INFINITY
        : Math.max(0, Math.floor((mp - minMPAtLevel(classData, L)) / classData.mpLossPerReset));
      const fresh = Math.min(5, phase3FreshRemaining, Math.max(0, affordableResets - stale));
      // When the Swap Level IS the target level, the swap event happens here — the burst and the
      // INT reset both land on this row (the branch above is skipped since L === targetLevel).
      const swapHere = !p.capWash && L === p.mpWashStop;
      let pendingTargetFreshResets = 0;
      if (!swapHere && L > currentState.level) {
        if (fresh > 0 || stale > 0) {
          hp = Math.min(MAX_HP, hp + freshHPWashYield(classData, fresh) + staleHPWashYield(classData, stale));
          phase3FreshRemaining -= fresh;
          freshHPWashesThisLevel = fresh;
          // Apply stale washes while the fresh allocations keep the HP/MP Pool non-empty, then
          // reclaim those fresh AP after target-level cleanup below.
          mp -= washCycleMPCost(classData, stale);
          pendingTargetFreshResets = fresh;
          resetsThisLevel = fresh + stale;
          mpResetsThisLevel = fresh + stale;
          phase = (fresh > 0 && stale > 0) ? 'Fresh + Stale HP Wash'
            : fresh > 0 ? 'Fresh HP Wash'
            : 'Stale HP Wash';
        } else {
          phase = `Build ${classData.mainStat}`;
        }
        mainStat += 5;
      }
      let swapFresh = 0;
      let pendingSwapMPResets = 0;
      let postBurstMPWashNet = 0;
      if (swapHere && L > currentState.level) {
        if (mpWashEnd === p.mpWashStop && mpWashEnd > p.mpWashStart) {
          const resetsToInt = Math.min(5, Math.max(0, p.targetBaseInt - baseInt));
          baseInt += resetsToInt;
          mainStat += 5 - resetsToInt;
          const gross = classData.freshAPMPBase + Math.floor(baseInt / 10);
          const totalNet = 5 * washCycleMP(classData, baseInt);
          mp += gross;
          peakMPThisLevel = Math.max(peakMPThisLevel, mp);
          pendingSwapMPResets = 1;
          postBurstMPWashNet = totalNet - gross + classData.mpLossPerReset;
          let cycleMP = mp;
          for (let cycle = 1; cycle < 5; cycle++) {
            cycleMP += gross;
            peakMPThisLevel = Math.max(peakMPThisLevel, cycleMP);
            cycleMP -= classData.mpLossPerReset;
          }
          resetsThisLevel += 5;
          mpResetsThisLevel += 5;
        } else if (mpWashEnd < p.mpWashStop) {
          swapFresh = 5;
          hp = Math.min(MAX_HP, hp + freshHPWashYield(classData, swapFresh));
          pendingSwapMPResets = swapFresh;
          mainStat += swapFresh;
          freshHPWashesThisLevel = swapFresh;
          resetsThisLevel += swapFresh;
          mpResetsThisLevel += swapFresh;
        } else {
          const freshToInt = Math.min(5, Math.max(0, p.targetBaseInt - baseInt));
          baseInt += freshToInt;
          mainStat += 5 - freshToInt;
        }
      }
      const burstHere = swapHere ? (p.swapBurst || 0) : 0;
      const intResetsHere = swapHere ? result.breakdown.intReset : 0;
      if (burstHere > 0) {
        hp = Math.min(MAX_HP, hp + staleHPWashYield(classData, burstHere));
        mp -= washCycleMPCost(classData, burstHere);
      }
      // Then top up to the HP Goal with whatever the swap burst didn't cover.
      const cleanupStale = p.cleanupStaleHPWash || 0;
      const hpShort = Math.max(0, goals.hpGoal - hp);
      const extraStale = Math.max(cleanupStale, Math.ceil(hpShort / classData.staleAPHP));
      hp = Math.min(MAX_HP, hp + staleHPWashYield(classData, extraStale));
      mp -= washCycleMPCost(classData, extraStale);
      resetsThisLevel += extraStale;
      mpResetsThisLevel += extraStale;
      // Reclaim the fresh AP only after every stale wash; this keeps the shared HP/MP Pool non-empty.
      mp -= washCycleMPCost(classData, pendingSwapMPResets + pendingTargetFreshResets);
      mp += postBurstMPWashNet;
      peakMPThisLevel = Math.max(peakMPThisLevel, mp);
      mainStat += intResetsHere;
      if (swapHere) baseInt = classData.requiresIntResetAtTarget ? STARTING_MAIN_STAT : baseInt;
      resetsThisLevel += burstHere + intResetsHere;
      mpResetsThisLevel += burstHere;
      const staleAtSwap = burstHere + extraStale;
      const swapPhase = swapFresh > 0 && staleAtSwap > 0 && intResetsHere > 0 ? 'Fresh + Stale HP Wash + Reset INT'
        : swapFresh > 0 && intResetsHere > 0 ? 'Fresh HP Wash + Reset INT'
        : swapFresh > 0 && staleAtSwap > 0 ? 'Fresh + Stale HP Wash'
        : swapFresh > 0 ? 'Pre-Swap Fresh HP Wash'
        : staleAtSwap > 0 && intResetsHere > 0 ? 'Stale HP Wash + Reset INT'
        : staleAtSwap > 0 ? 'Stale HP Wash'
        : intResetsHere > 0 ? 'Reset Base INT'
        : '';
      if (!swapHere && freshHPWashesThisLevel > 0 && extraStale > 0) phase = 'Fresh + Stale HP Wash';
      else if (swapHere && swapPhase) phase = swapPhase;
      else if (extraStale > 0) phase = 'Stale HP Wash';
      else if (!phase) phase = 'Done';
    }

    cumulativeResets += resetsThisLevel;

    rows.push({
      level: L,
      hp: Math.round(hp),
      mp: Math.round(mp),
      peakMPThisLevel: Math.round(peakMPThisLevel),
      baseInt: Math.round(baseInt),
      // Mages: Main Stat IS INT, so reflect it rather than tracking a separate counter.
      mainStat: Math.round(classData.isMage ? baseInt : mainStat),
      phase,
      freshHPWashesThisLevel,
      mpResetsThisLevel,
      resetsThisLevel,
      cumulativeResets,
    });
  }

  return rows;
}
