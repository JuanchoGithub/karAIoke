import { SearchResult } from '../types';

// Proxy to bypass CORS.
const PROXY_BASE = 'https://api.allorigins.win/raw?url=';
const USDB_BASE = 'https://usdb.animux.de';

/**
 * Parses the HTML list from USDB search to find songs.
 */
function parseUsdbList(html: string): SearchResult[] {
  const results: SearchResult[] = [];
  
  // Regex to find rows with onclick="show_detail(ID)"
  const rowRegex = /<tr[^>]*onclick="show_detail\((\d+)\)"[^>]*>([\s\S]*?)<\/tr>/g;
  let match;

  while ((match = rowRegex.exec(html)) !== null) {
    const id = match[1];
    const rowContent = match[2];

    // Extract table cells
    const tds = rowContent.match(/<td[^>]*>([\s\S]*?)<\/td>/g);
    
    if (tds && tds.length >= 2) {
        // Strip HTML tags from content
        const clean = (s: string) => s.replace(/<[^>]+>/g, '').trim();
        
        const artist = clean(tds[0]);
        const title = clean(tds[1]);
        
        // Simple validation to ensure we got something valid
        if (artist && title) {
            results.push({
                id,
                artist,
                title,
                videoId: '', // Will be parsed from TXT later
                source: 'USDB'
            });
        }
    }
  }
  
  return results.slice(0, 15);
}

export async function searchUsdb(query: string): Promise<SearchResult[]> {
  const searchUrl = `${USDB_BASE}/index.php?link=list&keyword=${encodeURIComponent(query)}&limit=30`;
  const proxyUrl = `${PROXY_BASE}${encodeURIComponent(searchUrl)}`;

  try {
    const response = await fetch(proxyUrl);
    const html = await response.text();
    return parseUsdbList(html);
  } catch (e) {
    console.error("USDB Search failed", e);
    return [];
  }
}

/**
 * Fetches the detail page and extracts TXT content + Metadata (Video ID, Cover)
 */
export async function fetchUsdbContent(id: string): Promise<{ txt: string, extraVideoId?: string, extraCoverUrl?: string }> {
    const detailUrl = `${USDB_BASE}/index.php?link=detail&id=${id}`;
    const proxyUrl = `${PROXY_BASE}${encodeURIComponent(detailUrl)}`;

    try {
        const response = await fetch(proxyUrl);
        const html = await response.text();
        
        let txt = '';
        let extraVideoId = '';
        let extraCoverUrl = '';

        // 1. Try to find the YouTube Video ID in the HTML (iframe or link)
        // Look for standard youtube embed
        const ytMatch = html.match(/youtube\.com\/embed\/([a-zA-Z0-9_-]{11})/);
        if (ytMatch && ytMatch[1].length === 11) {
            extraVideoId = ytMatch[1];
        } else {
            // Look for data-video-id or similar patterns sometimes used in USDB comments
            const ytLinkMatch = html.match(/youtube\.com\/watch\?v=([a-zA-Z0-9_-]{11})/);
            if (ytLinkMatch && ytLinkMatch[1].length === 11) {
                extraVideoId = ytLinkMatch[1];
            } else {
                // Look for youtu.be shortlinks
                const ytShortMatch = html.match(/youtu\.be\/([a-zA-Z0-9_-]{11})/);
                if (ytShortMatch && ytShortMatch[1].length === 11) extraVideoId = ytShortMatch[1];
            }
        }

        // 2. Try to find Cover Image in the HTML
        // USDB detail pages often show the cover image with a specific class or structure
        const imgMatch = html.match(/src="([^"]+)"[^>]*class="cover"/i) || html.match(/src="([^"]+(?:jpg|png|jpeg))"[^>]*width="300"/i);
        if (imgMatch) {
            let url = imgMatch[1];
            if (url.startsWith('http')) {
                extraCoverUrl = url;
            } else {
                // Handle relative URLs
                extraCoverUrl = `${USDB_BASE}/${url}`;
            }
        }

        // 3. Extract TXT content
        // Attempt A: Textarea (Edit view or raw view)
        const textAreaMatch = html.match(/<textarea[^>]*>([\s\S]*?)<\/textarea>/);
        if (textAreaMatch && textAreaMatch[1].includes('#TITLE')) {
             txt = textAreaMatch[1]
                .replace(/&amp;/g, '&')
                .replace(/&lt;/g, '<')
                .replace(/&gt;/g, '>');
        }
        
        // Attempt B: Pre tag
        if (!txt) {
            const preMatch = html.match(/<pre[^>]*>([\s\S]*?)<\/pre>/);
            if (preMatch && preMatch[1].includes('#TITLE')) {
                 txt = preMatch[1]
                    .replace(/&amp;/g, '&')
                    .replace(/&lt;/g, '<')
                    .replace(/&gt;/g, '>');
            }
        }

        // Attempt C: 'Get TXT' link fallback (if public)
        if (!txt) {
            try {
                const txtUrl = `${USDB_BASE}/index.php?link=gettxt&id=${id}`;
                const txtProxy = `${PROXY_BASE}${encodeURIComponent(txtUrl)}`;
                const txtResp = await fetch(txtProxy);
                const rawTxt = await txtResp.text();
                if (rawTxt.includes('#TITLE') && !rawTxt.includes('<html')) {
                    txt = rawTxt;
                }
            } catch (err) {
                console.warn("Failed to fetch raw txt endpoint", err);
            }
        }

        return { txt, extraVideoId, extraCoverUrl };

    } catch (e) {
        console.error("USDB Content fetch failed", e);
        return { txt: '', extraVideoId: '' };
    }
}

// Deprecated: kept for compatibility if needed, but fetchUsdbContent is preferred
export async function fetchUsdbTxt(id: string): Promise<string | null> {
    const data = await fetchUsdbContent(id);
    return data.txt || null;
}