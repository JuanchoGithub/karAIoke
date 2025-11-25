import { GoogleGenAI, Type } from "@google/genai";
import { SongData, SearchResult } from "../types";

// We use Gemini here because we cannot analyze YouTube audio directly in the browser due to CORS/DRM.
// Gemini "hallucinates" a playable karaoke chart based on its knowledge of the song.

const getAi = () => {
  if (!process.env.API_KEY) {
    throw new Error("API Key is missing");
  }
  return new GoogleGenAI({ apiKey: process.env.API_KEY });
};

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
  const ai = getAi();

  const prompt = `
    Create a rhythm game chart for the song "${song.title}" by "${song.artist}".
    We are using the YouTube video ID: "${song.videoId}".

    The chart should contain the main vocal melody as a sequence of notes.
    
    IMPORTANT: 
    - The 'notes' array must represent the melody.
    - 'start' is in seconds from the beginning of the video.
    - 'duration' is in seconds.
    - 'pitch' is the MIDI note number (Middle C = 60). Average male vocal range 40-60, female 55-75.
    - 'lyric' is the word or syllable being sung at that moment.
    
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
    // Ensure we use the videoId we selected, even if AI hallucinated a different one (though prompt says use it)
    return { ...data, videoId: song.videoId }; 
  } catch (e) {
    console.error("Failed to parse AI response", e);
    throw new Error("Could not generate song data.");
  }
};