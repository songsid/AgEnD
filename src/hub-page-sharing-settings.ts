/** One raw leaf; no Hub runtime or second consent database is mounted by this Settings read. */
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==="object"&&!Array.isArray(value);
export function hubPageSharingSettings(raw:unknown):{enabled:boolean} {
  if(!object(raw))throw Error("invalid_hub_page_sharing");
  const member=Object.hasOwn(raw,"hub_member")?raw.hub_member:undefined;
  if(member!==undefined&&!object(member))throw Error("invalid_hub_page_sharing");
  const enabled=member&&Object.hasOwn(member,"share_from_hub")?member.share_from_hub:undefined;
  if(enabled!==undefined&&typeof enabled!=="boolean")throw Error("invalid_hub_page_sharing");
  return {enabled:enabled!==false};
}
export function parseHubPageSharing(input:unknown):{enabled:boolean} {
  if(!object(input)||Object.keys(input).length!==1||!Object.hasOwn(input,"enabled")||typeof input.enabled!=="boolean")throw Error("invalid_hub_page_sharing");
  return {enabled:input.enabled};
}
