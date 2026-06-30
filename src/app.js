import { AskService, isContinue, parseAsk, parseAskPerplexity } from "./ask.js";
import { SPOT_SMS_LIMIT } from "./config.js";
import { fireReply } from "./fire.js";
import { GeminiService, parseGemini } from "./gemini.js";
import { HydroService, parseRiverCommand } from "./hydro.js";
import { ScratchBook } from "./scratchbook.js";
import { compactAscii, takeSmsChunk } from "./text.js";
import { weatherReply } from "./weather.js";

const SPOT_CONT_SUFFIX = " cont";

// SPOT-like gateways are detected after their first delivery failure and kept in a compact reply mode.
export async function handleMessage(message, env, from) {
  const scratchBook = new ScratchBook(env);
  await scratchBook.purgeOld();

  const deliveryFallback = await deliveryNoticeReply(message, scratchBook, from);
  if (deliveryFallback) {
    return deliveryFallback;
  }

  const constrained = await scratchBook.isConstrainedSender(from);
  const remember = async (reply) => prepareReply(reply, message, scratchBook, from, constrained);

  const help = helpReply(message);
  if (help) {
    return remember(help);
  }

  const askService = new AskService(env, scratchBook);
  if (isContinue(message)) {
    if (constrained) {
      return continueConstrainedReply(scratchBook, from);
    }

    return remember(await askService.continue(from));
  }

  const askp = parseAskPerplexity(message);
  if (askp) {
    return remember(await askService.answer(askp, from));
  }

  const ask = parseAsk(message);
  if (ask) {
    return remember(await new GeminiService(env, scratchBook).answer(ask, from));
  }

  const gemini = parseGemini(message);
  if (gemini) {
    return remember(await new GeminiService(env, scratchBook).answer(gemini, from));
  }

  const river = parseRiverCommand(message);
  if (river) {
    return remember(await new HydroService(env, scratchBook).answer(river));
  }

  const fire = await fireReply(message);
  if (fire) {
    return remember(fire);
  }

  const weather = await weatherReply(message);
  return remember(weather || unknownCommandText());
}

function helpText() {
  return "Cmds: wx, fx, rv, ask, askp, cont. Info: bot help; bot wx; bot fx; bot rv; bot ask.";
}

function unknownCommandText() {
  return "Unknown cmd. Try: bot help. Ex: wx tdy town prov; fx town prov; rv river prov; ask question; cont.";
}

function helpReply(message) {
  if (/^bot help$/i.test(message)) {
    return helpText();
  }

  if (/^(?:wx help|bot wx)$/i.test(message)) {
    return "WX: wx tdy/tmr/wk town prov, or wx tdy/tmr/wk [utm] zone easting northing. Ex: wx tdy ottawa on";
  }

  if (/^(?:fx help|bot fx)$/i.test(message)) {
    return "FX: fx town prov, or fx [utm] zone easting northing. Official source coverage varies by province. Ex: fx algonquin park on";
  }

  if (/^(?:rv help|bot rv)$/i.test(message)) {
    return "RV: rv river prov, or rv gauge_id. Use section/town if known. Ex: rv lower madawaska on; rv upper petawawa on; rv 02KB001";
  }

  if (/^(?:(?:ask|askp|gemini) help|bot ask)$/i.test(message)) {
    return "ASK: ask question uses Gemini web search. askp question uses Perplexity. Send cont for the next saved chunk.";
  }

  return "";
}

// Store the full response for recovery, but transform replies for constrained satellite/SMS senders.
async function prepareReply(reply, command, scratchBook, from, constrained) {
  await scratchBook.saveLastReply(from, reply);

  if (!constrained) {
    return reply;
  }

  return pageConstrainedReply(spotSafeSummary(reply, command), scratchBook, from);
}

// Delivery failure notices are inbound SMSes from the device service, not user commands.
async function deliveryNoticeReply(message, scratchBook, from) {
  if (!isDeliveryFailureNotice(message)) {
    return "";
  }

  await scratchBook.markConstrainedSender(from, "spot");
  const previous = await scratchBook.getLastReply(from);
  if (!previous) {
    return "Marked SPOT-safe. Prior reply failed/truncated; no saved copy. Try command again.";
  }

  return pageConstrainedReply(spotSafeSummary(previous, ""), scratchBook, from);
}

async function continueConstrainedReply(scratchBook, from) {
  const tail = await scratchBook.get(from);
  if (!tail) {
    return "No saved page. Try command again.";
  }

  return pageConstrainedReply(tail, scratchBook, from, false);
}

// Page compact replies through D1 so constrained devices can ask for the rest with cont.
async function pageConstrainedReply(text, scratchBook, from, condense = true) {
  const clean = condense ? spotSafeSummary(text, "") : compactAscii(text);
  const first = takeSmsChunk(clean, SPOT_SMS_LIMIT - SPOT_CONT_SUFFIX.length);
  const tail = clean.slice(first.length).trim();

  if (!tail) {
    await scratchBook.delete(from);
    return takeSmsChunk(clean, SPOT_SMS_LIMIT);
  }

  if (await scratchBook.save(from, tail)) {
    return `${first}${SPOT_CONT_SUFFIX}`;
  }

  return takeSmsChunk(clean, SPOT_SMS_LIMIT);
}

