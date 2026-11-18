// M-3311 (2): this module moved to /assets/chat-quote.js (src/ui/shared/), shared by the fleet and the Hub (a Hub conversation
// quotes a selected passage too). A tab opened before the move still imports it from here: the same module (one instance), re-exported.
export * from "/assets/chat-quote.js";
