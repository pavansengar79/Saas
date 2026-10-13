const mongoose = require('mongoose');

module.exports = async function migrateDesignationIndexes() {
  const db = mongoose.connection.db;
  if (!db) {
    throw new Error('Database must be connected before migrating designation indexes');
  }

  const collection = db.collection('designations');

  const indexes = await collection.indexes();
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
