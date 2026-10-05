// const mongoose = require('mongoose');
// const { seedRoles }       = require('../seeders/roleSeeder');
// const { seedPermissions } = require('../seeders/permission.Seeder');
// const { seedModules }     = require('../seeders/module.Seeders');
// const { seedPlans }       = require('../seeders/plan.Seeder');
// const { seedHolidays }    = require('../seeders/holiday.Seeders');

// const connectDB = async () => {
//   try {
//     await mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/erp');
//     console.log('✅ MongoDB connected');

//     // ── Mongoose Query Logger (dev only) ──────────────────────
//     if (process.env.NODE_ENV !== 'production') {
//       mongoose.set('debug', (collectionName, method, query, doc) => {
//         try {
//           const safeQuery = JSON.stringify(query)
//           const safeDoc   = doc && typeof doc === 'object' && Object.keys(doc).length
//             ? JSON.stringify(doc)
//             : ''
//           console.log(
//             `\x1b[35m  🍃 Mongoose:\x1b[0m \x1b[33m${collectionName}.${method}\x1b[0m`,
//             safeQuery,
//             safeDoc
//           )
//         } catch (e) {
//           console.log(
//             `\x1b[35m  🍃 Mongoose:\x1b[0m \x1b[33m${collectionName}.${method}\x1b[0m`,
//             '[query not serializable — session or circular ref]'
//           )
//         }
//       });
//     }

//     // ── Seeders ───────────────────────────────────────────────
//     await seedModules();
//     await seedPlans();
//     await seedPermissions();
//     await seedRoles();
//     await seedHolidays();

//   } catch (error) {
//     console.error('❌ MongoDB connection error:', error.message);
//     process.exit(1);
//   }
// };

// module.exports = connectDB;

const mongoose = require('mongoose');
const { seedRoles }       = require('../seeders/roleSeeder');
const { seedPermissions } = require('../seeders/permission.Seeder');
const { seedModules }     = require('../seeders/module.Seeders');
const { seedPlans }       = require('../seeders/plan.Seeder');
const { seedHolidays }    = require('../seeders/holiday.Seeders');
const migrateLeaveTypeIndexes = require('../modules/leave/migrations/migrateLeaveTypeIndexes');

// ── Serverless-safe connection caching ──────────────────────────
// Vercel spins up fresh function instances per request/cold-start.
// Without this cache, every invocation tries to open a brand-new
// connection — slow, and can exceed Mongoose's default buffering
// timeout (the "Operation X.find() buffering timed out" error).
// `global` persists across invocations on a warm instance, so we
// reuse the same connection/promise instead of reconnecting.
let cached = global._mongooseConn;
if (!cached) cached = global._mongooseConn = { conn: null, promise: null, seeded: false };

const connectDB = async () => {
  if (cached.conn) return cached.conn;

  if (!process.env.MONGO_URI) {
    // Fail loudly instead of silently falling back to localhost,
    // which doesn't exist on Vercel and just causes a slow timeout
    // with a confusing error instead of a clear one.
    throw new Error('MONGO_URI environment variable is not set');
  }

  if (!cached.promise) {
    cached.promise = mongoose.connect(process.env.MONGO_URI, {
      bufferCommands: false,          // fail fast instead of buffering silently for 10s
      serverSelectionTimeoutMS: 10000,
    }).then((m) => {
      console.log('✅ MongoDB connected');
      return m;
    });
  }

  cached.conn = await cached.promise;

  // ── Mongoose Query Logger (dev only) ──────────────────────
  if (process.env.NODE_ENV !== 'production') {
    mongoose.set('debug', (collectionName, method, query, doc) => {
      try {
        const safeQuery = JSON.stringify(query)
        const safeDoc   = doc && typeof doc === 'object' && Object.keys(doc).length
          ? JSON.stringify(doc)
          : ''
        console.log(
          `\x1b[35m  🍃 Mongoose:\x1b[0m \x1b[33m${collectionName}.${method}\x1b[0m`,
          safeQuery,
          safeDoc
        )
      } catch (e) {
        console.log(
          `\x1b[35m  🍃 Mongoose:\x1b[0m \x1b[33m${collectionName}.${method}\x1b[0m`,
          '[query not serializable — session or circular ref]'
        )
      }
    });
    
  }

  // ── Seeders — run once per warm instance, not on every request ──
  if (!cached.seeded) {
    cached.seeded = true;
    await seedModules();
    await seedPlans();
    await seedPermissions();
    await seedRoles();
    await seedHolidays();
    await migrateLeaveTypeIndexes();
  }

  return cached.conn;
};

module.exports = connectDB;