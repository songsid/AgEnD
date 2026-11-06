// Hub PR A (#3226): this script moved to /assets/chat-render.js (src/ui/shared/), shared by the fleet and the Hub. A tab opened
// before the move still imports it from here for its effect (the global it sets): the same module, once.
import "/assets/chat-render.js";
