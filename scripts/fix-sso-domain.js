/**
 * Quick Fix: Update SSO Domain for Testing
 * 
 * WorkOS org_test_idp allows testing with ANY domain,
 * but the email domain must match what's configured in MongoDB.
 * 
 * Solution: Update MongoDB to match your test email domain.
 */

const path = require('path');
const mongoose = require('mongoose');
const dotenv = require('dotenv');

dotenv.config({ path: path.join(__dirname, '..', '.env') });

const MONGO_URI = process.env.MONGO_URI;
if (!MONGO_URI) {
  console.error('❌ MONGO_URI is not set. Add it to .env or the environment before running this script.');
  process.exit(1);
}

mongoose.connect(MONGO_URI)
  .then(() => console.log('✅ Connected to MongoDB'))
  .catch(err => {
    console.error('❌ Connection error:', err.message);
    process.exit(1);
  });

const ssoConnectionSchema = new mongoose.Schema({
  org_id: mongoose.Schema.Types.ObjectId,
  connectionId: String,
  domain: String,
  provider: String,
  environment: String,
  active: Boolean
}, { collection: 'ssoconnections' });

const SSOConnection = mongoose.model('SSOConnection', ssoConnectionSchema);

async function fixDomain() {
  try {
    console.log('\n=== 🔧 Fixing SSO Domain ===\n');

    // Option 1: Use benosupport.com (for real testing)
    const domain1 = 'benosupport.com';
    
    // Option 2: Use WorkOS test domain
    const domain2 = 'workos.com';
    
    // Option 3: Use generic test domain
    const domain3 = 'test.com';

    console.log('Choose domain update:');
    console.log(`1. benosupport.com (use with: vibhav@benosupport.com)`);
    console.log(`2. workos.com (use with: test@workos.com)`);
    console.log(`3. test.com (use with: user@test.com)`);

    const selectedDomain = domain1; // Default: benosupport.com

    console.log(`\n📝 Updating to: ${selectedDomain}`);

    // Update SSO connection
    const result = await SSOConnection.updateOne(
      { connectionId: 'org_test_idp' },
      {
        $set: {
          domain: selectedDomain,
          provider: 'mock',
          environment: 'development',
          active: true,
          updatedAt: new Date()
        }
      }
    );

    if (result.modifiedCount > 0) {
      console.log(`✅ Domain updated to: ${selectedDomain}`);
      console.log('\n🧪 Test with:');
      console.log(`   Email: vibhav@${selectedDomain}`);
      console.log(`   Or: test@${selectedDomain}`);
      console.log('\nWorkOS will now accept authentication from this domain.');
    } else if (result.matchedCount > 0) {
      console.log('ℹ️  Already configured with this domain');
    } else {
      console.log('❌ No SSO connection found with org_test_idp');
      
      // Create new connection
      console.log('\n📝 Creating new SSO connection...');
      const newConnection = await SSOConnection.create({
        org_id: '6a44f2f900e74ed3ecb234d0', // Your org ID
        connectionId: 'org_test_idp',
        domain: selectedDomain,
        provider: 'mock',
        environment: 'development',
        active: true
      });
      
      console.log(`✅ Created new SSO connection for ${selectedDomain}`);
    }

    // Show current configuration
    const currentConnection = await SSOConnection.findOne({ connectionId: 'org_test_idp' });
    if (currentConnection) {
      console.log('\n📊 Current Configuration:');
      console.log('   Domain:', currentConnection.domain);
      console.log('   Connection ID:', currentConnection.connectionId);
      console.log('   Provider:', currentConnection.provider);
      console.log('   Active:', currentConnection.active);
    }

    console.log('\n✅ Done! Test SSO login now.');
    console.log(`   Use email: vibhav@${selectedDomain}`);

    process.exit(0);
  } catch (error) {
    console.error('\n❌ Error:', error.message);
    process.exit(1);
  }
}

fixDomain();
