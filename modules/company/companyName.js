// Comparison key: treat case, Unicode presentation forms and repeated whitespace equally.
exports.normalizeCompanyName = (name) =>
  name.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();

// Also match older records that have not yet been backfilled with company_name_key.
exports.legacyNamePattern = (name) =>
  `^\\s*${name.normalize('NFKC').trim().split(/\s+/).map((part) =>
    part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  ).join('\\s+')}\\s*$`;
