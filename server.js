require('dotenv').config();
require('./config/db')();

// Run migrations after DB connects
const mongoose = require('mongoose');
mongoose.connection.once('open', async () => {
  console.log('📦 Running database migrations...');
  const dropTenantIdIndex = require('./modules/companyConfig/migrations/dropTenantIdIndex');
  await dropTenantIdIndex();
  
  // Fix leave type employment types
  const migrateEmploymentTypes = require('./migrations/fix-leave-type-employment');
  await migrateEmploymentTypes();
});

const app = require('./app');

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
// server connected to db and listening on port 5000