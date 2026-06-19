export const APP_VERSION = "2026-06-19-aig-perplexity";

export const ASK_SMS_LIMIT = 306;
export const CONT_SUFFIX = " Reply cont";
export const SCRATCH_TTL_MS = 10 * 60 * 1000;

export const ASK_SYSTEM_PROMPT = [
  "You answer for a satellite SMS bot used when the sender has poor or no data service.",
  "Reply in plain ASCII text under 306 characters, ideally under 250.",
  "Use current web info when relevant.",
  "Give the answer first. No markdown, citations, links, emojis, smart punctuation, preambles, or caveats unless safety-critical.",
  "If uncertain, say so briefly and give the most useful next check.",
].join(" ");

export const PERPLEXITY_GATEWAY_URL = "https://gateway.ai.cloudflare.com/v1/0220c3a82e8c2874e60132409274661c/sat-weather/perplexity-ai/chat/completions";
