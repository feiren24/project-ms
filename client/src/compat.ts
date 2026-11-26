// Public HTTP origins do not expose randomUUID, but still provide secure random bytes.
// This module is evaluated before any application module creates request IDs.
export function uuidV4(): `${string}-${string}-${string}-${string}-${string}` {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 15) | 64;
  bytes[8] = (bytes[8]! & 63) | 128;
  const hex = Array.from(bytes, value => value.toString(16).padStart(2,'0')).join('');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}
if (typeof crypto.randomUUID !== 'function') Object.defineProperty(crypto, 'randomUUID', {value:uuidV4, configurable:true});
