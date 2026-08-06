/**
 * Process-wide singletons for the workflow runtime and operator assist
 * services.
 *
 * These hold live state (the compiled workflow currently serving each tenant,
 * which conversations an operator is attached to). Constructing them ad hoc -
 * as routes/workflow.js did on every publish - means the hot-swap lands in a
 * throwaway object and the workflow actually serving traffic never changes.
 */

const WorkflowRuntimeService = require('./workflow-runtime');
const OperatorAssistService = require('./operator-assist');

let runtimeService = null;
let operatorAssistService = null;

/**
 * Wire the singletons to a socket manager. Safe to call more than once; later
 * calls are ignored so the live state is never discarded.
 */
function initialize(socketManager) {
  if (!runtimeService) {
    runtimeService = new WorkflowRuntimeService(socketManager);
  }
  if (!operatorAssistService) {
    operatorAssistService = new OperatorAssistService(socketManager);
  }
  return { runtimeService, operatorAssistService };
}

function getRuntimeService() {
  if (!runtimeService) {
    // Lazily create without a socket manager so background callers still work
    // in contexts where sockets were never initialised (tests, scripts).
    runtimeService = new WorkflowRuntimeService(null);
  }
  return runtimeService;
}

function getOperatorAssistService() {
  if (!operatorAssistService) {
    operatorAssistService = new OperatorAssistService(null);
  }
  return operatorAssistService;
}

/** Test helper: drop the singletons so suites start from a clean slate. */
function reset() {
  if (runtimeService && typeof runtimeService.shutdown === 'function') {
    runtimeService.shutdown();
  }
  runtimeService = null;
  operatorAssistService = null;
}

module.exports = {
  initialize,
  getRuntimeService,
  getOperatorAssistService,
  reset
};
