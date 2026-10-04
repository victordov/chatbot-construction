/**
 * Process-wide singleton for the workflow runtime.
 *
 * These hold live state (the compiled workflow currently serving each tenant). Constructing them ad hoc -
 * as routes/workflow.js did on every publish - means the hot-swap lands in a
 * throwaway object and the workflow actually serving traffic never changes.
 */

const WorkflowRuntimeService = require('./workflow-runtime');

let runtimeService = null;

/**
 * Wire the singletons to a socket manager. Safe to call more than once; later
 * calls are ignored so the live state is never discarded.
 */
function initialize(socketManager) {
  if (!runtimeService) {
    runtimeService = new WorkflowRuntimeService(socketManager);
  }
  return { runtimeService };
}

function getRuntimeService() {
  if (!runtimeService) {
    // Lazily create without a socket manager so background callers still work
    // in contexts where sockets were never initialised (tests, scripts).
    runtimeService = new WorkflowRuntimeService(null);
  }
  return runtimeService;
}

/** Test helper: drop the singletons so suites start from a clean slate. */
function reset() {
  if (runtimeService && typeof runtimeService.shutdown === 'function') {
    runtimeService.shutdown();
  }
  runtimeService = null;
}

module.exports = {
  initialize,
  getRuntimeService,
  reset
};
