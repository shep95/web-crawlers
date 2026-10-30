import { C } from "../categories.js";
import type { ExtractionContext } from "../extractor.js";
import { clean } from "../normalize.js";

/**
 * Research-context mining over document text (PDF text layer, HTML body,
 * plain text): methodology, samples, populations, weighting, instruments,
 * calibration, accession numbers and retention statements. Each value is a
 * quoted source claim with the sentence it came from.
 */
export function mineResearchText(ctx: ExtractionContext, plain: string, where: string): void {
  if (!plain) return;
  const text = plain.slice(0, 400_000);
  const sentence = (re: RegExp) => clean(text.match(re)?.[0], 400);
  const m = (what: string) => ({ method: `${what} in ${where}` });
  const methods = sentence(/[^.]{0,80}\b(?:methodology|methods?|sampling (?:design|frame|method)|data collection)\b[^.]{0,300}\./i);
  if (methods) {
    ctx.add(C.statistical, "methodologyStatement", methods, m("methodology sentence"));
    ctx.add(C.scientific, "method", methods, m("methodology sentence"));
  }
  const sample = text.match(/\b(?:n\s*=\s*|sample size of\s*)([\d,]{2,9})/i)?.[1];
  if (sample) ctx.add(C.statistical, "sampleSize", Number(sample.replace(/,/g, "")), { ...m("sample size statement"), evidence: text.match(/.{0,60}(?:n\s*=\s*|sample size of\s*)[\d,]{2,9}.{0,40}/i)?.[0] });
  ctx.add(C.statistical, "population", sentence(/[^.]{0,120}\b(?:target population|population of interest|universe)\b[^.]{0,160}\./i), m("population sentence"));
  ctx.add(C.statistical, "weighting", sentence(/[^.]{0,120}\bweight(?:s|ed|ing)\b[^.]{0,160}\./i), m("weighting sentence"));
  ctx.add(C.device_sensor, "calibration", sentence(/[^.]{0,120}\bcalibrat\w*\b[^.]{0,160}\./i), m("calibration sentence"));
  ctx.add(C.device_sensor, "instrument", sentence(/[^.]{0,80}\b(?:instrument|sensor|gauge|spectrometer|radiometer|thermometer|anemometer)s?\b[^.]{0,120}\./i), m("instrument sentence"));
  ctx.add(C.administrative, "accessionNumber", text.match(/\baccession (?:no\.?|number)[:\s]+([A-Z0-9][A-Z0-9./-]{2,30})/i)?.[1], m("accession number"));
  // Funding acknowledgements ("This work was supported by the Department of Science and Technology under grant …").
  const funding = sentence(/[^.]{0,100}\b(?:funded|supported|sponsored|financed|financially supported)\s+(?:in part\s+)?by\b[^.]{3,220}\./i) ?? sentence(/[^.]{0,60}\b(?:grant|award)s?\b[^.]{0,120}\bfrom\s+(?:the\s+)?[A-Z][^.]{3,160}\./);
  if (funding) {
    ctx.add(C.business, "fundingStatement", funding, m("funding sentence"));
    const by = funding.match(/\b(?:by|from)\s+(?:the\s+)?((?:[A-Z][\w&'()-]*|of|for|and|on|&)(?:\s+(?:[A-Z][\w&'()-]*|of|for|and|on|&)){0,10})/);
    const name = by?.[1]?.replace(/\s+(?:of|for|and|on|&)$/, "").trim();
    if (name && /[A-Z]/.test(name) && name.split(/\s+/).length <= 12) ctx.add(C.business, "funder", clean(name, 160), { ...m("funder named in a funding sentence"), evidence: funding });
  }
  const lic = text.match(/(?:licensed under|license:|licence:)[^.]{0,120}\./i)?.[0];
  if (lic) ctx.add(C.rights, "rightsStatement", clean(lic, 200), m("licence sentence"));
}
