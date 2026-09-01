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

// Phase 1: INT build via fresh AP from currentLevel → mpWashStart.
// 5 AP per level allocated to INT; Base INT rises from `startBaseInt` to `phase1EndInt`.
function runPhase1(classData, currentState, params, gearInt, mwMultiplier) {
  const { mpWashStart, shift } = params;
  const startBaseInt = currentState.baseInt + shift;
  const phase1Levels = mpWashStart - currentState.level;
  const phase1EndInt = startBaseInt + 5 * phase1Levels;
  const mpFromInt = intMPContribution(currentState.level, mpWashStart, startBaseInt, phase1EndInt, gearInt, mwMultiplier);
  return { startBaseInt, phase1EndInt, mpFromInt };
}

// Phase 2: MP Wash from mpWashStart → mpWashStop. 5 AP Resets/level: -MP +INT until Base INT
// reaches `targetBaseInt`, then -MP +MainStat for remaining plateau levels.
//
// Levels are (mpWashStart, mpWashStop] — the level-up AT mpWashStop is the last MP wash, and the
// swap burst + INT reset happen after it. `levelTable` classifies level mpWashStop as the swap
// event, so this must match or the two paths drift by one level of MP-wash yield.
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
  const { phase1EndInt } = phase1;

  // MP Wash needs a level-up (fresh AP), so the level the character is ALREADY at yields nothing.
  // Wash levels are therefore (max(mpWashStart, currentLevel), mpWashStop] — matching levelTable,
  // which washes `L < mpWashStop && L > currentLevel` and handles mpWashStop itself in the swap row.
  // Count only levels that actually produce a level-up (and hence fresh AP). The character's
  // current level never yields AP, so when mpWashStart is at/below it the first washing level is
  // currentLevel+1. Span = [firstWashingLevel, mpWashStop], inclusive — matching levelTable, which
  // washes `L < mpWashStop && L > currentLevel` and applies mpWashStop itself in the swap row.
  // A zero-length Phase 2 (mpWashStart === mpWashStop) contributes nothing.
  if (mpWashStop <= mpWashStart) {
    const zero = { ...zeroPhase2(phase1EndInt, targetBaseInt) };
    return zero;
  }
  const firstWashingLevel = Math.max(mpWashStart, (currentLevel ?? mpWashStart) + 1);
  const phase2Levels = Math.max(0, mpWashStop - firstWashingLevel + 1);
  const phase2APResets = phase2Levels * 5;
  const intResetsInPhase2 = Math.max(0, targetBaseInt - phase1EndInt);
  const phase2BuildLevels = Math.ceil(intResetsInPhase2 / 5);
  const phase2PlateauLevels = phase2Levels - phase2BuildLevels;
  const phase2BuildEndLevel = mpWashStart + phase2BuildLevels;

  const mpFromInt_build   = intMPContribution(mpWashStart, phase2BuildEndLevel, phase1EndInt, targetBaseInt, gearInt, mwMultiplier);
  const mpFromInt_plateau = intMPContribution(phase2BuildEndLevel, mpWashStop, targetBaseInt, targetBaseInt, gearInt, mwMultiplier);

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

