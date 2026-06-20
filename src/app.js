import { AskService, isContinue, parseAsk } from "./ask.js";
import { GeminiService, parseGemini } from "./gemini.js";
import { HydroService, parseRiverCommand } from "./hydro.js";
import { ScratchBook } from "./scratchbook.js";
import { weatherReply } from "./weather.js";

export async function handleMessage(message, env, from) {
  const scratchBook = new ScratchBook(env);
  await scratchBook.purgeOld();

  if (/^(wx\s+)?help$/i.test(message)) {
    return helpText();
  }

  const askService = new AskService(env, scratchBook);
  if (isContinue(message)) {
    return askService.continue(from);
  }

  const ask = parseAsk(message);
  if (ask) {
    return askService.answer(ask, from);
  }

  const gemini = parseGemini(message);
  if (gemini) {
    return new GeminiService(env, scratchBook).answer(gemini, from);
  }

  const river = parseRiverCommand(message);
  if (river) {
    return new HydroService(env, scratchBook).answer(river);
  }

  const weather = await weatherReply(message);
  return weather || "Use: wx tdy town prov | wx tdy utm zone easting northing";
}

function helpText() {
  return "Cmds: wx tdy/tmr/wk town prov; wx tdy utm zone easting northing; rv river prov; ask question; cont.";
}
