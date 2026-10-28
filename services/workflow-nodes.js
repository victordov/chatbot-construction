/**
 * The node types that do something other than produce a sentence.
 *
 * The existing set could only answer: match the message, retrieve, generate,
 * reply. Everything a real support flow needs between those steps was missing —
 * asking a question and using the answer, offering choices, branching on the
 * result of a lookup, tagging, raising a ticket, telling somebody.
 *
 * These are deliberately not a copy of n8n's or Node-RED's palette. Those are
 * general automation tools whose unit of work is a record moving through a
 * pipeline; here the unit of work is a conversation with a person who is
 * waiting. The nodes that matter are the ones that are aware of that: a step
 * that waits for a reply, a step that offers buttons, a step that knows whether
 * the office is open. A "Code" node — n8n's most-used — is deliberately absent:
 * running tenant-supplied JavaScript in this process is a remote code execution
 * hole wearing a hat, and it would need a sandbox this product does not have.
 * A structured condition covers the cases people actually use it for.
 */

const Conversation = require('../models/conversation');
const Company = require('../models/company');
const Task = require('../models/task');
const emailChannel = require('./email-channel');
const availability = require('./availability');
const connector = require('./connector');
const capabilityContract = require('../config/capabilities');
const assignmentService = require('./assignment');
const { logger } = require('./logging');

/** How many times a badly answered question is asked again before giving up. */
const MAX_ASK_ATTEMPTS = 3;

/** Longest pattern a tenant may write. Real validation patterns are short. */
const MAX_PATTERN_LENGTH = 200;

/**
 * Why a tenant-authored regular expression is refused, or null if it is fine.
 *
 * The patterns come from a tenant admin, not a visitor, but a single
 * `(\w+)*$` in an Ask node runs against every visitor's every answer, and one
 * badly chosen pattern would make the whole tenant's bot hang - which is also
 * the thread every other tenant's replies run on. There is no safe-regex
 * library here, so this is a length cap plus a detector for the shape that
 * causes catastrophic backtracking: a quantified group (something inside it
 * can repeat) that is itself quantified.
 */
function unsafePatternReason(pattern) {
  const text = String(pattern);

  if (text.length > MAX_PATTERN_LENGTH) {
    return `is longer than ${MAX_PATTERN_LENGTH} characters`;
  }

  // Walk the pattern once, tracking groups. A group is "quantified inside"
  // when an unescaped *, + or {n,} appears in it outside a character class;
  // if that group is then followed by a quantifier the pattern can backtrack
  // exponentially. Nested groups inherit: `((a+)b)*` is as bad as `(a+)*`.
  const stack = [];
  let inClass = false;
  let lastClosedGroupQuantified = false;
  let justClosedGroup = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];

    if (char === '\\') {
      i++;
      justClosedGroup = false;
      continue;
    }

    if (inClass) {
      if (char === ']') {
        inClass = false;
      }
      justClosedGroup = false;
      continue;
    }

    if (char === '[') {
      inClass = true;
      justClosedGroup = false;
      continue;
    }

    if (char === '(') {
      stack.push({ quantified: false });
      justClosedGroup = false;
      continue;
    }

    if (char === ')') {
      const closed = stack.pop() || { quantified: false };
      lastClosedGroupQuantified = closed.quantified;
      if (closed.quantified && stack.length > 0) {
        stack[stack.length - 1].quantified = true;
      }
      justClosedGroup = true;
      continue;
    }

    // Only an unbounded repetition matters: `(\d+)?` tries at most two ways,
    // `(\d+)*` tries exponentially many.
    const unbounded = char === '*' || char === '+' ||
      (char === '{' && /^\{\d+,\}/.test(text.slice(i)));

    if (unbounded && justClosedGroup && lastClosedGroupQuantified) {
      return 'repeats a group that already contains a repetition, which can ' +
        'take exponential time to match (for example (a+)+ or (.*)*)';
    }

    if (unbounded && stack.length > 0) {
      stack[stack.length - 1].quantified = true;
    }

    justClosedGroup = false;
  }

  return null;
}

// Patterns are compiled once and reused: a published workflow runs the same
// three or four patterns against every message, and construction is the
// expensive part. Bounded so a flood of distinct patterns cannot grow it.
const compiledPatterns = new Map();
const MAX_COMPILED_PATTERNS = 500;

