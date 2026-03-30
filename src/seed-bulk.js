require('dotenv').config();
const mongoose = require('mongoose');
const XLSX = require('xlsx');
const User = require('./models/User.model');
const Cafe = require('./models/Cafe.model');
const Organization = require('./models/Organization.model');
const Transaction = require('./models/Transaction.model');
const Item = require('./models/Item.model');

const YOCO_FILE = 'C:\\Users\\shaun\\transactions_temp.xlsx';
const MONGO_URI = process.argv[2] || process.env.MONGODB_URI;

async function seed() {
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
  const user = new User({ name: 'Shaun Schoeman', email: 'shaun@yourguava.com', password: 'password123', role: 'owner' });
  await user.save();

  const org = await Organization.create({
    name: 'Schoeman Coffee Group',
    ownerId: user._id,
  });

  const cafe = await Cafe.create({
    name: 'Blouberg Coffee',
    orgId: org._id,
    location: { address: 'Bloubergstrand', city: 'Cape Town', lat: -33.8069, lng: 18.4703 },
    dataUploaded: true,
    lastSyncAt: new Date(),
  });

  user.orgId = org._id;
  user.cafeIds = [cafe._id];
  user.activeCafeId = cafe._id;
  await user.save();
  console.log('User + Org + Cafe created');

  // Parse XLSX
  const workbook = XLSX.readFile(YOCO_FILE);
  const rows = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { defval: '' });
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

  console.log('\nDone! Login: shaun@yourguava.com / password123');
  await mongoose.disconnect();
  process.exit(0);
}

seed().catch(e => { console.error(e); process.exit(1); });
