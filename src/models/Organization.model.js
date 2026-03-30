const mongoose = require('mongoose');

const organizationSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
    },
    ownerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    plan: {
      type: String,
      enum: ['free', 'growth', 'pro'],
      default: 'free',
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Organization', organizationSchema);
