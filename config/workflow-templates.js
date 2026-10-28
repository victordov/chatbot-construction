/**
 * Workflows a tenant can start from.
 *
 * A blank canvas is the worst thing to hand somebody who has just been told
 * they can automate their support. They do not need a tutorial on node types;
 * they need the flow they were going to build anyway, already wired, with their
 * own wording to change and one API URL to fill in.
 *
 * Each of these is a real support pattern rather than a demonstration of the
 * editor. They are opinionated on purpose: every one checks whether anybody is
 * actually available before promising a person, every one tags the conversation
 * so the queue can be filtered afterwards, and every one has an answer for the
 * case where the visitor's problem is not what the flow assumed.
 *
 * Positions are laid out left to right in the order a conversation travels, so
 * a tenant opening one sees the shape of it before reading any of the nodes.
 *
 * Each has a trigger. The front desk sorts every conversation, so it answers
 * everything; the others run only for what they are about ("where is my
 * order?"), leaving the assistant to answer the rest from the knowledge base.
 */

const templates = [
  {
    id: 'order-status',
    name: 'Where is my order?',
    industry: 'Retail and e-commerce',
    summary: 'Asks for the order number, looks it up in your system, and answers with the real status.',
    // Said plainly, because a template that silently needs a working API and
    // does nothing until it has one is worse than no template.
    requires: 'An API that returns an order by reference. Fill in the URL on the "Look up the order" node.',
    // Which messages it answers once live. Everything else still goes to
    // the assistant, so publishing it does not take over the bot.
    trigger: { type: 'intent', description: 'where is my order' },
    nodes: [
      { id: 'persona', type: 'persona', position: { x: 40, y: 40 }, data: {
        label: 'Persona',
        prompt: 'You are a helpful support assistant for an online shop. Be brief and concrete.',
        tone: 'friendly', personality: 'concise'
      } },
      { id: 'start', type: 'start', position: { x: 40, y: 200 }, data: { label: 'Start' } },
      { id: 'ask-order', type: 'ask', position: { x: 280, y: 200 }, data: {
        label: 'Ask for the order number',
        question: 'Happy to check that. What is your order number? It is on your confirmation email.',
        variable: 'order_id', validate: 'reference', maxAttempts: '3'
      } },
      { id: 'lookup', type: 'action', position: { x: 540, y: 160 }, data: {
        label: 'Look up the order',
        url: 'https://api.example.com/orders/{{order_id}}',
        method: 'GET',
        auth: { type: 'none' },
        outputs: [
          { variable: 'order_status', path: 'status' },
          { variable: 'eta', path: 'estimated_delivery', fallback: 'shortly' },
          { variable: 'tracking_url', path: 'tracking_url', fallback: '' }
        ],
        timeoutMs: 8000
      } },
      { id: 'shipped', type: 'condition', position: { x: 800, y: 120 }, data: {
        label: 'Has it shipped?',
        left: '{{order_status}}', operator: 'equals', right: 'shipped'
      } },
      { id: 'reply-shipped', type: 'response', position: { x: 1060, y: 60 }, data: {
        label: 'Tell them it is on the way',
        template: 'Order {{order_id}} is on its way and should arrive {{eta}}. {{tracking_url}}'
      } },
      { id: 'reply-other', type: 'response', position: { x: 1060, y: 200 }, data: {
        label: 'Tell them the status',
        template: 'Order {{order_id}} is currently "{{order_status}}". Anything else I can check?'
      } },
      { id: 'tag-order', type: 'tag', position: { x: 540, y: 320 }, data: {
        label: 'Tag it', tags: ['order-status']
      } },
      { id: 'lookup-failed', type: 'operator-handoff', position: { x: 800, y: 320 }, data: {
        label: 'Hand over',
        message: 'I could not reach our order system just now — let me get a colleague to help.'
      } },
      { id: 'gave-up', type: 'operator-handoff', position: { x: 540, y: 440 }, data: {
        label: 'Could not get a number',
        message: 'No problem — I will pass you to someone who can find it another way.'
      } }
    ],
    edges: [
      { id: 'e1', source: 'start', target: 'ask-order' },
      { id: 'e2', source: 'ask-order', target: 'lookup', sourceHandle: 'next' },
      { id: 'e3', source: 'ask-order', target: 'gave-up', sourceHandle: 'invalid' },
      { id: 'e4', source: 'lookup', target: 'shipped', sourceHandle: 'success' },
      { id: 'e5', source: 'lookup', target: 'tag-order', sourceHandle: 'error' },
      { id: 'e6', source: 'tag-order', target: 'lookup-failed' },
      { id: 'e7', source: 'shipped', target: 'reply-shipped', sourceHandle: 'true' },
      { id: 'e8', source: 'shipped', target: 'reply-other', sourceHandle: 'false' }
    ]
  },

  {
    id: 'returns',
    name: 'Returns and refunds',
    industry: 'Retail and e-commerce',
    summary: 'Collects the order and the reason, raises a task for the team, and tells the customer what happens next.',
    requires: 'Nothing. Works as it is; the task lands in Tasks for someone to action.',
    trigger: { type: 'intent', description: 'return or refund' },
    nodes: [
      { id: 'persona', type: 'persona', position: { x: 40, y: 40 }, data: {
        label: 'Persona',
        prompt: 'You handle returns for an online shop. Be reassuring and specific about next steps.',
        tone: 'empathetic', personality: 'helpful'
      } },
      { id: 'start', type: 'start', position: { x: 40, y: 200 }, data: { label: 'Start' } },
      { id: 'ask-order', type: 'ask', position: { x: 280, y: 200 }, data: {
        label: 'Ask for the order',
        question: 'I can start a return for you. What is the order number?',
        variable: 'order_id', validate: 'reference'
      } },
      { id: 'why', type: 'buttons', position: { x: 540, y: 200 }, data: {
        label: 'Why are they returning it?',
        question: 'What is the reason for the return?',
        variable: 'reason',
        choices: [
          { id: 'faulty', label: 'It arrived damaged or faulty', value: 'faulty' },
          { id: 'wrong', label: 'Wrong item was sent', value: 'wrong item' },
          { id: 'changed', label: 'I changed my mind', value: 'changed mind' }
        ]
      } },
      { id: 'ask-email', type: 'ask', position: { x: 800, y: 200 }, data: {
        label: 'Ask for their email',
        question: 'Which email address should we send the return label to?',
        variable: 'email', validate: 'email'
      } },
      { id: 'tag-return', type: 'tag', position: { x: 1060, y: 200 }, data: {
        label: 'Tag it', tags: ['return', 'refund']
      } },
      { id: 'make-task', type: 'task', position: { x: 1300, y: 200 }, data: {
        label: 'Raise the return',
        title: 'Return: order {{order_id}} ({{reason}})',
        description: 'Customer asked to return order {{order_id}}. Reason: {{reason}}. Send the label to {{email}}.',
        priority: 'medium', dueInDays: '1'
      } },
      { id: 'confirm', type: 'response', position: { x: 1560, y: 140 }, data: {
        label: 'Confirm',
        template: 'Thanks — I have logged the return for {{order_id}}. We will email the label to {{email}} within one working day.'
      } },
      // A faulty item is not the same conversation as a change of mind, and
      // making somebody wait a day for a label when the thing arrived broken is
      // how a return becomes a complaint.
      { id: 'faulty-urgent', type: 'tag', position: { x: 800, y: 380 }, data: {
        label: 'Mark it urgent', tags: ['faulty', 'urgent']
      } },
      { id: 'faulty-handoff', type: 'operator-handoff', position: { x: 1060, y: 380 }, data: {
        label: 'Get a person',
        message: 'Sorry it arrived like that. Let me get a colleague to sort this out properly.'
      } },
      { id: 'no-order', type: 'operator-handoff', position: { x: 280, y: 380 }, data: {
        label: 'No order number',
        message: 'That is fine — I will pass you to someone who can look it up from your details.'
      } }
    ],
    edges: [
      { id: 'e1', source: 'start', target: 'ask-order' },
      { id: 'e2', source: 'ask-order', target: 'why', sourceHandle: 'next' },
      { id: 'e3', source: 'ask-order', target: 'no-order', sourceHandle: 'invalid' },
      { id: 'e4', source: 'why', target: 'faulty-urgent', sourceHandle: 'faulty' },
      { id: 'e5', source: 'why', target: 'ask-email', sourceHandle: 'wrong' },
      { id: 'e6', source: 'why', target: 'ask-email', sourceHandle: 'changed' },
      { id: 'e7', source: 'why', target: 'ask-email', sourceHandle: 'other' },
      { id: 'e8', source: 'faulty-urgent', target: 'faulty-handoff' },
      { id: 'e9', source: 'ask-email', target: 'tag-return', sourceHandle: 'next' },
      { id: 'e10', source: 'ask-email', target: 'tag-return', sourceHandle: 'invalid' },
      { id: 'e11', source: 'tag-return', target: 'make-task' },
      { id: 'e12', source: 'make-task', target: 'confirm' }
    ]
  },

  {
    id: 'triage',
    name: 'Front desk',
    industry: 'Any',
    summary: 'Sorts the conversation into the right lane first, answers common questions from your knowledge base, and escalates the rest.',
    requires: 'A knowledge source for the "Answer from your material" node, if you have one.',
    trigger: { type: 'always' },
    nodes: [
      // Defers to the tenant's Persona screen until edited: this flow answers
      // every message, so its persona would otherwise replace theirs. The
      // other templates' personas only speak in their own steps.
      { id: 'persona', type: 'persona', position: { x: 40, y: 40 }, data: {
        label: 'Persona',
        inheritPersona: true,
        prompt: 'You are the first point of contact for a support team. Answer briefly, and offer a person when you are not sure.',
        tone: 'friendly', personality: 'helpful'
      } },
      { id: 'moderation', type: 'moderation', position: { x: 40, y: 180 }, data: {
        label: 'Moderation', strictness: 'medium'
      } },
      { id: 'start', type: 'start', position: { x: 40, y: 320 }, data: { label: 'Start' } },
      { id: 'what', type: 'buttons', position: { x: 280, y: 320 }, data: {
        label: 'What do they need?',
        question: 'Hello. What can I help you with today?',
        variable: 'topic',
        choices: [
          { id: 'account', label: 'My account', value: 'account' },
          { id: 'billing', label: 'Billing', value: 'billing' },
          { id: 'technical', label: 'Something is broken', value: 'technical' },
          { id: 'person', label: 'Talk to a person', value: 'person' }
        ]
      } },
      { id: 'tag-topic', type: 'tag', position: { x: 560, y: 200 }, data: {
        label: 'Tag the topic', tags: ['{{topic}}']
      } },
      { id: 'knowledge', type: 'knowledge', position: { x: 800, y: 200 }, data: {
        label: 'Your material', sourceType: 'vector_store', config: { collectionName: '' }
      } },
      { id: 'answer', type: 'llm', position: { x: 1040, y: 200 }, data: {
        label: 'Answer from your material',
        prompt: 'Answer the question using only the knowledge provided. If it is not there, say so plainly and offer to pass them to a colleague.\n\nQuestion: {{user_input}}',
        model: 'gpt-4o-mini', temperature: 0.3
      } },
      { id: 'hours', type: 'business-hours', position: { x: 560, y: 440 }, data: {
        label: 'Is anyone there?', requireOperator: 'an operator is online'
      } },
      { id: 'to-person', type: 'operator-handoff', position: { x: 820, y: 380 }, data: {
        label: 'Hand over',
        message: 'Of course — connecting you to a colleague now.'
      } },
      { id: 'closed', type: 'ask', position: { x: 820, y: 520 }, data: {
        label: 'Take a message',
        question: 'Everyone is away right now. Leave your email and we will reply as soon as we are back.',
        variable: 'email', validate: 'email'
      } },
      { id: 'closed-task', type: 'task', position: { x: 1080, y: 520 }, data: {
        label: 'Raise a callback',
        title: 'Out-of-hours message from {{email}}',
        description: 'Came in while closed. They asked: {{user_input}}',
        priority: 'high', dueInDays: '1'
      } },
      { id: 'closed-confirm', type: 'response', position: { x: 1340, y: 520 }, data: {
        label: 'Promise a reply',
        template: 'Thank you — we have your message and will reply to {{email}} when we open.'
      } }
    ],
    edges: [
      { id: 'e1', source: 'start', target: 'what' },
      { id: 'e2', source: 'what', target: 'tag-topic', sourceHandle: 'account' },
      { id: 'e3', source: 'what', target: 'tag-topic', sourceHandle: 'billing' },
      { id: 'e4', source: 'what', target: 'tag-topic', sourceHandle: 'technical' },
      { id: 'e5', source: 'what', target: 'hours', sourceHandle: 'person' },
      { id: 'e6', source: 'what', target: 'tag-topic', sourceHandle: 'other' },
      { id: 'e7', source: 'tag-topic', target: 'knowledge' },
      { id: 'e8', source: 'knowledge', target: 'answer' },
      { id: 'e9', source: 'hours', target: 'to-person', sourceHandle: 'open' },
      { id: 'e10', source: 'hours', target: 'closed', sourceHandle: 'closed' },
      { id: 'e11', source: 'closed', target: 'closed-task', sourceHandle: 'next' },
      { id: 'e12', source: 'closed', target: 'closed-task', sourceHandle: 'invalid' },
      { id: 'e13', source: 'closed-task', target: 'closed-confirm' }
    ]
  },

  {
    id: 'lead-qualification',
    name: 'Qualify a new enquiry',
    industry: 'B2B and services',
    summary: 'Finds out who they are and what they need before taking up a salesperson\'s time, then books the follow-up.',
    requires: 'Nothing. The qualified lead lands in Tasks.',
    trigger: { type: 'intent', description: 'a quote or new enquiry' },
    nodes: [
      { id: 'persona', type: 'persona', position: { x: 40, y: 40 }, data: {
        label: 'Persona',
        prompt: 'You greet new enquiries for a B2B company. Be warm and efficient; do not oversell.',
        tone: 'professional', personality: 'proactive'
      } },
      { id: 'start', type: 'start', position: { x: 40, y: 200 }, data: { label: 'Start' } },
      { id: 'ask-name', type: 'ask', position: { x: 280, y: 200 }, data: {
        label: 'Who are they?',
        question: 'Happy to help. Who am I speaking to, and which company are you with?',
        variable: 'who', validate: 'any'
      } },
      { id: 'ask-need', type: 'buttons', position: { x: 540, y: 200 }, data: {
        label: 'What do they want?',
        question: 'What are you looking into?',
        variable: 'need',
        choices: [
          { id: 'pricing', label: 'Pricing', value: 'pricing' },
          { id: 'demo', label: 'A demo', value: 'demo' },
          { id: 'integration', label: 'Whether it fits our stack', value: 'integration' },
          { id: 'partnership', label: 'Partnership', value: 'partnership' }
        ]
      } },
      { id: 'ask-size', type: 'buttons', position: { x: 800, y: 200 }, data: {
        label: 'How big are they?',
        question: 'Roughly how many people are in your team?',
        variable: 'team_size',
        choices: [
          { id: 'small', label: 'Under 10', value: 'under 10' },
          { id: 'mid', label: '10 to 100', value: '10-100' },
          { id: 'large', label: 'More than 100', value: '100+' }
        ]
      } },
      { id: 'ask-email', type: 'ask', position: { x: 1060, y: 200 }, data: {
        label: 'How to reach them',
        question: 'What is the best email to follow up on?',
        variable: 'email', validate: 'email'
      } },
      { id: 'tag-lead', type: 'tag', position: { x: 1320, y: 200 }, data: {
        label: 'Tag the lead', tags: ['lead', '{{need}}']
      } },
      { id: 'big-enough', type: 'condition', position: { x: 1560, y: 200 }, data: {
        label: 'Worth a call?',
        left: '{{team_size}}', operator: 'not_equals', right: 'under 10'
      } },
      { id: 'lead-task', type: 'task', position: { x: 1820, y: 120 }, data: {
        label: 'Book the follow-up',
        title: 'Qualified lead: {{who}} ({{need}})',
        description: '{{who}} — team size {{team_size}}, interested in {{need}}. Contact: {{email}}',
        priority: 'high', dueInDays: '1'
      } },
      { id: 'self-serve', type: 'response', position: { x: 1820, y: 300 }, data: {
        label: 'Point them at the docs',
        template: 'Thanks {{who}} — for a team your size the quickest route is our self-serve plan. I have sent the details to {{email}}.'
      } },
      { id: 'confirm', type: 'response', position: { x: 2080, y: 120 }, data: {
        label: 'Confirm',
        template: 'Thanks — someone from the team will be in touch at {{email}} within one working day.'
      } }
    ],
    edges: [
      { id: 'e1', source: 'start', target: 'ask-name' },
      { id: 'e2', source: 'ask-name', target: 'ask-need', sourceHandle: 'next' },
      { id: 'e3', source: 'ask-name', target: 'ask-need', sourceHandle: 'invalid' },
      { id: 'e4', source: 'ask-need', target: 'ask-size', sourceHandle: 'pricing' },
      { id: 'e5', source: 'ask-need', target: 'ask-size', sourceHandle: 'demo' },
      { id: 'e6', source: 'ask-need', target: 'ask-size', sourceHandle: 'integration' },
      { id: 'e7', source: 'ask-need', target: 'ask-size', sourceHandle: 'partnership' },
      { id: 'e8', source: 'ask-need', target: 'ask-size', sourceHandle: 'other' },
      { id: 'e9', source: 'ask-size', target: 'ask-email', sourceHandle: 'small' },
      { id: 'e10', source: 'ask-size', target: 'ask-email', sourceHandle: 'mid' },
      { id: 'e11', source: 'ask-size', target: 'ask-email', sourceHandle: 'large' },
      { id: 'e12', source: 'ask-size', target: 'ask-email', sourceHandle: 'other' },
      { id: 'e13', source: 'ask-email', target: 'tag-lead', sourceHandle: 'next' },
      { id: 'e14', source: 'ask-email', target: 'tag-lead', sourceHandle: 'invalid' },
      { id: 'e15', source: 'tag-lead', target: 'big-enough' },
      { id: 'e16', source: 'big-enough', target: 'lead-task', sourceHandle: 'true' },
      { id: 'e17', source: 'big-enough', target: 'self-serve', sourceHandle: 'false' },
      { id: 'e18', source: 'lead-task', target: 'confirm' }
    ]
  },

  {
    id: 'booking',
    name: 'Book or change an appointment',
    industry: 'Clinics, salons, trades and services',
    summary: 'Offers real free times from your calendar and books the one they pick. Without a calendar connected, or for a change, it takes the details and raises a task for whoever runs the diary.',
    requires: 'Nothing. Connect Cal.com, Calendly or Google Calendar under Bot → Booking and it books real appointments; until then it raises a task.',
    trigger: { type: 'intent', description: 'book, change or cancel an appointment' },
    nodes: [
      { id: 'persona', type: 'persona', position: { x: 40, y: 40 }, data: {
        label: 'Persona',
        prompt: 'You take appointment enquiries. Be brief, warm, and always confirm what you have understood.',
        tone: 'friendly', personality: 'concise'
      } },
      { id: 'start', type: 'start', position: { x: 40, y: 200 }, data: { label: 'Start' } },
      { id: 'what', type: 'buttons', position: { x: 280, y: 200 }, data: {
        label: 'New or existing?',
        question: 'Of course. Is this a new appointment or a change to one you already have?',
        variable: 'booking_type',
        choices: [
          { id: 'new', label: 'A new appointment', value: 'new' },
          { id: 'change', label: 'Change or cancel one', value: 'change' }
        ]
      } },
      { id: 'ask-name', type: 'ask', position: { x: 540, y: 140 }, data: {
        label: 'Their name',
        question: 'What name should I put it under?',
        variable: 'customer_name', validate: 'any'
      } },
      // The calendar's real free times, offered as buttons. With no calendar
      // connected (or nothing free) this takes its other output, into the
      // task-based path below - so the template works before and after.
      { id: 'find-slots', type: 'capability', position: { x: 800, y: 40 }, data: {
        label: 'Offer free times',
        capability: 'availability.slots',
        input: {},
        limit: '6',
        offerAsChoices: 'yes',
        question: 'Here are the next free times. Which suits you?',
        variable: 'slot'
      } },
      { id: 'ask-email', type: 'ask', position: { x: 1060, y: 40 }, data: {
        label: 'Where to confirm',
        question: 'Lovely. What email should the booking go under?',
        variable: 'email', validate: 'email', maxAttempts: '2'
      } },
      { id: 'book-slot', type: 'capability', position: { x: 1320, y: 40 }, data: {
        label: 'Book it',
        capability: 'availability.book',
        input: { slotId: '{{slot}}', name: '{{customer_name}}', email: '{{email}}' },
        offerAsChoices: 'no'
      } },
      { id: 'is-link', type: 'condition', position: { x: 1560, y: 40 }, data: {
        label: 'Finished on their page?',
        left: '{{result_status}}', operator: 'equals', right: 'link'
      } },
      { id: 'reply-link', type: 'response', position: { x: 1820, y: 0 }, data: {
        label: 'Send the booking page',
        template: 'Nearly done: tap the link to confirm {{slot_label}} on our booking page. {{result_url}}'
      } },
      { id: 'tag-booked', type: 'tag', position: { x: 1820, y: 110 }, data: {
        label: 'Tag it', tags: ['booking', 'booked']
      } },
      { id: 'reply-booked', type: 'response', position: { x: 2080, y: 110 }, data: {
        label: 'Confirm the booking',
        template: 'All booked: {{slot_label}}, under {{customer_name}}. Your reference is {{result_reference}} — quote it if you need to change or cancel.'
      } },
      // The time was taken in the meantime, or the calendar refused: fall
      // back to a person, with the time they chose as their preference.
      { id: 'book-failed', type: 'set', position: { x: 1560, y: 200 }, data: {
        label: 'Keep their choice',
        assignments: [{ variable: 'preferred_time', value: '{{slot_label}}' }]
      } },
      { id: 'ask-when', type: 'ask', position: { x: 800, y: 200 }, data: {
        label: 'When suits',
        question: 'When would suit you? A day and rough time is enough.',
        variable: 'preferred_time', validate: 'any'
      } },
      { id: 'ask-phone', type: 'ask', position: { x: 1060, y: 260 }, data: {
        label: 'How to confirm',
        question: 'What is the best number to confirm on?',
        variable: 'phone', validate: 'phone'
      } },
      { id: 'ask-ref', type: 'ask', position: { x: 540, y: 380 }, data: {
        label: 'Existing booking',
        question: 'No problem. What name is the existing appointment under, and when is it?',
        variable: 'existing_booking', validate: 'any'
      } },
      { id: 'tag-booking', type: 'tag', position: { x: 1320, y: 320 }, data: {
        label: 'Tag it', tags: ['booking', '{{booking_type}}']
      } },
      { id: 'booking-task', type: 'task', position: { x: 1560, y: 320 }, data: {
        label: 'Raise the booking',
        title: 'Appointment ({{booking_type}}): {{customer_name}}{{existing_booking}}',
        description: 'Preferred: {{preferred_time}}. Contact: {{phone}}. Existing: {{existing_booking}}',
        priority: 'high', dueInDays: '1'
      } },
      { id: 'confirm', type: 'response', position: { x: 1820, y: 320 }, data: {
        label: 'Confirm',
        template: 'Thanks — I have passed this to the team and someone will confirm shortly. We have you down for around {{preferred_time}}.'
      } }
    ],
    edges: [
      { id: 'e1', source: 'start', target: 'what' },
      { id: 'e2', source: 'what', target: 'ask-name', sourceHandle: 'new' },
      { id: 'e3', source: 'what', target: 'ask-ref', sourceHandle: 'change' },
      { id: 'e4', source: 'what', target: 'ask-name', sourceHandle: 'other' },
      { id: 'e5', source: 'ask-name', target: 'find-slots', sourceHandle: 'next' },
      { id: 'e6', source: 'ask-name', target: 'find-slots', sourceHandle: 'invalid' },
      { id: 'e7', source: 'ask-when', target: 'ask-phone', sourceHandle: 'next' },
      { id: 'e8', source: 'ask-when', target: 'ask-phone', sourceHandle: 'invalid' },
      { id: 'e9', source: 'ask-phone', target: 'tag-booking', sourceHandle: 'next' },
      { id: 'e10', source: 'ask-phone', target: 'tag-booking', sourceHandle: 'invalid' },
      { id: 'e11', source: 'ask-ref', target: 'tag-booking', sourceHandle: 'next' },
      { id: 'e12', source: 'ask-ref', target: 'tag-booking', sourceHandle: 'invalid' },
      { id: 'e13', source: 'tag-booking', target: 'booking-task' },
      { id: 'e14', source: 'booking-task', target: 'confirm' },
      { id: 'e15', source: 'find-slots', target: 'ask-email', sourceHandle: 'success' },
      { id: 'e16', source: 'find-slots', target: 'ask-when', sourceHandle: 'error' },
      { id: 'e17', source: 'ask-email', target: 'book-slot', sourceHandle: 'next' },
      // No usable email after two tries: still book. Google needs none, and
      // Calendly answers with its booking page, which asks for one.
      { id: 'e18', source: 'ask-email', target: 'book-slot', sourceHandle: 'invalid' },
      { id: 'e19', source: 'book-slot', target: 'is-link', sourceHandle: 'success' },
      { id: 'e20', source: 'book-slot', target: 'book-failed', sourceHandle: 'error' },
      { id: 'e21', source: 'is-link', target: 'reply-link', sourceHandle: 'true' },
      { id: 'e22', source: 'is-link', target: 'tag-booked', sourceHandle: 'false' },
      { id: 'e23', source: 'tag-booked', target: 'reply-booked' },
      { id: 'e24', source: 'book-failed', target: 'ask-phone' }
    ]
  },

  {
    id: 'account-lookup',
    name: 'Answer about their account',
    industry: 'SaaS and subscriptions',
    summary: 'Only answers account questions for someone whose identity your own application has vouched for.',
    requires: 'Identity verification set up (People → Identity), and an API returning the account for a verified user.',
    trigger: { type: 'intent', description: 'a question about my account' },
    nodes: [
      { id: 'persona', type: 'persona', position: { x: 40, y: 40 }, data: {
        label: 'Persona',
        prompt: 'You answer account and subscription questions. Never discuss account details unless the person is verified.',
        tone: 'professional', personality: 'thorough'
      } },
      { id: 'start', type: 'start', position: { x: 40, y: 200 }, data: { label: 'Start' } },
      // The check that makes this template safe to ship. A visitor who merely
      // typed an email address is not the account holder, and a flow that
      // cannot tell the difference will read somebody's billing history to a
      // stranger.
      { id: 'verified', type: 'condition', position: { x: 280, y: 200 }, data: {
        label: 'Are they verified?',
        left: '{{contact_verified}}', operator: 'equals', right: 'true'
      } },
      { id: 'lookup', type: 'action', position: { x: 540, y: 120 }, data: {
        label: 'Look up the account',
        url: 'https://api.example.com/accounts/{{contact_external_id}}',
        method: 'GET',
        auth: { type: 'none' },
        outputs: [
          { variable: 'plan_name', path: 'plan.name', fallback: 'your current plan' },
          { variable: 'renews_on', path: 'plan.renews_on', fallback: '' },
          { variable: 'seats_used', path: 'seats.used', fallback: '' }
        ]
      } },
      { id: 'answer', type: 'llm', position: { x: 800, y: 120 }, data: {
        label: 'Answer the question',
        prompt: 'Answer using only these account details. Do not guess anything that is not here.\n\nPlan: {{plan_name}}\nRenews: {{renews_on}}\nSeats used: {{seats_used}}\n\nQuestion: {{user_input}}',
        model: 'gpt-4o-mini', temperature: 0.2
      } },
      { id: 'not-verified', type: 'response', position: { x: 540, y: 320 }, data: {
        label: 'Ask them to sign in',
        template: 'I can help with that once you are signed in — account details are only available to a signed-in account holder. Sign in and come back to this chat, or I can pass you to a colleague.'
      } },
      { id: 'lookup-failed', type: 'operator-handoff', position: { x: 800, y: 280 }, data: {
        label: 'Hand over',
        message: 'I could not reach our account system just now — let me get a colleague.'
      } }
    ],
    edges: [
      { id: 'e1', source: 'start', target: 'verified' },
      { id: 'e2', source: 'verified', target: 'lookup', sourceHandle: 'true' },
      { id: 'e3', source: 'verified', target: 'not-verified', sourceHandle: 'false' },
      { id: 'e4', source: 'lookup', target: 'answer', sourceHandle: 'success' },
      { id: 'e5', source: 'lookup', target: 'lookup-failed', sourceHandle: 'error' }
    ]
  },

  {
    id: 'cancellation-save',
    name: 'Cancel my subscription',
    industry: 'SaaS and subscriptions',
    summary: 'Finds out why they are leaving, routes a fixable reason to the team the same day, and never makes cancelling feel like a trap.',
    requires: 'Nothing. The save attempt lands in Tasks with the reason attached.',
    trigger: { type: 'intent', description: 'cancel subscription' },
    nodes: [
      { id: 'persona', type: 'persona', position: { x: 40, y: 40 }, data: {
        label: 'Persona',
        prompt: 'You handle cancellations. Never argue with the decision or hide the way out; your job is to learn the reason and route it.',
        tone: 'empathetic', personality: 'concise'
      } },
      { id: 'start', type: 'start', position: { x: 40, y: 220 }, data: { label: 'Start' } },
      { id: 'why', type: 'buttons', position: { x: 280, y: 220 }, data: {
        label: 'Why are they leaving?',
        question: 'Sorry to see you go — I can sort that. So we route this right, what is the main reason?',
        variable: 'cancel_reason',
        choices: [
          { id: 'price', label: 'It costs too much', value: 'price' },
          { id: 'feature', label: 'It is missing something I need', value: 'missing feature' },
          { id: 'unused', label: 'We are not using it enough', value: 'not using it' }
        ]
      } },
      { id: 'which-feature', type: 'ask', position: { x: 540, y: 380 }, data: {
        label: 'Which feature?',
        question: 'That is useful to know — what is the thing you needed it to do?',
        variable: 'missing_feature', validate: 'any', maxAttempts: '2'
      } },
      { id: 'tag-cxl', type: 'tag', position: { x: 800, y: 220 }, data: {
        label: 'Tag it', tags: ['cancellation', '{{cancel_reason}}']
      } },
      { id: 'save-task', type: 'task', position: { x: 1040, y: 220 }, data: {
        label: 'Raise the save attempt',
        title: 'Cancellation: {{cancel_reason}}',
        description: 'A customer asked to cancel. Reason: {{cancel_reason}}. {{missing_feature}}',
        priority: 'high', dueInDays: '1'
      } },
      // The promise matters more than the pitch. "Someone will call to
      // convince you" reads as a trap; "it is done unless you hear from us"
      // keeps the trust the save attempt depends on.
      { id: 'confirm', type: 'response', position: { x: 1300, y: 220 }, data: {
        label: 'Confirm honestly',
        template: 'Done — your cancellation is being processed and someone will confirm by email today. If the reason is something we can actually fix, they will mention it, but nothing is conditional on that.'
      } },
      { id: 'other-handoff', type: 'operator-handoff', position: { x: 540, y: 60 }, data: {
        label: 'Something else',
        message: 'Let me get a colleague — they can sort the cancellation and whatever else is going on.'
      } }
    ],
    edges: [
      { id: 'e1', source: 'start', target: 'why' },
      { id: 'e2', source: 'why', target: 'tag-cxl', sourceHandle: 'price' },
      { id: 'e3', source: 'why', target: 'which-feature', sourceHandle: 'feature' },
      { id: 'e4', source: 'why', target: 'tag-cxl', sourceHandle: 'unused' },
      { id: 'e5', source: 'why', target: 'other-handoff', sourceHandle: 'other' },
      { id: 'e6', source: 'which-feature', target: 'tag-cxl', sourceHandle: 'next' },
      { id: 'e7', source: 'which-feature', target: 'tag-cxl', sourceHandle: 'invalid' },
      { id: 'e8', source: 'tag-cxl', target: 'save-task' },
      { id: 'e9', source: 'save-task', target: 'confirm' }
    ]
  },

  {
    id: 'complaint',
    name: 'Handle a complaint',
    industry: 'Any',
    summary: 'Hears the complaint in full, marks it urgent, gets a person if anyone is there — and if not, promises a reply and emails the team so it is not waiting for someone to open the dashboard.',
    requires: 'Change the address on the "Email the team" node. Sending needs SMTP configured; without it the task is still raised.',
    trigger: { type: 'intent', description: 'make a complaint' },
    nodes: [
      { id: 'persona', type: 'persona', position: { x: 40, y: 40 }, data: {
        label: 'Persona',
        prompt: 'You are the first person to hear a complaint. Acknowledge before you ask for anything, never defend the company, and never promise what you cannot do.',
        tone: 'empathetic', personality: 'helpful'
      } },
      { id: 'start', type: 'start', position: { x: 40, y: 220 }, data: { label: 'Start' } },
      { id: 'listen', type: 'ask', position: { x: 280, y: 220 }, data: {
        label: 'Hear them out',
        question: 'I am sorry something has gone wrong. Tell me what happened — I am listening, and it goes straight to the team.',
        variable: 'complaint', validate: 'any', maxAttempts: '2'
      } },
      { id: 'reference', type: 'ask', position: { x: 540, y: 220 }, data: {
        label: 'Get a reference',
        question: 'Thank you for explaining. Do you have an order or account reference so we start in the right place? If not, just say no.',
        variable: 'reference', validate: 'any', maxAttempts: '2'
      } },
      { id: 'tag-complaint', type: 'tag', position: { x: 800, y: 220 }, data: {
        label: 'Mark it urgent', tags: ['complaint', 'urgent']
      } },
      { id: 'anyone-there', type: 'business-hours', position: { x: 1040, y: 220 }, data: {
        label: 'Is anyone there?', requireOperator: 'an operator is online'
      } },
      { id: 'to-person', type: 'operator-handoff', position: { x: 1300, y: 120 }, data: {
        label: 'Get a person now',
        message: 'Thank you — I am passing you to a colleague right now so you do not have to repeat any of this. They can see everything you told me.'
      } },
      { id: 'log-it', type: 'task', position: { x: 1300, y: 320 }, data: {
        label: 'Log the complaint',
        title: 'Complaint{{reference}}',
        description: 'Received while nobody was available. They said: {{complaint}}. Reference: {{reference}}.',
        priority: 'urgent', dueInDays: '1'
      } },
      // The email is the courtesy copy for a team that lives in their inbox;
      // the task above is the durable record if SMTP is not set up.
      { id: 'email-team', type: 'notify', position: { x: 1560, y: 320 }, data: {
        label: 'Email the team',
        to: 'support@yourcompany.example',
        subject: 'Complaint from {{contact_name}}',
        body: 'They said: {{complaint}}\n\nReference: {{reference}}\n\nLogged as an urgent task.'
      } },
      { id: 'promise', type: 'response', position: { x: 1820, y: 320 }, data: {
        label: 'Promise a reply',
        template: 'Thank you — everything you told me has gone to the team marked urgent, and someone will come back to you within one working day. You will not have to explain it again.'
      } },
      { id: 'listen-failed', type: 'operator-handoff', position: { x: 280, y: 400 }, data: {
        label: 'Straight to a person',
        message: 'Let me get you straight to a colleague.'
      } }
    ],
    edges: [
      { id: 'e1', source: 'start', target: 'listen' },
      { id: 'e2', source: 'listen', target: 'reference', sourceHandle: 'next' },
      { id: 'e3', source: 'listen', target: 'listen-failed', sourceHandle: 'invalid' },
      { id: 'e4', source: 'reference', target: 'tag-complaint', sourceHandle: 'next' },
      { id: 'e5', source: 'reference', target: 'tag-complaint', sourceHandle: 'invalid' },
      { id: 'e6', source: 'tag-complaint', target: 'anyone-there' },
      { id: 'e7', source: 'anyone-there', target: 'to-person', sourceHandle: 'open' },
      { id: 'e8', source: 'anyone-there', target: 'log-it', sourceHandle: 'closed' },
      { id: 'e9', source: 'log-it', target: 'email-team' },
      { id: 'e10', source: 'email-team', target: 'promise' }
    ]
  }
];

/** The list for the picker: everything except the graphs themselves. */
function summaries() {
  return templates.map(({ id, name, industry, summary, requires, trigger, nodes }) => ({
    id, name, industry, summary, requires, trigger, nodeCount: nodes.length
  }));
}

function byId(id) {
  return templates.find(template => template.id === id) || null;
}

module.exports = { templates, summaries, byId };
