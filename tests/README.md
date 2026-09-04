# Tests

## Run

From the repo root:

```
node tests/engine.test.js
```

No dependencies. The harness concatenates `classes.js` and `engine.js` into a
temporary CommonJS module and `require()`s it, so both source files stay in the
form the browser expects (plain `<script>`s, no module wrapping). `require` is
used in preference to `eval` because V8 leaves eval'd code interpreted, which
makes the brute-force optimizer roughly five times slower.

Exit code is `0` on success, non-zero on any failure.

Expect several minutes, not seconds: a few tests run full level-1-to-200
searches. `plan()` memoises on its resolved inputs, so the many tests that
assert different facets of one fixture pay for it once.

## What's tested

- **Reference cases (Krythan-aligned)** — Assassin, Fighter, and Magician at
  Krythan's published defaults. Where Krythan's sheets take Target Base INT as a
  user input that our optimizer picks automatically, we assert a range rather
  than an exact value (±10%); elsewhere the reference assertions are exact.
- **Boundary cases** — 30k HP/MP caps, MP exactly at Min MP, Current Level ==
  Target Level, mid-progress vs fresh-start cost relationship.
- **Infeasibility detection** — Mage requesting 30k HP at lvl 50, MP Goal below
  class Min MP, Target Level below Current Level, plans that would overshoot
  the 30k MP cap.
- **Per-class smoke tests** — every one of the 11 classes returns a feasible
  plan for a sensible HP/MP/Target Level combination.
- **Engine invariants** — cumulative AP Resets monotone, HP monotone, the 30k
  HP/MP caps, the HP/MP Pool rule, and exact agreement between the summary
  numbers and the final row of the level table.
- **Phase plan and level table shape** — phase ordering and vocabulary, the
  Base-INT collapse at the Swap Level, per-level AP splits, and the Non-INT pool
  column.
- **Input preparation and worker wiring** — `prepareInputs` clamping and its
  notes, plus `wash-worker.js` driven in a `vm` against a stub `optimize`.

## Where the reference numbers come from

Krythan's per-class washing sheets on MapleLegends (see `CONTEXT.md` for the
five spreadsheet IDs). His sheets cross-reference Nise's MapleLegends formula
compilation, which is what our `classes.js` constants are derived from.

When in doubt about a constant, the source of truth is:

1. Nise: <https://forum.legends.ml/index.php?threads/nises-hp-washing-formula-compilation.38558/>
2. Then Krythan's class-specific guides if Nise doesn't disambiguate.
