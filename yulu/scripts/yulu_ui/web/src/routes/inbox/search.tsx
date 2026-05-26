import { Placeholder } from "../../components/Placeholder.js";

export const handle = { breadcrumb: "Inbox / Search", filters: null };

export function Search() {
  // search.run requires a query; we just render the placeholder without firing a real query.
  return <Placeholder phase="C" backendNote="search.run available; UI deferred to Phase C" />;
}
