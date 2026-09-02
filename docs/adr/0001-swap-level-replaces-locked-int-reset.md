# Reset Base INT at a user-supplied Swap Level, not at Target Level

We previously locked "level to reset **Base INT** → **Main Stat**" to **Target Level**, on the rationale that resetting earlier "loses INT/10 MP gain for remaining levels at no benefit." That rationale was wrong: there is a benefit, and it is the entire point of washing. A character carrying several hundred **Base INT** does no damage, because INT is not its **Main Stat**. We now take **Swap Level** as a user input at which all **Base INT** is reset to the **Main Stat**.

## What remains coupled

Once INT is flushed, further `-MP +MainStat` MP-wash cycles are net MP-negative: `freshAPMPBase + ⌊Base INT/10⌋` falls below `mpLossPerReset` at low INT (10 + 0 < 12 for a Night Lord). **MP Wash** therefore cannot continue past **Swap Level**, and **Base INT** cannot be rebuilt afterwards. **Target Base INT** must be reached before the swap.

The converse does not hold: stopping **MP Wash** does not require resetting INT immediately. While **Base INT** is retained, a level can allocate all 5 fresh AP to HP and pair them with 5 `-MP +MainStat` resets. Compared with MP Washing that level, the reset count is unchanged; it trades fresh-AP MP generation for the class's larger Fresh AP HP gain. The optimizer may therefore end **MP Wash** early and use the suffix through **Swap Level** for **Pre-Swap Fresh HP Wash**.

This matches Krythan's canonical plan, which resets Base INT at ~150 and explicitly calls the character "playable" only afterwards.

## Considered Options

- **Keep the reset locked to Target Level.** Rejected — it optimises purely for reset count and produces a character that cannot fight for its whole life.
- **Expose independent MP Wash stop and reset levels.** Rejected as a UI design — playability timing is the user's decision, but the reset-minimising optimizer can choose the internal transition to **Pre-Swap Fresh HP Wash**. A second input would ask the user to solve an optimization problem the calculator already has enough information to solve.
- **Search the swap level as an optimization variable.** Rejected — playability timing is a player preference that the reset-count objective cannot value. Minimizing resets alone may choose an impractically late swap.

## Consequences

- **The MP→HP conversion becomes a schedule, not a cost.** Whether the **Stale HP Wash** happens at the swap level or at **Target Level** does not change total **AP Resets** (verified: identical counts across the whole split). So we maximise the burst at **Swap Level** subject to the **MP Goal**, giving the player their HP as early as possible at no extra NX.
- **Post-swap Fresh HP Wash is an exact, frontloaded count.** A uniform per-level rate can force the optimizer to choose only coarse multiples of the post-swap level count. It now chooses the exact number of fresh washes needed and schedules 5 per level as early as possible, with a partial final level when necessary. Fresh and stale washes have the same reset and MP cost, but fresh yields more HP, so exact counting can replace several stale washes and lower NX while also delivering HP sooner.
- **Existing Base INT stays until the swap.** An early `-INT +MainStat` costs exactly the same AP Reset that would move the point at **Swap Level**, but loses its MP contribution on every intervening level. The optimizer therefore never shifts INT down up-front. If it no longer needs fresh-AP MP generation, it transitions to **Pre-Swap Fresh HP Wash** while retaining the INT-based level-up MP gain.
- **The MP Wash end is an internal optimization boundary.** The search checks the HP breakpoint where whole five-AP pre-Swap levels satisfy the HP Goal and the MP breakpoint where enough MP-wash levels remain to satisfy the MP Goal. Nearby endpoints cover integer floors and cleanup-wash boundaries. The user still supplies only **Swap Level**.
- **Swap cost is not monotonic.** A later Swap retains INT-based MP gain and creates more room for pre-Swap Fresh HP Wash, but also delays playability. The reset-minimising calculator does not choose that preference for the player.
- **The per-level walk is authoritative over the analytical sums.** `evaluateStrategy` sums whole ranges (plateau averages, one `Math.ceil` at the end); `levelTable` walks level by level with a `floor()` on INT/10 and a MAX_HP clip at every step. The two differ by a wash or two, which decides whether a tight plan actually reaches its goals. `optimize` keeps a shortlist of the cheapest candidates and returns the cheapest that `levelTable` confirms, then reports the walk's numbers — so the Summary and the level table can never disagree. Cost is one `levelTable` call per shortlisted candidate (~5ms) against a ~200ms search.
- **Minimum MP / Minimum HP only bind from 2nd job onward.** Both are post-2nd-JA floors, so a lvl-1 character (MP 5 vs a formula value of ~149) must not be rejected for sitting below them. Enforcing them earlier made every plan that starts MP-washing before 2nd job infeasible and masked the real binding constraint.
