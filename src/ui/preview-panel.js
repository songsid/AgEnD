// Hub E (#3226): the side panel moved to /assets/preview-panel.js (src/ui/shared/), shared by the fleet and the Hub. This
// is the fleet's: the same module (one instance), re-exported, plus the two pieces only the fleet shows — Files & changes
// (workspace-panel.js) and a page's Share (page-share-dialog.js) — registered with the core here. A tab opened before the
// move still imports this path, so it registers them too.
import { setWorkspaceView } from "/assets/preview-panel.js";
import { setShareButton } from "/assets/preview-panel-actions.js";
import { WorkspacePanel } from "./workspace-panel.js";
import { PageShareButton } from "./page-share-dialog.js";
setWorkspaceView(WorkspacePanel);
setShareButton(PageShareButton);
export * from "/assets/preview-panel.js";
