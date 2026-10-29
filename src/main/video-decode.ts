/** VideoToolbox silently drops/corrupts AVC camera frames outside its 8-bit
 * 4:2:0 path, sometimes with exit 0. Encoding to H.264 in hardware is safe;
 * this rule applies only to decoding originals, never to converted proxies. */
export function canVideoToolboxDecode(codec: string | undefined): boolean {
  return !/(?:h\.?264|avc)/i.test(codec ?? '') || !/(?:4:2:2|4:4:4|422|444|10[- ]?bit|12[- ]?bit|p10|p12|high\s*10)/i.test(codec ?? '');
}
