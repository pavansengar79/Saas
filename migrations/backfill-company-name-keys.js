// Run before deploying the new name check, preferably while company writes are paused.
// Usage: node migrations/backfill-company-name-keys.js [--dry-run] [--preserve-duplicates | --index-only]
// --index-only protects newly keyed companies without changing legacy records.
// --preserve-duplicates keys one record per conflicting name and leaves the
// others untouched. Resolve these records manually before a full backfill.
require('dotenv').config();
const mongoose = require('mongoose');
const { normalizeCompanyName } = require('../modules/company/companyName');

async function backfillCompanyNames() {
  if (!process.env.MONGO_URI) throw new Error('MONGO_URI is required');
  const indexOnly = process.argv.includes('--index-only');
  const preserveDuplicates = process.argv.includes('--preserve-duplicates');
  const dryRun = process.argv.includes('--dry-run');
  if (indexOnly && (dryRun || preserveDuplicates)) {
    throw new Error('--index-only cannot be combined with other modes');
  }
  await mongoose.connect(process.env.MONGO_URI);
  try {
    const companies = mongoose.connection.db.collection('companies');
    const records = await companies.find({ is_deleted: false }, {
      projection: { _id: 1, org_id: 1, company_name: 1, company_name_key: 1 },
    }).toArray();
    const groups = new Map();
    const duplicates = [];
    const changes = [];
    const unkeyed = [];

    for (const company of records) {
      if (typeof company.company_name !== 'string' || !normalizeCompanyName(company.company_name)) {
        throw new Error(`Company ${company._id} has no valid name`);
      }
      const nameKey = normalizeCompanyName(company.company_name);
      const scopeKey = JSON.stringify([String(company.org_id), nameKey]);
      if (!groups.has(scopeKey)) groups.set(scopeKey, { nameKey, companies: [] });
      groups.get(scopeKey).companies.push(company);
    }

    for (const { nameKey, companies: group } of groups.values()) {
      const keyed = group.filter((company) => company.company_name_key === nameKey);
      if (keyed.length > 1) {
        throw new Error(`Existing name-key collision: ${keyed.map((company) => company._id).join(', ')}`);
      }
      // Keep an already-keyed record; otherwise choose the lowest ID for stable reruns.
      const keeper = keyed[0] || group.reduce((a, b) =>
        String(a._id) < String(b._id) ? a : b
      );
      for (const company of group) {
        if (company !== keeper) {
          duplicates.push(`${company._id} (${company.company_name}) conflicts with ${keeper._id} (${keeper.company_name})`);
          if (preserveDuplicates) {
            if (company.company_name_key != null) {
              throw new Error(`Conflicting company ${company._id} has a different name key; resolve manually`);
            }
            unkeyed.push(String(company._id));
            continue;
          }
        }
        if (company.company_name_key === nameKey) continue;
        changes.push({ updateOne: {
          // Refuse to update a record that was renamed or deleted after the scan.
          filter: {
            _id: company._id,
            org_id: company.org_id,
            company_name: company.company_name,
            is_deleted: false,
            company_name_key: Object.hasOwn(company, 'company_name_key')
              ? company.company_name_key : { $exists: false },
          },
          update: { $set: { company_name_key: nameKey } },
        } });
      }
    }

    if (duplicates.length) {
      const conflicts = `Resolve duplicate company names within an organization first:\n${duplicates.join('\n')}`;
      if (!indexOnly && !preserveDuplicates) throw new Error(conflicts);
      console.warn(conflicts);
    }
    console.log(`${changes.length} active companies need a normalized name key.`);
    if (unkeyed.length) console.log(`Leaving ${unkeyed.length} duplicate records unkeyed: ${unkeyed.join(', ')}`);
    if (dryRun) return;

    // Create the index before writes so concurrent keyed inserts are also protected.
    await companies.createIndex(
      { org_id: 1, company_name_key: 1 },
      {
        unique: true,
        name: 'unique_active_company_name_per_org',
        partialFilterExpression: { is_deleted: false, company_name_key: { $type: 'string' } },
      }
    );
    if (!indexOnly) {
      for (let i = 0; i < changes.length; i += 500) {
        const batch = changes.slice(i, i + 500);
        const result = await companies.bulkWrite(batch, { ordered: true });
        if (result.matchedCount !== batch.length) {
          throw new Error('A company changed during backfill. Rerun the migration after company writes are paused.');
        }
      }
    }
    console.log(indexOnly
      ? 'Unique index created for keyed companies; existing names remain unbackfilled.'
      : preserveDuplicates
        ? 'Unambiguous names backfilled; duplicate records were preserved. Resolve them before full backfill.'
        : 'Company names backfilled; unique index created.');
  } finally {
    await mongoose.disconnect();
  }
}

if (require.main === module) {
  backfillCompanyNames().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = backfillCompanyNames;
