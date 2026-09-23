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

/**
 * Next value of a per-scope sequence (gap-10). The first call for a scope seeds it from seedFn() (for tickets: the highest
 * number the organisation already has), so existing numbers are kept and new ones follow them. A concurrent first call that
 * loses the upsert race on _id retries once and then increments the winner's document.
 */
counterSchema.statics.nextScoped = async function nextScoped(name, scopeId, seedFn) {
  const key = `${name}:${String(scopeId)}`;
  const existing = await this.findOneAndUpdate({ _id: key }, { $inc: { seq: 1 } }, { new: true });
  if (existing) return existing.seq;
  const seed = Number(await seedFn()) || 0;
  const upsert = () => this.collection.findOneAndUpdate(
    { _id: key },
    [{ $set: { seq: { $add: [{ $ifNull: ['$seq', seed] }, 1] } } }],
    { upsert: true, returnDocument: 'after' }
  );
  try {
    return (await upsert()).seq;
  } catch (error) {
    if (error?.code === 11000) return (await upsert()).seq;
    throw error;
  }
};

module.exports = mongoose.model('Counter', counterSchema);
