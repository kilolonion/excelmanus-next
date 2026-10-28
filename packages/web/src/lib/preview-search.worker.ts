import { createPreviewLineSearch } from "./preview-line-search";
import { createTextLines } from "./text-lines";

type Request = { type: "init"; content: string } | { type: "search"; id: number; query: string };
const scope = self as unknown as {
  onmessage: (event: MessageEvent<Request>) => void;
  postMessage: (result: { id: number; matches: Uint32Array }, transfer: Transferable[]) => void;
};
let search = createPreviewLineSearch([]);
scope.onmessage = (event: MessageEvent<Request>) => {
  const request = event.data;
  if (request.type === "init") search = createPreviewLineSearch(createTextLines(request.content));
  else {
    // Transfer a separate compact view; keep the worker's candidates for the next query.
    const matches = Uint32Array.from(search(request.query));
    scope.postMessage({ id: request.id, matches }, [matches.buffer]);
  }
};
