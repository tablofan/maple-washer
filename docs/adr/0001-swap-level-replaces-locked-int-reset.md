# Reset Base INT at a user-supplied Swap Level, not at Target Level

We previously locked "level to reset **Base INT** → **Main Stat**" to **Target Level**, on the rationale that resetting earlier "loses INT/10 MP gain for remaining levels at no benefit." That rationale was wrong: there is a benefit, and it is the entire point of washing. A character carrying several hundred **Base INT** does no damage, because INT is not its **Main Stat**. We now take **Swap Level** as a user input, at which **MP Wash** stops and all **Base INT** is reset to the **Main Stat** in a single event.

## Why coupled

The stop and the reset are one event, not two. Once INT is flushed, further `-MP +MainStat` cycles are net MP-negative — `freshAPMPBase + ⌊Base INT/10⌋` falls below `mpLossPerReset` at low INT (10 + 0 < 12 for a Night Lord) — so continuing the **MP Wash** past the swap would burn MP for nothing. Coupling them also means **Base INT** cannot be rebuilt afterwards, so **Target Base INT** must be reached at or before **Swap Level**, and both the INT-build and MP-wash phases must fit inside `current level → Swap Level`.

This matches Krythan's canonical plan, which resets Base INT at ~150 and explicitly calls the character "playable" only afterwards.

## Considered Options

- **Keep the reset locked to Target Level.** Rejected — it optimises purely for reset count and produces a character that cannot fight for its whole life.
- **Decouple the two** (Independent **MP Wash Stop Level** and reset level). Rejected — the MP-negative argument above makes a stop-without-reset useless, and two inputs would expose a combination that never helps.
- **Search the swap level as an optimization variable.** Rejected — playability timing is a player preference, not something the reset-count objective can express. The optimizer is indifferent to it.

## Consequences

- **The MP→HP conversion becomes a schedule, not a cost.** Whether the **Stale HP Wash** happens at the swap level or at **Target Level** does not change total **AP Resets** (verified: identical counts across the whole split). So we maximise the burst at **Swap Level** subject to the **MP Goal**, giving the player their HP as early as possible at no extra NX.
- **The post-swap stretch trades HP for Main Stat at a fixed rate.** `-MP +MainStat` and `-MP +HP` cost the same reset and the same MP, so pairing trades exactly `staleAPHP` HP per **Main Stat** point with total resets invariant. We set the pairing rate as high as the **MP Goal** allows (max 5/level), falling back only when the **MP Goal** would otherwise be missed. Without that fallback the plan is infeasible in a substantial share of scenarios we tested.
- **Lowering the pairing rate can never rescue a short HP Goal.** The HP shortfall is unaffected by the rate, so infeasibility must be reported as such rather than absorbed by tuning it.
- **Earlier swaps are much cheaper for high-`freshAPHP` classes.** Sweeping a Hero at 30k HP / 2k MP @ 180: swap 40 → 603 resets, swap 120 → 982, swap 180 → 1,666. Their 52 HP/AP fresh wash makes every MP-washing level expensive. The old model hid this by choosing the stop point itself (~lvl 32, 452 resets); now that the user supplies it, a late swap can cost ~2.8× an early one.
- **The per-level walk is authoritative over the analytical sums.** `evaluateStrategy` sums whole ranges (plateau averages, one `Math.ceil` at the end); `levelTable` walks level by level with a `floor()` on INT/10 and a MAX_HP clip at every step. The two differ by a wash or two, which decides whether a tight plan actually reaches its goals. `optimize` keeps a shortlist of the cheapest candidates and returns the cheapest that `levelTable` confirms, then reports the walk's numbers — so the Summary and the level table can never disagree. Cost is one `levelTable` call per shortlisted candidate (~5ms) against a ~200ms search.
- **Minimum MP / Minimum HP only bind from 2nd job onward.** Both are post-2nd-JA floors, so a lvl-1 character (MP 5 vs a formula value of ~149) must not be rejected for sitting below them. Enforcing them earlier made every plan that starts MP-washing before 2nd job infeasible and masked the real binding constraint.
