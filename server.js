require('dotenv').config();

// ---- DNS fix for "querySrv ECONNREFUSED" (only if DNS_SERVERS is set in .env) ----
const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');
if (process.env.DNS_SERVERS) {
dns.setServers(process.env.DNS_SERVERS.split(',').map(s => s.trim()).filter(Boolean));
}
console.log('🌐 DNS servers:', dns.getServers());

// Show which DB we connect to (password hidden)
const mongoUri = process.env.MONGO_URI || '';
console.log('🗄️ MONGO_URI:', mongoUri.replace(/\/\/([^:]+):[^@]+@/, '//$1:****@') || '(not set!)');

// ---- Connect DB ----
const mongoose = require('mongoose');

mongoose.connection.on('error', (err) => {
console.error('❌ MongoDB connection error:', err.message);
});

// Run one migration; a failure is logged and the server keeps going
async function runMigration(name, fn) {
try {
    await fn();
} catch (err) {
    if (err?.code === 26) {
     console.log(`ℹ️ [Migration] ${name}: collection not created yet, skipped`);
    } else {
     console.error(`❌ [Migration] ${name} failed:`, err.message);
    }
}
}

// Run migrations after DB connects
mongoose.connection.once('open', async () => {
console.log(`✅ MongoDB connected: ${mongoose.connection.host}/${mongoose.connection.name}`);
console.log('📦 Running database migrations...');

await runMigration('dropTenantIdIndex', require('./modules/companyConfig/migrations/dropTenantIdIndex'));

// Fix leave type employment types
await runMigration('fix-leave-type-employment', require('./migrations/fix-leave-type-employment'));
});

// Log errors nobody caught instead of crashing the server
process.on('unhandledRejection', (err) => {
console.error('❌ Unhandled error:', err?.message || err);
});

require('./config/db')();

// ---- Start server ----
const app = require('./app');
const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
console.log(`🚀 Server running on port ${PORT}`);
});
