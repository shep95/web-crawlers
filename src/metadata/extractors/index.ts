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
import { ebmlExtractor } from "./ebml.js";
import { epubExtractor } from "./epub.js";
import { geoExtractor } from "./geo.js";
import { opaqueBinaryExtractor, scientificExtractor } from "./scientific.js";
import { configExtractor, dataLinesExtractor, packageManifestExtractor, sourceCodeExtractor } from "./structured.js";
import { streamManifestExtractor, subtitleExtractor } from "./timed-media.js";
import { webArchiveExtractor } from "./web-archive.js";

/**
 * Extractor plugin registry. To add a format: implement `Extractor`
 * (see ../extractor.ts), declare kinds (or detected `formats`, see ../formats.ts)
 * + categories, add/refresh the format's entry in ../formats.ts, and append it here.
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
  webArchiveExtractor,
  subtitleExtractor,
  streamManifestExtractor,
  ebmlExtractor,
  scientificExtractor,
  opaqueBinaryExtractor,
  geoExtractor,
  epubExtractor,
  dataLinesExtractor,
  configExtractor,
  packageManifestExtractor,
  sourceCodeExtractor,
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
