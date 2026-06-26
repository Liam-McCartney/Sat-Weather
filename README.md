# Sat-Weather
Using Apple's satellite SMS capability to implement basic automated weather queries for use in the field as a river guide

## SMS Commands

```text
bot help
bot wx
bot fx
bot ask
bot rv
wx tdy town prov
wx tmr town prov
wx wk town prov
wx tdy utm grid easting northing
wx tmr utm grid easting northing
wx wk utm grid easting northing
wx tdy grid easting northing
fx town prov
fx utm grid easting northing
fx grid easting northing
rv river prov
rv gauge_id
ask question
askp question
cont
```

Examples:

```text
bot help
bot wx
wx tdy ottawa on
wx tmr algonquin park on
wx wk vancouver bc
wx tdy utm 17T 630084 4833438
wx tdy 17T 630084 4833438
bot fx
fx algonquin park on
fx utm 17T 630084 4833438
fx 17T 630084 4833438
bot rv
rv lower madawaska on
rv 02KB001
bot ask
ask habs game score
askp habs game score
cont
```

Named places are geocoded, then converted to a weather forecast. UTM input is converted directly in the Worker and is usually the better option when working from a map in remote areas. The `utm` keyword is optional for UTM input, so both `wx tdy utm 17T ...` and `wx tdy 17T ...` work.

Today and tomorrow return a day summary plus period breakdowns for overnight, morning, midday, afternoon, evening, and night. Week returns a compact daily summary.

## Fire Restrictions

The `fx` command checks fire restriction sources for a town/province or UTM coordinate:

```text
fx town prov
fx utm grid easting northing
fx grid easting northing
```

Examples:

```text
fx algonquin park on
fx halifax ns
fx 17T 630084 4833438
```

Fire-ban data is uneven across Canada. The bot uses official sources where possible and replies conservatively when an adapter is not wired yet.

Current adapter groups:

```text
api/map-style: AB, MB, ON
full html scrape: NB, NL, NS, PE
unique/in-between: BC, QC, SK, YT, NT, NU
```

Ontario currently scrapes the official provincial forest fire page for Restricted Fire Zone status. Nova Scotia currently scrapes the BurnSafe county table. Other provinces and territories have source-aware stubs that identify the likely official source class but do not yet perform a location-specific lookup.

## River Levels

The `rv` command returns the latest Hydro Canada realtime river reading. It is intended for quick flow checks over SMS:

```text
rv river prov
rv gauge_id
```

Examples:

```text
rv lower madawaska on
rv upper petawawa on
rv ottawa britannia on
rv 02KB001
rv 02kb001
```

Gauge ID lookup is direct and case-insensitive. If you already know the Hydro station number, use `rv gauge_id`; no province is needed.

Named river lookup requires a province or territory so the fuzzy search has a sane search area. Bordering provinces and territories are included automatically, since rivers do not always respect political lines.

River replies prioritize discharge in cubic metres per second (`m3/s`) and include level in metres when Hydro provides it. If a river name is ambiguous, the bot suggests candidate station names and IDs. If local fuzzy matching is not decisive, Gemini is used as a fallback to interpret paddling section names like upper, mid, and lower against web context, but it can only choose from official Hydro candidates.

## Ask Commands

The `ask` command uses Gemini with Google Search grounding for short web-grounded answers. Configure the API key as a Cloudflare Worker secret:

```powershell
npx wrangler secret put GEMINI_API_KEY
```

The `askp` command uses Perplexity Sonar as an alternate web answer path. Configure the API key as a Cloudflare Worker secret:

```powershell
npx wrangler secret put PERPLEXITY_API_KEY
```

Both `ask` and `askp` save overflow text to the same scratchbook. Send `cont` to get the next chunk.
