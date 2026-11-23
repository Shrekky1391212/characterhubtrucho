export function formatMigrationConflictReport(conflicts) {
  return conflicts.map(row => `${row.table}: ${JSON.stringify(row)}`).join('\n');
}

export function assertSafeSqliteImport(accountCount, tableCounts) {
  const records = Object.values(tableCounts).reduce((sum, count) => sum + Number(count), 0);
  if (Number(accountCount) > 0 || records > 0) {
    throw new Error('SQLite import stopped: PostgreSQL must have no accounts and no archive records. Import into a fresh database before creating the first account; no unowned records were written.');
  }
}
