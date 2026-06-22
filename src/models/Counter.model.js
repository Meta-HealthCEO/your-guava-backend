const mongoose = require('mongoose');

// Generic named counter for gap-free sequential numbering (e.g. ticket numbers).
const counterSchema = new mongoose.Schema({
  _id: { type: String, required: true }, // counter name, e.g. 'improvementTicket'
  seq: { type: Number, default: 0 },
});

/**
 * Atomically increments and returns the next value for a named counter.
 * Safe under concurrency — relies on a single-document $inc.
 * @param {string} name
 * @returns {Promise<number>}
 */
counterSchema.statics.next = async function next(name) {
  const counter = await this.findByIdAndUpdate(
    name,
    { $inc: { seq: 1 } },
    { new: true, upsert: true }
  );
  return counter.seq;
};

module.exports = mongoose.model('Counter', counterSchema);
