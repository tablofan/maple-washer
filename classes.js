// MapleLegends class constants for HP/MP washing.
// Source: Nise's compilation (https://forum.legends.ml/index.php?threads/nises-hp-washing-formula-compilation.38558/)
// cross-checked against Krythan's per-class washing sheets.
// All HP/MP values are mid-range averages (the calculator does not model the random rolls).
// MapleLegends grants HP/MP bonuses only on 1st and 2nd job advancement.

const CLASS_ORDER = [
  'Night Lord', 'Shadower',
  'Bowmaster', 'Marksman',
  'Corsair', 'Buccaneer',
  'Hero', 'Dark Knight', 'Paladin',
  'Magician',
  'Beginner',
];

const FIRST_JOB_REQUIREMENTS = {
  THIEF: { level: 10, stat: 'DEX', minimum: 25 },
  BOWMAN: { level: 10, stat: 'DEX', minimum: 25 },
  PIRATE: { level: 10, stat: 'DEX', minimum: 20 },
  WARRIOR: { level: 10, stat: 'STR', minimum: 35 },
  MAGICIAN: { level: 8, stat: 'INT', minimum: 20 },
};

const CLASSES = {
  'Night Lord': {
    mainStat: 'LUK',
    firstJobRequirement: FIRST_JOB_REQUIREMENTS.THIEF,
    naturalHPPerLevel: 22,
    naturalMPPerLevel: 15,
    freshAPHP: 18,
    staleAPHP: 16,
    freshAPMPBase: 10,
    mpLossPerReset: 12,
    minMPFormula: (L) => 14 * L + 135,
    minHPFormula: (L) => 20 * L + 378,
    maxHPBonusPerLevel: 0,
    maxHPActivatesAt: null,
    maxMPBonusPerLevel: 0,
    maxMPActivatesAt: null,
    jaBonuses: [
      { level: 10, hp: 162, mp: 0 },
      { level: 30, hp: 325, mp: 175 },
    ],
  },
  'Shadower': {
    mainStat: 'LUK',
    firstJobRequirement: FIRST_JOB_REQUIREMENTS.THIEF,
    naturalHPPerLevel: 22,
    naturalMPPerLevel: 15,
    freshAPHP: 18,
    staleAPHP: 16,
    freshAPMPBase: 10,
    mpLossPerReset: 12,
    minMPFormula: (L) => 14 * L + 135,
    minHPFormula: (L) => 20 * L + 378,
    maxHPBonusPerLevel: 0,
    maxHPActivatesAt: null,
    maxMPBonusPerLevel: 0,
    maxMPActivatesAt: null,
    jaBonuses: [
      { level: 10, hp: 162, mp: 0 },
      { level: 30, hp: 325, mp: 175 },
    ],
  },
  'Bowmaster': {
    mainStat: 'DEX',
    firstJobRequirement: FIRST_JOB_REQUIREMENTS.BOWMAN,
    naturalHPPerLevel: 22,
    naturalMPPerLevel: 15,
    freshAPHP: 18,
    staleAPHP: 16,
    freshAPMPBase: 10,
    mpLossPerReset: 12,
    minMPFormula: (L) => 14 * L + 135,
    minHPFormula: (L) => 20 * L + 378,
    maxHPBonusPerLevel: 0,
    maxHPActivatesAt: null,
    maxMPBonusPerLevel: 0,
    maxMPActivatesAt: null,
    jaBonuses: [
      { level: 10, hp: 162, mp: 0 },
      { level: 30, hp: 325, mp: 175 },
    ],
  },
  'Marksman': {
    mainStat: 'DEX',
    firstJobRequirement: FIRST_JOB_REQUIREMENTS.BOWMAN,
    naturalHPPerLevel: 22,
    naturalMPPerLevel: 15,
    freshAPHP: 18,
    staleAPHP: 16,
    freshAPMPBase: 10,
    mpLossPerReset: 12,
    minMPFormula: (L) => 14 * L + 135,
    minHPFormula: (L) => 20 * L + 378,
    maxHPBonusPerLevel: 0,
    maxHPActivatesAt: null,
    maxMPBonusPerLevel: 0,
    maxMPActivatesAt: null,
    jaBonuses: [
      { level: 10, hp: 162, mp: 0 },
      { level: 30, hp: 325, mp: 175 },
    ],
  },
  'Corsair': {
    mainStat: 'DEX',
    firstJobRequirement: FIRST_JOB_REQUIREMENTS.PIRATE,
    naturalHPPerLevel: 25,
    // Mid-range avg of 18-23 = 20.5; using 20 (floor) underestimates MP by ~0.5/lvl. Acceptable for V1.
    naturalMPPerLevel: 20,
    freshAPHP: 18,
    staleAPHP: 18,
    freshAPMPBase: 14,
    mpLossPerReset: 16,
    minMPFormula: (L) => 18 * L + 95,
    minHPFormula: (L) => 22 * L + 380,
    maxHPBonusPerLevel: 0,
    maxHPActivatesAt: null,
    maxMPBonusPerLevel: 0,
    maxMPActivatesAt: null,
    jaBonuses: [
      { level: 10, hp: 162, mp: 0 },
      { level: 30, hp: 225, mp: 162 },
    ],
  },
  'Buccaneer': {
    mainStat: 'STR',
    firstJobRequirement: FIRST_JOB_REQUIREMENTS.PIRATE,
    // naturalHPPerLevel is the WITHOUT-MaxHP value; the +30 bonus from Improve Max HP
    // activates at maxHPActivatesAt. freshAPHP, by contrast, is the WITH-MaxHP value
    // (the +20 bonus on AP allocations is baked in). Same asymmetry for Warriors below.
    naturalHPPerLevel: 25,
    // Same 18-23 range as Corsair; using 20 (floor of 20.5) underestimates MP by ~0.5/lvl.
    naturalMPPerLevel: 20,
    freshAPHP: 38,
    staleAPHP: 18,
    freshAPMPBase: 14,
    mpLossPerReset: 16,
    minMPFormula: (L) => 18 * L + 95,
    minHPFormula: (L) => 22 * L + 380,
    maxHPBonusPerLevel: 30,
    maxHPActivatesAt: 33,
    maxMPBonusPerLevel: 0,
    maxMPActivatesAt: null,
    jaBonuses: [
      { level: 10, hp: 162, mp: 0 },
      { level: 30, hp: 225, mp: 162 },
    ],
  },
  'Hero': {
    mainStat: 'STR',
    firstJobRequirement: FIRST_JOB_REQUIREMENTS.WARRIOR,
    naturalHPPerLevel: 26,
    naturalMPPerLevel: 5,
    freshAPHP: 52,
    staleAPHP: 20,
    freshAPMPBase: 2,
    mpLossPerReset: 4,
    minMPFormula: (L) => 4 * L + 55,
    minHPFormula: (L) => 24 * L + 472,
    maxHPBonusPerLevel: 40,
    maxHPActivatesAt: 16,
    maxMPBonusPerLevel: 0,
    maxMPActivatesAt: null,
    jaBonuses: [
      { level: 10, hp: 225, mp: 0 },
      { level: 30, hp: 325, mp: 0 },
    ],
  },
  'Dark Knight': {
    mainStat: 'STR',
    firstJobRequirement: FIRST_JOB_REQUIREMENTS.WARRIOR,
    naturalHPPerLevel: 26,
    naturalMPPerLevel: 5,
    freshAPHP: 52,
    staleAPHP: 20,
    freshAPMPBase: 2,
    mpLossPerReset: 4,
    minMPFormula: (L) => 4 * L + 155,
    minHPFormula: (L) => 24 * L + 172,
    maxHPBonusPerLevel: 40,
    maxHPActivatesAt: 16,
    maxMPBonusPerLevel: 0,
    maxMPActivatesAt: null,
    jaBonuses: [
      { level: 10, hp: 225, mp: 0 },
      { level: 30, hp: 0, mp: 125 },
    ],
  },
  'Paladin': {
    mainStat: 'STR',
    firstJobRequirement: FIRST_JOB_REQUIREMENTS.WARRIOR,
    naturalHPPerLevel: 26,
    naturalMPPerLevel: 5,
    freshAPHP: 52,
    staleAPHP: 20,
    freshAPMPBase: 2,
    mpLossPerReset: 4,
    minMPFormula: (L) => 4 * L + 155,
    minHPFormula: (L) => 24 * L + 172,
    maxHPBonusPerLevel: 40,
    maxHPActivatesAt: 16,
    maxMPBonusPerLevel: 0,
    maxMPActivatesAt: null,
    jaBonuses: [
      { level: 10, hp: 225, mp: 0 },
      { level: 30, hp: 0, mp: 125 },
    ],
  },
  'Magician': {
    mainStat: 'INT',
    firstJobRequirement: FIRST_JOB_REQUIREMENTS.MAGICIAN,
    naturalHPPerLevel: 12,
    naturalMPPerLevel: 23,
    freshAPHP: 8,
    staleAPHP: 6,
    // With MaxMP skill maxed (always-assumed). Base AP-assignment MP is ~18; Improving Max MP adds
    // +20 (the "2× Improving Max MP Increase" term). 18 + 20 = 38. Confirmed by Krythan's mage sheet
    // (89 MP/wash at avg base INT 511 ⟹ base ≈ 38) and Shivering's comprehensive mage guide
    // (net wash 56-58 at base INT 480 ⟹ base ≈ 38). Matches the +20 used for naturalMP level-ups.
    freshAPMPBase: 38,
    mpLossPerReset: 30,
    // Krythan distinguishes the 1st-job and post-2nd-job Mage MP floors.
    beginnerMinMPFormula: (L) => 10 * L - 5,
    firstJobMinMPFormula: (L) => 22 * L - 1,
    minMPFormula: (L) => 22 * L + 449,
    minHPFormula: (L) => 10 * L + 64,
    maxHPBonusPerLevel: 0,
    maxHPActivatesAt: null,
    maxMPBonusPerLevel: 20,
    // Krythan's Projection sheet applies a 30-MP correction for the early levels before
    // Improved MaxMP Increase is complete. Spread that correction over levels 9-11 so the
    // level table and analytical totals stay aligned; the full +20 applies from level 12.
    partialMaxMPBonusPerLevel: 10,
    partialMaxMPStartsAt: 9,
    maxMPActivatesAt: 12,
    jaBonuses: [
      { level: 8, hp: 0, mp: 125 },
      { level: 30, hp: 0, mp: 475 },
    ],
  },
  'Beginner': {
    mainStat: 'STR',
    firstJobRequirement: null,
    naturalHPPerLevel: 14,
    naturalMPPerLevel: 11,
    freshAPHP: 10,
    staleAPHP: 8,
    freshAPMPBase: 6,
    mpLossPerReset: 8,
    minMPFormula: (L) => 10 * L - 5,
    minHPFormula: (L) => 12 * L + 50,
    maxHPBonusPerLevel: 0,
    maxHPActivatesAt: null,
    maxMPBonusPerLevel: 0,
    maxMPActivatesAt: null,
    jaBonuses: [],
  },
};

