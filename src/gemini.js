// Gemini-backed ask path used for grounded web answers and river gauge disambiguation.
import { ASK_SMS_LIMIT, ASK_SYSTEM_PROMPT, CONT_SUFFIX, GEMINI_GATEWAY_URL } from "./config.js";
import { cleanAskText, compactAscii, limitSms, takeSmsChunk } from "./text.js";

export class GeminiService {
  constructor(env, scratchBook) {
    this.env = env;
    this.scratchBook = scratchBook;
  }

  // Entry point for ask/gemini: grounded Gemini answer, ASCII cleanup, then D1-backed paging.
  async answer(question, from) {
    const cleanKey = String(this.env?.GEMINI_API_KEY || "").trim();
    if (!cleanKey) {
      return "Gemini not configured. Add GEMINI_API_KEY as a Cloudflare Worker secret.";
    }

    const data = await this.callGemini(question, cleanKey, {
      grounding: true,
      maxOutputTokens: 700,
    });
    const text = this.extractText(data);
    return this.chunkReply(from, cleanAskText(text || "No answer returned."));
  }

  // Gemini can be verbose; save overflow so cont can retrieve it.
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

  // Try Cloudflare AI Gateway first, then direct native Gemini, then OpenAI-compatible Gemini.
  async callGemini(question, apiKey, options = {}) {
    const nativePayload = this.nativePayload(question, options);
    const gateway = await this.callGeminiNative(GEMINI_GATEWAY_URL, apiKey, nativePayload);
    if (gateway.ok) {
      return gateway.data;
    }

    const direct = await this.callGeminiNative(GEMINI_DIRECT_URL, apiKey, nativePayload);
    if (direct.ok) {
      return direct.data;
    }

    const compat = await this.callGeminiCompat(apiKey, question, options);
    if (compat.ok) {
      return compat.data;
    }

    throw new Error(
      `Gemini unavailable: gateway ${gateway.status} ${gateway.error}; native ${direct.status} ${direct.error}; compat ${compat.status} ${compat.error}`
    );
  }

  // Compatibility endpoint is a last resort when native Gemini calls fail.
  async callGeminiCompat(apiKey, question, options = {}) {
    const response = await fetch(GEMINI_OPENAI_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gemini-3.5-flash",
        max_tokens: options.maxOutputTokens || 700,
        temperature: 0,
        messages: [
          {
            role: "system",
            content: options.systemPrompt || ASK_SYSTEM_PROMPT,
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

  // Native call wrapper keeps gateway and direct Google calls on the same response shape.
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

  // Native Gemini payload is required for Google Search grounding.
  nativePayload(question, options = {}) {
    const payload = {
      systemInstruction: {
        parts: [
          {
            text: options.systemPrompt || ASK_SYSTEM_PROMPT,
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
        maxOutputTokens: options.maxOutputTokens || 700,
        responseMimeType: "text/plain",
        temperature: 0,
      },
    };

    if (options.grounding) {
      payload.tools = [
        {
          google_search: {},
        },
      ];
    }

    return JSON.stringify(payload);
  }

  // Handles both OpenAI-compatible and native Gemini response formats.
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

// gemini is kept as a diagnostic/manual command alongside ask.
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
