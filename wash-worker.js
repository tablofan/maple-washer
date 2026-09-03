// Off-main-thread driver for engine.optimize().
//
// Loaded as a classic worker from index.html (relative path, same origin — this is what keeps it
// deployable to GitHub Pages with no build step). engine.js and classes.js are plain scripts with
// no DOM references, so they import unchanged and stay byte-identical to what the Node test
// harness evals.
//
// Message contract (see tests/engine.test.js for the shape assertions):
//   in:  { requestId, className, currentState, goals, gearInt, mwMultiplier }
//   out: { requestId, type: 'progress', completed, total }
//      | { requestId, type: 'result', result }
//      | { requestId, type: 'error', message }
//
// `className` is sent instead of the `classData` object because class entries carry function
// properties (minMPFormula, minHPFormula) which structured cloning cannot transfer. The worker
// resolves the name against its own CLASSES table.

importScripts('./classes.js', './engine.js');

self.onmessage = (event) => {
  const { requestId, className, currentState, goals, gearInt, mwMultiplier } = event.data;
  try {
    const classData = CLASSES[className];
    if (!classData) {
      throw new Error(`Unknown class: ${className}`);
    }

    // Progress is reported from the optimizer's outer loop, so these fire a bounded number of
    // times (one per Target Base INT candidate) rather than per candidate.
    const result = optimize(
      classData,
      currentState,
      goals,
      gearInt,
      mwMultiplier,
      (progress) => {
        self.postMessage({
          requestId,
          type: 'progress',
          completed: progress.completed,
          total: progress.total,
        });
      }
    );

    self.postMessage({ requestId, type: 'result', result });
  } catch (err) {
    self.postMessage({
      requestId,
      type: 'error',
      message: (err && err.message) ? err.message : String(err),
    });
  }
};
