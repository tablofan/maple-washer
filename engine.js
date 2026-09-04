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

// Every level-up awards five fresh AP. Third and fourth job advancement award five more.
function freshAPAtLevel(classData, level) {
  return 5 + (classData.advancementAPLevels.includes(level) ? 5 : 0);
}

// Fresh AP earned over (fromLevel, toLevel].
function freshAPInRange(classData, fromLevel, toLevel) {
  if (toLevel <= fromLevel) return 0;
  let total = 5 * (toLevel - fromLevel);
  for (const level of classData.advancementAPLevels) {
    if (level > fromLevel && level <= toLevel) total += 5;
  }
  return total;
}

function baseStatValue(currentState, stat) {
  return stat === 'INT'
    ? currentState.baseInt
    : (currentState[stat.toLowerCase()] ?? STARTING_MAIN_STAT);
}

// AP which must remain in the first-job stat is not available for INT-building or washing.
// Schedule it as early as possible, matching the fresh-character route in Krythan's guides:
// meet the advancement requirement first, then put the remaining AP into INT.
function firstJobAPNeeded(classData, currentState) {
  const requirement = classData.firstJobRequirement;
  if (!requirement || currentState.level >= requirement.level) return 0;
  return Math.max(0,
    requirement.minimum - baseStatValue(currentState, requirement.stat));
}

function firstJobRequirementAPAtLevel(classData, currentState, level) {
  const requirement = classData.firstJobRequirement;
  if (!requirement || currentState.level >= requirement.level
      || level <= currentState.level || level > requirement.level) return 0;
  const needed = firstJobAPNeeded(classData, currentState);
  const earnedBeforeLevel = freshAPInRange(classData, currentState.level, level - 1);
  return Math.max(0, Math.min(freshAPAtLevel(classData, level), needed - earnedBeforeLevel));
}

function usableFreshAPAtLevel(classData, currentState, level) {
  const requirement = classData.firstJobRequirement;
  // A Magician's required INT is itself useful to the washing strategy, so those AP remain usable
  // as Base INT. Every non-INT requirement is a permanent diversion from the strategy budget.
  const reserved = requirement && requirement.stat !== 'INT'
    ? firstJobRequirementAPAtLevel(classData, currentState, level)
    : 0;
  return freshAPAtLevel(classData, level) - reserved;
}

function usableFreshAPInRange(classData, currentState, fromLevel, toLevel) {
  if (toLevel <= fromLevel) return 0;
  const total = freshAPInRange(classData, fromLevel, toLevel);
  const requirement = classData.firstJobRequirement;
  if (!requirement || requirement.stat === 'INT'
      || currentState.level >= requirement.level) return total;
  const needed = firstJobAPNeeded(classData, currentState);
  const allocatedThrough = level => Math.min(needed,
    freshAPInRange(classData, currentState.level,
      Math.min(requirement.level, Math.max(currentState.level, level))));
  return total - Math.max(0, allocatedThrough(toLevel) - allocatedThrough(fromLevel));
}

function levelForUsableFreshAPCount(classData, currentState, fromLevel, toLevel, count) {
  if (count <= 0) return fromLevel;
  let remaining = count;
  for (let level = fromLevel + 1; level <= toLevel; level++) {
    remaining -= usableFreshAPAtLevel(classData, currentState, level);
    if (remaining <= 0) return level;
  }
  return toLevel + 1;
}