// Prefer command-aware summaries over blind character slicing; the final pager enforces the hard cap.
function spotSafeSummary(reply, command) {
  const clean = compactAscii(reply);
  return condenseGeneric(
    condenseWeather(clean)
    || condenseFire(clean)
    || condenseHelp(clean)
    || condenseUnknown(clean)
    || condenseAsk(clean, command)
    || clean,
  );
}

function condenseWeather(text) {
  const daily = text.match(/^([^:]+):\s+(Tdy|Tmr)\s+([^.]*)\.\s+Rain\s+([^.]*)\.\s+([\s\S]*?)\s+Wind\s+([^.]*)\.?$/i);
  if (daily) {
    const place = daily[1];
    const label = daily[2];
    const temp = daily[3];
    const rain = daily[4];
    const parts = daily[5].split(";").map((part) => part.trim()).filter(Boolean);
    const important = parts.filter((part) => !/\b0mm\b/i.test(part)).slice(0, 2);
    const extra = important.length ? ` ${important.join("; ")}.` : "";
    return `${place} ${label}: ${temp}. Rain ${rain}. Wind ${daily[6]}.${extra}`;
  }

  const week = text.match(/^([^:]+):\s+([\s\S]+)\.$/);
  if (week && /\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\b/.test(week[2])) {
    return `${week[1]} wk: ${week[2].split(";").slice(0, 4).map((part) => part.trim()).join("; ")}.`;
  }

  return "";
}

function condenseFire(text) {
  if (!/^\w{2}\s+/.test(text) || !/(fire|burn|restriction|ban|sopfeu|bcws|burnsafe|rfz)/i.test(text)) {
    return "";
  }

  return text
    .replace(/\.\s*(Local|Municipal|Municipal\/local|Local\/park)[^.]*apply\.?/gi, "")
    .replace(/official source coverage varies by province/gi, "coverage varies")
    .replace(/fire restrictions/gi, "fire")
    .replace(/prohibitions and restrictions/gi, "bans")
    .replace(/restrictions?/gi, "restr")
    .replace(/prohibited/gi, "ban")
    .replace(/allowed/gi, "ok");
}

function condenseHelp(text) {
  if (/^Cmds:/i.test(text)) {
    return "Cmds wx fx rv ask askp cont. Info bot wx/fx/rv/ask.";
  }

  if (/^WX:/i.test(text)) {
    return "WX wx tdy/tmr/wk town prov OR zone east north. Ex wx tdy ottawa on";
  }

  if (/^FX:/i.test(text)) {
    return "FX fx town prov OR zone east north. Ex fx algonquin park on";
  }

  if (/^RV:/i.test(text)) {
    return "RV rv river prov OR gauge_id. Ex rv lower madawaska on; rv 02KB001";
  }

  if (/^ASK:/i.test(text)) {
    return "ASK ask question. askp uses Perplexity. cont gets next page.";
  }

  return "";
}

function condenseUnknown(text) {
  if (!/^Unknown cmd/i.test(text)) {
    return "";
  }

  return "Unknown. Try bot help. Ex wx tdy town prov; fx town prov; rv river prov; ask q; cont.";
}

function condenseAsk(text, command) {
  if (!/^(ask|askp|gemini)\s+/i.test(command)) {
    return "";
  }

  const sentences = text.split(/(?<=[.!?])\s+/).filter(Boolean);
  return sentences.slice(0, 2).join(" ") || text;
}

function condenseGeneric(text) {
  return compactAscii(text)
    .replace(/\btemperature\b/gi, "temp")
    .replace(/\bprecipitation\b/gi, "precip")
    .replace(/\bafternoon\b/gi, "aft")
    .replace(/\bmidday\b/gi, "mid")
    .replace(/\bmorning\b/gi, "morn")
    .replace(/\bovernight\b/gi, "o/n")
    .replace(/\btonight\b/gi, "nite")
    .replace(/\bkilometres?\/hour\b/gi, "km/h")
    .replace(/\bUpdated\b/g, "Upd")
    .replace(/\s+([.,!?;:])/g, "$1")
    .replace(/;\s*$/g, ".")
    .trim();
}

// Match generic gateway failure language so Garmin/ZOLEO-like services can be learned too.
function isDeliveryFailureNotice(message) {
  const text = compactAscii(message).toLowerCase();
  const hasLengthProblem = text.includes("message sent was truncated")
    || text.includes("exceeds length limit")
    || text.includes("exceeded length limit")
    || text.includes("message too long")
    || text.includes("character limit")
    || text.includes("length limit");
  const hasDeliveryProblem = text.includes("truncated")
    || text.includes("not delivered")
    || text.includes("undelivered")
    || text.includes("delivery failed")
    || text.includes("unable to deliver")
    || text.includes("failed to deliver")
    || text.includes("failed/truncated");

  return text.includes("message") && hasLengthProblem && hasDeliveryProblem;
}
