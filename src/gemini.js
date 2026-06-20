import { ASK_SMS_LIMIT, ASK_SYSTEM_PROMPT, CONT_SUFFIX, GEMINI_GATEWAY_URL } from "./config.js";
import { cleanAskText, compactAscii, limitSms, takeSmsChunk } from "./text.js";

export class GeminiService {
  constructor(env, scratchBook) {
    this.env = env;
    this.scratchBook = scratchBook;
  }

  async answer(question, from) {
    const cleanKey = String(this.env?.GEMINI_API_KEY || "").trim();
    if (!cleanKey) {
      return "Gemini not configured. Add GEMINI_API_KEY as a Cloudflare Worker secret.";
    }

    const data = await this.callGemini(question, cleanKey);
    const text = this.extractText(data);
    return this.chunkReply(from, cleanAskText(text || "No answer returned."));
  }

  async chunkReply(from, text) {
    const clean = compactAscii(text);
    const first = takeSmsChunk(clean, ASK_SMS_LIMIT - CONT_SUFFIX.length);
    const tail = clean.slice(first.length).trim();

    if (!tail) {
      await this.scratchBook.delete(from);
      return clean;
    }

    if (await this.scratchBook.save(from, tail)) {
      return `${first}${CONT_SUFFIX}`;
    }

    return takeSmsChunk(clean, ASK_SMS_LIMIT);
  }

  async callGemini(question, apiKey) {
    const compat = await this.callGeminiCompat(apiKey, question);
    if (compat.ok) {
      return compat.data;
    }

    const nativePayload = this.nativePayload(question);
    const gateway = await this.callGeminiNative(GEMINI_GATEWAY_URL, apiKey, nativePayload);
    if (gateway.ok) {
      return gateway.data;
    }

    const direct = await this.callGeminiNative(GEMINI_DIRECT_URL, apiKey, nativePayload);
    if (direct.ok) {
      return direct.data;
    }

    throw new Error(
      `Gemini unavailable: compat ${compat.status} ${compat.error}; gateway ${gateway.status} ${gateway.error}; native ${direct.status} ${direct.error}`
    );
  }

  async callGeminiCompat(apiKey, question) {
    const response = await fetch(GEMINI_OPENAI_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gemini-3.5-flash",
        max_tokens: 220,
        temperature: 0,
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

  async callGeminiNative(url, apiKey, payload) {
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

  nativePayload(question) {
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
        maxOutputTokens: 220,
        temperature: 0,
      },
    });
  }

  extractText(data) {
    const compatText = data.choices?.[0]?.message?.content;
    if (compatText) {
      return compatText;
    }

    const nativeText = data.candidates?.[0]?.content?.parts
      ?.map((part) => part.text || "")
      .join(" ");
    return nativeText || "";
  }
}

export function parseGemini(message) {
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
const GEMINI_OPENAI_URL = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";