/**
 * Compile a tenant-authored pattern, or explain why it cannot be used.
 *
 * @returns {{regex: RegExp}|{error: string}}
 */
function compilePattern(pattern, flags = '') {
  const key = `${flags}/${pattern}`;
  const cached = compiledPatterns.get(key);
  if (cached) {
    return cached;
  }

  let result;
  const reason = unsafePatternReason(pattern);

  if (reason) {
    result = { error: `Pattern "${String(pattern).slice(0, 40)}" ${reason}` };
  } else {
    try {
      result = { regex: new RegExp(pattern, flags) };
    } catch (error) {
      result = { error: `Pattern "${String(pattern).slice(0, 40)}" is not a valid regular expression: ${error.message}` };
    }
  }

  if (compiledPatterns.size >= MAX_COMPILED_PATTERNS) {
    compiledPatterns.clear();
  }
  compiledPatterns.set(key, result);
  return result;
}

/**
 * Report what a node would have done, instead of doing it.
 *
 * Used when a flow is being tried out from the editor. A preview that raises
 * real tasks, tags real conversations and emails a real team is worse than no
 * preview at all: an author testing a branch six times leaves six tickets
 * behind, and stops testing.
 *
 * The note is shown to the author beside the transcript, so a dry run is still
 * informative — "would have raised a task titled X" tells them the wiring is
 * right without anybody's queue paying for it.
 */
function wouldHave(description, extra = {}) {
  return { simulated: [{ description, ...extra }] };
}

/**
 * Answer formats worth checking before accepting.
 *
 * Validation exists so a workflow does not carry "asdf" forward into an API
 * call as an order number and produce a confusing failure two steps later.
 */
const VALIDATORS = {
  any: () => true,
  email: value => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value),
  phone: value => /^[+()\-.\s\d]{6,20}$/.test(value),
  number: value => /^-?\d+(\.\d+)?$/.test(value.replace(/[\s,]/g, '')),
  // Deliberately loose: order references vary wildly and rejecting a valid one
  // is worse than accepting a wrong one, which the lookup will catch anyway.
  reference: value => /^[\w-]{3,40}$/.test(value.trim())
};

const VALIDATION_HELP = {
  email: 'That does not look like an email address. Could you check it?',
  phone: 'That does not look like a phone number. Could you check it?',
  number: 'I need a number for that.',
  reference: 'That does not look like a reference. It is usually letters and numbers.'
};

/**
 * Check an answer against the node's expected format.
 */
function validateAnswer(value, kind = 'any', pattern = null) {
  const text = String(value || '').trim();

  if (!text) {
    return { valid: false, message: 'I did not catch that — could you try again?' };
  }

  if (pattern) {
    // Refused patterns are caught at validation time; one that slipped through
    // (a workflow saved before the check existed) is ignored rather than run,
    // and the input is capped so even an accepted pattern stays bounded.
    const compiled = compilePattern(pattern);
    if (compiled.error) {
      logger.warn('Ask node has an unusable pattern', { pattern, error: compiled.error });
    } else if (!compiled.regex.test(text.slice(0, 500))) {
      return { valid: false, message: 'That does not look right — could you try again?' };
    }
  }

  const check = VALIDATORS[kind] || VALIDATORS.any;

  return check(text)
    ? { valid: true, value: text }
    : { valid: false, message: VALIDATION_HELP[kind] || 'That does not look right — could you try again?' };
}

/**
 * A question that waits for the answer.
 *
 * The node that the whole multi-turn capability rests on. Returning `awaiting`
 * tells the caller to stop walking and remember where it was; the next message
 * from this visitor resumes here rather than starting the workflow again.
 */
function runAsk(step, context) {
  const data = step.data || {};
  const variable = String(data.variable || 'answer').replace(/[^\w]/g, '_');

  return {
    response: context.render(data.question || 'Could you tell me a bit more?'),
    awaiting: {
      nodeId: context.currentId,
      variable,
      kind: data.validate || 'any',
      pattern: data.pattern || null,
      attempts: 0,
      maxAttempts: parseInt(data.maxAttempts, 10) || MAX_ASK_ATTEMPTS
    },
    halt: true
  };
}

