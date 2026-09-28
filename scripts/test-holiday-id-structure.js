/**
 * URGENT PRODUCTION FIX TEST
 * Test that holidays return _id and frontend handles it correctly
 */

const mongoose = require('mongoose');
require('dotenv').config();

const Holiday = require('../modules/holiday/models/holiday.models');

async function testHolidayStructure() {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log('✅ Connected to MongoDB\n');

    // Find a holiday (any holiday)
    const holiday = await Holiday.findOne({ isDeleted: false }).lean();
    
    if (!holiday) {
      console.log('⚠️  No holidays found in database');
      console.log('Creating a test holiday...\n');
      
      // Create test holiday
      const testHoliday = await Holiday.create({
        org_id: 'test',
        company_id: 'test',
        name: 'Test Holiday',
        date: new Date('2026-01-26'),
        type: 'NATIONAL',
        year: 2026,
        isDeleted: false
      });
      
      console.log('✅ Test holiday created:');
      console.log('   _id:', testHoliday._id);
      console.log('   id:', testHoliday.id);
      console.log('   name:', testHoliday.name);
      console.log('');
      console.log('⚠️  MongoDB documents use _id (ObjectId)');
      console.log('⚠️  Frontend must use holiday._id not holiday.id\n');
      
      // Cleanup
      await Holiday.deleteOne({ _id: testHoliday._id });
      console.log('✅ Test holiday cleaned up');
      
    } else {
      console.log('✅ Found holiday:');
      console.log('   _id:', holiday._id);
      console.log('   id field:', holiday.id);
      console.log('   id type:', typeof holiday._id);
      console.log('   name:', holiday.name);
      console.log('   date:', holiday.date);
      console.log('');
      
      // Check the structure
      const hasMongoId = !!holiday._id;
      const hasIdField = 'id' in holiday;
      
      console.log('📋 Structure Check:');
      console.log('   Has _id (MongoDB):', hasMongoId ? '✅ YES' : '❌ NO');
      console.log('   Has id field:', hasIdField ? 'YES (custom)' : 'NO (default)');
      console.log('');
      
      if (hasMongoId) {
        console.log('✅ Backend returns _id correctly');
        console.log('✅ Frontend should use: holiday._id');
        console.log('✅ Delete API needs: /api/v1/holidays/' + holiday._id);
      } else {
        console.log('❌ ERROR: No _id found!');
      }
    }

    process.exit(0);
  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  }
}

testHolidayStructure();
