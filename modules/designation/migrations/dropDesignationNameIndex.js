const mongoose = require('mongoose');

module.exports = async function migrateDesignationIndexes() {
  const db = mongoose.connection.db;
  if (!db) {
    throw new Error('Database must be connected before migrating designation indexes');
  }

  const collection = db.collection('designations');

  // A new/empty database has no "designations" collection yet: listing its
  // indexes fails with NamespaceNotFound (code 26). Nothing to drop then —
  // createIndex below creates the collection and the index.
  let indexes = [];
  try {
    indexes = await collection.indexes();
  } catch (err) {
    if (err?.code !== 26 && err?.codeName !== 'NamespaceNotFound') throw err;
  }
  for (const index of indexes) {
    const fields = Object.keys(index.key);
    const isLegacyUnitIndex = fields.includes('unit_id') &&
      fields.every(field => field === 'unit_id' || field === 'isDeleted');
    const isDesignationNameIndex = fields.length === 2 &&
      fields[0] === 'unit_id' && fields[1] === 'name';
    const isCurrentNameIndex = isDesignationNameIndex && index.unique &&
      index.partialFilterExpression?.isDeleted === false;
    const isLegacyNameIndex = fields.includes('name') && !isCurrentNameIndex;

    if ((index.unique && (isLegacyUnitIndex || isLegacyNameIndex)) ||
      (isDesignationNameIndex && !isCurrentNameIndex)) {
      await collection.dropIndex(index.name);
      console.log(`[Migration] Dropped obsolete designation index ${index.name}`);
    }
  }

  await collection.createIndex(
    { unit_id: 1, name: 1 },
    { name: 'unit_id_1_name_1', unique: true, partialFilterExpression: { isDeleted: false } }
  );
};