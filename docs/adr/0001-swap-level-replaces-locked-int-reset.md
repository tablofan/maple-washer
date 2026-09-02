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
- **Post-swap Fresh HP Wash is an exact, frontloaded count.** A uniform per-level rate can force the optimizer to choose only coarse multiples of the post-swap level count. It now chooses the exact number of fresh washes needed and schedules 5 per level as early as possible, with a partial final level when necessary. Fresh and stale washes have the same reset and MP cost, but fresh yields more HP, so exact counting can replace several stale washes and lower NX while also delivering HP sooner.
- **Existing Base INT stays until the swap.** An early `-INT +MainStat` costs exactly the same AP Reset that would move the point at **Swap Level**, but loses its MP contribution on every intervening level. The optimizer therefore never shifts INT down up-front. If the retained INT already generates enough MP, it skips or delays **MP Wash** and puts otherwise-unused pre-swap fresh AP directly into **Main Stat**.
- **Very late swaps remain expensive for high-`freshAPHP` classes, but cost is not monotonic.** Sweeping a Hero at 30k HP / 2k MP @ 180 gives: swap 40 → 662 resets, 80 → 563, 120 → 624, 160 → 984, 180 → 1,159. The optimizer trades pre-swap Main Stat allocation against post-swap Fresh HP Wash, so the best mix can sit in the middle; a late Swap Level no longer falsely forces an MP Wash on every preceding level.
- **The per-level walk is authoritative over the analytical sums.** `evaluateStrategy` sums whole ranges (plateau averages, one `Math.ceil` at the end); `levelTable` walks level by level with a `floor()` on INT/10 and a MAX_HP clip at every step. The two differ by a wash or two, which decides whether a tight plan actually reaches its goals. `optimize` keeps a shortlist of the cheapest candidates and returns the cheapest that `levelTable` confirms, then reports the walk's numbers — so the Summary and the level table can never disagree. Cost is one `levelTable` call per shortlisted candidate (~5ms) against a ~200ms search.
- **Minimum MP / Minimum HP only bind from 2nd job onward.** Both are post-2nd-JA floors, so a lvl-1 character (MP 5 vs a formula value of ~149) must not be rejected for sitting below them. Enforcing them earlier made every plan that starts MP-washing before 2nd job infeasible and masked the real binding constraint.
