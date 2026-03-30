const mongoose = require('mongoose');

const leaveBalanceSchema = new mongoose.Schema(
  {
    staffId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Staff',
      required: true,
      unique: true,
    },
    cafeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Cafe',
      required: true,
    },
    annual: {
      total: { type: Number, default: 15 },
      used: { type: Number, default: 0 },
    },
    sick: {
      total: { type: Number, default: 30 },
      used: { type: Number, default: 0 },
    },
    family: {
      total: { type: Number, default: 3 },
      used: { type: Number, default: 0 },
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('LeaveBalance', leaveBalanceSchema);
