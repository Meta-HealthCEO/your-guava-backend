const fs = require('fs');
const path = require('path');
const csv = require('csv-parser');
const XLSX = require('xlsx');
const Transaction = require('../models/Transaction.model');
const Item = require('../models/Item.model');

/**
 * Parses a Yoco CSV export and upserts transactions into the database.
 *
 * Yoco CSV columns:
 * Receipt, Date, Time, Status, Payment Method, Order Number, Card Reader,
 * Items, Note, Currency, Tip, Discount, VAT, Total (incl. tax), Fee Amount, Net Amount
 *
 * @param {string} filePath - Absolute path to the uploaded CSV file
 * @param {string} cafeId   - Mongoose ObjectId of the cafe
 * @returns {Promise<{ imported: number, skipped: number, errors: number }>}
 */
const parseYocoCSV = (filePath, cafeId) => {
  return new Promise((resolve, reject) => {
    const results = [];

    fs.createReadStream(filePath)
      .pipe(csv())
      .on('data', (row) => results.push(row))
      .on('error', reject)
      .on('end', async () => {
        try {
          const stats = await processRows(results, cafeId);
          resolve(stats);
        } catch (err) {
          reject(err);
        }
      });
  });
};

/**
 * Parses a Yoco XLSX export and upserts transactions into the database.
 *
 * @param {string} filePath
 * @param {string} cafeId
 * @returns {Promise<{ imported: number, skipped: number, errors: number }>}
 */
const parseYocoXLSX = async (filePath, cafeId) => {
  const workbook = XLSX.readFile(filePath);
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
  return processRows(rows, cafeId);
};

/**
 * Shared row processing logic for both CSV and XLSX.
 */
const processRows = async (rows, cafeId) => {
  let imported = 0;
  let skipped = 0;
  let errors = 0;

  const itemNamesSeen = new Map(); // itemName -> { totalQty, totalRevenue }

  for (const row of rows) {
    try {
      // Normalise column names (trim whitespace)
      const status = (row['Status'] || row['status'] || '').trim();

      // Only process approved transactions
      if (status.toLowerCase() !== 'approved') {
        skipped++;
        continue;
      }

      const receiptId = (row['Receipt'] || row['receipt'] || '').trim();
      if (!receiptId) {
        skipped++;
        continue;
      }

      // Parse date: YYYY/MM/DD
      const dateStr = (row['Date'] || row['date'] || '').trim();
      const timeStr = (row['Time'] || row['time'] || '').trim();

      if (!dateStr) {
        skipped++;
        continue;
      }

      // Support both YYYY/MM/DD and YYYY-MM-DD
      const normalizedDate = dateStr.replace(/\//g, '-');
      const dateTimeStr = timeStr ? `${normalizedDate}T${timeStr}` : normalizedDate;
      const parsedDate = new Date(dateTimeStr);

      if (isNaN(parsedDate.getTime())) {
        errors++;
        continue;
      }

      const hour = parsedDate.getHours();
      const dayOfWeek = parsedDate.getDay();

      // Parse items: "1 x Flat White (Blend),3 x Brownie"
      const itemsStr = (row['Items'] || row['items'] || '').trim();
      const parsedItems = parseItems(itemsStr);

      const totalRaw = row['Total (incl. tax)'] || row['Total'] || row['total'] || 0;
      const total = parseFloat(String(totalRaw).replace(/[^0-9.-]/g, '')) || 0;
      const tip = parseFloat(String(row['Tip'] || row['tip'] || '0').replace(/[^0-9.-]/g, '')) || 0;
      const discount = parseFloat(String(row['Discount'] || row['discount'] || '0').replace(/[^0-9.-]/g, '')) || 0;

      // Rough unit price estimate: total / total items quantity
      const totalQty = parsedItems.reduce((sum, i) => sum + i.quantity, 0);
      const unitPrice = totalQty > 0 ? total / totalQty : 0;
      const itemsWithPrice = parsedItems.map((item) => ({
        ...item,
        unitPrice: parseFloat(unitPrice.toFixed(2)),
      }));

      const paymentMethod = (
        row['Payment Method'] ||
        row['payment_method'] ||
        row['payment method'] ||
        ''
      ).trim();

      // Upsert by cafeId + receiptId
      await Transaction.findOneAndUpdate(
        { cafeId, receiptId },
        {
          $setOnInsert: {
            cafeId,
            receiptId,
            date: parsedDate,
            hour,
            dayOfWeek,
            status: 'approved',
            paymentMethod,
            items: itemsWithPrice,
            total,
            tip,
            discount,
            source: 'csv',
          },
        },
        { upsert: true, new: false }
      )
        .then((existing) => {
          if (existing === null) {
            imported++;
          } else {
            skipped++;
          }
        })
        .catch((err) => {
          if (err.code === 11000) {
            // Duplicate key — already exists
            skipped++;
          } else {
            throw err;
          }
        });

      // Track item names for Item upserts
      for (const item of parsedItems) {
        const key = item.name;
        const current = itemNamesSeen.get(key) || { totalQty: 0, totalRevenue: 0 };
        current.totalQty += item.quantity;
        current.totalRevenue += unitPrice * item.quantity;
        itemNamesSeen.set(key, current);
      }
    } catch (err) {
      console.error('[ingestion] Row error:', err.message);
      errors++;
    }
  }

  // Upsert Item records
  for (const [name, stats] of itemNamesSeen.entries()) {
    try {
      await Item.findOneAndUpdate(
        { cafeId, name },
        {
          $inc: { totalSold: stats.totalQty },
          $set: {
            avgPrice:
              stats.totalQty > 0
                ? parseFloat((stats.totalRevenue / stats.totalQty).toFixed(2))
                : 0,
          },
          $setOnInsert: { cafeId, name },
        },
        { upsert: true, new: true }
      );
    } catch (err) {
      console.error(`[ingestion] Item upsert error for "${name}":`, err.message);
    }
  }

  return { imported, skipped, errors };
};

/**
 * Parses Yoco item string into an array of { name, quantity } objects.
 * e.g. "1 x Flat White (Blend),3 x Brownie" -> [{name:"Flat White (Blend)", quantity:1}, ...]
 *
 * @param {string} itemsStr
 * @returns {{ name: string, quantity: number }[]}
 */
const parseItems = (itemsStr) => {
  if (!itemsStr) return [];
  const items = [];
  const regex = /(\d+)\s+x\s+(.+?)(?:,(?=\d+\s+x\s+)|$)/g;
  let match;
  while ((match = regex.exec(itemsStr)) !== null) {
    const quantity = parseInt(match[1], 10);
    const name = match[2].trim();
    if (name) {
      items.push({ name, quantity });
    }
  }
  return items;
};

/**
 * Auto-detects file type by extension and routes to the correct parser.
 *
 * @param {string} filePath
 * @param {string} cafeId
 * @returns {Promise<{ imported: number, skipped: number, errors: number }>}
 */
const ingestFile = async (filePath, cafeId) => {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.csv') {
    return parseYocoCSV(filePath, cafeId);
  } else if (ext === '.xlsx' || ext === '.xls') {
    return parseYocoXLSX(filePath, cafeId);
  } else {
    throw new Error(`Unsupported file type: ${ext}`);
  }
};

module.exports = {
  parseYocoCSV,
  parseYocoXLSX,
  ingestFile,
};
