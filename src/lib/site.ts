export interface SiteConfig {
  instagram?: string
  discord?: string
}

export function readSiteConfig(): SiteConfig {
  try {
    const el = document.getElementById('site-config')
    if (!el?.textContent) return {}
    const v = JSON.parse(el.textContent) as unknown
    if (!v || typeof v !== 'object') return {}
    const o = v as Record<string, unknown>
    return {
      instagram: typeof o.instagram === 'string' && o.instagram ? o.instagram : undefined,
      discord: typeof o.discord === 'string' && o.discord ? o.discord : undefined,
    }
  } catch {
    return {}
  }
}
