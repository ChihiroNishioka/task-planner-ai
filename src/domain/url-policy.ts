import { BlockList, isIP } from 'node:net';

const blocked4 = new BlockList();
for (const [address, prefix] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.88.99.0',24],['192.168.0.0',16],['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',4],['240.0.0.0',4]] satisfies [string,number][]) blocked4.addSubnet(address,prefix,'ipv4');
blocked4.addAddress('168.63.129.16','ipv4');
const public6 = new BlockList(); public6.addSubnet('2000::',3,'ipv6');
const blocked6 = new BlockList();
for (const [address,prefix] of [['2001::',32],['2001:2::',48],['2001:10::',28],['2001:20::',28],['2001:db8::',32],['2002::',16],['3fff::',20]] satisfies [string,number][]) blocked6.addSubnet(address,prefix,'ipv6');
export function isBlockedAddress(address: string): boolean {
  const family = isIP(address);
  return family === 4 ? blocked4.check(address,'ipv4') : family === 6 ? !public6.check(address,'ipv6') || blocked6.check(address,'ipv6') : true;
}
export function validateUrl(input: string): URL {
  if (input.length > 2048) throw new UrlPolicyError('BLOCKED_URL_FORM');
  let url:URL;try{url=new URL(input);}catch{throw new UrlPolicyError('BLOCKED_URL_FORM');}
  if (!['http:','https:'].includes(url.protocol) || url.username || url.password || (url.port && !['80','443'].includes(url.port))) throw new UrlPolicyError('BLOCKED_URL_FORM');
  const hostname = url.hostname.replace(/^\[|\]$/g,'').replace(/\.$/,'').toLowerCase();
  if (isIP(hostname)) { if(isBlockedAddress(hostname)) throw new UrlPolicyError('BLOCKED_ADDRESS'); }
  else if (!hostname.includes('.') || ['localhost','local','internal','intranet','lan','home','corp','home.arpa','ts.net','metadata.goog'].some(name=>hostname===name || hostname.endsWith(`.${name}`))) throw new UrlPolicyError('BLOCKED_ADDRESS');
  return url;
}

export class UrlPolicyError extends Error {
  constructor(readonly reason:'BLOCKED_ADDRESS'|'BLOCKED_URL_FORM') { super('BLOCKED_URL'); }
}
