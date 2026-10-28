/**
 * The contract between this platform and a tenant's own systems.
 *
 * A workflow's Call an API node can already reach any URL, but everything it
 * gets back is shapeless: strings pulled out by path, no idea what they mean.
 * That is enough to say "your order is shipped" and nothing more. It cannot
 * show a product with its picture, offer three appointment times as buttons, or
 * let the assistant decide for itself to search the catalogue — because none of
 * those are possible without knowing what a product or a slot *is*.
 *
 * So this file defines a small number of things a business plausibly has, with
 * fixed shapes. A tenant implements the ones that apply to them using the SDK
 * in sdk/, and from then on the platform knows what it is holding.
 *
 * Deliberately small. Every capability here is one somebody would recognise
 * from their own business; there is no generic `query` escape hatch, because a
 * contract that can express anything constrains nothing and the widget would be
 * back to rendering paragraphs.
 */

/**
 * The data shapes. Written as a tiny declarative form rather than JSON Schema:
 * the validation errors have to be read by whoever is implementing the
 * connector, and "product.price: expected a string, got 12.5" is more use to
 * them than a schema path.
 *
 * `?` marks a field as optional. `url` is a string that must parse as one, so a
 * broken image link is caught here rather than as a missing picture later.
 */
const TYPES = {
  Product: {
    id: 'string',
    title: 'string',
    price: 'string?',
    currency: 'string?',
    image: 'url?',
    url: 'url?',
    description: 'string?',
    inStock: 'boolean?'
  },
  Slot: {
    id: 'string',
    startsAt: 'date',
    endsAt: 'date?',
    label: 'string?',
    staff: 'string?'
  },
  Booking: {
    id: 'string',
    startsAt: 'date',
    reference: 'string?',
    status: 'string?',
    // What the widget's card says ("Booked: Tue 21 Oct, 09:15"), and, when
    // the status is `link`, the page where the visitor finishes booking -
    // Calendly on its free plan cannot book through its API.
    title: 'string?',
    url: 'url?'
  }
};

/**
 * What a tenant can implement.
 *
 * `kind` is the load-bearing field. A read can be run whenever we like —
 * including from the editor's preview, and speculatively by the assistant. A
 * write changes something in somebody's business and is never run to try a flow
 * out, and never without the conversation having reached that step for real.
 */
const CAPABILITIES = [
  {
    id: 'catalog.search',
    label: 'Search the catalogue',
    kind: 'read',
    description: 'Find products matching what the visitor asked for.',
    input: { query: 'string', limit: 'number?' },
    returns: { list: 'Product' },
    example: 'A visitor asks "do you have waterproof panniers?"'
  },
  {
    id: 'catalog.get',
    label: 'Get one product',
    kind: 'read',
    description: 'Look up a single product by its id.',
    input: { id: 'string' },
    returns: { one: 'Product' },
    example: 'Showing the product a visitor picked from search results.'
  },
  {
    id: 'availability.slots',
    label: 'List free appointment times',
    kind: 'read',
    description: 'The times somebody could book, between two dates.',
    input: { service: 'string?', from: 'date?', to: 'date?', limit: 'number?' },
    returns: { list: 'Slot' },
    example: 'A visitor asks for a service on Thursday.'
  },
  {
    id: 'availability.book',
    label: 'Book an appointment',
    kind: 'write',
    description: 'Reserve one of the slots. This changes the diary.',
    input: { slotId: 'string', name: 'string?', email: 'string?', phone: 'string?', notes: 'string?' },
    returns: { one: 'Booking' },
    example: 'The visitor picked a time and gave their details.'
  },
  {
    id: 'availability.cancel',
    label: 'Cancel an appointment',
    kind: 'write',
    description: 'Cancel a booking by its reference. The visitor must be in the conversation it was booked from, or give the email it was booked under.',
    input: { reference: 'string', email: 'string?' },
    returns: { one: 'Booking' },
    example: 'A visitor says "I can\'t make it on Thursday, please cancel BK-7F3K2Q".'
  }
];

const BY_ID = new Map(CAPABILITIES.map(capability => [capability.id, capability]));

/**
 * Check one value against a field type.
 *
 * @returns {{ok: true, value: *}|{ok: false, error: string}}
 */