// Beginner HP/MP/lvl applied to levels 1 through (first JA level - 1) for all classes.
const BEGINNER_HP_PER_LEVEL = 14;
const BEGINNER_MP_PER_LEVEL = 11;

// Starting HP and MP for all classes.
const STARTING_HP = 50;
const STARTING_MP = 5;
const STARTING_MAIN_STAT = 4;

// Cost constants.
const NX_PER_AP_RESET = 3100;
const MAX_NX_PER_DAY_PER_ACCOUNT = 6500;

// Maple Warrior MP multiplier (1 + 0.005 * MW level).
const MAPLE_WARRIOR_LEVELS = [
  { label: 'None', level: 0, multiplier: 1.00 },
  { label: 'MW 10', level: 10, multiplier: 1.05 },
  { label: 'MW 20', level: 20, multiplier: 1.10 },
  { label: 'MW 30', level: 30, multiplier: 1.15 },
];

// Derived behaviour flags — computed once so the engine reads named fields instead of
// re-deriving `mainStat === 'INT'` at every site. Source of truth stays `mainStat`.
for (const [className, cls] of Object.entries(CLASSES)) {
  cls.isMage = cls.mainStat === 'INT';
  // Old-school MapleStory awards five extra AP at 3rd and 4th job advancement.
  // Beginners never advance, so they receive only the normal five AP per level.
  cls.advancementAPLevels = className === 'Beginner' ? [] : [70, 120];
  // At target level, non-Mages reset Base INT down to STARTING_MAIN_STAT (-INT +MainStat).
  // Mages skip this — INT is their Main Stat, the reset would be a no-op.
  cls.requiresIntResetAtTarget = !cls.isMage;
}
