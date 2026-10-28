/**
 * The editor's rules for connecting steps, kept apart from the DOM so they
 * can be tested on their own.
 *
 * The rule is one connection per output. A step with one output (a Fixed
 * Reply, a Tag) can lead to one next step; a step with several - a Router's
 * rules, an Action's Worked and Failed, an Ask's Answered and Could not
 * answer, each choice of an Offer Choices step - can lead somewhere different
 * from each. Connecting an output that is already connected moves that
 * connection.
 *
 * It used to be "one connection per step" for everything but a Router, so
 * wiring an Action's Failed output silently deleted its Worked one, and the
 * branching steps the compiler supports could not be drawn.
 */

/**
 * The edges after connecting `source` (from `sourceHandle`) to `target`.
 *
 * @param {Array<{id, source, target, sourceHandle}>} edges
 * @param {{source: string, target: string, sourceHandle?: string|null, id: string}} link
 * @returns {{edges: Array, changed: boolean}} a new array; `changed` is false
 *          when exactly that connection already existed
 */
export function connectEdge(edges, { source, target, sourceHandle = null, id }) {
  const handle = sourceHandle || null;
  const sameOutput = edge => edge.source === source && (edge.sourceHandle || null) === handle;

  if (edges.some(edge => sameOutput(edge) && edge.target === target)) {
    return { edges, changed: false };
  }

  return {
    edges: [
      ...edges.filter(edge => !sameOutput(edge)),
      { id, source, target, sourceHandle: handle }
    ],
    changed: true
  };
}

/**
 * Whether connecting `source` to `target` would make a loop - a path from
 * `target` that already leads back to `source`.
 */
export function wouldCycle(edges, source, target) {
  const adjacency = new Map();
  edges.forEach(edge => {
    if (!adjacency.has(edge.source)) {
      adjacency.set(edge.source, []);
    }
    adjacency.get(edge.source).push(edge.target);
  });

  const seen = new Set();
  const stack = [target];
  while (stack.length) {
    const current = stack.pop();
    if (current === source) {
      return true;
    }
    if (seen.has(current)) {
      continue;
    }
    seen.add(current);
    (adjacency.get(current) || []).forEach(next => stack.push(next));
  }
  return false;
}

/**
 * What a trigger means, in a sentence for the publish dialog and the list.
 *
 * @param {{type?: string, description?: string, keywords?: string[]}} trigger
 */
export function describeTrigger(trigger) {
  const type = trigger && trigger.type;
  if (type === 'intent') {
    const description = String(trigger.description || '').trim();
    return description
      ? `Runs when the visitor wants: ${description}`
      : 'Runs when the visitor wants… (not described yet)';
  }
  if (type === 'keywords') {
    const keywords = (trigger.keywords || []).filter(Boolean);
    return keywords.length
      ? `Runs when a message mentions ${keywords.map(keyword => `"${keyword}"`).join(', ')}`
      : 'Runs on keywords (none added yet)';
  }
  return 'Answers every message';
}