// Phase 3: from mpWashStop (= Swap Level) → targetLevel. Each level can combine `freshHPPerLevelPhase3`
// fresh-AP-to-HP wash AND `staleHPPerLevelPhase3` -MP+HP resets. Each fresh-AP-to-HP is paired with a
// `-MP +MainStat` reset (see CONTEXT.md: Post-Swap Fresh HP Wash), so `freshHPPerLevelPhase3` counts
// both the AP allocations and their accompanying resets. Both drain MP via reset cost.
//
// Base INT is STARTING_MAIN_STAT throughout Phase 3 — the reset to MainStat happened AT the swap.
function runPhase3(classData, params, goals, gearInt, mwMultiplier) {
  const { mpWashStop, freshHPPerLevelPhase3, staleHPPerLevelPhase3 = 0 } = params;
  const phase3Levels = goals.targetLevel - mpWashStop;
  const phase3FreshHPResets = phase3Levels * freshHPPerLevelPhase3;
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
//   (Pre-game) Optional `shift`: AP-Reset `-<non-INT> +INT` (shift > 0; source is any of the user's non-INT stats)
//              or `-INT +MainStat` (shift < 0; Mages can't shift down — their MainStat IS INT).
//   Phase 1 (currentLevel → mpWashStart): Fresh AP → INT. Base INT rises from (currentBaseInt + shift) to phase1EndInt.
//   Phase 2 (mpWashStart → mpWashStop):  MP Wash. Fresh AP → MP. 5 AP Resets/lvl: -MP +INT until targetBaseInt, then -MP +MainStat.
//   Phase 3 (mpWashStop → targetLevel): Combinable per level — `freshHPPerLevelPhase3` fresh-AP→HP (each paired
//              with a -MP +MainStat reset) AND `staleHPPerLevelPhase3` -MP +HP resets (drains MP into HP at the
//              stale rate; required when peak MP would otherwise blow past the 30k cap).
//   At targetLevel: Stale HP wash (-MP +HP) to fill remaining HP gap, then Reset Base INT (-INT +MainStat) to STARTING_MAIN_STAT (skipped for Mages).
//
// Returns { feasible, finalHP, finalMP, apResets, breakdown, params }.
function evaluateStrategy(classData, currentState, goals, gearInt, mwMultiplier, params, ranges, phase1Cache) {
  const { targetBaseInt, mpWashStart, mpWashStop, shift } = params;
  ranges = ranges || precomputeRanges(classData, currentState.level, goals.targetLevel);

  // --- Cross-phase parameter validation ---
  const startBaseInt = currentState.baseInt + shift;
  if (startBaseInt < STARTING_MAIN_STAT) return { feasible: false, reason: 'shift would drop Base INT below starting value' };
  if (startBaseInt > targetBaseInt)      return { feasible: false, reason: 'starting INT after shift exceeds target INT' };
  if (mpWashStart < currentState.level || mpWashStop < mpWashStart || mpWashStop > goals.targetLevel) {
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

  // --- Phase 3 ---
  const p3 = runPhase3(classData, params, goals, gearInt, mwMultiplier);

  // MP banked at the Swap Level (end of Phase 2) — before any swap burst.
  const minMPAtStop = minMPAtLevel(classData, mpWashStop);
  const mpAtSwap = currentState.mp
    + ranges.naturalMPInRange(currentState.level, mpWashStop)
    + ranges.jaMPInRange(currentState.level, mpWashStop)
    + p1.mpFromInt + p2.mpFromInt_build + p2.mpFromInt_plateau
    + p2.mpFromMPWash_build + p2.mpFromMPWash_plateau;

  // HP accumulated by the swap (natural + JA only — no HP washing happens before the swap).
  const hpAtSwapNatural = currentState.hp
    + cumulativeNaturalHP(classData, currentState.level, mpWashStop)
    + jaHPBonusInRange(classData, currentState.level, mpWashStop);

  // Natural HP/MP accrued over the whole plan, for the peak-MP and final checks below.
  const naturalMPInPhase3 = ranges.naturalMPInRange(mpWashStop, goals.targetLevel);
  const jaMPInPhase3 = ranges.jaMPInRange(mpWashStop, goals.targetLevel);

  // --- Swap burst: convert banked MP → HP at the swap (free — see runSwapBurst) ---
  // HP still needed from stale washes once fresh AP→HP and the swap burst have contributed.
  const hpEndPhase3 = currentState.hp + ranges.hpNatural + ranges.hpJA + p3.hpFromFresh + p3.hpFromStale;
  const needWashes = Math.ceil(Math.max(0, goals.hpGoal - hpEndPhase3) / classData.staleAPHP);
  const hpGrowthAfterSwap = (currentState.hp + ranges.hpNatural + ranges.hpJA) - hpAtSwapNatural
    + p3.hpFromFresh + p3.hpFromStale;
  const mpNetAfterSwap = naturalMPInPhase3 + jaMPInPhase3 + p3.mpFromInt + p3.mpFromResets;
  const swapBurst = runSwapBurst(classData, mpAtSwap, hpAtSwapNatural, needWashes, minMPAtStop, hpGrowthAfterSwap, mpNetAfterSwap, goals.mpGoal);
  const hpAtSwap = hpAtSwapNatural + staleHPWashYield(classData, swapBurst.burst);

  const mpEndPhase2 = swapBurst.mpAfterBurst;
  const mpEndPhase3Raw = swapBurst.mpAfterBurst
    + naturalMPInPhase3 + jaMPInPhase3 + p3.mpFromInt + p3.mpFromResets;

  // --- 30k caps + Min MP/HP invariant checks ---
  const peakMP = Math.max(mpEndPhase2, mpEndPhase3Raw);
  if (peakMP > MAX_MP) return { feasible: false, reason: `Plan overshoots the 30,000 MP cap (peak would reach ${Math.round(peakMP)})` };
  if (hpEndPhase3 > MAX_HP) return { feasible: false, reason: `Plan overshoots the 30,000 HP cap (would reach ${Math.round(hpEndPhase3)})` };

  // Min MP only binds once you try to -MP +X reset at that level. A character below 2nd job
  // legitimately sits under the Min MP formula (a fresh lvl 1 has MP 5 vs a formula value of ~149),
  // exactly as CONTEXT.md documents for Current HP/MP. So enforce it only where resets drain MP —
  // i.e. from the first MP-wash cycle onward, and only if that level is at/after 2nd job.
  const mpAtMPWashStart = currentState.mp
    + ranges.naturalMPInRange(currentState.level, mpWashStart)
    + ranges.jaMPInRange(currentState.level, mpWashStart)
    + p1.mpFromInt;
  const minMPAtStart = minMPAtLevel(classData, mpWashStart);
  if (mpWashStart >= secondJALevel(classData) && mpAtMPWashStart < minMPAtStart) {
    return { feasible: false, reason: `MP at lvl ${mpWashStart} (${Math.round(mpAtMPWashStart)}) would be below Min MP (${minMPAtStart})` };
  }
  if (mpEndPhase2 < minMPAtStop) {
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
  const apResets = p2.phase2APResets + p3.phase3FreshHPResets + p3.phase3StaleHPResets
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
      phase3Fresh: p3.phase3FreshHPResets,
      intReset: cleanup.intResetAPResets,
      staleHPWash: totalStaleHPWash,
    },
    params: {
      ...params,
      phase1EndInt: p1.phase1EndInt,
      phase2BuildEndLevel: p2.phase2BuildEndLevel,
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
      phase1EndInt: p1.phase1EndInt,
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
      freshHPPerLevelPhase3: 0,
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
function optimize(classData, currentState, goals, gearInt, mwMultiplier) {
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
  const maxNegativeShift = classData.canShiftIntDownToMainStat ? Math.max(0, currentState.baseInt - STARTING_MAIN_STAT) : 0;

  // Precompute range sums (these depend only on class + currentLevel + targetLevel, not strategy).
  const ranges = precomputeRanges(classData, currentState.level, goals.targetLevel);

  // Target Base INT range. Allow values BELOW current Base INT (via shift-down).
  const intMin = STARTING_MAIN_STAT;
  // Cap: largest INT we could reach via shift-up + all fresh AP. No reason to go higher.
  const intMax = Math.min(2000, currentState.baseInt + maxPositiveShift + 5 * remainingLevels);
  const intStep = 5;

  let best = null;
  // Shortlist of the cheapest candidates, kept so a winner that fails the per-level walk can be
  // replaced by the next-cheapest that survives it.
  const runners = [];
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
      const insertAt = runners.findIndex(x => x.apResets > result.apResets);
      if (insertAt === -1) runners.push(result); else runners.splice(insertAt, 0, result);
      if (runners.length > 40) runners.length = 40;
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
    const last = levelTable(classData, currentState, goals, gearInt, mwMultiplier, result).pop();
    return last.hp >= goals.hpGoal && last.mp >= goals.mpGoal;
  };

  for (let targetBaseInt = intMin; targetBaseInt <= intMax; targetBaseInt += intStep) {
    // idealShift makes phase 1 zero-length (start at target INT already).
    const idealShift = targetBaseInt - currentState.baseInt;
    // shift ∈ [minShift, maxShift]. minShift covers "fit phase 1 within remainingLevels"; maxShift covers "fit phase 1 ≥ 0".
    const minShift = Math.max(-maxNegativeShift, idealShift - 5 * remainingLevels);
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
    const shiftCandidates = [...shiftCandidateSet].filter(s => s >= minShift && s <= maxShift);

    for (const shift of shiftCandidates) {
      const adjustedStart = currentState.baseInt + shift;
      if (adjustedStart < STARTING_MAIN_STAT || adjustedStart > targetBaseInt) continue;

      // Phase 1 length needed via fresh AP (after shift).
      const phase1IntNeeded = targetBaseInt - adjustedStart;
      const phase1FreshLevels = Math.floor(phase1IntNeeded / 5);
      const naturalMPWashStart = currentState.level + phase1FreshLevels;

      // MP-wash-start candidates: the no-overlap natural value plus 2 "overlap" candidates
      // where MP wash starts earlier (Phase 2 builds the remaining INT via -MP +INT cycles).
      const mpWashStartCandidates = new Set();
      mpWashStartCandidates.add(naturalMPWashStart);
      // Earlier candidates — make Phase 1 shorter
      const earlier1 = currentState.level + Math.floor(phase1FreshLevels * 0.5);
      const earlier2 = Math.max(currentState.level, currentState.level + phase1FreshLevels - 10);
      mpWashStartCandidates.add(earlier1);
      mpWashStartCandidates.add(earlier2);
      mpWashStartCandidates.add(currentState.level);  // Full overlap (no Phase 1)

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

          // Non-Mages: Post-Swap Fresh HP Wash. Each post-swap level spends its fresh AP on HP and
          // pairs it with a `-MP +MainStat` reset. Per CONTEXT.md the rate is set as high as the
          // MP Goal allows (max 5/level), falling back only when a lower rate is forced. Total
          // AP Resets are invariant to the rate (a Main Stat point and a stale HP point cost the
          // same reset and the same MP), so we try 5 first and stop at the first feasible rate —
          // never searching lower out of preference.
          // When the Swap Level IS the Target Level there is no post-swap stretch, so Phase 3 must
          // be empty — a non-zero rate would book fresh AP + resets on levels that don't exist.
          const maxFresh = mpWashStop >= goals.targetLevel ? 0 : 5;
          const maxStale = mpWashStop >= goals.targetLevel ? 0 : 5;
          // Search EVERY rate and let consider() keep the cheapest. A higher pairing rate is only
          // worth paying for when it's the cheapest way to reach the HP Goal — when the goal is
          // already met (or overshot), a lower rate is strictly cheaper, so settling on the highest
          // feasible rate would spend resets on HP nobody asked for.
          for (let freshHPPerLevelPhase3 = maxFresh; freshHPPerLevelPhase3 >= 0; freshHPPerLevelPhase3--) {
            for (let staleHPPerLevelPhase3 = 0; staleHPPerLevelPhase3 <= maxStale; staleHPPerLevelPhase3++) {
              const r = evaluateStrategy(classData, currentState, goals, gearInt, mwMultiplier, {
                targetBaseInt, mpWashStart, mpWashStop, shift, freshHPPerLevelPhase3, staleHPPerLevelPhase3,
              }, ranges, phase1Cache);
              consider(r);
            }
          }
        }
      }
    }
  }

  // Accept the cheapest candidate that the per-level walk confirms actually reaches both goals.
  for (const candidate of runners) {
    if (verifyWithWalk(candidate)) {
      const last = levelTable(classData, currentState, goals, gearInt, mwMultiplier, candidate).pop();
      // Report the walk's numbers so the Summary and the level table always agree.
      candidate.finalHP = last.hp;
      candidate.finalMP = last.mp;
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
  const b = result.breakdown;
  const phases = [];

  if (b.shift > 0 && b.shiftDir === 'up') {
    phases.push({
      range: `Before levelling`,
      action: `AP Reset ${b.shift} times: -<STR/DEX/LUK> +INT (mid-progress shift; you choose which non-INT stat(s) to draw from).`,
      phase: 'Shift to INT',
    });
  } else if (b.shift > 0 && b.shiftDir === 'down') {
    phases.push({
      range: `Before levelling`,
      action: `AP Reset ${b.shift} times: -INT +${classData.mainStat} (reduce over-built INT).`,
      phase: 'Shift from INT',
    });
  }
  if (p.mpWashStart > currentState.level) {
    const fromInt = currentState.baseInt + (b.shiftDir === 'down' ? -b.shift : b.shift);
    phases.push({
      range: `Lvl ${currentState.level} → ${p.mpWashStart}`,
      action: `Allocate fresh AP to INT. Build Base INT from ${fromInt} to ${p.phase1EndInt}.`,
      phase: 'Build Base INT',
    });
  }
  if (p.mpWashStop > p.mpWashStart) {
    phases.push({
      range: `Lvl ${p.mpWashStart} → ${p.mpWashStop}`,
      action: `Allocate fresh AP to MP. 5 AP Resets per level: -MP +INT until Base INT = ${p.targetBaseInt}, then -MP +${classData.mainStat}.`,
      phase: 'MP Wash',
    });
  }
  // === THE SWAP === One event at Swap Level: the MP→HP burst, then Reset Base INT → Main Stat.
  // The burst is free (see runSwapBurst / ADR 0001) — it just moves washes earlier on the schedule.
  if (!p.capWash && p.mpWashStop < goals.targetLevel) {
    const burst = p.swapBurst || 0;
    const intResets = b.intReset;
    const parts = [];
    if (burst > 0) parts.push(`${burst} AP Resets: -MP +HP (Stale HP Wash — convert banked MP into HP now)`);
    if (intResets > 0) parts.push(`${intResets} AP Resets: -INT +${classData.mainStat} (Reset Base INT — you are playable from here)`);
    if (parts.length > 0) {
      phases.push({
        range: `At Lvl ${p.mpWashStop} (swap)`,
        action: parts.join(' · ') + '.',
        phase: burst > 0 && intResets > 0 ? 'Stale HP Wash + Reset INT'
          : burst > 0 ? 'Stale HP Wash'
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
    const fresh = p.freshHPPerLevelPhase3;
    const stale = p.staleHPPerLevelPhase3 || 0;
    if (fresh > 0 || stale > 0) {
      const parts = [];
      if (fresh > 0) parts.push(`${fresh} fresh AP per level → HP (Fresh HP Wash) + ${fresh} AP Resets: -MP +${classData.mainStat}`);
      if (stale > 0) parts.push(`${stale} AP Resets per level: -MP +HP (Stale HP Wash, absorbs MP)`);
      const phaseName = (fresh > 0 && stale > 0) ? 'Fresh + Stale HP Wash'
                      : fresh > 0 ? 'Fresh HP Wash'
                      : 'Stale HP Wash';
      phases.push({
        range: `Lvl ${p.mpWashStop} → ${goals.targetLevel}`,
        action: parts.join(' · ') + '.',
        phase: phaseName,
      });
    } else {
      phases.push({
        range: `Lvl ${p.mpWashStop} → ${goals.targetLevel}`,
        action: `Allocate fresh AP to ${classData.mainStat}.`,
        phase: `Build ${classData.mainStat}`,
      });
    }
  }
  // Cleanup stale wash at target level (separate from any Phase 3 stale wash; both count toward breakdown.staleHPWash).
  if (p.cleanupStaleHPWash > 0) {
    phases.push({
      range: `At Lvl ${goals.targetLevel}`,
      action: `${p.cleanupStaleHPWash} AP Resets: -MP +HP (Stale HP Wash, fill remaining HP gap).`,
      phase: 'Stale HP Wash',
    });
  }
  // Reset Base INT only appears here when the swap IS the target level; otherwise it was already
  // emitted as part of the swap event above (ADR 0001).
  if (b.intReset > 0 && p.mpWashStop >= goals.targetLevel) {
    phases.push({
      range: `At Lvl ${goals.targetLevel}`,
      action: `${b.intReset} AP Resets: -INT +${classData.mainStat} (Reset Base INT).`,
      phase: 'Reset Base INT',
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

  for (let L = currentState.level; L <= goals.targetLevel; L++) {
    let resetsThisLevel = 0;
    let phase = '';

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
    }

    // Phase classification + actions
    if (L < p.mpWashStart) {
      phase = 'Build Base INT';
      if (L > currentState.level) baseInt += 5;
    } else if (L < p.mpWashStop) {
      phase = 'MP Wash';
      // (Mages keep mainStat === baseInt, handled below.)
      // MP Wash cycles only happen on a level-up (fresh AP), never at the current level.
      if (L > currentState.level) {
        const resetsToInt = Math.min(5, Math.max(0, p.targetBaseInt - baseInt));
        baseInt += resetsToInt;
        // Remaining cycles/lvl go -MP +MainStat once INT is at target.
        mainStat += 5 - resetsToInt;
        // 5 cycles/lvl, each cycle gain = washCycleMP(class, current baseInt).
        mp += 5 * washCycleMP(classData, baseInt);
        resetsThisLevel = 5;
      }
    } else if (!p.capWash && L === p.mpWashStop && L < goals.targetLevel) {
      // === THE SWAP === One event: MP→HP burst, then Reset Base INT → Main Stat (ADR 0001).
      // Level mpWashStop IS an MP-wash level (Phase 2 spans (mpWashStart, mpWashStop]), so apply
      // its 5 -MP +X resets here — the `L < mpWashStop` branch above handles only the levels below
      // it, so without this the swap level's own wash would be dropped entirely.
      if (L > currentState.level) {
        const resetsToInt = Math.min(5, Math.max(0, p.targetBaseInt - baseInt));
        baseInt += resetsToInt;
        mainStat += 5 - resetsToInt;
        mp += 5 * washCycleMP(classData, baseInt);
        resetsThisLevel = 5;
      }
      const burst = p.swapBurst || 0;
      const intResets = result.breakdown.intReset;
      if (burst > 0) {
        hp = Math.min(MAX_HP, hp + staleHPWashYield(classData, burst));
        mp -= washCycleMPCost(classData, burst);
      }
      mainStat += intResets;
      baseInt = classData.requiresIntResetAtTarget ? STARTING_MAIN_STAT : baseInt;
      resetsThisLevel += burst + intResets;
      phase = burst > 0 && intResets > 0 ? 'Stale HP Wash + Reset INT'
        : burst > 0 ? 'Stale HP Wash'
        : intResets > 0 ? 'Reset Base INT'
        : 'Done';
    } else if (p.capWash && L < goals.targetLevel) {
      // Cap-wash: fresh AP → MP this level (natural + INT already added above), then convert all
      // MP above the goal into HP via -MP +HP, holding MP at the cap.
      phase = 'MP-Cap HP Wash';
      if (L > currentState.level) {
        mp += 5 * (classData.freshAPMPBase + Math.floor(baseInt / 10));
        if (mp > goals.mpGoal) {
          const washes = Math.floor((mp - goals.mpGoal) / classData.mpLossPerReset);
          hp = Math.min(MAX_HP, hp + staleHPWashYield(classData, washes));
          mp = Math.min(MAX_MP, mp - washCycleMPCost(classData, washes));  // never display above the cap
          resetsThisLevel = washes;
        }
      }
    } else if (L < goals.targetLevel) {
      const fresh = p.freshHPPerLevelPhase3;
      const stale = p.staleHPPerLevelPhase3 || 0;
      if (fresh > 0 || stale > 0) {
        phase = (fresh > 0 && stale > 0) ? 'Fresh + Stale HP Wash'
              : fresh > 0 ? 'Fresh HP Wash'
              : 'Stale HP Wash';
        if (L > currentState.level) {
          hp += freshHPWashYield(classData, fresh) + staleHPWashYield(classData, stale);
          // `fresh` AP went to HP; the rest of the level's AP goes to Main Stat. The `fresh`
          // -MP +MainStat resets are the pair described in CONTEXT.md (Post-Swap Fresh HP Wash).
          mainStat += (5 - fresh) + fresh;
          mp -= washCycleMPCost(classData, fresh + stale);
          resetsThisLevel = fresh + stale;
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
        if (mp > goals.mpGoal) {
          const washes = Math.floor((mp - goals.mpGoal) / classData.mpLossPerReset);
          hp = Math.min(MAX_HP, hp + staleHPWashYield(classData, washes));
          mp = Math.min(MAX_MP, mp - washCycleMPCost(classData, washes));  // never display above the cap
          resetsThisLevel = washes;
        }
      }
    } else {
      // L == targetLevel. Phase 3 spans (mpWashStop, targetLevel] — 80 levels for a 120→200 plan —
      // so the target level's OWN fresh AP and paired resets belong here, not just the levels
      // below it.
      const fresh = p.freshHPPerLevelPhase3;
      const stale = p.staleHPPerLevelPhase3 || 0;
      if (L > currentState.level && (fresh > 0 || stale > 0)) {
        hp += freshHPWashYield(classData, fresh) + staleHPWashYield(classData, stale);
        mainStat += 5;
        mp -= washCycleMPCost(classData, fresh + stale);
        resetsThisLevel = fresh + stale;
      }
      // When the Swap Level IS the target level, the swap event happens here — the burst and the
      // INT reset both land on this row (the branch above is skipped since L === targetLevel).
      // The target level is also the LAST MP-wash level, so apply its 5 -MP +X resets too.
      const swapHere = !p.capWash && L === p.mpWashStop;
      if (swapHere && L > currentState.level) {
        const resetsToInt = Math.min(5, Math.max(0, p.targetBaseInt - baseInt));
        baseInt += resetsToInt;
        mainStat += 5 - resetsToInt;
        mp += 5 * washCycleMP(classData, baseInt);
        resetsThisLevel += 5;
      }
      const burstHere = swapHere ? (p.swapBurst || 0) : 0;
      const intResetsHere = swapHere ? result.breakdown.intReset : 0;
      if (burstHere > 0) {
        hp = Math.min(MAX_HP, hp + staleHPWashYield(classData, burstHere));
        mp -= washCycleMPCost(classData, burstHere);
      }
      mainStat += intResetsHere;
      if (swapHere) baseInt = classData.requiresIntResetAtTarget ? STARTING_MAIN_STAT : baseInt;
      resetsThisLevel += burstHere + intResetsHere;
      // Then top up to the HP Goal with whatever the swap burst didn't cover.
      const cleanupStale = p.cleanupStaleHPWash || 0;
      const hpShort = Math.max(0, goals.hpGoal - hp);
      const extraStale = Math.max(cleanupStale, Math.ceil(hpShort / classData.staleAPHP));
      hp = Math.min(MAX_HP, hp + staleHPWashYield(classData, extraStale));
      mp -= washCycleMPCost(classData, extraStale);
      resetsThisLevel += extraStale;
      const swapPhase = burstHere > 0 && intResetsHere > 0 ? 'Stale HP Wash + Reset INT'
        : burstHere > 0 ? 'Stale HP Wash'
        : intResetsHere > 0 ? 'Reset Base INT'
        : '';
      if (swapHere && extraStale > 0) phase = 'Stale HP Wash';
      else if (swapHere && swapPhase) phase = swapPhase;
      else phase = extraStale > 0 ? 'Stale HP Wash' : 'Done';
    }

    cumulativeResets += resetsThisLevel;

    rows.push({
      level: L,
      hp: Math.round(hp),
      mp: Math.round(mp),
      baseInt: Math.round(baseInt),
      // Mages: Main Stat IS INT, so reflect it rather than tracking a separate counter.
      mainStat: Math.round(classData.isMage ? baseInt : mainStat),
      phase,
      resetsThisLevel,
      cumulativeResets,
    });
  }

  return rows;
}
