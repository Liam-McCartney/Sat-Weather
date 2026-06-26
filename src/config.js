export const APP_VERSION = "2026-06-25-fx-adapters";

export const ASK_SMS_LIMIT = 306;
export const CONT_SUFFIX = " Reply cont";
export const SCRATCH_TTL_MS = 10 * 60 * 1000;

export const ASK_SYSTEM_PROMPT = [
  "You answer for a satellite SMS bot used when the sender has poor or no data service.",
  "Use current web info when relevant and synthesize it into a useful direct answer.",
  "Reply in plain ASCII text, usually 2 to 4 short sentences and under 650 characters.",
  "Give the answer first. No markdown, citations, links, emojis, smart punctuation, or preambles.",
  "If uncertain, say so briefly and give the most useful next check.",
].join(" ");

export const PERPLEXITY_GATEWAY_URL = "https://gateway.ai.cloudflare.com/v1/0220c3a82e8c2874e60132409274661c/sat-weather/perplexity-ai/chat/completions";
export const GEMINI_GATEWAY_URL = "https://gateway.ai.cloudflare.com/v1/0220c3a82e8c2874e60132409274661c/sat-weather-gemini/google-ai-studio/v1/models/gemini-2.5-flash:generateContent";
