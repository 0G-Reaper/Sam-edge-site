/** Browser installation identity, not a permanent physical hardware identifier. */
export interface MembershipStatus { enabled: boolean; emailReady: boolean; discordReady: boolean }
export interface AuthChallenge { challengeId: string; nonce: string; message: string }
export interface MemberIdentity { id: number; userId: string; email: string }
export interface AuthResult { ok: true; member: MemberIdentity; deviceId: string; sessionBinding: string }
export class MemberApiError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); this.name = 'MemberApiError' }
}
interface BrowserIdentity { privateKey: CryptoKey; publicKey: CryptoKey; label: string }
interface StoredChallenge { nonce: string; keyHash: string }
const DATABASE = 'sam-membership-device-v1'
const STORE = 'credentials'
const encoder = new TextEncoder()
let identityPromise: Promise<BrowserIdentity> | undefined

function openStore(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DATABASE, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(STORE)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(new Error('This browser could not store a secure device credential. Enable site storage to continue.'))
  })
}
async function readStore<T>(key: string): Promise<T | undefined> {
  const db = await openStore()
  try {
    return await new Promise<T | undefined>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly')
      const req = tx.objectStore(STORE).get(key)
      req.onsuccess = () => resolve(req.result as T | undefined)
      req.onerror = () => reject(req.error)
    })
  } finally { db.close() }
}
async function writeStore(key: string, value: unknown): Promise<void> {
  const db = await openStore()
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).put(value, key)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
      tx.onabort = () => reject(tx.error)
    })
  } finally { db.close() }
}
async function installIdentity(candidate: BrowserIdentity): Promise<BrowserIdentity> {
  const db = await openStore()
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite'), store = tx.objectStore(STORE)
      const read = store.get('identity')
      let selected = candidate
      read.onsuccess = () => {
        if (read.result) selected = read.result as BrowserIdentity
        else store.put(candidate, 'identity')
      }
      tx.oncomplete = () => resolve(selected)
      tx.onerror = () => reject(tx.error)
      tx.onabort = () => reject(tx.error)
    })
  } finally { db.close() }
}
function browserIdentity(): Promise<BrowserIdentity> {
  if (identityPromise) return identityPromise
  identityPromise = (async () => {
    if (!window.isSecureContext || !crypto.subtle || !window.indexedDB) throw new Error('A secure browser with local site storage is required to sign in.')
    const loadOrCreate = async () => {
      const existing = await readStore<BrowserIdentity>('identity')
      if (existing) return existing
      const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify'])
      const ua = navigator.userAgent
      const platform = /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Windows/.test(ua) ? 'Windows' : /Mac/.test(ua) ? 'Mac' : 'Computer'
      const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'browser'
      const identity = { privateKey: pair.privateKey, publicKey: pair.publicKey, label: `${platform} · ${browser}` }
      return installIdentity(identity)
    }
    // Serializes first-time creation across tabs; browsers without Web Locks still use IndexedDB.
    return navigator.locks ? navigator.locks.request('sam-membership-device-create', loadOrCreate) : loadOrCreate()
  })().catch(error => { identityPromise = undefined; throw error })
  return identityPromise
}
function base64url(bytes: ArrayBuffer | Uint8Array): string {
  return btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
async function hash(text: string): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(text)))].map(b => b.toString(16).padStart(2, '0')).join('')
}
async function sign(identity: BrowserIdentity, value: string): Promise<string> {
  return base64url(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, identity.privateKey, encoder.encode(value)))
}
async function decode<T>(response: Response): Promise<T> {
  let value: { message?: string; error?: string }
  try { value = await response.json() } catch { throw new MemberApiError(response.status, 'invalid_response', 'The server could not complete this request. Try again later.') }
  if (!response.ok) throw new MemberApiError(response.status, value.error ?? 'request_failed', value.message ?? 'The request could not be completed.')
  return value as T
}
export async function getMembershipStatus(): Promise<MembershipStatus> {
  return decode(await fetch('/api/membership/status', { credentials: 'same-origin', cache: 'no-store' }))
}
export async function startMembershipAuth(input: { mode: 'login' | 'signup'; email: string; userId?: string; inviteToken?: string }): Promise<AuthChallenge> {
  const identity = await browserIdentity()
  const exported = await crypto.subtle.exportKey('jwk', identity.publicKey)
  const publicKey = { kty: 'EC', crv: 'P-256', x: exported.x!, y: exported.y! }
  const keyHash = await hash(JSON.stringify({ crv: publicKey.crv, kty: publicKey.kty, x: publicKey.x, y: publicKey.y }))
  const challenge = await decode<AuthChallenge>(await fetch(`/api/membership/${input.mode}`, {
    method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: input.email.trim().toLowerCase(), ...(input.userId ? { userId: input.userId.trim().replace(/^@+/, '') } : {}), ...(input.inviteToken ? { inviteToken: input.inviteToken } : {}), publicKey, deviceLabel: identity.label }),
  }))
  await writeStore(`challenge:${challenge.challengeId}`, { nonce: challenge.nonce, keyHash } satisfies StoredChallenge)
  return challenge
}
export async function verifyMembershipAuth(input: { challengeId: string; code: string }): Promise<AuthResult> {
  const identity = await browserIdentity()
  const challenge = await readStore<StoredChallenge>(`challenge:${input.challengeId}`)
  if (!challenge) throw new MemberApiError(400, 'challenge_missing', 'Request a fresh code from this browser.')
  const code = input.code.replace(/\s/g, '')
  const signature = await sign(identity, ['SAM-VERIFY-v1', input.challengeId, challenge.nonce, code, challenge.keyHash].join('\n'))
  const result = await decode<AuthResult>(await fetch('/api/membership/verify', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ challengeId: input.challengeId, code, signature }) }))
  await writeStore('session-binding', result.sessionBinding)
  return result
}
/** Each authenticated request signs its exact method, path, body, timestamp and fresh nonce. */
export async function memberFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const url = new URL(path, window.location.origin)
  if (url.origin !== window.location.origin || !url.pathname.startsWith('/api/')) throw new Error('Member requests must use the SAM API on this site.')
  const identity = await browserIdentity()
  const sessionBinding = await readStore<string>('session-binding')
  if (!sessionBinding) throw new MemberApiError(401, 'unauthorized', 'Please sign in from a registered browser.')
  const method = (init.method ?? 'GET').toUpperCase()
  if (init.body && typeof init.body !== 'string') throw new Error('Member request bodies must be JSON strings.')
  const body = typeof init.body === 'string' ? init.body : ''
  const timestamp = String(Date.now())
  const nonce = base64url(crypto.getRandomValues(new Uint8Array(18)))
  const signature = await sign(identity, ['SAM-MEMBER-v1', sessionBinding, method, url.pathname + url.search, await hash(body), timestamp, nonce].join('\n'))
  const headers = new Headers(init.headers)
  if (body && !headers.has('content-type')) headers.set('content-type', 'application/json')
  headers.set('x-sam-timestamp', timestamp)
  headers.set('x-sam-nonce', nonce)
  headers.set('x-sam-signature', signature)
  headers.set('x-sam-session', sessionBinding)
  return decode(await fetch(url.pathname + url.search, { ...init, method, headers, credentials: 'same-origin', cache: 'no-store' }))
}
export async function logoutMember(): Promise<void> {
  await memberFetch('/api/membership/logout', { method: 'POST' })
  // Retain the key: logging out must not manufacture a third installation on the next login.
}
