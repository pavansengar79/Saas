/**
 * Check all holidays in database
 */

const mongoose = require('mongoose');
require('dotenv').config();

const Holiday = require('../modules/holiday/models/holiday.models');

async function checkAllHolidays() {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log('✅ Connected to MongoDB\n');

    // Find all holidays
    const holidays = await Holiday.find({ isDeleted: false })
      .limit(10)
      .lean();
    
    console.log(`📊 Found ${holidays.length} holidays in database:\n`);
    
    holidays.forEach((h, i) => {
      console.log(`${i + 1}. ${h.name}`);
      console.log(`   _id: ${h._id}`);
      console.log(`   date: ${h.date}`);
      console.log(`   org_id: ${h.org_id}`);
      console.log(`   company_id: ${h.company_id}`);
      console.log(`   unit_id: ${h.unit_id}`);
      console.log('');
    });

    // Check if the specific ID exists
    const specificId = '6a46a1e0ece88b1d443d713e';
    const specificHoliday = await Holiday.findById(specificId).lean();
    
    if (specificHoliday) {
      console.log(`\n✅ Holiday ${specificId} exists`);
    } else {
      console.log(`\n❌ Holiday ${specificId} NOT FOUND in database`);
      console.log('');
      console.log('⚠️  This means:');
      console.log('   - Frontend calendar shows holidays that don\'t exist');
      console.log('   - OR they\'re from a different collection (HolidayMaster?)');
      console.log('   - OR they were deleted');
    }

    process.exit(0);
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

checkAllHolidays();
