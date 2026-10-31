import type { Extractor } from "../extractor.js";
import { archiveExtractor as zipArchiveExtractor } from "./archive.js";
import { csvExtractor, jsonExtractor, xmlExtractor } from "./data.js";
import { officeExtractor, pdfExtractor } from "./documents.js";
import { archiveExtractor, checksumVerifier, crossrefCorroboration, dnsExtractor, githubExtractor, huggingFaceExtractor, packageRegistryExtractor, tlsExtractor } from "./enrich.js";
import { htmlExtractor } from "./html.js";
import { isoBmffExtractor } from "./isobmff.js";
import { ocrExtractor } from "./ocr.js";
import { httpExtractor } from "./http.js";
import { audioVideoExtractor, imageExtractor } from "./media.js";
import { emailExtractor, privacyExtractor, textExtractor } from "./text.js";
import { textIntelligenceExtractor } from "./text-intel.js";

/**
 * Extractor plugin registry. To add a format: implement `Extractor`
 * (see ../extractor.ts), declare kinds + categories, and append it here.
 */
export const EXTRACTORS: Extractor[] = [
  httpExtractor,
  htmlExtractor,
  imageExtractor,
  audioVideoExtractor,
  isoBmffExtractor,
  ocrExtractor,
  pdfExtractor,
  officeExtractor,
  jsonExtractor,
  csvExtractor,
  xmlExtractor,
  textExtractor,
  emailExtractor,
  zipArchiveExtractor,
  privacyExtractor,
  textIntelligenceExtractor,
  dnsExtractor,
  tlsExtractor,
  archiveExtractor,
  checksumVerifier,
  githubExtractor,
  huggingFaceExtractor,
  packageRegistryExtractor,
  crossrefCorroboration,
];
