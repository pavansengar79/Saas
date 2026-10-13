/**
 * Debug script to check why holiday not found
 */

const mongoose = require('mongoose');
require('dotenv').config();

const Holiday = require('../modules/holiday/models/holiday.models');

async function debug() {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log('✅ Connected to MongoDB\n');

    const holidayId = '6a46a1e0ece88b1d443d713e';
    
    // Check if holiday exists
    const holiday = await Holiday.findById(holidayId).lean();
    
    if (!holiday) {
      console.log('❌ Holiday not found in database');
      console.log('ID:', holidayId);
      process.exit(1);
    }

    console.log('✅ Holiday found in database:\n');
    console.log('Holiday Details:');
    console.log('  _id:', holiday._id);
    console.log('  name:', holiday.name);
    console.log('  org_id:', holiday.org_id);
    console.log('  company_id:', holiday.company_id);
    console.log('  unit_id:', holiday.unit_id);
    console.log('  isDeleted:', holiday.isDeleted);
    console.log('');

    // User from JWT token
    const user = {
      orgId: '6aaa43e39580f2755066f57c',
      companyId: '6aaa43e49580f2755066f57e',
      unitId: '6aaa43e49580f2755066f580'
    };

    console.log('User Details (from JWT):');
    console.log('  orgId:', user.orgId);
    console.log('  companyId:', user.companyId);
    console.log('  unitId:', user.unitId);
    console.log('');

    // Build the filter
    const filter = { 
      _id: holidayId, 
      isDeleted: false, 
      org_id: user.orgId 
    };
    
    if (user.companyId) filter.company_id = user.companyId;

    console.log('Query Filter:');
    console.log(JSON.stringify(filter, null, 2));
    console.log('');

    // Try to find with filter
    const found = await Holiday.findOne(filter).lean();
    
    if (found) {
      console.log('✅ Holiday matches filter - API SHOULD WORK');
    } else {
      console.log('❌ Holiday does NOT match filter');
      console.log('');
      console.log('Mismatch Analysis:');
      
      // Check org_id
      if (holiday.org_id && holiday.org_id.toString() !== user.orgId) {
        console.log('  ⚠️  org_id mismatch:');
        console.log('     Holiday org_id:', holiday.org_id);
        console.log('     User orgId:', user.orgId);
      }
      
      // Check company_id
      if (filter.company_id && holiday.company_id && holiday.company_id.toString() !== user.companyId) {
        console.log('  ⚠️  company_id mismatch:');
        console.log('     Holiday company_id:', holiday.company_id);
        console.log('     User companyId:', user.companyId);
      }
      
      // Check isDeleted
      if (holiday.isDeleted) {
        console.log('  ⚠️  Holiday is soft-deleted');
      }
    }

    process.exit(0);
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

debug();
