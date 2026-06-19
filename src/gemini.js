import { ASK_SMS_LIMIT, ASK_SYSTEM_PROMPT, GEMINI_GATEWAY_URL } from "./config.js";
import { cleanAskText, limitSms, takeSmsChunk } from "./text.js";

export class GeminiTestService {
  constructor(env) {
    this.env = env;
  }

  async answer(question) {
    const cleanKey = String(this.env?.GEMINI_API_KEY || "").trim();
    if (!cleanKey) {
      return "Gemini not configured. Add GEMINI_API_KEY as a Cloudflare Worker secret.";
    }

    const response = await fetch(GEMINI_GATEWAY_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${cleanKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gemini-3.5-flash",
        max_tokens: 120,
        messages: [
          {
            role: "system",
            content: ASK_SYSTEM_PROMPT,
          },
          {
            role: "user",
            content: question,
          },
        ],
      }),
    });

    if (!response.ok) {
      return `Gemini unavailable: ${response.status} ${await shortProviderError(response)}`;
    }

    const data = await response.json();
    const text = data.choices?.[0]?.message?.content || "No answer returned.";
    return takeSmsChunk(cleanAskText(text), ASK_SMS_LIMIT);
  }
}

export function parseGeminiTest(message) {
  const match = message.match(/^(?:wx\s+)?gemini\s+(.+)$/i);
  if (!match) {
    return null;
  }

  return match[1].trim();
}

async function shortProviderError(response) {
  const body = await response.text();
  try {
    const parsed = JSON.parse(body);
    return limitSms(parsed.error?.message || parsed.message || body, 160);
  } catch {
    return limitSms(body, 160);
  }
}
