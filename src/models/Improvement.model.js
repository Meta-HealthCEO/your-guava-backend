const mongoose = require('mongoose');
const Counter = require('./Counter.model');

// Allowed values — exported so the controller validates against the same source.
const IMPROVEMENT_TYPES = ['fix', 'improvement'];
const IMPROVEMENT_AREAS = [
  'dashboard',
  'planning',
  'analytics',
  'history',
  'ask_guava',
  'data_uploads',
  'menu_items',
  'integrations',
  'team',
  'settings',
  'billing',
  'other',
];
const PRIORITIES = ['low', 'medium', 'high'];
const STATUSES = ['open', 'planned', 'in_progress', 'done', 'declined'];

/**
 * An improvement or fix logged by a platform partner.
 *
 * The schema is intentionally self-documenting so a ticket can be read straight
 * from the database and acted on without extra context:
 *   - type            what kind of change ('fix' = something broken, 'improvement' = an idea)
 *   - title           one-line summary
 *   - area            which part of the app it concerns (maps to a product surface)
 *   - priority        how urgent the reporter feels it is
 *   - description     the full problem (for a fix) or idea (for an improvement)
 *   - desiredOutcome  what "done" looks like — acceptance criteria for the implementer
 *   - createdBy       denormalized reporter so the ticket is self-explanatory
 */
const improvementSchema = new mongoose.Schema(
  {
    // Sequential, human-friendly ticket number (1, 2, 3, ...). Assigned on create.
    ticketNumber: { type: Number, unique: true },
    type: {
      type: String,
      enum: IMPROVEMENT_TYPES,
      default: 'improvement',
      required: true,
    },
    title: { type: String, required: true, trim: true, maxlength: 140 },
    area: { type: String, enum: IMPROVEMENT_AREAS, default: 'other', index: true },
    priority: { type: String, enum: PRIORITIES, default: 'medium', index: true },
    description: { type: String, required: true, trim: true, maxlength: 4000 },
    desiredOutcome: { type: String, trim: true, maxlength: 2000 },
    // Where in the app the reporter was when logging this (optional context).
    pageUrl: { type: String, trim: true, maxlength: 300 },
    status: { type: String, enum: STATUSES, default: 'open', index: true },
    // Filled in when the ticket is resolved or declined.
    resolutionNotes: { type: String, trim: true, maxlength: 2000 },
    createdBy: {
      userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      name: { type: String },
      email: { type: String },
    },
    orgId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organization',
      required: true,
      index: true,
    },
    cafeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Cafe' },
  },
  { timestamps: true }
);

improvementSchema.index({ orgId: 1, status: 1, createdAt: -1 });

// Assign the next ticket number atomically before validation. Numbers are
// unique and monotonically increasing; a rare gap can occur if a save fails
// after the counter increments, which is acceptable for human-facing IDs.
improvementSchema.pre('validate', async function assignTicketNumber() {
  if (this.isNew && this.ticketNumber == null) {
    this.ticketNumber = await Counter.next('improvementTicket');
  }
});

const Improvement = mongoose.model('Improvement', improvementSchema);

Improvement.IMPROVEMENT_TYPES = IMPROVEMENT_TYPES;
Improvement.IMPROVEMENT_AREAS = IMPROVEMENT_AREAS;
Improvement.PRIORITIES = PRIORITIES;
Improvement.STATUSES = STATUSES;

module.exports = Improvement;