/**
 * A question with a fixed set of answers.
 *
 * Buttons rather than free text wherever the answer is one of a known few: it
 * removes the guessing from routing entirely, and a visitor tapping "Track my
 * order" is unambiguous in a way that typing "wheres my stuff" is not.
 */
function runButtons(step, context) {
  const data = step.data || {};

  const choices = (data.choices || [])
    .filter(choice => choice && choice.label)
    .map((choice, index) => ({
      id: choice.id || `choice_${index}`,
      label: String(choice.label).slice(0, 60),
      value: choice.value || choice.label
    }));

  if (choices.length === 0) {
    // Nothing to offer: treat it as a plain message rather than sending an
    // empty prompt the visitor cannot answer.
    return { response: context.render(data.question || ''), halt: false };
  }

  return {
    response: context.render(data.question || 'Which of these do you need?'),
    choices,
    awaiting: {
      nodeId: context.currentId,
      variable: String(data.variable || 'choice').replace(/[^\w]/g, '_'),
      kind: 'choice',
      choices,
      attempts: 0,
      maxAttempts: parseInt(data.maxAttempts, 10) || MAX_ASK_ATTEMPTS
    },
    halt: true
  };
}

/**
 * Match a reply against the offered choices.
 *
 * Tolerant on purpose: a visitor may tap the button, type the label, or type
 * the number next to it. Rejecting two of those three would make the flow feel
 * broken for no benefit.
 */
function matchChoice(reply, choices = []) {
  const text = String(reply || '').trim().toLowerCase();

  if (!text) {
    return null;
  }

  // Everything through String(): a choice built from a capability result has
  // whatever id the tenant's system used, which is often a number.
  const exact = choices.find(choice =>
    String(choice.id).toLowerCase() === text ||
    String(choice.value).toLowerCase() === text ||
    String(choice.label).toLowerCase() === text);

  if (exact) {
    return exact;
  }

  const index = parseInt(text, 10);
  if (!Number.isNaN(index) && index >= 1 && index <= choices.length) {
    return choices[index - 1];
  }

  // Last resort: a label contained in the reply, so "the second one, refunds"
  // still lands.
  return choices.find(choice => text.includes(String(choice.label).toLowerCase())) || null;
}

/**
 * Branch on data rather than on what the visitor said.
 *
 * The Router asks "what did they mean"; this asks "what did we find out". A
 * flow that looks up an order needs to do something different when it is
 * `shipped` versus `refunded`, and no amount of intent matching on the
 * visitor's message can answer that.
 *
 * Structured rather than an expression language: there is no evaluator here for
 * a tenant-supplied string, which is the difference between a condition node
 * and an arbitrary code execution hole.
 */
const COMPARATORS = {
  equals: (left, right) => left.toLowerCase() === right.toLowerCase(),
  not_equals: (left, right) => left.toLowerCase() !== right.toLowerCase(),
  contains: (left, right) => left.toLowerCase().includes(right.toLowerCase()),
  starts_with: (left, right) => left.toLowerCase().startsWith(right.toLowerCase()),
  is_empty: left => left.trim() === '',
  is_not_empty: left => left.trim() !== '',
  greater_than: (left, right) => Number(left) > Number(right),
  less_than: (left, right) => Number(left) < Number(right),
  matches: (left, right) => {
    const compiled = compilePattern(right, 'i');
    return compiled.regex ? compiled.regex.test(left.slice(0, 500)) : false;
  }
};

function runCondition(step, context) {
  const data = step.data || {};

  // Several checks in one node, combined with all/any. This is the answer to
  // "do we need scripting": the overwhelming share of real conditions are
  // two or three comparisons AND-ed together — "status is shipped and days
  // late is greater than 3" — and a clause list covers that without an
  // expression evaluator for tenant-supplied strings, which is where the
  // security trouble starts.
  //
  // The single left/operator/right shape is still honoured, so workflows
  // saved before clauses existed keep working untouched.
  const clauses = (Array.isArray(data.clauses) && data.clauses.length > 0)
    ? data.clauses
    : (data.left !== undefined ? [data] : []);

  const evaluate = clause => {
    const left = context.render(clause.left || '');
    const right = context.render(clause.right || '');
    const comparator = COMPARATORS[clause.operator] || COMPARATORS.equals;

    try {
      return Boolean(comparator(String(left), String(right)));
    } catch (error) {
      logger.warn('Condition clause failed to evaluate', { error: error.message });
      return false;
    }
  };

  const usable = clauses.filter(clause => clause && clause.left !== undefined);

  if (usable.length === 0) {
    return { branch: 'false' };
  }

  const result = data.match === 'any'
    ? usable.some(evaluate)
    : usable.every(evaluate);

  return { branch: result ? 'true' : 'false' };
}