// First level in (fromLevel, toLevel] whose cumulative fresh AP reaches `count`.
function levelForFreshAPCount(classData, fromLevel, toLevel, count) {
  if (count <= 0) return fromLevel;
  let remaining = count;
  for (let level = fromLevel + 1; level <= toLevel; level++) {
    remaining -= freshAPAtLevel(classData, level);
    if (remaining <= 0) return level;
  }
  return toLevel + 1;
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
  if (classData.maxMPActivatesAt !== null && L >= classData.maxMPActivatesAt) {
    gain += classData.maxMPBonusPerLevel;
  } else if (classData.partialMaxMPStartsAt !== undefined
      && L >= classData.partialMaxMPStartsAt) {
    gain += classData.partialMaxMPBonusPerLevel;
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
  if (classData.beginnerMinMPFormula && level < firstJALevel(classData)) {
    return Math.max(0, classData.beginnerMinMPFormula(level));
  }
  if (classData.firstJobMinMPFormula && level < secondJALevel(classData)) {
    return Math.max(0, classData.firstJobMinMPFormula(level));
  }
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
// Uses Base INT only — INT Gear and Maple Warrior do NOT amplify this per-cycle yield (per Nise).
function washCycleMP(classData, baseInt) {
  const deficit = classData.mpLossPerReset - classData.freshAPMPBase;
  return Math.floor(baseInt / 10) - deficit;
}

// Per-level MP gained from INT after a level-up: floor((Base INT * MW + INT Gear) / 10).
// INT Gear contributes only if level ≥ GEAR_WORN_FROM_LEVEL. Class-independent (no classData).
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

// Sum floor(value / 10) for `count` consecutive integer values starting at `start`.
function sumIntTenths(start, count) {
  const prefix = end => {
    if (end <= 0) return 0;
    const fullBlocks = Math.floor(end / 10);
    const remainder = end % 10;
    return 10 * fullBlocks * (fullBlocks - 1) / 2 + fullBlocks * remainder;
  };
  return prefix(start + count) - prefix(start);
}

// Sum of INT-driven MP contributions over levels (fromLevel, toLevel] (level-ups at L = fromLevel+1 … toLevel).
// Per Nise: MP Gained LvlUP includes Total INT/10. Per Krythan: MW multiplies the Base-INT portion only.
// Per spec: INT Gear is worn from level GEAR_WORN_FROM_LEVEL onward (lvl 10 by default).
// Per level L: gain = floor((Base_INT_at_L * MW + Gear_INT_at_L) / 10), via intMPPerLevel().
//
// For plateau ranges (startInt === endInt) the sum is computed as `levels * intMPPerLevel(...)`.
// For ramp ranges, this iterates per level using the same `+5 INT per level, capped at endInt`
// rule that levelTable() applies — so the analytical sum here and the per-level walk in
// levelTable always agree exactly. This is the contract that lets us drop the test tolerance.
function intMPContribution(classData, fromLevel, toLevel, startInt, endInt, gearInt, mwMultiplier, currentState) {
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
    const freshAP = currentState
      ? usableFreshAPAtLevel(classData, currentState, L)
      : freshAPAtLevel(classData, L);
    intAtL = Math.min(endInt, intAtL + freshAP);
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
  // "Start MP Washing at level L" means a Mage uses the fresh AP earned on reaching L for
  // MP washing. Non-Mage Phase 2 starts on the following level. Keep that boundary consistent
  // with levelTable() so Mage AP at the start level is never counted twice.
  const allocationEndLevel = classData.isMage
    ? Math.max(currentState.level, mpWashStart - 1)
    : mpWashStart;
  const phase1FreshAP = usableFreshAPInRange(classData, currentState,
    currentState.level, allocationEndLevel);
  // For Mages Main Stat is INT, so there is no separate Main Stat destination to switch to.
  const phase1EndInt = classData.isMage
    ? startBaseInt + phase1FreshAP
    : Math.min(targetBaseInt, startBaseInt + phase1FreshAP);
  const freshAPToInt = Math.max(0, phase1EndInt - startBaseInt);
  const freshAPToMainStat = phase1FreshAP - freshAPToInt;
  const phase1BuildEndLevel = levelForUsableFreshAPCount(classData, currentState,
    currentState.level, allocationEndLevel, freshAPToInt);
  // Include the MP gained while levelling *to* mpWashStart. Its AP is allocated afterward,
  // so capping the ramp at phase1EndInt produces the correct pre-wash INT for that level-up.
  const mpFromInt = intMPContribution(classData, currentState.level, mpWashStart,
    startBaseInt, phase1EndInt, gearInt, mwMultiplier, currentState);
  return { startBaseInt, phase1EndInt, freshAPToInt, freshAPToMainStat, phase1BuildEndLevel, mpFromInt };
}

// Phase 2: MP Wash from mpWashStart → mpWashEnd. Every available fresh AP is washed: -MP +INT
// until Base INT reaches `targetBaseInt`, then -MP +MainStat for remaining plateau AP.
//
// Levels are (mpWashStart, mpWashEnd]. For non-Mages, mpWashEnd may precede mpWashStop (the user's
// Swap Level), leaving a suffix for pre-Swap Fresh HP Wash while Base INT is retained.
// Zero-length Phase 2: no MP wash, so no resets and no MP from washing.
function zeroPhase2(phase1EndInt, targetBaseInt) {
  return {
    phase2APResets: 0,
    intResetsInPhase2: Math.max(0, targetBaseInt - phase1EndInt),
    mpWashIntResets: Math.max(0, targetBaseInt - phase1EndInt),
    directFreshToInt: 0,
    phase2BuildLevels: 0,
    phase2BuildEndLevel: 0,
    phase2PlateauLevels: 0,
    mpFromInt_build: 0, mpFromInt_plateau: 0,
    mpFromMPWash_build: 0, mpFromMPWash_plateau: 0,
    phase2EndInt: phase1EndInt,
  };
}

function runPhase2(classData, params, phase1, gearInt, mwMultiplier, currentStateOrLevel) {
  const { mpWashStart, mpWashStop, targetBaseInt } = params;
  const mpWashEnd = params.mpWashEnd ?? mpWashStop;
  const boundaryFresh = params.preSwapFreshAtBoundary || 0;
  const { phase1EndInt } = phase1;
  const currentState = typeof currentStateOrLevel === 'object' ? currentStateOrLevel : null;
  const currentLevel = currentState ? currentState.level : currentStateOrLevel;

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
  const phase2FreshAP = phase2Levels > 0
    ? (currentState
      ? usableFreshAPInRange(classData, currentState, firstWashingLevel - 1, mpWashEnd)
      : freshAPInRange(classData, firstWashingLevel - 1, mpWashEnd))
    : 0;
  const maxBoundaryFresh = phase2Levels > 0
    ? (currentState
      ? usableFreshAPAtLevel(classData, currentState, mpWashEnd)
      : freshAPAtLevel(classData, mpWashEnd))
    : 0;
  if (boundaryFresh < 0 || boundaryFresh > maxBoundaryFresh) {
    return { ...zeroPhase2(phase1EndInt, targetBaseInt), invalid: true };
  }
  const phase2APResets = phase2FreshAP - boundaryFresh;
  // Every Mage AP ultimately belongs in INT: washed AP return via -MP +INT and boundary AP go
  // directly to INT. For other classes, only the portion needed to reach Target Base INT does so.
  const intResetsInPhase2 = classData.isMage
    ? phase2FreshAP
    : Math.max(0, targetBaseInt - phase1EndInt);
  const directFreshToInt = classData.isMage ? boundaryFresh : 0;
  const mpWashIntResets = classData.isMage
    ? phase2APResets
    : Math.max(0, intResetsInPhase2 - directFreshToInt);
  const phase2EndInt = classData.isMage
    ? phase1EndInt + phase2FreshAP
    : targetBaseInt;
  const phase2BuildEndLevel = currentState
    ? levelForUsableFreshAPCount(classData, currentState,
      firstWashingLevel - 1, mpWashEnd, intResetsInPhase2)
    : levelForFreshAPCount(classData,
      firstWashingLevel - 1, mpWashEnd, intResetsInPhase2);
  const phase2BuildLevels = intResetsInPhase2 > 0
    ? phase2BuildEndLevel - firstWashingLevel + 1 : 0;
  const phase2PlateauLevels = phase2Levels - phase2BuildLevels;

  let mpFromInt_build;
  if (classData.isMage) {
    // Mage washing starts on mpWashStart itself. The level-up MP at that level is already in
    // Phase 1, but its fresh AP are allocated afterward and must affect the next level's INT MP.
    // Seed the walk with those start-level allocations to avoid lagging one level behind the
    // schedule (notably by 10 INT when level 70 also awards advancement AP).
    let intAtLevel = phase1EndInt;
    if (mpWashStart > currentLevel) {
      intAtLevel += currentState
        ? usableFreshAPAtLevel(classData, currentState, mpWashStart)
        : freshAPAtLevel(classData, mpWashStart);
    }
    mpFromInt_build = 0;
    for (let level = mpWashStart + 1; level <= mpWashEnd; level++) {
      mpFromInt_build += intMPPerLevel(intAtLevel, gearInt, mwMultiplier, level);
      intAtLevel += currentState
        ? usableFreshAPAtLevel(classData, currentState, level)
        : freshAPAtLevel(classData, level);
    }
  } else {
    mpFromInt_build = intMPContribution(classData, mpWashStart, mpWashEnd,
      phase1EndInt, phase2EndInt, gearInt, mwMultiplier, currentState);
  }
  const mpFromInt_plateau = 0;

  // During an INT-building MP Wash, each fresh AP sees the Base INT from before its own
  // -MP +INT reset. Sum the integer INT/10 breakpoints exactly without entering the hot-loop.
  const buildCycles = Math.min(mpWashIntResets, phase2APResets);
  const washBaseNet = classData.freshAPMPBase - classData.mpLossPerReset;
  const mpFromMPWash_build = buildCycles * washBaseNet
    + sumIntTenths(phase1EndInt, buildCycles);
  const plateauCycles = Math.max(0, phase2APResets - buildCycles);
  const mpFromMPWash_plateau = plateauCycles * washCycleMP(classData, targetBaseInt);

  return {
    phase2APResets, intResetsInPhase2, mpWashIntResets, directFreshToInt, phase2EndInt,
    phase2BuildLevels, phase2BuildEndLevel, phase2PlateauLevels,
    mpFromInt_build, mpFromInt_plateau,
    mpFromMPWash_build, mpFromMPWash_plateau,
  };
}

// After MP Washing ends, non-Mages can retain Base INT and use every fresh AP through the Swap
// Level for Fresh HP Wash. Each allocation is paired with -MP +MainStat, so the character gains HP
// and Main Stat while continuing to receive Base-INT level-up MP until the swap.
function runPreSwapFresh(classData, params, gearInt, mwMultiplier, currentState) {
  const { mpWashStop, targetBaseInt } = params;
  const mpWashEnd = params.mpWashEnd ?? mpWashStop;
  const boundaryFresh = params.preSwapFreshAtBoundary || 0;
  const swapSeedFresh = params.swapSeedFreshHPResets || 0;
  const freshAP = currentState
    ? usableFreshAPInRange(classData, currentState, mpWashEnd, mpWashStop)
    : freshAPInRange(classData, mpWashEnd, mpWashStop);
  const preSwapFreshHPResets = freshAP
    + boundaryFresh + swapSeedFresh;
  return {
    preSwapFreshHPResets,
    hpFromFresh: freshHPWashYield(classData, preSwapFreshHPResets),
    mpFromInt: intMPContribution(classData, mpWashEnd, mpWashStop,
      targetBaseInt, targetBaseInt, gearInt, mwMultiplier, currentState),
    mpFromResets: -washCycleMPCost(classData, preSwapFreshHPResets),
  };
}

// Phase 3: from mpWashStop (= Swap Level) → targetLevel. `phase3FreshHPResets` is the exact total
// number of fresh-AP-to-HP washes, frontloaded up to each level's available AP by levelTable. Each is paired
// with a `-MP +MainStat` reset (see CONTEXT.md: Post-Swap Fresh HP Wash). Phase 3 can also combine
// `staleHPPerLevelPhase3` -MP+HP resets. Both drain MP via reset cost.
//
// Base INT is STARTING_MAIN_STAT throughout Phase 3 — the reset to MainStat happened AT the swap.
function runPhase3(classData, params, goals, gearInt, mwMultiplier, currentState) {
  const { mpWashStop, phase3FreshHPResets = 0, staleHPPerLevelPhase3 = 0 } = params;
  const phase3Levels = goals.targetLevel - mpWashStop;
  const phase3StaleHPResets = phase3Levels * staleHPPerLevelPhase3;

  const hpFromFresh = freshHPWashYield(classData, phase3FreshHPResets);
  const hpFromStale = staleHPWashYield(classData, phase3StaleHPResets);
  const mpFromInt = intMPContribution(classData, mpWashStop, goals.targetLevel,
    STARTING_MAIN_STAT, STARTING_MAIN_STAT, gearInt, mwMultiplier, currentState);
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
//   Phase 2 (mpWashStart → mpWashEnd): MP Wash. Fresh AP → MP, then -MP +INT until targetBaseInt, then -MP +MainStat.
//   Pre-swap (mpWashEnd → mpWashStop): Fresh AP → HP, paired with -MP +MainStat, while retaining Base INT.
//   Phase 3 (mpWashStop → targetLevel): Frontload `phase3FreshHPResets` fresh-AP→HP washes
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
  const p2 = runPhase2(classData, params, p1, gearInt, mwMultiplier, currentState);
  // No reason: this is a per-candidate detail (a given Target Base INT simply doesn't fit the
  // window). Surfacing it would mask the real binding constraint reported by optimize().
  if (p2.invalid || p2.mpWashIntResets > p2.phase2APResets) return { feasible: false };

  const swapSeedFresh = params.swapSeedFreshHPResets || 0;
  if (swapSeedFresh > 0) {
    // This special one-AP seed is taken from otherwise-direct Main Stat AP on a zero-length
    // Phase 2. All other pre-Swap fresh allocations are already represented by the suffix.
    if (classData.isMage || swapSeedFresh !== 1 || mpWashStart !== mpWashStop
        || mpWashEnd !== mpWashStop || mpWashStop <= currentState.level) {
      return { feasible: false, reason: 'invalid swap-level HP/MP Pool seed' };
    }
    const intBeforeSwap = Math.min(targetBaseInt, startBaseInt
      + usableFreshAPInRange(classData, currentState,
        currentState.level, mpWashStop - 1));
    const directAPAtSwap = usableFreshAPAtLevel(classData, currentState, mpWashStop)
      - Math.max(0, targetBaseInt - intBeforeSwap);
    if (directAPAtSwap < swapSeedFresh) {
      return { feasible: false, reason: 'no free swap-level AP is available to seed the HP/MP Pool' };
    }
  }

  const preSwap = runPreSwapFresh(classData, params, gearInt, mwMultiplier, currentState);

  // --- Phase 3 ---
  const p3 = runPhase3(classData, params, goals, gearInt, mwMultiplier, currentState);

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

  // Reject an MP Wash that starts before the character has enough MP to survive its first actual
  // reset row. Checking mpWashStart itself is too early for non-Mages: their first wash is on the
  // following level, whose fresh-AP MP gain can legitimately lift them above Minimum MP.
  if (!classData.isMage && p2.phase2APResets > 0) {
    const firstWashLevel = mpWashStart + 1;
    const firstWashCount = Math.min(usableFreshAPAtLevel(classData, currentState, firstWashLevel),
      p2.phase2APResets);
    const mpBeforeFirstWash = currentState.mp
      + ranges.naturalMPInRange(currentState.level, firstWashLevel)
      + ranges.jaMPInRange(currentState.level, firstWashLevel)
      + p1.mpFromInt
      + intMPContribution(classData, mpWashStart, firstWashLevel,
        p1.phase1EndInt, targetBaseInt, gearInt, mwMultiplier, currentState);
    const firstBuildCycles = Math.min(firstWashCount, p2.mpWashIntResets);
    const firstWashNet = firstBuildCycles
        * (classData.freshAPMPBase - classData.mpLossPerReset)
      + sumIntTenths(p1.phase1EndInt, firstBuildCycles)
      + (firstWashCount - firstBuildCycles) * washCycleMP(classData, targetBaseInt);
    const mpAfterFirstWash = mpBeforeFirstWash + firstWashNet;
    if (firstWashLevel >= secondJALevel(classData)
        && mpAfterFirstWash < minMPAtLevel(classData, firstWashLevel)) {
      return { feasible: false };
    }
  }

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
      + intMPContribution(classData, mpWashEnd, level,
        targetBaseInt, targetBaseInt, gearInt, mwMultiplier, currentState)
      // At the boundary itself, the peak is observed before its Fresh HP paired resets. At later
      // levels those boundary resets and every completed intervening level have already drained MP.
      - washCycleMPCost(classData, level === mpWashEnd ? 0
        : (params.preSwapFreshAtBoundary || 0)
          + usableFreshAPInRange(classData, currentState, mpWashEnd, level - 1))
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
  // With a conservative starting pool of zero, at least one fresh MP/HP allocation must precede
  // any stale -MP +HP operation. One such AP can remain in the shared pool until stale washing is
  // complete and be reclaimed by its already-counted paired reset afterwards.
  const hasHPMPPoolSeed = p2.phase2APResets > 0
    || preSwap.preSwapFreshHPResets > 0 || p3.phase3FreshHPResets > 0;
  if (totalStaleHPWash > 0 && !hasHPMPPoolSeed) {
    return { feasible: false, reason: 'Stale HP Wash requires a fresh AP in the HP/MP Pool' };
  }
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
//   Phase 1 builds INT. From the selected MP-wash start onward, every fresh AP goes +MP and is
//     returned with -MP +INT, so the Mage never stops growing its Main Stat.
//   Once MP reaches the goal/30k cap, additional -MP +HP resets convert the net MP inflow while
//     the ordinary MP Wash continues. The per-level walk models cap clipping exactly.
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
  const p2 = runPhase2(classData, params, p1, gearInt, mwMultiplier, currentState);
  // No reason: per-candidate detail. optimize() reports the real binding constraint.
  if (p2.invalid || p2.mpWashIntResets > p2.phase2APResets) return { feasible: false };

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

  // --- Phase 3: MP-cap HP wash. ---
  // Mages keep every level-up AP in INT. Each fresh AP first MP-washes (+MP, then -MP +INT),
  // and only the resulting excess MP is stale-washed into HP. Krythan's sheet counts both reset
  // groups; sending the fresh AP directly from MP to HP would strand it outside INT and undercount
  // the plan by five resets per ordinary level.
  const capBaseInt = p2.phase2EndInt;
  let finalBaseInt = capBaseInt;
  let phase3MPWashes = 0;
  let capWashes = 0;
  let staleHPWashStartLevel = null;
  let finalMP = mpAtCap;
  let grossMP = mpAtCap;
  // Walk the relatively short cap phase exactly. This preserves the per-level floor(Base INT/10)
  // breakpoints and the real 30k clipping behavior instead of accumulating reusable fractional
  // remainders that the game would have discarded at the cap.
  for (let level = mpWashStop + 1; level <= goals.targetLevel; level++) {
    let generatedThisLevel = naturalMPGainAtLevel(classData, level)
      + intMPPerLevel(finalBaseInt, gearInt, mwMultiplier, level);
    for (const ja of classData.jaBonuses) {
      if (ja.level === level) generatedThisLevel += ja.mp;
    }
    finalMP += generatedThisLevel;
    grossMP += generatedThisLevel;

    const freshAP = usableFreshAPAtLevel(classData, currentState, level);
    phase3MPWashes += freshAP;
    for (let cycle = 0; cycle < freshAP; cycle++) {
      const freshMP = classData.freshAPMPBase + Math.floor(finalBaseInt / 10);
      finalMP += freshMP - classData.mpLossPerReset;
      grossMP += freshMP;
      finalBaseInt++;
    }

    if (finalMP > goals.mpGoal) {
      const washes = Math.floor((finalMP - goals.mpGoal) / classData.mpLossPerReset);
      if (washes > 0 && staleHPWashStartLevel === null) {
        staleHPWashStartLevel = level;
      }
      capWashes += washes;
      finalMP = Math.min(MAX_MP,
        finalMP - washCycleMPCost(classData, washes));
    }
  }

  if (finalMP < goals.mpGoal) {
    return { feasible: false, reason: `This build only generates ${Math.round(finalMP)} MP — short of the ${goals.mpGoal} MP goal` };
  }

  const hpFromCapWash = staleHPWashYield(classData, capWashes);

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
  const apResets = p2.phase2APResets + phase3MPWashes + capWashes
    + intResetAPResets + Math.abs(shift);

  return {
    feasible: true,
    finalHP: Math.round(finalHP),
    finalMP: Math.round(finalMP),
    apResets,
    breakdown: {
      shift: Math.abs(shift),
      shiftDir: shift >= 0 ? 'up' : 'down',
      mpWash: p2.phase2APResets + phase3MPWashes,
      phase3Fresh: 0,
      intReset: intResetAPResets,
      staleHPWash: capWashes,
    },
    params: {
      ...params,
      // For a Mage, Target Base INT is the final INT at the requested level. capBaseInt is the
      // transition-level value used by the MP-cap calculation.
      targetBaseInt: finalBaseInt,
      capBaseInt,
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
      phase2MPWashResets: p2.phase2APResets,
      phase3MPWashResets: phase3MPWashes,
      staleHPWashStartLevel,
      capPhaseMPWashResets: staleHPWashStartLevel === null ? 0
        : usableFreshAPInRange(classData, currentState,
          staleHPWashStartLevel - 1, goals.targetLevel),
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
  const firstJobRequirement = classData.firstJobRequirement;
  if (firstJobRequirement) {
    const currentRequiredStat = baseStatValue(currentState, firstJobRequirement.stat);
    if (currentState.level >= firstJobRequirement.level
        && currentRequiredStat < firstJobRequirement.minimum) {
      return {
        feasible: false,
        reason: `${firstJobRequirement.stat} cannot be below ${firstJobRequirement.minimum} after the level ${firstJobRequirement.level} first job advancement.`,
      };
    }
    if (currentState.level < firstJobRequirement.level
        && currentRequiredStat
          + freshAPInRange(classData, currentState.level, firstJobRequirement.level)
          < firstJobRequirement.minimum) {
      return {
        feasible: false,
        reason: `There is not enough AP remaining to reach ${firstJobRequirement.minimum} ${firstJobRequirement.stat} by the level ${firstJobRequirement.level} first job advancement.`,
      };
    }
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
  // Positive-shift budget = non-INT AP above the permanent class floors. The required first-job
  // stat cannot be reset below its advancement minimum after the job has been taken.
  const str = currentState.str ?? STARTING_MAIN_STAT;
  const dex = currentState.dex ?? STARTING_MAIN_STAT;
  const luk = currentState.luk ?? STARTING_MAIN_STAT;
  const statFloor = stat => firstJobRequirement && firstJobRequirement.stat === stat
    ? firstJobRequirement.minimum
    : STARTING_MAIN_STAT;
  const maxPositiveShift = Math.max(0,
    Math.max(0, str - statFloor('STR'))
      + Math.max(0, dex - statFloor('DEX'))
      + Math.max(0, luk - statFloor('LUK'))
  );
  // Precompute range sums (these depend only on class + currentLevel + targetLevel, not strategy).
  const ranges = precomputeRanges(classData, currentState.level, goals.targetLevel);

  // Existing Base INT stays in place until the Swap Level. Moving it to Main Stat earlier costs
  // the same reset as the eventual swap while discarding its INT-based MP gain, so it is dominated.
  const intMin = firstJobRequirement && firstJobRequirement.stat === 'INT'
      && goals.targetLevel >= firstJobRequirement.level
    ? Math.max(currentState.baseInt, firstJobRequirement.minimum)
    : currentState.baseInt;
  // Cap: largest INT we could reach via shift-up + all fresh AP. No reason to go higher.
  const intMax = Math.min(2000, currentState.baseInt + maxPositiveShift
    + usableFreshAPInRange(classData, currentState,
      currentState.level, goals.targetLevel));
  const intStep = 5;

  let best = null;
  // Shortlist of the cheapest candidates, kept so a winner that fails the per-level walk can be
  // replaced by the next-cheapest that survives it.
  const runnerBuckets = new Map();
  // Keep a small, margin-ranked sample at every reset cost. A single global list can be flooded by
  // thousands of equivalent near-misses at a cheaper cost and never retain the first legal plan.
  const MAX_RUNNERS_PER_COST = 8;
  // Equal-cost plans with more MP/HP headroom are less likely to lose feasibility to a later
  // per-level floor or cap. Prefer them in the bounded walk-verification shortlist instead of
  // letting search order fill the shortlist with exact-boundary near misses.
  const compareRunners = (a, b) => a.apResets - b.apResets
    || b.finalMP - a.finalMP || b.finalHP - a.finalHP;
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
      // Retain candidates by cost, not just one global cheapest slice. The authoritative walk can
      // reject every plan at several consecutive costs, so each later cost needs representation.
      const bucket = runnerBuckets.get(result.apResets) || [];
      const insertAt = bucket.findIndex(x => compareRunners(result, x) < 0);
      if (insertAt === -1) bucket.push(result);
      else bucket.splice(insertAt, 0, result);
      if (bucket.length > MAX_RUNNERS_PER_COST) bucket.length = MAX_RUNNERS_PER_COST;
      runnerBuckets.set(result.apResets, bucket);
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
    const scheduledEveryReset = last.cumulativeResets === result.apResets;
    const scheduledFresh = rows.reduce((sum, row) => sum + row.freshHPWashesThisLevel, 0);
    const scheduledMPWashes = rows.reduce((sum, row) => sum + row.mpWashesThisLevel, 0);
    const scheduledEveryFreshWash = classData.isMage
      || scheduledFresh === (result.params.preSwapFreshHPResets || 0)
        + result.params.phase3FreshHPResets;
    const scheduledEveryMPWash = scheduledMPWashes === result.breakdown.mpWash;
    const respectsHPMPPool = rows.every(row => row.hpMPPoolValid);
    const respectsCaps = rows.every(row => row.hp <= MAX_HP && row.mp <= MAX_MP
      && (result.params.capWash || row.peakMPThisLevel <= MAX_MP));
    return {
      valid: last.hp >= goals.hpGoal && last.mp >= goals.mpGoal
        && respectsMinimumMP && respectsCaps && respectsHPMPPool
        && scheduledEveryReset && scheduledEveryFreshWash && scheduledEveryMPWash,
      rows,
      last,
    };
  };

  const targetBaseIntCandidates = new Set();
  if (isMage) {
    // A Mage never chooses an INT stopping point: every available AP ultimately belongs in INT.
    // Use the reachable maximum as a search ceiling; evaluateCapWash derives the actual INT at
    // the MP/HP transition and at Target Level from the selected levels.
    targetBaseIntCandidates.add(intMax);
  } else {
    for (let targetBaseInt = intMin; targetBaseInt <= intMax; targetBaseInt += intStep) {
      targetBaseIntCandidates.add(targetBaseInt);
    }
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
    const minShift = isMage ? 0 : Math.max(0, idealShift
      - usableFreshAPInRange(classData, currentState,
        currentState.level, goals.targetLevel));
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
      const naturalMPWashStart = levelForUsableFreshAPCount(classData, currentState,
        currentState.level, goals.targetLevel, phase1IntNeeded);
      const phase1FreshLevels = naturalMPWashStart - currentState.level;

      // Search every possible start. Starts before the natural build end overlap MP washing with
      // the INT build via -MP +INT; later starts put the intervening fresh AP directly into Main
      // Stat and avoid MP Wash AP Resets that the MP Goal does not require.
      const mpWashStartCandidates = new Set();
      if (isMage) {
        // With no Swap Level or chosen INT plateau, the only strategic timing choice is which
        // consecutive fresh AP to MP-wash before beginning the MP-cap HP phase. Search every start
        // level so the reset minimum is real rather than dependent on a few sampled levels.
        for (let L = currentState.level; L <= goals.targetLevel; L++) {
          mpWashStartCandidates.add(L);
        }
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
            // Mage endgame: MP Wash continuously from the selected start. This internal boundary
            // lets the evaluator begin checking for MP-cap stale washes; it is not an INT swap and
            // is not exposed as a user choice. Fresh-AP-to-HP (8/AP) is too weak to compete with
            // returning fresh AP to INT and stale-washing the MP profit.
            // The final MP-Wash level may use only a subset of its AP for MP. Any remainder goes
            // directly to INT, avoiding an otherwise artificial whole-level overshoot of 30k MP.
            const boundaryCapacity = mpWashStop > mpWashStart
              ? usableFreshAPAtLevel(classData, currentState, mpWashStop) : 0;
            for (let preSwapFreshAtBoundary = 0;
              preSwapFreshAtBoundary <= boundaryCapacity; preSwapFreshAtBoundary++) {
              consider(evaluateCapWash(classData, currentState, goals, gearInt, mwMultiplier, {
                targetBaseInt, mpWashStart, mpWashStop, shift, preSwapFreshAtBoundary,
              }, ranges, phase1Cache));
            }
            continue;
          }

          // Non-Mages: MP Wash may end before the user-supplied Swap Level. The remaining levels
          // use all fresh AP for HP while retaining Base INT, then the post-swap phase uses the exact
          // number of additional Fresh HP Washes needed.
          const phase3Levels = goals.targetLevel - mpWashStop;
          const maxFresh = usableFreshAPInRange(classData, currentState,
            mpWashStop, goals.targetLevel);
          const maxStale = mpWashStop >= goals.targetLevel ? 0 : 5;
          const phase3IntMP = intMPContribution(classData, mpWashStop, goals.targetLevel,
            STARTING_MAIN_STAT, STARTING_MAIN_STAT, gearInt, mwMultiplier, currentState);
          const earliestMPWashEnd = levelForUsableFreshAPCount(classData, currentState,
            mpWashStart, mpWashStop,
            Math.max(0, targetBaseInt - phase1Cache.phase1EndInt));
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
              phase1Cache, gearInt, mwMultiplier, currentState);
            const boundaryPreSwap = runPreSwapFresh(classData, boundaryBase,
              gearInt, mwMultiplier, currentState);
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
              // A transition level can split its individually allocatable fresh AP between MP and
              // HP. Post-swap Fresh HP Washes strictly dominate sacrificing a boundary MP Wash, so
              // the useful split is the minimum needed after later fresh-AP capacity is exhausted.
              // Zero is retained as the MP-preserving alternative (with stale HP cleanup). Near the
              // MP cap, where a split can also be required to avoid a transient overflow, inspect
              // every AP count on the boundary.
              const maxBoundaryFresh = mpWashEnd > mpWashStart
                ? usableFreshAPAtLevel(classData, currentState, mpWashEnd) - 1 : 0;
              const basePreSwapFresh = usableFreshAPInRange(classData, currentState,
                mpWashEnd, mpWashStop);
              const minimumBoundaryForHP = Math.max(0, Math.min(maxBoundaryFresh,
                totalFreshNeeded - basePreSwapFresh - maxFresh));
              const boundaryCandidates = new Set([0]);
              if (minimumBoundaryForHP > 0) boundaryCandidates.add(minimumBoundaryForHP);

              const zeroBoundaryBase = {
                targetBaseInt, mpWashStart, mpWashEnd, mpWashStop, shift,
                preSwapFreshAtBoundary: 0,
              };
              const zeroBoundaryP2 = runPhase2(classData, zeroBoundaryBase,
                phase1Cache, gearInt, mwMultiplier, currentState);
              const mpAtEndWithoutSplit = currentState.mp
                + ranges.naturalMPInRange(currentState.level, mpWashEnd)
                + ranges.jaMPInRange(currentState.level, mpWashEnd)
                + phase1Cache.mpFromInt
                + zeroBoundaryP2.mpFromInt_build + zeroBoundaryP2.mpFromInt_plateau
                + zeroBoundaryP2.mpFromMPWash_build + zeroBoundaryP2.mpFromMPWash_plateau;
              const boundaryGrossMP = classData.freshAPMPBase + Math.floor(targetBaseInt / 10);
              const requiresExhaustiveBoundary = usableFreshAPAtLevel(classData,
                currentState, mpWashEnd) > 5
                || mpAtEndWithoutSplit > MAX_MP - maxBoundaryFresh * boundaryGrossMP;
              if (requiresExhaustiveBoundary) {
                for (let count = 0; count <= maxBoundaryFresh; count++) {
                  boundaryCandidates.add(count);
                }
              }

              for (const preSwapFreshAtBoundary of boundaryCandidates) {
                const base = {
                  targetBaseInt, mpWashStart, mpWashEnd, mpWashStop, shift,
                  preSwapFreshAtBoundary,
                };
                const p2WithoutSeed = runPhase2(classData, base,
                  phase1Cache, gearInt, mwMultiplier, currentState);
                if (p2WithoutSeed.invalid
                    || p2WithoutSeed.mpWashIntResets > p2WithoutSeed.phase2APResets) continue;
                const preSwapWithoutSeed = runPreSwapFresh(classData, base,
                  gearInt, mwMultiplier, currentState);
                const canUseSwapSeed = p2WithoutSeed.phase2APResets === 0
                  && preSwapWithoutSeed.preSwapFreshHPResets === 0
                  && mpWashStart === mpWashStop && mpWashStop > currentState.level;
                const seedCandidates = canUseSwapSeed ? [0, 1] : [0];

                for (const swapSeedFreshHPResets of seedCandidates) {
                  const strategyBase = { ...base, swapSeedFreshHPResets };
                  const p2ForFreshCandidates = runPhase2(classData, strategyBase,
                    phase1Cache, gearInt, mwMultiplier, currentState);
                  const preSwap = runPreSwapFresh(classData, strategyBase,
                    gearInt, mwMultiplier, currentState);
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
                  if (requiresExhaustiveBoundary) {
                    // Fresh HP dominates stale HP at the same reset/MP cost. Once every boundary
                    // split is being searched, the only useful post-swap count is therefore the
                    // larger of the exact HP need and the count required to absorb the MP cap.
                    // Two successors cover per-level MAX_HP clipping in the authoritative walk.
                    const preferredFresh = Math.max(Math.ceil(idealFresh), freshForMPCap);
                    for (let delta = 0; delta <= 2; delta++) {
                      freshCandidates.add(Math.max(0,
                        Math.min(maxFresh, preferredFresh + delta)));
                    }
                  } else {
                    for (let delta = -2; delta <= 2; delta++) {
                      freshCandidates.add(Math.max(0, Math.min(maxFresh, Math.floor(idealFresh) + delta)));
                      freshCandidates.add(Math.max(0, Math.min(maxFresh, Math.ceil(idealFresh) + delta)));
                      freshCandidates.add(Math.max(0, Math.min(maxFresh, freshForMPCap + delta)));
                    }
                  }
                  for (const phase3FreshHPResets of freshCandidates) {
                    const r = evaluateStrategy(classData, currentState, goals, gearInt, mwMultiplier, {
                      ...strategyBase, phase3FreshHPResets, staleHPPerLevelPhase3,
                    }, ranges, phase1Cache);
                    consider(r);
                  }
                }
              }
            };
            for (const mpWashEnd of endCandidates) evaluateEnd(mpWashEnd);
          }
        }
      }
    }
  }

  // Accept the cheapest candidate that the per-level walk confirms actually reaches both goals.
  const runners = [...runnerBuckets.values()].flat().sort(compareRunners);
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
      candidate.params.mpWashSchedule = walk.rows
        .filter(row => row.mpWashesThisLevel > 0)
        .map(row => ({ level: row.level, count: row.mpWashesThisLevel }));
      candidate.params.preSwapFreshSchedule = walk.rows
        .filter(row => row.level <= candidate.params.mpWashStop
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
  const mpWashSchedule = new Map((p.mpWashSchedule || []).map(x => [x.level, x.count]));
  if (mpWashSchedule.size === 0 && b.mpWash > 0) {
    let remaining = p.phase2MPWashResets ?? b.mpWash;
    for (let level = p.mpWashFirstLevel; level <= mpWashEnd && remaining > 0; level++) {
      const count = Math.min(usableFreshAPAtLevel(classData, currentState, level), remaining);
      mpWashSchedule.set(level, count);
      remaining -= count;
    }
  }
  const preSwapFreshSchedule = new Map((p.preSwapFreshSchedule || [])
    .map(x => [x.level, x.count]));
  if (preSwapFreshSchedule.size === 0 && (p.preSwapFreshHPResets || 0) > 0) {
    if ((p.preSwapFreshAtBoundary || 0) > 0) {
      preSwapFreshSchedule.set(mpWashEnd, p.preSwapFreshAtBoundary);
    }
    for (let level = mpWashEnd + 1; level <= p.mpWashStop; level++) {
      preSwapFreshSchedule.set(level,
        usableFreshAPAtLevel(classData, currentState, level));
    }
    if ((p.swapSeedFreshHPResets || 0) > 0) {
      preSwapFreshSchedule.set(p.mpWashStop,
        (preSwapFreshSchedule.get(p.mpWashStop) || 0) + p.swapSeedFreshHPResets);
    }
  }
  const swapMPWashes = swapHasFreshAP ? (mpWashSchedule.get(p.mpWashStop) || 0) : 0;
  const swapFreshHPWashes = swapHasFreshAP
    ? (preSwapFreshSchedule.get(p.mpWashStop) || 0) : 0;

  if (b.shift > 0 && b.shiftDir === 'up') {
    phases.push({
      range: `Before levelling`,
      action: `AP Reset ${b.shift} times: -<STR/DEX/LUK> +INT (draw only from points above the permanent first-job stat floor).`,
      phase: 'Shift to INT',
    });
  }
  const requiredJobAP = firstJobAPNeeded(classData, currentState);
  if (requiredJobAP > 0) {
    const requirement = classData.firstJobRequirement;
    phases.push({
      range: `By Lvl ${requirement.level}`,
      action: `Allocate ${requiredJobAP} fresh AP to ${requirement.stat} first, reaching the permanent ${requirement.minimum} ${requirement.stat} required for first job advancement. The remaining fresh AP follow the plan below.`,
      phase: 'First Job Requirement',
    });
  }
  const fromInt = currentState.baseInt + b.shift;
  if (p.phase1BuildEndLevel > currentState.level && p.phase1EndInt > fromInt) {
    phases.push({
      range: `Lvl ${currentState.level} → ${p.phase1BuildEndLevel}`,
      action: `After any first-job requirement AP, allocate remaining fresh AP to INT until Base INT reaches ${p.phase1EndInt}; put any remainder into ${classData.mainStat}.`,
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
  const pushSchedule = (schedule, phase, actionForCount) => {
    const mageMPWashOnlyEnd = p.staleHPWashStartLevel === null
      ? goals.targetLevel
      : p.staleHPWashStartLevel - 1;
    const entries = [...schedule.entries()]
      .filter(([level, count]) => (p.capWash ? level <= mageMPWashOnlyEnd : level < p.mpWashStop)
        && count > 0)
      .sort((a, b) => a[0] - b[0]);
    const groups = [];
    for (const [level, count] of entries) {
      const last = groups[groups.length - 1];
      if (last && last.end + 1 === level && last.count === count) last.end = level;
      else groups.push({ start: level, end: level, count });
    }
    for (const group of groups) {
      phases.push({
        range: group.start === group.end ? `Lvl ${group.start}` : `Lvl ${group.start} → ${group.end}`,
      action: actionForCount(group.count),
        phase,
      });
    }
  };
  pushSchedule(mpWashSchedule, 'MP Wash', count => classData.isMage
    ? `Allocate ${count} fresh AP per level to MP, then use ${apResets(count)} per level: -MP +INT.`
    : `Allocate ${count} fresh AP per level to MP, then use ${apResets(count)} per level: -MP +INT until Base INT = ${p.targetBaseInt}, then -MP +${classData.mainStat}.`);
  if (!p.capWash) {
    pushSchedule(preSwapFreshSchedule, 'Pre-Swap Fresh HP Wash', count =>
      `Keep Base INT at ${p.targetBaseInt}. Allocate ${count} fresh AP per level to HP, then use ${apResets(count)} per level: -MP +${classData.mainStat}.`);
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
    if (swapMPWashes > 0) {
      parts.push(`Allocate ${swapMPWashes} fresh AP to MP${staleAtSwap > 0 ? ', keeping the final one in the HP/MP Pool until the stale washes finish' : ''}`);
    }
    if (swapFreshHPWashes > 0) {
      parts.push(`Allocate ${swapFreshHPWashes} fresh AP to HP${staleAtSwap > 0 ? ', keeping the HP/MP Pool available' : ''}`);
    }
    if (burst > 0) parts.push(`${apResets(burst)}: -MP +HP (Stale HP Wash — convert banked MP into HP now)`);
    if (cleanupHere > 0) parts.push(`${apResets(cleanupHere)}: -MP +HP (Stale HP Wash, fill remaining HP gap)`);
    if (swapMPWashes > 0) {
      parts.push(`${apResets(swapMPWashes)}: -MP +INT/${classData.mainStat} (complete the swap-level MP Washes)`);
    }
    if (swapFreshHPWashes > 0) {
      parts.push(`${apResets(swapFreshHPWashes)}: -MP +${classData.mainStat} (reclaim the swap-level fresh AP)`);
    }
    if (intResets > 0) parts.push(`${apResets(intResets)}: -INT +${classData.mainStat} (Reset Base INT — you are playable from here)`);
    if (parts.length > 0) {
      phases.push({
        range: `At Lvl ${p.mpWashStop}${p.mpWashStop < goals.targetLevel ? ' (swap)' : ''}`,
        action: parts.join(' · ') + '.',
        phase: swapFreshHPWashes > 0 && staleAtSwap > 0 && intResets > 0 ? 'Fresh + Stale HP Wash + Reset INT'
          : swapFreshHPWashes > 0 && intResets > 0 ? 'Fresh HP Wash + Reset INT'
          : swapFreshHPWashes > 0 && staleAtSwap > 0 ? 'Fresh + Stale HP Wash'
          : swapFreshHPWashes > 0 ? 'Pre-Swap Fresh HP Wash'
          : swapMPWashes > 0 && intResets > 0 ? 'MP Wash + Reset INT'
          : swapMPWashes > 0 ? 'MP Wash'
          : staleAtSwap > 0 && intResets > 0 ? 'Stale HP Wash + Reset INT'
          : staleAtSwap > 0 ? 'Stale HP Wash'
          : 'Reset Base INT',
      });
    }
  }
  if (p.capWash && p.staleHPWashStartLevel !== null) {
    // Cap-wash: keep MP near the goal while preserving every fresh AP in INT. The fresh AP are
    // MP-washed back into INT first; only the net MP generation is stale-washed into HP.
    phases.push({
      range: `Lvl ${p.staleHPWashStartLevel} → ${goals.targetLevel}`,
      action: `Keep MP near ${goals.mpGoal}. Each level: allocate fresh AP to MP, use AP Resets -MP +INT to keep growing INT, then stale-wash the net MP gain with -MP +HP. ${p.capPhaseMPWashResets} MP Wash resets + ${p.capWashes} Stale HP Wash resets across this phase.`,
      phase: 'MP-Cap HP Wash',
    });
  } else if (goals.targetLevel > p.mpWashStop) {
    const stale = p.staleHPPerLevelPhase3 || 0;
    const phase3Start = p.mpWashStop + 1;
    const scheduledFresh = new Map((p.phase3FreshSchedule || []).map(x => [x.level, x.count]));
    if (scheduledFresh.size === 0 && p.phase3FreshHPResets > 0) {
      let remaining = p.phase3FreshHPResets;
      for (let level = phase3Start; level <= goals.targetLevel && remaining > 0; level++) {
        const count = Math.min(usableFreshAPAtLevel(classData, currentState, level), remaining);
        scheduledFresh.set(level, count);
        remaining -= count;
      }
    }
    const groups = [];
    for (let level = phase3Start; level <= goals.targetLevel; level++) {
      const count = scheduledFresh.get(level) || 0;
      const last = groups[groups.length - 1];
      const available = usableFreshAPAtLevel(classData, currentState, level);
      if (last && last.count === count && last.available === available) last.end = level;
      else groups.push({ start: level, end: level, count, available });
    }
    for (const group of groups) {
      const parts = [];
      if (group.count > 0) {
        parts.push(`${group.count} fresh AP per level → HP (Fresh HP Wash)`);
        parts.push(`${apResets(group.count)} per level: -MP +${classData.mainStat}`);
        if (group.count < group.available) {
          parts.push(`${group.available - group.count} remaining fresh AP per level → ${classData.mainStat}`);
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
  const firstJobRequirement = classData.firstJobRequirement;
  let firstJobStatValue = firstJobRequirement
    ? baseStatValue(currentState, firstJobRequirement.stat)
    : null;
  let cumulativeResets = result.breakdown.shift;  // pre-game shift counted at level 0
  let phase2MPRemaining = p.phase2MPWashResets ?? result.breakdown.mpWash;
  let preSwapFreshRemaining = p.preSwapFreshHPResets || 0;
  let phase3FreshRemaining = p.phase3FreshHPResets || 0;
  // The calculator conservatively assumes the character starts with an empty HP/MP Pool.
  // Once a fresh AP has entered HP or MP, its paired reset can be left pending until all stale
  // washes are complete. This flag records that a legal seed has appeared in the schedule.
  let hpMPPoolSeeded = false;

  for (let L = currentState.level; L <= goals.targetLevel; L++) {
    let resetsThisLevel = 0;
    let mpResetsThisLevel = 0;
    let freshHPWashesThisLevel = 0;
    let staleHPWashesThisLevel = 0;
    let mpWashesThisLevel = 0;
    let phase = '';
    let peakMPThisLevel = mp;
    const firstJobAPThisLevel = L > currentState.level
      ? firstJobRequirementAPAtLevel(classData, currentState, L)
      : 0;
    const usableFreshAP = L > currentState.level
      ? usableFreshAPAtLevel(classData, currentState, L)
      : 0;

    if (firstJobRequirement && firstJobRequirement.stat !== 'INT'
        && firstJobAPThisLevel > 0) {
      firstJobStatValue += firstJobAPThisLevel;
      if (firstJobRequirement.stat === classData.mainStat) {
        mainStat += firstJobAPThisLevel;
      }
    }

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
        const freshAP = usableFreshAP;
        const freshToInt = classData.isMage
          ? freshAP
          : Math.min(freshAP, Math.max(0, p.targetBaseInt - baseInt));
        baseInt += freshToInt;
        mainStat += freshAP - freshToInt;
        phase = freshToInt > 0 ? 'Build Base INT' : `Build ${classData.mainStat}`;
      } else {
        phase = baseInt < p.targetBaseInt ? 'Build Base INT' : `Build ${classData.mainStat}`;
      }
    } else if (L < p.mpWashStop || (classData.isMage && L === p.mpWashStop)) {
      if (L > currentState.level) {
        const freshAP = usableFreshAP;
        const mpWashes = Math.min(freshAP, phase2MPRemaining);
        for (let cycle = 0; cycle < mpWashes; cycle++) {
          const gross = classData.freshAPMPBase + Math.floor(baseInt / 10);
          mp += gross;
          peakMPThisLevel = Math.max(peakMPThisLevel, mp);
          mp -= classData.mpLossPerReset;
          if (baseInt < p.targetBaseInt || classData.isMage) baseInt++;
          else mainStat++;
        }
        phase2MPRemaining -= mpWashes;
        mpWashesThisLevel = mpWashes;

        const freshHPWashes = Math.min(freshAP - mpWashes, preSwapFreshRemaining);
        hp = Math.min(MAX_HP, hp + freshHPWashYield(classData, freshHPWashes));
        mp -= washCycleMPCost(classData, freshHPWashes);
        mainStat += freshHPWashes;
        preSwapFreshRemaining -= freshHPWashes;
        freshHPWashesThisLevel = freshHPWashes;

        const directToMainStat = freshAP - mpWashes - freshHPWashes;
        if (classData.isMage) baseInt += directToMainStat;
        else mainStat += directToMainStat;
        resetsThisLevel = mpWashes + freshHPWashes;
        mpResetsThisLevel = resetsThisLevel;
        phase = mpWashes > 0 && freshHPWashes > 0 ? 'MP Wash + Pre-Swap Fresh HP Wash'
          : mpWashes > 0 ? 'MP Wash'
          : freshHPWashes > 0 ? 'Pre-Swap Fresh HP Wash'
          : `Build ${classData.mainStat}`;
      } else {
        phase = phase2MPRemaining > 0 ? 'MP Wash'
          : preSwapFreshRemaining > 0 ? 'Pre-Swap Fresh HP Wash'
          : `Build ${classData.mainStat}`;
      }
    } else if (!p.capWash && L === p.mpWashStop && L < goals.targetLevel) {
      // === THE SWAP === One event: MP→HP burst, then Reset Base INT → Main Stat (ADR 0001).
      // Fresh AP are individually allocated to the remaining MP-Wash prefix, Fresh HP suffix,
      // or Main Stat. Keep one paired reset pending while stale washing needs the HP/MP Pool.
      const burst = p.swapBurst || 0;
      let swapFresh = 0;
      let swapMPWashes = 0;
      let pendingFreshResets = 0;
      let pendingMPResetToInt = false;
      if (L > currentState.level) {
        const freshAP = usableFreshAP;
        swapMPWashes = Math.min(freshAP, phase2MPRemaining);
        swapFresh = Math.min(freshAP - swapMPWashes, preSwapFreshRemaining);

        for (let cycle = 0; cycle < swapMPWashes; cycle++) {
          const gross = classData.freshAPMPBase + Math.floor(baseInt / 10);
          mp += gross;
          peakMPThisLevel = Math.max(peakMPThisLevel, mp);
          const deferThisReset = burst > 0 && swapFresh === 0
            && cycle === swapMPWashes - 1;
          if (deferThisReset) {
            pendingMPResetToInt = baseInt < p.targetBaseInt;
          } else {
            mp -= classData.mpLossPerReset;
            if (baseInt < p.targetBaseInt) baseInt++;
            else mainStat++;
          }
        }
        phase2MPRemaining -= swapMPWashes;
        mpWashesThisLevel = swapMPWashes;

        hp = Math.min(MAX_HP, hp + freshHPWashYield(classData, swapFresh));
        pendingFreshResets = swapFresh;
        preSwapFreshRemaining -= swapFresh;
        freshHPWashesThisLevel = swapFresh;

        const unallocatedFresh = freshAP - swapMPWashes - swapFresh;
        const freshToInt = Math.min(unallocatedFresh, Math.max(0, p.targetBaseInt - baseInt));
        baseInt += freshToInt;
        mainStat += unallocatedFresh - freshToInt;
        resetsThisLevel = swapMPWashes + swapFresh;
        mpResetsThisLevel = resetsThisLevel;
      }
      const intResets = result.breakdown.intReset;
      if (burst > 0) {
        hp = Math.min(MAX_HP, hp + staleHPWashYield(classData, burst));
        mp -= washCycleMPCost(classData, burst);
        staleHPWashesThisLevel += burst;
      }
      if (pendingMPResetToInt || (burst > 0 && swapMPWashes > 0 && swapFresh === 0)) {
        mp -= classData.mpLossPerReset;
        if (pendingMPResetToInt) baseInt++;
        else mainStat++;
      }
      mp -= washCycleMPCost(classData, pendingFreshResets);
      mainStat += pendingFreshResets;
      peakMPThisLevel = Math.max(peakMPThisLevel, mp);
      mainStat += intResets;
      baseInt = classData.requiresIntResetAtTarget ? STARTING_MAIN_STAT : baseInt;
      resetsThisLevel += burst + intResets;
      mpResetsThisLevel += burst;
      phase = swapMPWashes > 0 && swapFresh > 0 && burst > 0 && intResets > 0
        ? 'MP + Fresh + Stale HP Wash + Reset INT'
        : swapMPWashes > 0 && swapFresh > 0 && intResets > 0
          ? 'MP Wash + Fresh HP Wash + Reset INT'
        : swapFresh > 0 && burst > 0 && intResets > 0 ? 'Fresh + Stale HP Wash + Reset INT'
        : swapFresh > 0 && intResets > 0 ? 'Fresh HP Wash + Reset INT'
        : swapFresh > 0 && burst > 0 ? 'Fresh + Stale HP Wash'
        : swapFresh > 0 ? 'Pre-Swap Fresh HP Wash'
        : burst > 0 && intResets > 0 ? 'Stale HP Wash + Reset INT'
        : burst > 0 ? 'Stale HP Wash'
        : intResets > 0 ? 'Reset Base INT'
        : 'Done';
    } else if (p.capWash && L < goals.targetLevel) {
      // Cap-wash: MP-wash every fresh AP back into INT, then stale-wash only the net MP above
      // the goal into HP. This preserves the Mage's damage stat and matches Krythan's sheet.
      phase = p.staleHPWashStartLevel !== null && L >= p.staleHPWashStartLevel
        ? 'MP-Cap HP Wash'
        : 'MP Wash';
      if (L > currentState.level) {
        const freshAP = usableFreshAP;
        for (let cycle = 0; cycle < freshAP; cycle++) {
          mp += classData.freshAPMPBase + Math.floor(baseInt / 10);
          peakMPThisLevel = Math.max(peakMPThisLevel, mp);
          mp -= classData.mpLossPerReset;
          baseInt++;
        }
        hpMPPoolSeeded = hpMPPoolSeeded || freshAP > 0;
        mpWashesThisLevel = freshAP;
        if (mp > goals.mpGoal) {
          const washes = Math.floor((mp - goals.mpGoal) / classData.mpLossPerReset);
          hp = Math.min(MAX_HP, hp + staleHPWashYield(classData, washes));
          mp = Math.min(MAX_MP, mp - washCycleMPCost(classData, washes));  // never display above the cap
          resetsThisLevel = freshAP + washes;
          mpResetsThisLevel = freshAP + washes;
          staleHPWashesThisLevel = washes;
        } else {
          resetsThisLevel = freshAP;
          mpResetsThisLevel = freshAP;
        }
      }
    } else if (L < goals.targetLevel) {
      const stale = p.staleHPPerLevelPhase3 || 0;
      const freshAP = usableFreshAP;
      const affordableResets = L < secondJALevel(classData)
        ? Number.POSITIVE_INFINITY
        : Math.max(0, Math.floor((mp - minMPAtLevel(classData, L)) / classData.mpLossPerReset));
      const fresh = Math.min(freshAP, phase3FreshRemaining, Math.max(0, affordableResets - stale));
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
          mainStat += freshAP;
          mp -= washCycleMPCost(classData, fresh + stale);
          resetsThisLevel = fresh + stale;
          mpResetsThisLevel = fresh + stale;
          staleHPWashesThisLevel = stale;
        }
      } else {
        phase = `Build ${classData.mainStat}`;
        mainStat += freshAP;
      }
    } else if (p.capWash) {
      // Target level under cap-wash: keep its fresh AP in INT and convert the net MP inflow to HP.
      phase = p.staleHPWashStartLevel !== null && L >= p.staleHPWashStartLevel
        ? 'MP-Cap HP Wash'
        : 'MP Wash';
      if (L > currentState.level) {
        const freshAP = usableFreshAP;
        for (let cycle = 0; cycle < freshAP; cycle++) {
          mp += classData.freshAPMPBase + Math.floor(baseInt / 10);
          peakMPThisLevel = Math.max(peakMPThisLevel, mp);
          mp -= classData.mpLossPerReset;
          baseInt++;
        }
        hpMPPoolSeeded = hpMPPoolSeeded || freshAP > 0;
        mpWashesThisLevel = freshAP;
        if (mp > goals.mpGoal) {
          const washes = Math.floor((mp - goals.mpGoal) / classData.mpLossPerReset);
          hp = Math.min(MAX_HP, hp + staleHPWashYield(classData, washes));
          mp = Math.min(MAX_MP, mp - washCycleMPCost(classData, washes));  // never display above the cap
          resetsThisLevel = freshAP + washes;
          mpResetsThisLevel = freshAP + washes;
          staleHPWashesThisLevel = washes;
        } else {
          resetsThisLevel = freshAP;
          mpResetsThisLevel = freshAP;
        }
      }
    } else {
      // L == targetLevel. Phase 3 spans (mpWashStop, targetLevel] — 80 levels for a 120→200 plan —
      // so the target level's OWN fresh AP and paired resets belong here, not just the levels
      // below it.
      const stale = p.staleHPPerLevelPhase3 || 0;
      const freshAP = usableFreshAP;
      const affordableResets = L < secondJALevel(classData)
        ? Number.POSITIVE_INFINITY
        : Math.max(0, Math.floor((mp - minMPAtLevel(classData, L)) / classData.mpLossPerReset));
      const fresh = Math.min(freshAP, phase3FreshRemaining, Math.max(0, affordableResets - stale));
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
          staleHPWashesThisLevel += stale;
          phase = (fresh > 0 && stale > 0) ? 'Fresh + Stale HP Wash'
            : fresh > 0 ? 'Fresh HP Wash'
            : 'Stale HP Wash';
        } else {
          phase = `Build ${classData.mainStat}`;
        }
        mainStat += freshAP;
      }
      let swapFresh = 0;
      let swapMPWashes = 0;
      let pendingSwapFreshResets = 0;
      let pendingSwapMPResetDestination = null;
      if (swapHere && L > currentState.level) {
        swapMPWashes = Math.min(freshAP, phase2MPRemaining);
        swapFresh = Math.min(freshAP - swapMPWashes, preSwapFreshRemaining);
        const staleWillRun = (p.swapBurst || 0) + (p.cleanupStaleHPWash || 0) > 0;

        for (let cycle = 0; cycle < swapMPWashes; cycle++) {
          const gross = classData.freshAPMPBase + Math.floor(baseInt / 10);
          mp += gross;
          peakMPThisLevel = Math.max(peakMPThisLevel, mp);
          const deferThisReset = staleWillRun && swapFresh === 0
            && cycle === swapMPWashes - 1;
          if (deferThisReset) {
            pendingSwapMPResetDestination = baseInt < p.targetBaseInt ? 'INT' : 'main';
          } else {
            mp -= classData.mpLossPerReset;
            if (baseInt < p.targetBaseInt) baseInt++;
            else mainStat++;
          }
        }
        phase2MPRemaining -= swapMPWashes;
        mpWashesThisLevel = swapMPWashes;

        hp = Math.min(MAX_HP, hp + freshHPWashYield(classData, swapFresh));
        pendingSwapFreshResets = swapFresh;
        preSwapFreshRemaining -= swapFresh;
        freshHPWashesThisLevel = swapFresh;

        const unallocatedFresh = freshAP - swapMPWashes - swapFresh;
        const freshToInt = Math.min(unallocatedFresh, Math.max(0, p.targetBaseInt - baseInt));
        baseInt += freshToInt;
        mainStat += unallocatedFresh - freshToInt;
        resetsThisLevel += swapMPWashes + swapFresh;
        mpResetsThisLevel += swapMPWashes + swapFresh;
      }
      const burstHere = swapHere ? (p.swapBurst || 0) : 0;
      const intResetsHere = swapHere ? result.breakdown.intReset : 0;
      if (burstHere > 0) {
        hp = Math.min(MAX_HP, hp + staleHPWashYield(classData, burstHere));
        mp -= washCycleMPCost(classData, burstHere);
        staleHPWashesThisLevel += burstHere;
      }
      // Then top up to the HP Goal with whatever the swap burst didn't cover.
      const cleanupStale = p.cleanupStaleHPWash || 0;
      const hpShort = Math.max(0, goals.hpGoal - hp);
      const extraStale = Math.max(cleanupStale, Math.ceil(hpShort / classData.staleAPHP));
      hp = Math.min(MAX_HP, hp + staleHPWashYield(classData, extraStale));
      mp -= washCycleMPCost(classData, extraStale);
      resetsThisLevel += extraStale;
      mpResetsThisLevel += extraStale;
      staleHPWashesThisLevel += extraStale;
      // Reclaim the fresh AP only after every stale wash; this keeps the shared HP/MP Pool non-empty.
      if (pendingSwapMPResetDestination !== null) {
        mp -= classData.mpLossPerReset;
        if (pendingSwapMPResetDestination === 'INT') baseInt++;
        else mainStat++;
      }
      mp -= washCycleMPCost(classData, pendingSwapFreshResets + pendingTargetFreshResets);
      mainStat += pendingSwapFreshResets;
      peakMPThisLevel = Math.max(peakMPThisLevel, mp);
      mainStat += intResetsHere;
      if (swapHere) baseInt = classData.requiresIntResetAtTarget ? STARTING_MAIN_STAT : baseInt;
      resetsThisLevel += burstHere + intResetsHere;
      mpResetsThisLevel += burstHere;
      const staleAtSwap = burstHere + extraStale;
      const swapPhase = swapMPWashes > 0 && swapFresh > 0 && staleAtSwap > 0 && intResetsHere > 0
        ? 'MP + Fresh + Stale HP Wash + Reset INT'
        : swapMPWashes > 0 && swapFresh > 0 && intResetsHere > 0
          ? 'MP Wash + Fresh HP Wash + Reset INT'
        : swapFresh > 0 && staleAtSwap > 0 && intResetsHere > 0 ? 'Fresh + Stale HP Wash + Reset INT'
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

    if (mpWashesThisLevel > 0 || freshHPWashesThisLevel > 0) hpMPPoolSeeded = true;
    if (firstJobAPThisLevel > 0) {
      const jobLabel = `${firstJobRequirement.stat} for 1st Job`;
      phase = phase ? `${jobLabel} + ${phase}` : jobLabel;
    }
    const hpMPPoolValid = staleHPWashesThisLevel === 0 || hpMPPoolSeeded;
    cumulativeResets += resetsThisLevel;

    rows.push({
      level: L,
      hp: Math.round(hp),
      mp: Math.round(mp),
      peakMPThisLevel: Math.round(peakMPThisLevel),
      baseInt: Math.round(baseInt),
      // Mages: Main Stat IS INT, so reflect it rather than tracking a separate counter.
      mainStat: Math.round(classData.isMage ? baseInt : mainStat),
      firstJobStat: firstJobRequirement ? firstJobRequirement.stat : null,
      firstJobStatValue: firstJobRequirement
        ? Math.round(firstJobRequirement.stat === 'INT' ? baseInt : firstJobStatValue)
        : null,
      firstJobAPThisLevel,
      phase,
      freshHPWashesThisLevel,
      staleHPWashesThisLevel,
      mpWashesThisLevel,
      hpMPPoolValid,
      mpResetsThisLevel,
      resetsThisLevel,
      cumulativeResets,
    });
  }

  return rows;
}
