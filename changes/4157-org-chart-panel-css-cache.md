---
section: Changed
---
- Web dashboard: the Fleet org chart and the panels' own stylesheets are faster over a slow link, and the browser keeps them too (#4157 follow-up). The org chart's route worker, the Office pictures and the stylesheets a panel adds when it opens are now cached until the next update, like the rest of the app. The route worker's files are requested together instead of one after another. In a test with 150 ms of latency per request, the org chart's lines were all drawn after 1.5 s instead of 2.3 s, and after 1.0 s instead of 1.5 s when the chart was opened again. A tab left open across an update never gets a newer stylesheet.