/**
 * Put something into the run's variables.
 *
 * Small, and needed constantly: composing a value out of two others, giving a
 * field a friendlier name before it reaches a reply, setting a default so a
 * later template does not render an empty gap.
 */
function runSet(step, context) {
  const assignments = {};

  (step.data?.assignments || []).forEach(assignment => {
    if (!assignment || !assignment.variable) {
      return;
    }
    const name = String(assignment.variable).replace(/[^\w]/g, '_');
    assignments[name] = context.render(assignment.value || '');
  });

  return { variables: assignments };
}

/**
 * Branch on whether the team is actually available.
 *
 * "Let me put you through to someone" at 2am is the single most common way a
 * chatbot loses somebody's trust. This is the check that lets a flow promise a
 * reply tomorrow instead.
 */
async function runBusinessHours(step, context) {
  try {
    const status = await availability.status(context.companyId);

    // Both halves matter: inside opening hours with nobody connected is still
    // nobody to talk to, so requiring an operator is the default. The editor
    // offers this as a phrase rather than a boolean, because "require
    // operator: false" is not a thing anyone reads correctly at a glance.
    const hoursOnly = step.data?.requireOperator === false ||
      step.data?.requireOperator === 'inside opening hours';

    const open = hoursOnly ? status.open : status.canReachOperator;

    return {
      branch: open ? 'open' : 'closed',
      variables: {
        opens_at: status.opensAt || '',
        next_opening: status.nextOpening || ''
      }
    };
  } catch (error) {
    logger.warn('Business hours check failed; treating as open', { error: error.message });
    // Fail towards the human. Wrongly offering a person is recoverable;
    // wrongly refusing one strands somebody who needed help.
    return { branch: 'open' };
  }
}

/**
 * Label the conversation from inside the flow.
 *
 * The tags an operator would have applied by hand, applied at the moment the
 * flow already knows the answer — which is also the only moment anybody has the
 * information for free.
 */
async function runTag(step, context) {
  const tags = assignmentService.normaliseTags(
    (step.data?.tags || []).map(tag => context.render(tag))
  );

  if (tags.length === 0) {
    return {};
  }

  if (context.simulate) {
    return wouldHave(`Tag the conversation: ${tags.join(', ')}`);
  }

  // Both halves of the filter are required. A session id is something a
  // caller can name, and the execute endpoint takes one from the request, so
  // without the company in the filter a workflow could tag another tenant's
  // conversation.
  if (!context.sessionId || !context.companyId) {
    return {};
  }

  try {
    await Conversation.updateOne(
      { sessionId: context.sessionId, company: context.companyId },
      { $addToSet: { tags: { $each: tags } } }
    );
  } catch (error) {
    // A failed tag must not break the conversation it was describing.
    logger.warn('Workflow tag node failed', { error: error.message });
  }

  return {};
}

/**
 * Raise a piece of work for the team.
 *
 * The difference between a bot that takes a message and a bot that opens a
 * ticket. Everything the flow collected goes into the description, so whoever
 * picks it up does not have to read the transcript to find the order number.
 */
