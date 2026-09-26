import type { Hono, MiddlewareHandler } from 'hono'
import type { Db } from './db.js'
import { initializeMembershipSchema } from './membership-schema.js'
import { mountMembershipAuth, requireMember } from './membership-auth.js'
import { awardReview, canStartDiscordQuest, getMemberProfile, initMembershipQuests, mountMembershipQuestRoutes, onDiscordVerified, onMemberVerified, redeemInvite, reserveInvite } from './membership-quests.js'
import { mountMemberDiscord, discordReadiness, type MemberDiscordConfig } from './member-discord.js'
import { mountMemberResearch } from './member-research.js'
import { deliverMailBatch, enqueueMail, initMail, mailReady, type MailConfig } from './mail.js'
import { finalizeMemberDeletions, initMemberDeletion } from './member-deletion.js'

export interface MemberPlatformConfig {
  enabled?: boolean
  mail?: MailConfig
  discord?: MemberDiscordConfig
  researchKey?: string
  reviewKey?: string
  allowedProviders?: string[]
  allowedReviewModels?: string[]
  discordPublicKey?: string
  discordResearchChannelId?: string
  questDeadline?: string
}
export interface MemberRuntime {
  enabled: boolean
  auth: MiddlewareHandler
  tick: () => Promise<void>
}

/** Once members-only cutover occurs, a missing flag must never reopen public enrollment. */
export function membershipCutoverApplied(db: Db): boolean {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='membership_migrations'").get()) return false
  return Boolean(db.prepare("SELECT 1 FROM membership_migrations WHERE name='waitlist-bootstrap-v1'").get())
}

export function mountMemberPlatform(app: Hono, db: Db, config: MemberPlatformConfig = {}, now = Date.now): MemberRuntime {
  const enabled = config.enabled === true || membershipCutoverApplied(db)
  initializeMembershipSchema(db, now(), enabled)
  initMail(db)
  initMembershipQuests(db)
  initMemberDeletion(db)
  const emailConfigured = mailReady(config.mail)
  const discordConfigured = Boolean(config.discord && discordReadiness(config.discord).ready && emailConfigured)
  const researchConfigured = Boolean(config.researchKey && config.researchKey.length >= 32 && config.reviewKey && config.reviewKey.length >= 32 &&
    config.researchKey !== config.reviewKey && config.allowedProviders?.length && config.allowedReviewModels?.length)
  const auth = requireMember({ db, now, enabled }) as MiddlewareHandler
  mountMembershipAuth(app, {
    db, now, enabled, emailReady: emailConfigured, discordReady: discordConfigured,
    enqueueMail: mail => enqueueMail(db,mail,now()),
    validateInvite: (token,email) => reserveInvite(db,token,email,now()),
    onMemberCreated: (memberId,token) => redeemInvite(db,memberId,token,now()),
    onMemberVerified: memberId => onMemberVerified(db,memberId,now()),
  })
  mountMembershipQuestRoutes(app,{ db,now,requireMember:auth,questDeadline:config.questDeadline,
    readiness:{email:emailConfigured,discord:discordConfigured,research:researchConfigured} })
  const isActive = (id: number) => Boolean(db.prepare('SELECT 1 FROM members WHERE id=? AND disabled_at IS NULL AND verified_at IS NOT NULL').get(id))
  const discord = mountMemberDiscord(app, {
    db,now,requireMember:auth,isMemberActive:isActive,enqueueMail,canStartDiscordQuest,onDiscordVerified,
    config: config.discord ? { ...config.discord, enabled: enabled && emailConfigured && config.discord.enabled } : {
      enabled:false,clientId:'1553172093393440808',guildId:'1552864798889353218',
    },
  })
  mountMemberResearch(app, {
    db,now,auth,sharedKey: enabled ? config.researchKey : undefined,reviewSharedKey: enabled ? config.reviewKey : undefined,
    allowedProviders:config.allowedProviders,allowedReviewModels:config.allowedReviewModels,
    canSubmitResearch: id => isActive(id) && Boolean(db.prepare("SELECT 1 FROM discord_member_links WHERE member_id=? AND state='verified'").get(id)),
    awardReview: (input,authority) => {
      const result = awardReview(db,input,authority,now())
      if (!result.idempotent) {
        const member = db.prepare('SELECT user_id,email FROM members WHERE id=? AND disabled_at IS NULL').get(input.memberId) as { user_id:string;email:string } | undefined
        if (member) enqueueMail(db,{to:member.email,subject:'Your SAM research review is ready',
          text:`${member.user_id}, your research submission ${input.submissionId} has been reviewed.\n\nAward: ${input.points} points.\nReason: ${input.reason}\n\nYour profile shows the review and your current quest. A review is an assessment of the evidence, not a promise about market performance.`,
          kind:'research_review',dedupeKey:`research:${input.reviewId}`,memberId:input.memberId},now())
      }
      return result
    },
    ...(enabled && discordConfigured && config.discordPublicKey && config.discordResearchChannelId ? {discord:{
      publicKey:config.discordPublicKey,guildId:config.discord!.guildId,channelId:config.discordResearchChannelId,
      publicOrigin:config.discord!.publicOrigin,
      getMemberSummary:(id:number)=>{
        const profile=getMemberProfile(db,id,{questDeadline:config.questDeadline,now:now()})
        return {userId:profile.userId,rank:profile.research.rank,title:profile.research.title,points:profile.research.points,
          deadline:profile.countdown.deadline,collectibles:profile.collectibles}
      },
      getLinkedMember: (discordId:string) => db.prepare(`SELECT m.id FROM discord_member_links d JOIN members m ON m.id=d.member_id
        WHERE d.discord_user_id=? AND d.state='verified' AND m.disabled_at IS NULL AND m.verified_at IS NOT NULL`).get(discordId) as {id:number}|undefined,
    }} : {}),
  })
  let busy = false
  return {enabled,auth,async tick(){
    if (!enabled || busy) return
    busy=true
    try { await deliverMailBatch(db,config.mail ?? {},5); await discord.reconcile(10); finalizeMemberDeletions(db,now()) }
    finally {busy=false}
  }}
}
