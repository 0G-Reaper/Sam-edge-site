import { randomUUID } from 'node:crypto'
import type { Db } from './db.js'
import { memberHash } from './membership-auth.js'
import { deleteMemberResearch } from './member-research.js'

export function initMemberDeletion(db: Db) {
  db.exec(`CREATE TABLE IF NOT EXISTS member_deletions (
    member_id INTEGER PRIMARY KEY,state TEXT NOT NULL,requested_at INTEGER NOT NULL,completed_at INTEGER
  )`)
}

/** Deliberate deletion. Disable access first; Discord and central research cleanup reconcile. */
export function requestMemberDeletion(db: Db, memberId: number, confirmUserId: string, now=Date.now()): boolean {
  initMemberDeletion(db)
  const row=db.prepare('SELECT user_id,email FROM members WHERE id=?').get(memberId) as {user_id:string;email:string}|undefined
  if (!row || row.user_id!==confirmUserId) return false
  db.exec('BEGIN IMMEDIATE')
  try {
    db.prepare('UPDATE members SET disabled_at=? WHERE id=?').run(new Date(now).toISOString(),memberId)
    db.prepare('UPDATE membership_sessions SET revoked_at=? WHERE member_id=? AND revoked_at IS NULL').run(now,memberId)
    db.prepare('UPDATE membership_devices SET revoked_at=? WHERE member_id=? AND revoked_at IS NULL').run(now,memberId)
    // A Discord outage must not keep sending messages or processing queued private
    // research after deletion is requested. Already accepted provider mail cannot be recalled.
    db.prepare('DELETE FROM membership_challenges WHERE member_id=? OR email=? COLLATE NOCASE').run(memberId,row.email)
    db.prepare('DELETE FROM discord_oauth_flows WHERE member_id=?').run(memberId)
    db.prepare(`UPDATE member_email_outbox SET state='cancelled',body='',lease_id=NULL,lease_until=NULL,last_error='member_deletion'
      WHERE (member_id=? OR recipient=? COLLATE NOCASE) AND state!='accepted'`).run(memberId,row.email)
    db.prepare('UPDATE member_invites SET token_hash=NULL,recipient_email=NULL,expires_at=NULL,reserved_until=NULL WHERE member_id=? OR recipient_email=? COLLATE NOCASE').run(memberId,row.email)
    deleteMemberResearch(db,memberId,now)
    db.prepare("UPDATE discord_member_links SET state='revocation_pending',confirmation_hash=NULL,access_token_ciphertext=NULL,updated_at=? WHERE member_id=? AND state!='revoked'").run(now,memberId)
    db.prepare("INSERT OR IGNORE INTO member_deletions(member_id,state,requested_at) VALUES(?,'requested',?)").run(memberId,now)
    db.exec('COMMIT')
  } catch(error){db.exec('ROLLBACK');throw error}
  finalizeMemberDeletions(db,now)
  return true
}

/** Keep only anonymous issuance/lineage tombstones; serial supply must never refill. */
export function finalizeMemberDeletions(db:Db,now=Date.now()): number {
  initMemberDeletion(db)
  const rows=db.prepare(`SELECT m.id,m.email FROM member_deletions d JOIN members m ON m.id=d.member_id
    WHERE d.state='requested' AND NOT EXISTS(SELECT 1 FROM discord_member_links l WHERE l.member_id=m.id AND l.state!='revoked')
    AND NOT EXISTS(SELECT 1 FROM member_research_deletions r WHERE r.member_id=m.id AND r.state!='completed')
    LIMIT 25`).all() as Array<{id:number;email:string}>
  for(const row of rows){
    db.exec('BEGIN IMMEDIATE')
    try{
      deleteMemberResearch(db,row.id,now)
      db.prepare('DELETE FROM waitlist WHERE id=? AND email=? COLLATE NOCASE').run(row.id,row.email)
      db.prepare('DELETE FROM member_email_outbox WHERE member_id=? OR recipient=? COLLATE NOCASE').run(row.id,row.email)
      db.prepare('DELETE FROM membership_request_nonces WHERE session_id IN (SELECT id FROM membership_sessions WHERE member_id=?)').run(row.id)
      db.prepare('DELETE FROM membership_sessions WHERE member_id=?').run(row.id)
      db.prepare('DELETE FROM membership_devices WHERE member_id=?').run(row.id)
      db.prepare('DELETE FROM membership_challenges WHERE member_id=? OR email=? COLLATE NOCASE').run(row.id,row.email)
      db.prepare('DELETE FROM membership_auth_limits WHERE key=?').run(`email:${memberHash(row.email)}`)
      db.prepare('DELETE FROM membership_audit WHERE member_id=?').run(row.id)
      db.prepare('DELETE FROM discord_oauth_flows WHERE member_id=?').run(row.id)
      db.prepare('DELETE FROM discord_member_links WHERE member_id=?').run(row.id)
      db.prepare('DELETE FROM member_discord_quests WHERE member_id=?').run(row.id)
      db.prepare('DELETE FROM member_quest_events WHERE member_id=?').run(row.id)
      db.prepare('DELETE FROM member_reviews WHERE member_id=?').run(row.id)
      db.prepare('DELETE FROM member_points_ledger WHERE member_id=?').run(row.id)
      db.prepare('UPDATE member_invites SET token_hash=NULL,recipient_email=NULL,expires_at=NULL,reserved_until=NULL WHERE member_id=? OR recipient_email=? COLLATE NOCASE').run(row.id,row.email)
      const tombstone=`deleted-${randomUUID()}`
      db.prepare('UPDATE members SET user_id=?,email=?,created_at=?,verified_at=NULL WHERE id=?').run(tombstone,`${tombstone}@deleted.invalid`,new Date(now).toISOString(),row.id)
      db.prepare("UPDATE member_deletions SET state='completed',completed_at=? WHERE member_id=?").run(now,row.id)
      db.exec('COMMIT')
    }catch(error){db.exec('ROLLBACK');throw error}
  }
  return rows.length
}
