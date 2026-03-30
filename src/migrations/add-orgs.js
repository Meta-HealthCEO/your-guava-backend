require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../models/User.model');
const Cafe = require('../models/Cafe.model');
const Organization = require('../models/Organization.model');

async function migrate() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Connected');

  const users = await User.find({ role: { $exists: false } });
  console.log(`Found ${users.length} users to migrate`);

  for (const user of users) {
    // Create org
    const org = await Organization.create({
      name: `${user.name}'s Organization`,
      ownerId: user._id,
    });

    // Find user's cafes (by old ownerId field)
    const cafes = await Cafe.find({ ownerId: user._id });

    // Update cafes to use orgId
    for (const cafe of cafes) {
      cafe.orgId = org._id;
      await cafe.save();
    }

    // Update user
    user.role = 'owner';
    user.orgId = org._id;
    user.cafeIds = cafes.map((c) => c._id);
    user.activeCafeId = cafes[0]?._id || null;
    await user.save();

    console.log(`Migrated ${user.email}: org=${org.name}, cafes=${cafes.length}`);
  }

  // Also handle cafes that might have been found by the old cafeId field
  const usersWithOldCafeId = await User.find({ cafeId: { $exists: true }, activeCafeId: { $exists: false } });
  for (const user of usersWithOldCafeId) {
    if (!user.activeCafeId && user.cafeId) {
      user.activeCafeId = user.cafeId;
      user.cafeIds = [user.cafeId];
      await user.save();
      console.log(`Fixed ${user.email}: set activeCafeId from old cafeId`);
    }
  }

  console.log('Migration complete');
  await mongoose.disconnect();
  process.exit(0);
}

migrate().catch((e) => { console.error(e); process.exit(1); });
