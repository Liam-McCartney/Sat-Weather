import { AskService, isContinue, parseAsk, parseAskPerplexity } from "./ask.js";
import { fireReply } from "./fire.js";
import { GeminiService, parseGemini } from "./gemini.js";
import { HydroService, parseRiverCommand } from "./hydro.js";
import { ScratchBook } from "./scratchbook.js";
import { weatherReply } from "./weather.js";

export async function handleMessage(message, env, from) {
  const scratchBook = new ScratchBook(env);
  await scratchBook.purgeOld();

  const help = helpReply(message);
  if (help) {
    return help;
  }

  const askService = new AskService(env, scratchBook);
  if (isContinue(message)) {
    return askService.continue(from);
  }

  const askp = parseAskPerplexity(message);
  if (askp) {
    return askService.answer(askp, from);
  }

  const ask = parseAsk(message);
  if (ask) {
    return new GeminiService(env, scratchBook).answer(ask, from);
  }

  const gemini = parseGemini(message);
  if (gemini) {
    return new GeminiService(env, scratchBook).answer(gemini, from);
  }

  const river = parseRiverCommand(message);
  if (river) {
    return new HydroService(env, scratchBook).answer(river);
  }

  const fire = await fireReply(message);
  if (fire) {
    return fire;
  }

  const weather = await weatherReply(message);
  return weather || unknownCommandText();
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