async function runTask(step, context) {
  const data = step.data || {};

  if (context.simulate) {
    return {
      // A believable id, so a later step that renders {{task_id}} shows
      // something of the right shape rather than a blank.
      variables: { task_id: 'preview-task' },
      ...wouldHave(`Raise a ${data.priority || 'medium'} task: "${context.render(data.title || '')}"`)
    };
  }

  if (!context.companyId) {
    return {};
  }

  try {
    // Only what the flow actually gathered. The bookkeeping variables — how a
    // call went, whether the identity was verified — are for the flow to branch
    // on, and in a task description they are noise in front of the three lines
    // somebody needs.
    const internal = new Set([
      'user_input', 'user_message', 'knowledge_result',
      'contact_verified', 'contact_external_id',
      'action_status', 'action_error', 'task_id'
    ]);

    const collected = Object.entries(context.variables || {})
      .filter(([key, value]) => value && !internal.has(key))
      .map(([key, value]) => `- ${key}: ${value}`)
      .join('\n');

    const task = await Task.create({
      title: context.render(data.title || 'Follow up from a conversation').slice(0, 200),
      description: [
        context.render(data.description || ''),
        collected ? `\nCollected during the conversation:\n${collected}` : ''
      ].filter(Boolean).join('\n'),
      priority: ['low', 'medium', 'high', 'urgent'].includes(data.priority)
        ? data.priority
        : 'medium',
      status: 'open',
      // Raised by the bot on a customer's behalf: there is no user behind it,
      // and pretending there was would misattribute it to whoever happened to
      // publish the workflow.
      createdByBot: true,
      company: context.companyId,
      conversationId: context.conversationId,
      // The model requires a deadline, so an unspecified one becomes a few
      // working days out rather than failing the whole node.
      dueDate: new Date(Date.now() + (Number(data.dueInDays) || 3) * 86400000)
    });

    require('./webhooks').dispatch(context.companyId, 'task.created', {
      taskId: String(task._id),
      title: task.title,
      priority: task.priority,
      dueDate: task.dueDate,
      sessionId: context.sessionId,
      raisedBy: 'workflow'
    });

    return { variables: { task_id: String(task._id) } };
  } catch (error) {
    logger.warn('Workflow task node failed', { error: error.message });
    return {};
  }
}

/**
 * Email the team when the flow gets here.
 *
 * The task node raises work inside the product; this is for the team that
 * lives in their inbox — which, for the small businesses this covers, is most
 * of them. A complaint captured at 2am that nobody sees until they open the
 * dashboard was captured but not handled.
 *
 * Fire-and-forget by design: the visitor's conversation must never stall on an
 * SMTP server, and a failed notification is logged loudly rather than breaking
 * the flow that tried to send it.
 */
async function runNotify(step, context) {
  const data = step.data || {};
  const to = context.render(data.to || '').trim();

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
    logger.warn('Notify node has no usable recipient', { to });
    return {};
  }

  if (context.simulate) {
    return wouldHave(
      `Email ${to} with the subject "${context.render(data.subject || '')}"`
    );
  }

  const transport = emailChannel.buildTransport();

  if (!transport) {
    // No SMTP configured. The flow carries on — the tag/task nodes are the
    // durable record; this is the courtesy copy.
    logger.warn('Notify node skipped: no SMTP transport configured');
    return {};
  }

  try {
    const company = context.companyId
      ? await Company.findById(context.companyId).select('name emailChannel').lean()
      : null;

    const from = company?.emailChannel?.fromAddress ||
      process.env.EMAIL_FROM || process.env.EMAIL_USER;

    await transport.sendMail({
      from: company?.name ? `"${company.name} bot" <${from}>` : from,
      to,
      subject: context.render(data.subject || 'A conversation needs attention').slice(0, 200),
      text: context.render(data.body || '')
    });
  } catch (error) {
    logger.error('Notify node failed to send', { error: error.message });
  }

  return {};
}

/**
 * Use one of the capabilities the tenant implemented in their connector.
 *
 * The difference between this and the Call an API node is that the result has a
 * known shape. A product has a title and an image; a slot has a time. So the
 * results can be offered as buttons, rendered as cards in the widget, and
 * referred to by name in a later step — none of which is possible with
 * arbitrary JSON pulled apart by hand.
 *
 * Two outputs, like the API node: what to do when it worked, and what to do
 * when it did not or found nothing. "Found nothing" is deliberately the same
 * branch as "failed", because from the visitor's point of view they are the
 * same situation — the flow could not help — and making an author wire three
 * paths for two outcomes is how flows end up with dead ends.
 */
