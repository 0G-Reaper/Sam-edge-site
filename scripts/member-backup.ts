import { backupKey, createMemberBackup, restoreMemberBackup } from '../server/member-backup.js'

process.umask(0o077)
const [operation, source, destination, ...extra] = process.argv.slice(2)
if (!['create', 'restore'].includes(operation) || !source || !destination || extra.length) {
  console.error('Usage: node dist/scripts/member-backup.js <create|restore> <source> <new-destination>')
  process.exitCode = 1
} else {
  try {
    const key = backupKey(process.env.MEMBER_BACKUP_KEY)
    try {
      const result = await (operation === 'create' ? createMemberBackup : restoreMemberBackup)(source,destination,key)
      console.log(JSON.stringify({ operation, ...result }))
    } finally { key.fill(0) }
  } catch {
    console.error('Backup operation failed. Check the protected key, paths, permissions and database integrity. Existing destinations are never overwritten.')
    process.exitCode = 1
  }
}
