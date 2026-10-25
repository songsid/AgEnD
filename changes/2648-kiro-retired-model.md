---
section: Fixed
---
- **A kiro instance whose saved conversation uses a model kiro has retired no longer reports "Model unavailable" on every start (#2648).** For an instance with no model of its own (none on the instance and none set as the fleet default), AgEnD now checks the model saved in the conversation it resumes. If kiro no longer offers that model, the instance resumes the same conversation on kiro's default model, and says so once in its topic. If AgEnD could not tell in advance, the first "Model unavailable" restarts the instance once on the default. An instance that is configured to use the unavailable model is never switched: it is told once to pick another model, instead of on every start.
