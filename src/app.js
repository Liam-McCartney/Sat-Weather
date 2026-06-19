import { AskService, isContinue, parseAsk } from "./ask.js";
import { GeminiTestService, parseGeminiTest } from "./gemini.js";
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

  const gemini = parseGeminiTest(message);
  if (gemini) {
    return new GeminiTestService(env).answer(gemini);
  }

  const weather = await weatherReply(message);
  return weather || "Use: wx tdy town prov | wx tdy utm zone easting northing";
}

function helpText() {
  return "Cmds: wx tdy/tmr/wk town prov; wx tdy utm zone easting northing; ask question; gemini question; cont.";
}
