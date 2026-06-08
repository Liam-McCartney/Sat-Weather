# Sat-Weather
Using Apple's satellite SMS capability to implement basic automated weather queries for use in the field as a river guide

## SMS Commands

```text
wx tdy town prov
wx tmr town prov
wx wk town prov
wx tdy utm grid easting northing
wx tmr utm grid easting northing
wx wk utm grid easting northing
```

Examples:

```text
wx tdy ottawa on
wx tmr algonquin park on
wx wk vancouver bc
wx tdy utm 17T 630084 4833438
```

Named places are geocoded, then converted to a weather forecast. UTM input is converted directly in the Worker and is usually the better option when working from a map in remote areas.

Today and tomorrow return a day summary plus period breakdowns for overnight, morning, midday, afternoon, evening, and night. Week returns a compact daily summary.