async function runCapability(step, context) {
  const data = step.data || {};
  const capabilityId = data.capability;
  const capability = capabilityContract.byId(capabilityId);

  if (!capability) {
    return { branch: 'error', variables: { capability_error: 'No capability chosen' } };
  }

  // The inputs are templates, so a search can use something collected earlier.
  const input = {};
  Object.keys(capability.input).forEach(field => {
    const raw = (data.input || {})[field];
    if (raw !== undefined && raw !== '') {
      input[field] = context.render(String(raw));
    }
  });

  const result = await connector.call(context.companyId, capabilityId, input, {
    simulate: context.simulate,
    maxItems: parseInt(data.limit, 10) || undefined,
    // So a booking made through a connected calendar is recorded against
    // this conversation, and its visitor can cancel it later.
    sessionId: context.sessionId
  });

  if (result.simulated) {
    // A write declined by the preview. Reported as success so the author is
    // testing the branch they meant to, exactly as the API node does.
    return { branch: 'success', simulated: result.simulated };
  }

  if (!result.ok) {
    return {
      branch: 'error',
      variables: { capability_error: result.error || 'The connector could not answer' }
    };
  }

  const value = result.value;
  const isList = Boolean(capability.returns.list);
  const items = isList ? (value || []) : (value ? [value] : []);

  if (items.length === 0) {
    // Nothing found is the error branch on purpose: the visitor asked for
    // something and the flow has nothing to say, which is the same problem to
    // solve as the connector being down.
    return { branch: 'error', variables: { capability_error: 'Nothing found' } };
  }

  const variables = { result_count: String(items.length) };

  // The first result flattened into variables, so a Fixed Reply can say
  // "{{result_title}} costs {{result_price}}" without anyone learning a path
  // syntax. The full list travels separately for the widget to render.
  Object.entries(items[0]).forEach(([field, fieldValue]) => {
    variables[`result_${field}`] = String(fieldValue);
  });

  const cards = { type: capability.returns.list || capability.returns.one, items };

  // The editor stores this as the words "yes"/"no", and "no" is truthy, so
  // every capability node used to offer buttons whether asked to or not.
  if (!isEnabled(data.offerAsChoices)) {
    // Rendered as cards by the widget rather than described in a sentence.
    return { branch: 'success', variables, cards };
  }

  const choices = items.slice(0, 6).map((item, index) => {
    const label = String(item.title || item.label || formatSlotLabel(item)).slice(0, 60);
    return {
      id: item.id !== undefined && item.id !== null ? item.id : `result_${index}`,
      label,
      value: item.id !== undefined && item.id !== null ? item.id : label
    };
  });

  // Offering buttons and walking straight on meant the flow booked, or
  // described, the first result before the visitor had tapped anything. It
  // now stops here like an Offer Choices step, and the tap resumes it down
  // the Found something output with the pick saved.
  return {
    branch: 'success',
    variables,
    cards,
    choices,
    response: context.render(data.question || 'Which one would you like?'),
    awaiting: {
      nodeId: context.currentId,
      variable: String(data.variable || 'selected').replace(/[^\w]/g, '_'),
      kind: 'choice',
      choices,
      attempts: 0,
      maxAttempts: MAX_ASK_ATTEMPTS,
      // Every pick goes the same way; somebody who keeps typing something
      // else is taken down the failure output, as for "nothing found".
      next: 'success',
      giveUp: 'error'
    },
    halt: true
  };
}

/**
 * Read a yes/no setting the editor may have stored as a boolean or a word.
 */
function isEnabled(value) {
  if (typeof value === 'boolean') {
    return value;
  }
  return ['yes', 'true', '1', 'on'].includes(String(value || '').trim().toLowerCase());
}

/**
 * A slot as somebody would say it out loud.
 *
 * Used when a slot has no label of its own — "Thursday, 2:30 pm" is a button
 * somebody can tap with confidence; an ISO timestamp is not.
 */
function formatSlotLabel(slot) {
  if (!slot || !slot.startsAt) {
    return 'This time';
  }

  const date = new Date(slot.startsAt);

  if (Number.isNaN(date.getTime())) {
    return String(slot.startsAt);
  }

  return date.toLocaleString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'short',
    hour: 'numeric', minute: '2-digit'
  });
}

module.exports = {
  runAsk,
  runButtons,
  runCondition,
  runSet,
  runBusinessHours,
  runTag,
  runTask,
  runNotify,
  runCapability,
  formatSlotLabel,
  matchChoice,
  validateAnswer,
  wouldHave,
  isEnabled,
  compilePattern,
  unsafePatternReason,
  MAX_PATTERN_LENGTH,
  COMPARATORS,
  VALIDATORS,
  MAX_ASK_ATTEMPTS
};
