/** Only return to a known project screen the signed-in user can still access. */
export function safeSettingsReturnTo(value:unknown, projectIds:readonly string[]):string {
  if(typeof value!=='string'||/[\\\u0000-\u001f]/.test(value)) return '/workspace';
  const match=value.match(/^\/projects\/([A-Za-z0-9_-]+)\/(overview|settings|plan|tasks|risks|analytics|workstreams)(?:\/[A-Za-z0-9_-]+)?(?:[?#].*)?$/);
  return match&&projectIds.includes(match[1]!)?value:'/workspace';
}
