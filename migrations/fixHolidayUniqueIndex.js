/**
 * Migration: Fix Holiday Unique Index to Include unit_id
 * 
 * Problem: Old unique index was { company_id: 1, date: 1 }
 * Solution: New unique index is { company_id: 1, unit_id: 1, date: 1 }
 * 
 * Why: Different units can have holidays on the same date
 * 
 * Run: node migrations/fixHolidayUniqueIndex.js
 */

const path = require('path');
const mongoose = require('mongoose');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const MONGO_URI = process.env.MONGO_URI;
if (!MONGO_URI) {
  console.error('❌ MONGO_URI is not set. Add it to .env or the environment before running this migration.');
  process.exit(1);
}

const runMigration = async () => {
  try {
    await mongoose.connect(MONGO_URI);
    
    const db = mongoose.connection.db;
    const collection = db.collection('holidaycalendars');
    
    console.log('=== HOLIDAY INDEX MIGRATION ===\n');
    
    // 1. Show current indexes
    console.log('Current indexes:');
    const currentIndexes = await collection.indexes();
    currentIndexes.forEach(idx => {
      if (idx.unique) {
        console.log('  ⚠️ UNIQUE:', idx.name, '-', JSON.stringify(idx.key));
      }
    });
    
    console.log('');
    
    // 2. Drop old unique index
    try {
      console.log('Dropping old unique index: company_id_1_date_1');
      await collection.dropIndex('company_id_1_date_1');
      console.log('✅ Old index dropped');
    } catch (err) {
      if (err.code === 27) {
        console.log('⚠️ Old index not found (already dropped or different name)');
      } else {
        throw err;
      }
    }
    
    console.log('');
    
    // 3. Create new unique index with unit_id
    console.log('Creating new unique index: { company_id: 1, unit_id: 1, date: 1 }');
    await collection.createIndex(
      { company_id: 1, unit_id: 1, date: 1 },
      {
        unique: true,
        partialFilterExpression: { isDeleted: false },
        name: 'company_id_1_unit_id_1_date_1'
      }
    );
    console.log('✅ New unique index created');
    
    console.log('');
    
    // 4. Show final indexes
    console.log('Final indexes:');
    const finalIndexes = await collection.indexes();
    finalIndexes.forEach(idx => {
      if (idx.unique) {
        console.log('  ✅ UNIQUE:', idx.name, '-', JSON.stringify(idx.key));
      }
    });
    
    console.log('');
    console.log('=== MIGRATION COMPLETE ===');
    console.log('');
    console.log('What changed:');
    console.log('  OLD: { company_id: 1, date: 1 } - Prevented unit-specific holidays');
    console.log('  NEW: { company_id: 1, unit_id: 1, date: 1 } - Allows different units to have holidays on same date');
    console.log('');
    console.log('Examples:');
    console.log('  ✅ Unit A can have Independence Day on 2026-08-15');
    console.log('  ✅ Unit B can have Independence Day on 2026-08-15');
    console.log('  ✅ Company-level can have Independence Day on 2026-08-15 (unit_id: null)');
    console.log('');
    
    await mongoose.disconnect();
    process.exit(0);
  } catch (error) {
    console.error('❌ Migration failed:', error.message);
    process.exit(1);
  }
};

runMigration();
