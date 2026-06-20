# Sat-Weather
Using Apple's satellite SMS capability to implement basic automated weather queries for use in the field as a river guide

## SMS Commands

```text
help
wx help
ask help
rv help
wx tdy town prov
wx tmr town prov
wx wk town prov
wx tdy utm grid easting northing
wx tmr utm grid easting northing
wx wk utm grid easting northing
rv river prov
ask question
askp question
cont
```

Examples:

```text
help
wx help
wx tdy ottawa on
wx tmr algonquin park on
wx wk vancouver bc
wx tdy utm 17T 630084 4833438
rv help
rv lower madawaska on
ask help
ask habs game score
askp habs game score
cont
```

Named places are geocoded, then converted to a weather forecast. UTM input is converted directly in the Worker and is usually the better option when working from a map in remote areas.

Today and tomorrow return a day summary plus period breakdowns for overnight, morning, midday, afternoon, evening, and night. Week returns a compact daily summary.

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
