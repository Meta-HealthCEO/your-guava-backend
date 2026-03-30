require('dotenv').config();
const mongoose = require('mongoose');
const User = require('./models/User.model');
const Cafe = require('./models/Cafe.model');
const { ingestFile } = require('./services/ingestion.service');

const YOCO_FILE = 'C:\\Users\\shaun\\transactions_temp.xlsx';

async function seed() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Connected to MongoDB');

  // Clean existing data
  await User.deleteMany({});
  await Cafe.deleteMany({});
  console.log('Cleared existing users and cafes');

  // Create cafe first (needs ownerId after user creation)
  const user = new User({
    name: 'Shaun Schoeman',
    email: 'shaun@yourguava.com',
    password: 'password123',
  });

  const cafe = await Cafe.create({
    name: 'Blouberg Coffee',
    ownerId: user._id,
    location: {
      address: 'Bloubergstrand',
      city: 'Cape Town',
      lat: -33.8069,
      lng: 18.4703,
    },
    dataUploaded: false,
    timezone: 'Africa/Johannesburg',
  });

  user.cafeId = cafe._id;
  await user.save();

  console.log(`User created: shaun@yourguava.com / password123`);
  console.log(`Cafe created: ${cafe.name} (${cafe._id})`);

  // Ingest the real Yoco data
  console.log(`\nIngesting Yoco data from ${YOCO_FILE}...`);
  const stats = await ingestFile(YOCO_FILE, cafe._id);
  console.log(`Ingestion complete: ${stats.imported} imported, ${stats.skipped} skipped, ${stats.errors} errors`);

  // Mark cafe as having data
  await Cafe.findByIdAndUpdate(cafe._id, {
    dataUploaded: true,
    lastSyncAt: new Date(),
  });

  console.log('\nSeed complete. Login with:');
  console.log('  Email:    shaun@yourguava.com');
  console.log('  Password: password123');

  await mongoose.disconnect();
  process.exit(0);
}

seed().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
