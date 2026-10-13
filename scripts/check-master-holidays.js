/**
 * Check HolidayMaster collection
 */

const mongoose = require('mongoose');
require('dotenv').config();

async function check() {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log('✅ Connected to MongoDB\n');

    // Get HolidayMaster model
    const HolidayMaster = mongoose.model('HolidayMaster', new mongoose.Schema({}, { strict: false }));
    
    // Find all master holidays
    const masterHolidays = await HolidayMaster.find({}).limit(15).lean();
    
    console.log(`📊 HolidayMaster collection: ${masterHolidays.length} holidays\n`);
    
    masterHolidays.forEach((h, i) => {
      console.log(`${i + 1}. ${h.name || 'Unknown'}`);
      console.log(`   _id: ${h._id}`);
      console.log(`   date: ${h.date}`);
      console.log(`   year: ${h.year}`);
      console.log(`   isActive: ${h.isActive}`);
      console.log('');
    });

    // Check if specific ID exists
    const specificId = '6a46a1e0ece88b1d443d713e';
    const specificHoliday = await HolidayMaster.findById(specificId).lean();
    
    if (specificHoliday) {
      console.log(`✅ Holiday ${specificId} FOUND in HolidayMaster collection`);
      console.log(`   This is a MASTER holiday (template), not a company holiday`);
    } else {
      console.log(`❌ Holiday ${specificId} NOT in HolidayMaster either`);
    }

    process.exit(0);
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

check();
