# MapleWasher

Browser-based calculator for HP/MP washing in MapleLegends — the practice of using AP Resets to trade MP for HP, exploiting INT-based MP gains to overshoot natural HP caps.

## Language

### Goals & constraints

**HP Goal**:
The user's required final HP at the **Target Level**. A hard constraint — the calculated plan must meet or exceed it.
_Avoid_: HP target, max HP

**MP Goal**:
The user's required final MP at the **Target Level**. A hard constraint — the calculated plan must meet or exceed it. Must itself be ≥ **Minimum MP** at the target level.
_Avoid_: MP target, max MP

**Target Level**:
The character level at which both **HP Goal** and **MP Goal** must be satisfied.
_Avoid_: goal level, washing target level

**Minimum MP**:
The class-and-level-dependent MP floor that `-MP +stat` **AP Resets** cannot drop max MP below. A game-enforced lower bound on resets — not on user input. Computed per Nise's MapleLegends formulas (e.g. `14·L + 135` for 2nd-job+ Thieves). Describes the *post-2nd-JA* state; a character's actual max MP can be below the formula in pre-advancement states (e.g. a level 1 character starts with MP 5, far below any class's formula value).
_Avoid_: MP floor, min MP

**Minimum HP**:
Same shape as **Minimum MP** but for HP. The floor that `-HP +stat` **AP Resets** cannot drop max HP below at a given level, post-2nd-JA. Per-class formula in `classes.js`.

### Game primitives

**AP Reset**:
A Cash Shop consumable (3,100 NX each) that converts one point of any stat into one point of any other stat. The atomic operation underlying every washing method. Notation: `-X +Y` (e.g. `-MP +INT`).
_Avoid_: reset, scroll

**AP Allocation**:
The free placement of newly-earned AP points (from level-up) into any stat. Distinct from **AP Reset** — no item is consumed, the AP is "fresh".
_Avoid_: AP spend, stat point

**Base INT**:
INT from **AP Allocation** and AP-Reset gains. Excludes equipment. Used in `INT/10` MP gain bonuses.
_Avoid_: pure INT, character INT

**Gear INT**:
INT from equipment. Added to **Base INT** to get **Total INT** (the value used in MP-gain formulas). User enters this as a flat number; assumed worn from level 10 until **Level to Remove INT Gear**.
_Avoid_: INT gear, equip INT

**Total INT**:
**Base INT** + **Gear INT**. The value plugged into per-level MP-gain formulas.

**Main Stat**:
The combat stat each class scales damage from — STR (Warrior), DEX (Bowman/Pirate-Gunslinger), LUK (Thief), STR (Pirate-Brawler/Buccaneer), and **INT itself** (Magician). For Magicians, INT serves as both the washing currency *and* the **Main Stat**, which is why their wash is much simpler.
_Avoid_: primary stat, attacking stat

**First Job Requirement**:
The Base Stat minimum required at first job advancement and retained permanently afterward: Warriors need 35 STR at level 10; Bowmen and Thieves need 25 DEX at level 10; Pirates need 20 DEX at level 10; Magicians need 20 INT at level 8. A fresh-character plan allocates these points first. Non-INT requirement points are removed from the AP available for INT-building and washing; Magician's required INT remains useful Base INT. The optimizer never treats these permanent points as available for **Shift to INT**.

**Non-INT Stats Pool**:
The user inputs current values for all four stats (STR, DEX, LUK, INT), normally floored at the starting value of 4 and additionally constrained by the class's permanent **First Job Requirement**. For positive **Shift to INT**, the optimizer treats eligible non-INT AP above those floors as a single shift-budget pool — the player decides which specific stat(s) to draw from when executing the plan. At target level the **Reset Base INT** step collapses any returned INT back into the **Main Stat**, so non-MainStat stat points consumed by the wash are not preserved (the player can manually redistribute via Cash Shop afterward if desired).
_Avoid_: side stats, secondary stats

**HP/MP Pool**:
A single shared counter of AP points the player has placed into HP or MP (via **AP Allocation** or `-stat +HP/MP` **AP Resets**). The game enforces: `-HP/MP +stat` resets require this pool to be non-empty (you can only reclaim AP you previously placed). `-stat +HP/MP` is unconstrained. MapleWasher assumes the user's **HP/MP Pool** is 0 at the start of the calculation — this is conservative (no historical wash credit). Before any planned Stale HP Wash, the schedule places at least one fresh AP into HP or MP and keeps its paired reset pending until the stale washes finish. A plan can skip **MP Wash** yet still use `-MP +MainStat` because one fresh AP can first seed HP and then be reclaimed after the stale wash.
_Avoid_: HP pool, MP pool (they are one)

### Wash phases & strategy

**MP Wash**:
The cycle: allocate 1 fresh AP → MP at level-up, later AP Reset `-MP +X` (where X is INT, Main Stat, or HP). Net effect per cycle: (`MP_gain_fresh` − `MP_loss_reset`) MP + 1 of stat X. Each cycle costs 1 **AP Reset**.

**Fresh HP Wash**:
Allocate 1 fresh AP → HP at level-up; the HP gain is the higher "Fresh AP HP" value for that class. Doesn't itself consume an AP Reset, but consumes a fresh AP slot. Typically paired with an `-MP +STAT` reset later to absorb the MP penalty from natural level-up MP gain.

**Stale HP Wash**:
AP Reset `-MP +HP` — directly converts existing MP into HP at the (slightly lower) Stale AP HP rate for the class. One **AP Reset** per HP point gained. Can be scheduled either **during Phase 3** (combinable with **Fresh HP Wash** at the same level — both drain MP, both add HP) or as a **cleanup burst at Target Level** to top up the HP Goal. Mid-flight Stale HP Wash is the lever that lets the plan convert MP earlier and still reach **HP Goal** when peak MP would otherwise blow the 30k cap.

**MP-Cap HP Wash**:
The Magician HP-wash endgame. Once MP reaches the goal (typically the 30k cap), the player holds MP there: each level they allocate fresh AP → MP, use `-MP +INT` to complete the MP Wash and preserve their INT growth, then use additional `-MP +HP` stale washes to convert the net MP inflow (MP-wash profit + natural level-up + INT/10) into HP. Distinct from ordinary **Stale HP Wash** (which drains existing MP *downward*) — here MP is *pinned* and the continuous inflow is what's converted. Dominant for Magicians because their **Fresh HP Wash** rate is tiny (≈8 HP/AP) while a high-**Base INT** Mage's per-AP MP generation converts to far more HP. Source: Krythan's mage sheet + Shivering's "Comprehensive Guide to HP/MP Washing on Mages". Non-Mage classes don't use it (their Fresh HP Wash dominates).
_Avoid_: overflow wash, cap wash (informal)

**MP Wash Start Level**:
The point at which the user begins **MP Wash** cycles. Before this, fresh AP builds **Base INT** only until **Target Base INT** is reached; any remaining fresh AP goes directly into **Main Stat**. Once washing starts, fresh AP goes into MP for the wash cycle until the optimizer transitions to **Pre-Swap Fresh HP Wash** or reaches **Swap Level**. The calculator may decide no **MP Wash** is needed when retained **Base INT** and natural level-up gains already meet the **MP Goal**.

**Swap Level**:
A user-supplied level at which the character becomes *playable*: all **Base INT** is reset to the **Main Stat** in one event. **MP Wash** cannot continue after this event because low-INT `-MP +MainStat` cycles are net MP-negative (`freshAPMPBase + ⌊Base INT/10⌋` falls below `mpLossPerReset`). It may stop earlier, however: the optimizer can retain **Base INT** and use the remaining pre-Swap levels for **Pre-Swap Fresh HP Wash**. **Target Base INT** must therefore be reached before that transition, and every INT-build, MP-wash, and pre-Swap fresh-wash level must fit inside `current level → Swap Level`.
_Avoid_: level to swap, MP Wash Stop Level, reset level

Magicians have no **Swap Level** — their **Main Stat** *is* INT, so they are playable throughout and never reset **Base INT**. Their plan is driven by the **MP Goal** alone.

**Target Base INT**:
For non-Mages, the peak **Base INT** the calculator decides to build, sustain until **Swap Level**, and then reset into **Main Stat**. For Magicians, this is simply their projected final INT at **Target Level**: every fresh AP ultimately returns to INT, so there is no chosen INT plateau or reset.

**Pre-Swap Fresh HP Wash**:
An optimizer-controlled suffix between **MP Wash** and **Swap Level**. **Base INT** remains at **Target Base INT**, preserving its level-up MP contribution. Fresh AP in this suffix go to HP and are paired with `-MP +MainStat` **AP Resets**. The transition level may split its AP between MP Wash and Fresh HP Wash; this avoids rounding a legal one-to-four-AP boundary up to a whole level. Compared with continuing **MP Wash**, the reset count is unchanged, but the character trades fresh-AP MP generation for the class's larger Fresh AP HP gain. The user does not supply this boundary.

**Post-Swap Fresh HP Wash**:
The default allocation for the stretch from **Swap Level** to **Target Level**: fresh AP goes to HP (**Fresh HP Wash**) *paired with* `-MP +MainStat` **AP Resets**, so each wash yields both HP and **Main Stat**. The optimizer chooses the exact total count needed, then frontloads it using every AP available from immediately after **Swap Level**. A normal level supplies 5 AP; 3rd and 4th job advancement at levels 70 and 120 each supply 5 additional AP. Once the chosen count is exhausted, later fresh AP goes directly into **Main Stat**. Because Fresh HP Wash yields more HP than **Stale HP Wash** for the same one-reset and MP cost, using the exact count can replace several stale washes and reduce total NX as well as delivering HP sooner.
_Avoid_: fresh wash toggle, HP wash mode

**Phase Plan**:
The level-banded sequence of allocation strategies the calculator outputs. Two shapes:
- **Non-Mage:** *(optional)* pre-game **Shift to INT** → satisfy the **First Job Requirement** → build **Base INT** → *(optional)* build **Main Stat** while retaining INT → *(optional)* **MP Wash** → *(optional)* **Pre-Swap Fresh HP Wash** while retaining INT → reset **Base INT** to **Main Stat** at **Swap Level** → *(optional)* **Post-Swap Fresh HP Wash** → *(optional)* cleanup **Stale HP Wash** at **Target Level**.
- **Mage:** *(optional)* pre-game **Shift to INT** → satisfy the 20 INT **First Job Requirement** as part of building **Base INT** → **MP Wash** (`+MP`, then `-MP +INT`) →, once the MP goal is reached, continue MP Washing while **MP-Cap HP Washing** the net inflow (`-MP +HP`) to **Target Level**. **Magicians skip the Base-INT reset** because INT is already their Main Stat.

The pre-game Shift to INT can draw from any eligible non-INT stats (STR/DEX/LUK) above their permanent minimums — the player picks the source.

## Calculator behavior

The calculator's job is to find the **Phase Plan** that minimises total **AP Resets** subject to: `final HP ≥ HP Goal`, `final MP ≥ MP Goal`, `MP ≥ Minimum MP` at every level along the way.

**Locked to Target Level (not optimization variables):**
- Level to remove **Gear INT** = **Target Level** (wearing it longer only helps; removing it earlier costs MP gain).

**Locked to Swap Level (not optimization variables):**
- Level to reset **Base INT** → **Main Stat** = **Swap Level** (superseded — see ADR 0001; it was previously locked to **Target Level** on the mistaken rationale that there was no benefit to resetting early).

**Search space (calculator decides):**
- **Target Base INT** for non-Mages; a Mage's final Base INT is determined by its current INT, eligible Shift to INT, and all remaining fresh AP
- **MP Wash Start Level**
- **Pre-Swap Fresh HP Wash Start Level** (equivalently, the internal end of **MP Wash**). This is optimizer-controlled and not a user input.
- The exact count of post-Swap **Fresh HP Washes**, frontloaded at up to 5 per level after **Swap Level**, plus any **Stale HP Wash** needed to absorb MP or finish the **HP Goal**
- For mid-progress users: amount of **Shift to INT** (from any non-INT stat) to do up-front, if it lowers total cost. Existing **Base INT** is retained until **Swap Level**: shifting it down earlier costs the same AP Resets as the swap while discarding useful MP gain.

## Output

When the calculator runs successfully:

1. **Summary card** — `Target Base INT`, `MP Wash Start Level`, total **AP Resets**, **NX Cost** (= AP Resets × 3,100), **Days-to-Wash** (= NX Cost ÷ 6,500 NX-per-day-per-account), plus a one-line per-reset-type breakdown. Non-Mages also show **Swap Level** and `HP at Swap Level`; Magicians instead show when **Stale HP Wash** starts.
2. **Phase Plan** — level-banded allocation guide (e.g. "Lvl 4-67 · All fresh AP → INT") matching the **Search space** decisions.
3. **Level-by-level table** — 8 columns: Level, HP, MP, Base INT, **Main Stat**, Phase, AP Resets this level, Cumulative AP Resets. **Main Stat** sits beside **Base INT** so the swap is visible: **Base INT** collapses to its starting value at **Swap Level** while **Main Stat** climbs to absorb it. Collapsed by default. The Phase column shows one of: *Build Base INT* / *MP Wash* / *Pre-Swap Fresh HP Wash* / *Fresh HP Wash* / *Stale HP Wash* / *Fresh + Stale HP Wash* / *Fresh HP Wash + Reset INT* / *Fresh + Stale HP Wash + Reset INT* / *MP-Cap HP Wash* (Mage endgame) / *Build &lt;Main Stat&gt;* / *Reset Base INT* / *Stale HP Wash + Reset INT* / *Done*.

When the user's inputs make the goal **infeasible** (e.g. Mage requesting 30k HP at lvl 50), the calculator shows an **infeasibility warning** in place of the Summary, naming the violated constraint (`HP Goal exceeds maximum possible at Target Level` / `MP Goal below Minimum MP at Target Level`).

**Days-to-Wash** anchors the user on whether the plan is realistic: 6,500 NX/day/account from daily voting, so a 7.5M NX plan = ~1,150 days on one account or ~580 days on two. Shown alongside the raw NX number, not in place of it.

## Reference calculators (MapleLegends)

Krythan's per-class washing sheets — one per class, same author, same Nise-formula basis. Useful templates for our analytical math (they compute HP/MP by summing contributions rather than simulating level-by-level):

- Night Lord / Archer: `1Ja3Fq26SCGZz-WCPkcxwbw-3tJGmzgR871hNvZzGcm0`
- Corsair: `1TrtTH36lrAUvCS5-ZMxrO5Gy_ChLAbm653hWKlYa2w0`
- Mage: `17LC5PGv8p0-DB-uEKFV8RxCZXEEvqtQLknNr-XK2j04`
- Warrior: `1xY8q4bTbICN6CfC6mcp74jWc96gru4otte9kAIYgJ_Q`
- Buccaneer: `1UffgnbjUbmkSZTnuZBe2dnzCyoBCbRYyiVMBIvJSCoY`

Their inputs include both "Level to Stop MP Washing" (the strategic switch) and "Level to Project To" (the level at which targets are evaluated). MapleWasher separates the underlying decisions: **Swap Level** remains the user's playability choice, while the optimizer may stop **MP Wash** earlier and spend the intervening levels on **Pre-Swap Fresh HP Wash**. This preserves one user-facing decision without forcing MP Washing to continue when Fresh HP Washing is cheaper.

Differences from MapleWasher's scope: Krythan's sheets include HP Challenges columns (skipped here), Spring of Youth quest HP and equip HP constants (skipped here), and individual INT-gear-piece tracking (replaced here with a single Gear INT input).

## Relationships

- An **HP Goal** and an **MP Goal** are both evaluated at the same **Target Level**.
- An **MP Goal** must be ≥ **Minimum MP** at the **Target Level** — the game makes lower MP physically unreachable via AP Resets.

## Example dialogue

> **User:** "I want 30k HP and 4k MP by level 135 on my Night Lord."
> **Calculator:** "Your HP Goal is 30,000 and MP Goal is 4,000, both at Target Level 135. Minimum MP for a Night Lord at level 135 is 2,025, so 4,000 is feasible."

## Flagged ambiguities

- UI phrasing of the **MP Wash Start Level** drops the word "Level" — the label reads "Start MP Wash at" because it's followed by a level value (`lvl 68`). **Swap Level** keeps its full name since it names an event, not a range.
