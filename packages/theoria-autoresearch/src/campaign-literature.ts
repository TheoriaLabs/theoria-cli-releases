export interface LiteratureResponse { url: string; text: string; truncated: boolean }
const hosts = new Set(['arxiv.org', 'www.arxiv.org', 'export.arxiv.org']);

/** Bounded arXiv-only retrieval. Redirects are rechecked and raw HTML is kept out of the agent context. */
export async function fetchLiterature(url: string, timeoutSeconds: number, maxBytes: number, signal?: AbortSignal): Promise<LiteratureResponse> {
  const combined = AbortSignal.any([AbortSignal.timeout(timeoutSeconds * 1000), ...(signal ? [signal] : [])]);
  for (let redirects = 0; redirects <= 3; redirects++) {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || !hosts.has(parsed.hostname) || parsed.username || parsed.password || (parsed.port && parsed.port !== '443')) throw new Error('Literature retrieval supports HTTPS arXiv URLs only.');
    const response = await fetch(url, { signal: combined, redirect: 'manual', headers: { Accept: 'application/atom+xml,text/html,text/plain', 'User-Agent': 'Theoria-autoresearch/1.0' } });
    if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
      await response.body?.cancel(); url = new URL(response.headers.get('location')!, url).href; continue;
    }
    if (!response.ok) { await response.body?.cancel(); throw new Error(`arXiv returned HTTP ${response.status}.`); }
    if (response.headers.get('content-type')?.includes('application/pdf')) { await response.body?.cancel(); throw new Error('Use an arXiv abstract or HTML URL; PDF extraction is not available.'); }
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Empty literature response.');
    const chunks: Uint8Array[] = []; let bytes = 0; let truncated = false;
    try {
      for (;;) {
        const { value, done } = await reader.read(); if (done) break;
        const left = maxBytes - bytes;
        chunks.push(value.subarray(0, left)); bytes += Math.min(value.length, left);
        if (value.length >= left) { truncated = true; await reader.cancel(); break; }
      }
    } finally { reader.releaseLock(); }
    const raw = Buffer.concat(chunks).toString('utf8');
    const text = raw.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
      .replace(/<\/?(?:entry|title|summary|abstract|p|div|h[1-6]|section|li)\b[^>]*>/gi, '\n')
      .replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/[\t ]+/g, ' ').replace(/\n\s*\n/g, '\n').trim();
    return { url, text, truncated };
  }
  throw new Error('Too many literature redirects.');
}

export const literatureQueryUrl = (query: string) => {
  if (!query.trim() || query.length > 500) throw new Error('Literature query must contain 1–500 characters.');
  return `https://export.arxiv.org/api/query?${new URLSearchParams({ search_query: `all:${query}`, start: '0', max_results: '5' })}`;
};
