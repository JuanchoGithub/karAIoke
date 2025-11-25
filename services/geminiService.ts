import { GoogleGenAI, Type } from "@google/genai";
import { SongData, SearchResult } from "../types";

// We use Gemini here because we cannot analyze YouTube audio directly in the browser due to CORS/DRM.
// Gemini "hallucinates" a playable karaoke chart based on its knowledge of the song.
// We use Google Search Grounding to fetch accurate lyrics ("Mixmatch" style) before generating the chart.

const getAi = () => {
  if (!process.env.API_KEY) {
    throw new Error("API Key is missing");
  }
  return new GoogleGenAI({ apiKey: process.env.API_KEY });
};

/**
 * Step 1: Search for the official lyrics using Google Search Grounding.
 * This prevents "hallucinated" lyrics.
 */
async function fetchLyrics(title: string, artist: string): Promise<string> {
  const ai = getAi();
  const prompt = `Find the full official lyrics for the song "${title}" by "${artist}". Return the lyrics as plain text. Do not include analysis, just the lyrics.`;
  
  try {
    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: prompt,
      config: {
        tools: [{ googleSearch: {} }],
        // Note: responseSchema and responseMimeType are NOT allowed when using googleSearch
      }
    });
    return response.text || "";
  } catch (e) {
    console.warn("Failed to fetch lyrics via search, falling back to model knowledge", e);
    return "";
  }
}

export const searchYoutubeSongs = async (query: string): Promise<SearchResult[]> => {
  const ai = getAi();
  
  const prompt = `
    Search for 5 distinct "Karaoke" or "Instrumental" videos on YouTube for the song "${query}".
    Prefer high-quality karaoke channels like Sing King, KaraFun, or similar.
    
    Return a JSON array of objects with title, artist, videoId, and channelName.
    The videoId must be a valid 11-character YouTube ID.
  `;

  const response = await ai.models.generateContent({
    model: "gemini-2.5-flash",
    contents: prompt,
    config: {
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          properties: {
             title: { type: Type.STRING },
             artist: { type: Type.STRING },
             videoId: { type: Type.STRING, description: "11 character YouTube ID" },
             channelName: { type: Type.STRING }
          },
          required: ["title", "artist", "videoId"]
        }
      }
    }
  });

  const text = response.text;
  if (!text) throw new Error("No response from AI");

  try {
    return JSON.parse(text) as SearchResult[];
  } catch (e) {
    console.error("Failed to parse Search Results", e);
    return [];
  }
};

export const generateSongChart = async (song: SearchResult): Promise<SongData> => {
  // 1. Fetch accurate lyrics first
  const realLyrics = await fetchLyrics(song.title, song.artist);

  // 2. Generate the chart using the lyrics as context
  const ai = getAi();

  const prompt = `
    Create a rhythm game chart for the song "${song.title}" by "${song.artist}".
    We are using the YouTube video ID: "${song.videoId}".

    ${realLyrics ? `IMPORTANT: Use the following lyrics as the strict source of truth for the chart:\n---\n${realLyrics}\n---\n` : ''}

    The chart should contain the main vocal melody as a sequence of notes.
    
    IMPORTANT: 
    - The 'notes' array must represent the melody.
    - 'start' is in seconds from the beginning of the video.
    - 'duration' is in seconds.
    - 'pitch' is the MIDI note number (Middle C = 60). Average male vocal range 40-60, female 55-75.
    - 'lyric' is the word or syllable being sung at that moment. Ensure lyrics match the rhythm.
    
    Make the chart roughly 1-2 minutes long or the full length if possible. Keep it rhythmic.
    Set difficulty based on the complexity of the melody.
  `;

  const response = await ai.models.generateContent({
    model: "gemini-2.5-flash",
    contents: prompt,
    config: {
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          title: { type: Type.STRING },
          artist: { type: Type.STRING },
          videoId: { type: Type.STRING },
          difficulty: { type: Type.STRING, enum: ["Easy", "Medium", "Hard"] },
          notes: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                startTime: { type: Type.NUMBER },
                duration: { type: Type.NUMBER },
                pitch: { type: Type.NUMBER },
                lyric: { type: Type.STRING }
              },
              required: ["startTime", "duration", "pitch"]
            }
          }
        },
        required: ["title", "artist", "videoId", "notes"]
      }
    }
  });

  const text = response.text;
  if (!text) throw new Error("No response from AI");

  try {
    const data = JSON.parse(text) as SongData;
    // Ensure we use the videoId we selected
    return { ...data, videoId: song.videoId }; 
  } catch (e) {
    console.error("Failed to parse AI response", e);
    throw new Error("Could not generate song data.");
  }
};