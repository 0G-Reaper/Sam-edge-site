/** Paths no visitor or crawler asks for: secret files, VCS metadata, server scripts and CMS admin panels. */
const PROBES = [
  /(^|\/)\.(env|git|aws|ssh|svn|hg|htaccess|htpasswd|s3cfg|npmrc|vscode|DS_Store)/i,
  /\.(php\d?|aspx?|jsp|cgi|sql|bak|pem|key)(\/|$)/i,
  /(^|\/)(wp-admin|wp-login|wp-content|wp-includes|xmlrpc|phpmyadmin|phpinfo|cgi-bin)/i,
]

export function isProbe(path: string): boolean {
  let decoded = path
  try {
    decoded = decodeURIComponent(path)
  } catch {
    // malformed escapes: match the raw path
  }
  return PROBES.some((re) => re.test(decoded))
}

/** Keys blocked until a deadline. In memory, so a redeploy clears it. */
export class BanList {
  private until = new Map<string, number>()

  constructor(
    private readonly ms: number,
    private readonly maxKeys = 20_000,
  ) {}

  add(key: string, now: number): void {
    this.until.delete(key)
    this.until.set(key, now + this.ms)
    if (this.until.size > this.maxKeys) {
      const oldest = this.until.keys().next().value
      if (oldest !== undefined) this.until.delete(oldest)
    }
  }

  has(key: string, now: number): boolean {
    const deadline = this.until.get(key)
    if (deadline === undefined) return false
    if (deadline > now) return true
    this.until.delete(key)
    return false
  }
}

export type SecurityLog = (event: string, fields: Record<string, string>) => void

/** One JSON line per event; Railway indexes it as a structured warning, searchable as "security:". */
export const logSecurityEvent: SecurityLog = (event, fields) => {
  console.warn(JSON.stringify({ level: 'warn', message: `security: ${event}`, ...fields }))
}
