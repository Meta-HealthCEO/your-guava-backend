require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const User = require('./models/User.model');
const Cafe = require('./models/Cafe.model');
const Organization = require('./models/Organization.model');
const Transaction = require('./models/Transaction.model');
const Item = require('./models/Item.model');
const { readWorkbookRows } = require('./services/parser.service');

const MONGO_URI = process.argv[2] || process.env.MONGODB_URI;
const IMPORT_FILE = process.env.SEED_IMPORT_FILE || process.argv[3];
const SEED_USER_NAME = process.env.SEED_USER_NAME || 'Demo Owner';
const SEED_USER_EMAIL = (process.env.SEED_USER_EMAIL || 'demo@yourguava.local').toLowerCase();
const SEED_USER_PASSWORD = process.env.SEED_USER_PASSWORD || 'password123';
const SEED_ORG_NAME = process.env.SEED_ORG_NAME || 'Demo Coffee Group';
const SEED_CAFE_NAME = process.env.SEED_CAFE_NAME || 'Demo Cafe';
const SEED_CAFE_CITY = process.env.SEED_CAFE_CITY || 'Cape Town';
const SEED_CAFE_ADDRESS = process.env.SEED_CAFE_ADDRESS || 'Demo address';

const isLocalUri = (uri = '') => /localhost|127\.0\.0\.1/.test(uri);

const resolveImportFile = () => {
  if (!IMPORT_FILE) {
    console.error('[seed-bulk] SEED_IMPORT_FILE or a third CLI argument import file is required.');
    process.exit(1);
  }

  const resolved = path.resolve(IMPORT_FILE);
  if (!fs.existsSync(resolved)) {
    console.error(`[seed-bulk] Import file does not exist: ${resolved}`);
    process.exit(1);
  }

  return resolved;
};

async function seed() {
  if (!MONGO_URI) {
    console.error('[seed-bulk] MONGODB_URI is required.');
    process.exit(1);
  }

  // Destructive: wipes all core collections. Refuse to run against anything
  // that isn't a local database unless explicitly forced.
  if (process.env.NODE_ENV === 'production' || (!isLocalUri(MONGO_URI) && process.env.SEED_FORCE !== 'true')) {
    console.error('[seed-bulk] Refusing to run: non-local MONGODB_URI or production environment. Set SEED_FORCE=true to override.');
    process.exit(1);
  }

  if (SEED_USER_PASSWORD.length < 8) {
    console.error('[seed-bulk] SEED_USER_PASSWORD must be at least 8 characters.');
    process.exit(1);
  }

  const importFile = resolveImportFile();

  console.log('Connecting to', MONGO_URI.replace(/\/\/.*@/, '//*****@'));
  await mongoose.connect(MONGO_URI);
  console.log('Connected');

  // Clean
  await Promise.all([
    User.deleteMany({}),
    Cafe.deleteMany({}),
    Organization.deleteMany({}),
    Transaction.deleteMany({}),
    Item.deleteMany({}),
  ]);
  console.log('Cleared all collections');

  // Create user + org + cafe
  const user = new User({ name: SEED_USER_NAME, email: SEED_USER_EMAIL, password: SEED_USER_PASSWORD, role: 'owner' });
  await user.save();

  const org = await Organization.create({
    name: SEED_ORG_NAME,
    ownerId: user._id,
  });

  const cafe = await Cafe.create({
    name: SEED_CAFE_NAME,
    orgId: org._id,
    location: { address: SEED_CAFE_ADDRESS, city: SEED_CAFE_CITY },
    dataUploaded: true,
    lastSyncAt: new Date(),
  });

  user.orgId = org._id;
  user.cafeIds = [cafe._id];
  user.activeCafeId = cafe._id;
  await user.save();
  console.log('User + Org + Cafe created');

  // Parse XLSX
  const rows = await readWorkbookRows(fs.readFileSync(importFile));
  console.log(`Parsed ${rows.length} rows`);

  // Build transaction documents in memory
  const txDocs = [];
  const itemMap = new Map();
  const regex = /(\d+)\s+x\s+(.+?)(?:,(?=\d+\s+x\s+)|$)/g;

  for (const row of rows) {
    const status = (row['Status'] || '').trim();
    if (status.toLowerCase() !== 'approved') continue;

    const receiptId = (row['Receipt'] || '').trim();
    const dateStr = (row['Date'] || '').trim().replace(/\//g, '-');
    const timeStr = (row['Time'] || '').trim();
    if (!receiptId || !dateStr) continue;

    const parsedDate = new Date(timeStr ? `${dateStr}T${timeStr}` : dateStr);
    if (isNaN(parsedDate.getTime())) continue;

    // Parse items
    const itemsStr = (row['Items'] || '').trim();
    const items = [];
    let match;
    regex.lastIndex = 0;
    while ((match = regex.exec(itemsStr)) !== null) {
      const qty = parseInt(match[1], 10);
      const name = match[2].trim();
      if (name) items.push({ name, quantity: qty });
    }

    const total = parseFloat(String(row['Total (incl. tax)'] || '0').replace(/[^0-9.-]/g, '')) || 0;
    const tip = parseFloat(String(row['Tip'] || '0').replace(/[^0-9.-]/g, '')) || 0;
    const discount = parseFloat(String(row['Discount'] || '0').replace(/[^0-9.-]/g, '')) || 0;
    const totalQty = items.reduce((s, i) => s + i.quantity, 0);
    const unitPrice = totalQty > 0 ? parseFloat((total / totalQty).toFixed(2)) : 0;

    txDocs.push({
      cafeId: cafe._id,
      receiptId,
      date: parsedDate,
      hour: parsedDate.getHours(),
      dayOfWeek: parsedDate.getDay(),
      status: 'approved',
      paymentMethod: (row['Payment Method'] || '').trim(),
      items: items.map(i => ({ ...i, unitPrice })),
      total, tip, discount,
      source: 'csv',
    });

    for (const item of items) {
      const cur = itemMap.get(item.name) || { qty: 0, rev: 0 };
      cur.qty += item.quantity;
      cur.rev += unitPrice * item.quantity;
      itemMap.set(item.name, cur);
    }
  }

  // Bulk insert transactions
  console.log(`Inserting ${txDocs.length} transactions...`);
  const BATCH = 500;
  for (let i = 0; i < txDocs.length; i += BATCH) {
    await Transaction.insertMany(txDocs.slice(i, i + BATCH), { ordered: false }).catch(() => {});
    process.stdout.write(`  ${Math.min(i + BATCH, txDocs.length)}/${txDocs.length}\r`);
  }
  console.log(`\nTransactions done`);

  // Bulk insert items
  const itemDocs = [...itemMap.entries()].map(([name, s]) => ({
    cafeId: cafe._id,
    name,
    avgPrice: s.qty > 0 ? parseFloat((s.rev / s.qty).toFixed(2)) : 0,
    totalSold: s.qty,
  }));
  await Item.insertMany(itemDocs, { ordered: false }).catch(() => {});
  console.log(`${itemDocs.length} items inserted`);

  console.log(`\nDone! Login: ${SEED_USER_EMAIL} / value from SEED_USER_PASSWORD, or the local demo default`);
  await mongoose.disconnect();
  process.exit(0);
}

seed().catch(e => { console.error(e); process.exit(1); });
