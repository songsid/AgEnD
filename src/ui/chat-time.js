// Hub PR A (#3226): this module moved to /assets/chat-time.js (src/ui/shared/), shared by the fleet and the Hub. A tab opened
// before the move still imports it from here: the same module (one instance), re-exported.
export * from "/assets/chat-time.js";
