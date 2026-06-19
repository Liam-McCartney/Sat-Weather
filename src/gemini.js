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

    const payload = this.payload(question);
    const gateway = await this.callGemini(GEMINI_GATEWAY_URL, cleanKey, payload);
    if (!gateway.ok) {
      const direct = await this.callGemini(GEMINI_DIRECT_URL, cleanKey, payload);
      if (!direct.ok) {
        return `Gemini unavailable: gw ${gateway.status} ${gateway.error}; direct ${direct.status} ${direct.error}`;
      }

      return this.formatResponse(direct.data);
    }

    return this.formatResponse(gateway.data);
  }

  async callGemini(url, apiKey, payload) {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: payload,
    });

    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        error: await shortProviderError(response),
      };
    }

    return {
      ok: true,
      data: await response.json(),
    };
  }

  payload(question) {
    return JSON.stringify({
        systemInstruction: {
          parts: [
            {
              text: ASK_SYSTEM_PROMPT,
            },
          ],
        },
        contents: [
          {
            role: "user",
            parts: [
              {
                text: question,
              },
            ],
          },
        ],
        generationConfig: {
          maxOutputTokens: 120,
          temperature: 0,
        },
    });
  }

  formatResponse(data) {
    const text = data.candidates?.[0]?.content?.parts
      ?.map((part) => part.text || "")
      .join(" ") || "No answer returned.";
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

const GEMINI_DIRECT_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent";
