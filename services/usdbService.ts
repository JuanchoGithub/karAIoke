import { SearchResult } from '../types';

/**
 * Search USDB using the Vercel Python API.
 * The API returns objects containing artist, title, and the full TXT content.
 */
export async function searchUsdb(query: string): Promise<SearchResult[]> {
  try {
    const res = await fetch('/api/usdb-search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query })
    });

    if (!res.ok) {
        throw new Error(`API error: ${res.status}`);
    }

    const data = await res.json();
    
    // The Python API returns { artist, title, txt }[]
    if (Array.isArray(data)) {
        return data.map((item: any, idx: number) => ({
            title: item.title,
            artist: item.artist,
            videoId: '', // Will be extracted from txt later
            id: `usdb-api-${idx}-${Date.now()}`, // Synthetic ID for React keys
            source: 'USDB',
            txt: item.txt
        }));
    }
    return [];
  } catch (e) {
    console.error("USDB Search failed", e);
    return [];
  }
}

/**
 * Legacy support: Originally used to fetch content from scraped ID.
 * Since the new API provides TXT in the search result, this is largely unused
 * unless specific legacy IDs are passed.
 */
export async function fetchUsdbContent(id: string): Promise<{ txt: string, extraVideoId?: string, extraCoverUrl?: string }> {
    return { txt: '' };
}

// Deprecated
export async function fetchUsdbTxt(id: string): Promise<string | null> {
    return null;
}