// Perplexity-backed freeform ask command, with SMS-sized paging through ScratchBook.
import {
  APP_VERSION,
  ASK_SMS_LIMIT,
  ASK_SYSTEM_PROMPT,
  CONT_SUFFIX,
  PERPLEXITY_GATEWAY_URL,
} from "./config.js";
import { cleanAskText, compactAscii, compactText, limitSms, takeSmsChunk } from "./text.js";

export class AskService {
  constructor(env, scratchBook) {
    this.env = env;
    this.scratchBook = scratchBook;
  }

  async answer(question, from) {
    if (!this.env?.PERPLEXITY_API_KEY) {
      return "Ask not configured. Add PERPLEXITY_API_KEY as a Cloudflare Worker secret.";
    }

    const data = await this.callPerplexity(question);
    const text = data.choices?.[0]?.message?.content;
    return this.chunkReply(from, cleanAskText(text || "No answer returned."));
  }

  async continue(from) {
    const tail = await this.scratchBook.get(from);
    if (!tail) {
      return "No saved reply. Try ask again.";
    }

    const first = takeSmsChunk(tail, ASK_SMS_LIMIT - CONT_SUFFIX.length);
    const rest = tail.slice(first.length).trim();
    if (rest) {
      await this.scratchBook.save(from, rest);
      return `${first}${CONT_SUFFIX}`;
    }

    await this.scratchBook.delete(from);
    return first;
  }

  // Store overflow so the user can request the next page with cont.
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

  // Prefer the chat endpoint, then fall back to Perplexity search if chat fails.
  async callPerplexity(question) {
    const cleanKey = String(this.env?.PERPLEXITY_API_KEY || "").trim();
    const payload = this.perplexityPayload(question);
    const endpoint = await this.perplexityGatewayUrl();

    const response = await fetch(endpoint, {
      method: "POST",
      headers: this.perplexityHeaders(cleanKey),
      body: payload,
    });

    if (!response.ok) {
      const searchFallback = await this.callPerplexitySearch(question, cleanKey);
      if (searchFallback.ok) {
        return {
          choices: [{
            message: {
              content: searchFallback.text,
            },
          }],
        };
      }

      return {
        choices: [{
          message: {
            content: `Ask unavailable ${APP_VERSION}: chat ${response.status} ${await shortProviderError(response)}; search ${searchFallback.status} ${searchFallback.error}`,
          },
        }],
      };
    }

    return response.json();
  }

  async perplexityGatewayUrl() {
    if (this.env?.AI) {
      const baseUrl = await this.env.AI.gateway("sat-weather").getUrl("perplexity-ai");
      return `${baseUrl}/chat/completions`;
    }

    return PERPLEXITY_GATEWAY_URL;
  }

  perplexityPayload(question) {
    return JSON.stringify({
      model: "sonar-pro",
      max_tokens: 220,
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
    });
  }

  perplexityHeaders(apiKey) {
    return {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    };
  }

  async callPerplexitySearch(question, apiKey) {
    const payload = JSON.stringify({
      query: question,
      max_results: 3,
      search_context_size: "low",
    });

    const response = await fetch("https://api.perplexity.ai/search", {
      method: "POST",
      headers: {
        "Accept": "application/json",
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "User-Agent": "Sat-Weather/0.1",
      },
      body: new TextEncoder().encode(payload),
    });

    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        error: await shortProviderError(response),
      };
    }

    const data = await response.json();
    const results = data.results || [];
    if (!results.length) {
      return {
        ok: false,
        status: 200,
        error: "no results",
      };
    }

    return {
      ok: true,
      text: formatSearchResults(results),
    };
  }
}

export function parseAsk(message) {
  const match = message.match(/^(?:wx\s+)?ask\s+(.+)$/i);
  if (!match) {
    return null;
  }

  return match[1].trim();
}

export function parseAskPerplexity(message) {
  const match = message.match(/^(?:wx\s+)?askp\s+(.+)$/i);
  if (!match) {
    return null;
  }

  return match[1].trim();
}

export function isContinue(message) {
  return /^(?:wx\s+)?(?:cont|continue)$/i.test(message);
}

function formatSearchResults(results) {
  return results
    .slice(0, 2)
    .map((result, index) => {
      const title = compactText(result.title || `Result ${index + 1}`, 45);
      const snippet = compactText(result.snippet || "", 150);
      return snippet ? `${index + 1}) ${title}: ${snippet}` : `${index + 1}) ${title}`;
    })
    .join(" ");
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