function checkField(value, spec) {
  const optional = spec.endsWith('?');
  const type = optional ? spec.slice(0, -1) : spec;

  if (value === undefined || value === null || value === '') {
    return optional
      ? { ok: true, value: undefined }
      : { ok: false, error: 'is required' };
  }

  switch (type) {
  case 'string':
    // Numbers are accepted and converted: an id or a price arriving as a
    // number is the single most common thing a connector gets "wrong", and
    // rejecting it would be pedantry rather than protection.
    if (typeof value === 'string' || typeof value === 'number') {
      return { ok: true, value: String(value) };
    }
    return { ok: false, error: `expected a string, got ${typeof value}` };

  case 'number': {
    const numeric = Number(value);
    return Number.isFinite(numeric)
      ? { ok: true, value: numeric }
      : { ok: false, error: `expected a number, got ${JSON.stringify(value)}` };
  }

  case 'boolean':
    return { ok: true, value: Boolean(value) };

  case 'url':
    try {
      const url = new URL(String(value));
      if (!['http:', 'https:'].includes(url.protocol)) {
        return { ok: false, error: 'must be an http or https URL' };
      }
      return { ok: true, value: url.toString() };
    } catch {
      return { ok: false, error: `is not a valid URL: ${JSON.stringify(value)}` };
    }

  case 'date': {
    const date = new Date(value);
    return Number.isNaN(date.getTime())
      ? { ok: false, error: `is not a date we can read: ${JSON.stringify(value)}` }
      : { ok: true, value: date.toISOString() };
  }

  default:
    return { ok: true, value };
  }
}

/**
 * Check an object against one of the shapes above.
 *
 * Unknown fields are dropped rather than rejected. A tenant's product almost
 * certainly carries twenty fields we have no use for, and refusing the whole
 * thing over them would make the contract impossible to satisfy — but passing
 * them through would put arbitrary business data into a model's context and a
 * stored transcript, which is exactly what we avoid everywhere else.
 */
function validateShape(value, typeName, path = typeName.toLowerCase()) {
  const shape = TYPES[typeName];

  if (!shape) {
    return { ok: false, errors: [`${path}: unknown type ${typeName}`] };
  }

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, errors: [`${path}: expected an object`] };
  }

  const errors = [];
  const clean = {};

  Object.entries(shape).forEach(([field, spec]) => {
    const result = checkField(value[field], spec);

    if (!result.ok) {
      errors.push(`${path}.${field} ${result.error}`);
      return;
    }
    if (result.value !== undefined) {
      clean[field] = result.value;
    }
  });

  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: clean };
}

/**
 * Check what a connector returned for a capability.
 *
 * Validating here rather than trusting it is what stops a mis-shaped response
 * becoming a blank product card three steps later, when the cause is no longer
 * obvious. The errors are written to be pasted into a bug report by whoever is
 * implementing the connector.
 */
function validateResult(capabilityId, result, options = {}) {
  const capability = BY_ID.get(capabilityId);

  if (!capability) {
    return { ok: false, errors: [`Unknown capability: ${capabilityId}`] };
  }

  const maxItems = options.maxItems || 25;

  if (capability.returns.list) {
    if (!Array.isArray(result)) {
      return { ok: false, errors: [`${capabilityId} must return an array`] };
    }

    const errors = [];
    const items = [];

    // Capped: a catalogue search that returns four thousand products would
    // otherwise put all of them through a model's context.
    result.slice(0, maxItems).forEach((item, index) => {
      const checked = validateShape(item, capability.returns.list, `item ${index}`);
      if (checked.ok) {
        items.push(checked.value);
      } else {
        errors.push(...checked.errors);
      }
    });

    // A few bad rows among good ones are dropped rather than failing the lot:
    // one product with a broken image URL should not hide the other nine.
    return errors.length > 0 && items.length === 0
      ? { ok: false, errors }
      : { ok: true, value: items, warnings: errors, truncated: result.length > maxItems };
  }

  const checked = validateShape(result, capability.returns.one);

  return checked.ok
    ? { ok: true, value: checked.value }
    : { ok: false, errors: checked.errors };
}

/** Check the inputs before a call goes out, so a mistake is ours to report. */
function validateInput(capabilityId, input = {}) {
  const capability = BY_ID.get(capabilityId);

  if (!capability) {
    return { ok: false, errors: [`Unknown capability: ${capabilityId}`] };
  }

  const errors = [];
  const clean = {};

  Object.entries(capability.input).forEach(([field, spec]) => {
    const result = checkField(input[field], spec);

    if (!result.ok) {
      errors.push(`${field} ${result.error}`);
      return;
    }
    if (result.value !== undefined) {
      clean[field] = result.value;
    }
  });

  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: clean };
}

module.exports = {
  CAPABILITIES,
  TYPES,
  byId: id => BY_ID.get(id) || null,
  ids: () => CAPABILITIES.map(capability => capability.id),
  isWrite: id => (BY_ID.get(id) || {}).kind === 'write',
  validateResult,
  validateInput,
  validateShape
};
