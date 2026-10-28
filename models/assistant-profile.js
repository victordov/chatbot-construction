const mongoose = require('mongoose');

/**
 * The answers behind a guided persona.
 *
 * The persona itself is free text on the company (`Company.assistant.persona`),
 * and that stays the thing the bot reads. These are the questions the Persona
 * screen asks to help write it — the business, what it does, the tone, what
 * never to guess at, when to hand over — kept so the admin can come back,
 * change one answer and compose the text again rather than starting over.
 */
const AssistantProfileSchema = new mongoose.Schema({
  company: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Company',
    required: true,
    unique: true
  },
  businessName: { type: String, trim: true, maxlength: 120 },
  whatYouDo: { type: String, trim: true, maxlength: 600 },
  tone: { type: String, enum: ['friendly', 'professional', 'brief'], default: 'friendly' },
  neverGuess: [{ type: String, trim: true, maxlength: 60 }],
  neverGuessOther: { type: String, trim: true, maxlength: 300 },
  handover: { type: String, trim: true, maxlength: 600 },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  updatedAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('AssistantProfile', AssistantProfileSchema);
