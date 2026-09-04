# Maple Washer

Maple Washer is a browser-based calculator and simulator for HP Washing, a MapleStory character
progression mechanic, using the rules of the MapleLegends server. It translates a dense set of class
formulas and game constraints into an executable, level-by-level plan while minimizing the number
of AP Resets required.

The project is a dependency-free JavaScript application. Its calculation engine is kept separate
from the interface and exercised directly through a Node.js test suite.

## Engineering highlights

- Searches non-Mage Target Base INT and wash transitions; non-Mages choose their Swap Level, while Magicians keep every fresh AP in INT and the calculator optimizes when MP washing and stale HP washing begin.
- Supports fresh characters and partially progressed characters across 11 classes.
- Models first-job Base Stat requirements, class-specific HP/MP gains, minimum HP/MP constraints,
  gear INT, Maple Warrior, fresh and stale HP washing, and the Magician MP-cap strategy.
- Generates both a concise phase plan and a level-by-level schedule from the same calculation path.
- Detects infeasible goals and reports the violated constraint rather than returning a misleading
  plan.
- Uses reference cases derived from published community formula compilations alongside engine
  invariants and boundary-focused tests.

## Repository structure

| Path | Purpose |
| --- | --- |
| `classes.js` | Class constants, limits, and formula inputs |
| `engine.js` | Optimization, feasibility checks, phase planning, and level projection |
| `wash-worker.js` | Web Worker wrapper that runs `optimize` off the main thread |
| `index.html` | Browser interface and result presentation |
| `tests/engine.test.js` | Dependency-free Node.js test harness |
| `CONTEXT.md` | Domain model, terminology, constraints, and reference notes |

## Run locally

There is no build step. Serve the repository locally:

> A local server is required because the calculator runs in a Web Worker, and browsers block
> worker scripts on `file://` origins. Without a worker, the page falls back to computing on the
> main thread, which freezes the UI during long searches.

```sh
python3 -m http.server 8731
```

Then open `http://localhost:8731` in a browser.

## Test

Run the complete engine suite from the repository root:

```sh
node tests/engine.test.js
```

The suite covers published reference cases, optimizer ordering, mid-progress strategies, engine
invariants, class limits, phase-plan structure, and agreement between summary and level-by-level
outputs. It has no package-install step or external test dependencies.

## Model and references

The planner follows the terminology and formulas documented in [`CONTEXT.md`](CONTEXT.md). Test
expectations are calibrated against Nise's formula compilation and Krythan's class-specific
planning sheets; ranges are used where those references expose user-selected variables that this
application optimizes automatically.

This is an independent planning tool for a community-run game server. It is not affiliated with
Nexon, MapleStory, MapleLegends, or the referenced guide authors.

## License

MIT
