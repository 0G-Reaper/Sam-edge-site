import { describe, expect, it } from 'vitest'
import { openDb } from '../server/db.js'
import { deliverMailBatch, enqueueMail, mailReady } from '../server/mail.js'

describe('transactional member mail', () => {
  const input = { to: 'member@example.com', subject: 'Welcome', text: 'Your quest', kind: 'welcome', dedupeKey: 'welcome:1' }
  it('persists once, sends with stable idempotency, and distinguishes acceptance from delivery', async () => {
    const db = openDb(':memory:')
    enqueueMail(db,input,1000); enqueueMail(db,input,1000)
    const calls: RequestInit[] = []
    const fetchImpl = (async (_url: unknown, init: RequestInit) => { calls.push(init); return Response.json({id:'mail-1'}) }) as typeof fetch
    const result = await deliverMailBatch(db,{enabled:true,apiKey:'test',from:'sam@example.com',now:()=>1100,fetchImpl})
    expect(result.accepted).toBe(1)
    expect(calls).toHaveLength(1)
    const row = db.prepare('SELECT state,body,provider_id FROM member_email_outbox').get()
    expect(row).toEqual({state:'accepted',body:'',provider_id:'mail-1'})
  })
  it('retries uncertain delivery with the same provider idempotency key',async()=>{
    const db=openDb(':memory:'); enqueueMail(db,input,1000)
    const keys:string[]=[]; let now=1100
    const config={enabled:true,apiKey:'test',from:'sam@example.com',now:()=>now,fetchImpl:(async (_u:unknown,init:RequestInit)=>{
      keys.push((init.headers as Record<string,string>)['Idempotency-Key']!); throw new Error('network')
    }) as typeof fetch}
    await deliverMailBatch(db,config); now=20_000; await deliverMailBatch(db,config)
    expect(keys).toHaveLength(2);expect(keys[0]).toBe(keys[1])
    expect((db.prepare('SELECT state FROM member_email_outbox').get() as {state:string}).state).toBe('queued')
  })
  it('does not send expired verification or mail when transport is disabled',async()=>{
    const db=openDb(':memory:');enqueueMail(db,{...input,kind:'login_code'},1000)
    let calls=0
    const config={enabled:true,apiKey:'test',from:'sam@example.com',now:()=>1_000_000,fetchImpl:(async()=>{calls++;return Response.json({id:'x'})}) as typeof fetch}
    await deliverMailBatch(db,config)
    expect(calls).toBe(0)
    expect(mailReady({...config,enabled:false})).toBe(false)
  })
  it('rolls back email alongside an enclosing membership operation',()=>{
    const db=openDb(':memory:');enqueueMail(db,input,1000)
    db.exec('BEGIN');enqueueMail(db,{...input,dedupeKey:'rollback'},1000);db.exec('ROLLBACK')
    expect(db.prepare('SELECT id FROM member_email_outbox').all()).toHaveLength(1)
  })
})
