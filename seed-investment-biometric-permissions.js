// seed-investment-biometric-permissions.js
// Script to seed investment_declaration and biometric permissions and update roles

const mongoose = require('mongoose');

require('dotenv').config();
const MONGO_URI = process.env.MONGO_URI;

const PERMISSIONS_TO_ADD = [
  // Investment Declaration permissions
  { module: 'investment_declaration', slug: 'investment_declaration.create', name: 'Create Investment Declaration', action: 'create', label: 'Create Investment Declaration', scope: ['unit'], description: 'Create investment declaration', category: 'Payroll', is_active: true },
  { module: 'investment_declaration', slug: 'investment_declaration.read', name: 'View Investment Declarations', action: 'read', label: 'View Investment Declarations', scope: ['org', 'company', 'unit'], description: 'View investment declarations', category: 'Payroll', is_active: true },
  { module: 'investment_declaration', slug: 'investment_declaration.update', name: 'Review Investment Declaration', action: 'update', label: 'Review Investment Declaration', scope: ['unit', 'company'], description: 'Approve/reject investment declarations', category: 'Payroll', is_active: true },
  { module: 'investment_declaration', slug: 'investment_declaration.delete', name: 'Delete Investment Declaration', action: 'delete', label: 'Delete Investment Declaration', scope: ['unit'], description: 'Delete investment declaration', category: 'Payroll', is_active: true },
  
  // Biometric permissions
  { module: 'biometric', slug: 'biometric.create', name: 'Create Biometric Config', action: 'create', label: 'Create Biometric Config', scope: ['unit'], description: 'Create biometric configuration', category: 'Configuration', is_active: true },
  { module: 'biometric', slug: 'biometric.read', name: 'View Biometric Config', action: 'read', label: 'View Biometric Config', scope: ['org', 'company', 'unit'], description: 'View biometric configuration', category: 'Configuration', is_active: true },
  { module: 'biometric', slug: 'biometric.update', name: 'Update Biometric Config', action: 'update', label: 'Update Biometric Config', scope: ['unit', 'company'], description: 'Update biometric configuration', category: 'Configuration', is_active: true },
  { module: 'biometric', slug: 'biometric.delete', name: 'Delete Biometric Config', action: 'delete', label: 'Delete Biometric Config', scope: ['unit'], description: 'Delete biometric configuration', category: 'Configuration', is_active: true },
];

const ROLE_PERMISSIONS = {
  employee: [
    'investment_declaration.create',
    'investment_declaration.read',
    'biometric.read',
    'biometric.create',
  ],
  hr_manager: [
    'investment_declaration.read',
    'investment_declaration.create',
    'investment_declaration.update',
    'biometric.read',
    'biometric.create',
    'biometric.update',
  ],
  unit_admin: [
    'investment_declaration.create',
    'investment_declaration.read',
    'investment_declaration.update',
    'investment_declaration.delete',
    'biometric.create',
    'biometric.read',
    'biometric.update',
    'biometric.delete',
  ],
};

async function seedPermissions() {
  try {
    if (!MONGO_URI) throw new Error('MONGO_URI environment variable is not set');
    await mongoose.connect(MONGO_URI);
    console.log('✅ Connected to MongoDB Atlas');

    const db = mongoose.connection.db;

    // 1. Add permissions
    console.log('\n📋 Adding permissions...');
    for (const perm of PERMISSIONS_TO_ADD) {
      const existing = await db.collection('permissions').findOne({ slug: perm.slug });
      if (!existing) {
        await db.collection('permissions').insertOne({
          ...perm,
          createdAt: new Date(),
          updatedAt: new Date(),
        });
        console.log(`  ✅ Created: ${perm.slug}`);
      } else {
        console.log(`  ⏭️  Already exists: ${perm.slug}`);
      }
    }

    // 2. Get permission ObjectIds
    const allPerms = await db.collection('permissions')
      .find({ slug: { $in: PERMISSIONS_TO_ADD.map(p => p.slug) } })
      .project({ _id: 1, slug: 1 })
      .toArray();

    const permMap = {};
    allPerms.forEach(p => {
      permMap[p.slug] = p._id;
    });

    // 3. Update roles
    console.log('\n📋 Updating roles...');
    
    for (const [roleSlug, permSlugs] of Object.entries(ROLE_PERMISSIONS)) {
      const role = await db.collection('roles').findOne({ slug: roleSlug, org_id: null });
      
      if (!role) {
        console.log(`  ⚠️  Role not found: ${roleSlug}`);
        continue;
      }

      const permIds = permSlugs
        .map(slug => permMap[slug])
        .filter(id => id);

      if (permIds.length === 0) {
        console.log(`  ⚠️  No permissions found for: ${roleSlug}`);
        continue;
      }

      // Add permissions to role (avoid duplicates)
      const result = await db.collection('roles').updateOne(
        { _id: role._id },
        { $addToSet: { permissions: { $each: permIds } } }
      );

      console.log(`  ✅ Updated ${roleSlug}: modified=${result.modifiedCount}`);
    }

    // 4. Verify
    console.log('\n📊 Verification:');
    for (const roleSlug of Object.keys(ROLE_PERMISSIONS)) {
      const role = await db.collection('roles')
        .findOne({ slug: roleSlug, org_id: null }, { projection: { permissions: 1 } });
      
      if (role) {
        const count = role.permissions?.length || 0;
        console.log(`  ${roleSlug}: ${count} permissions`);
      }
    }

    console.log('\n✅ Permissions seeded successfully!');
    console.log('\n⚠️  USERS MUST RE-LOGIN TO GET NEW PERMISSIONS');
    
    mongoose.connection.close();
    process.exit(0);
  } catch (err) {
    console.error('❌ Error:', err.message);
    process.exit(1);
  }
}

seedPermissions();
