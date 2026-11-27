import { fromMarkdown } from "mdast-util-from-markdown";

export const VOICE_VOLUME_KEY = "aurion.voice.volume";

/** @param {string | null} saved */
export function restoreVoiceVolume(saved) {
  const volume = saved == null || !saved.trim() ? NaN : Number(saved);
  return Number.isInteger(volume) && volume >= 0 && volume <= 100 ? volume : 100;
}

const atomTypes = new Set(["code", "inlineCode", "link", "linkReference", "image", "imageReference", "emphasis", "strong", "html", "definition"]);
const endOfSentence = /[.!?…](?:[*_`]{1,3})?(?=\s)|\n/gu;
const fenceStart = /^[\t >-]*(?:[`]{3,}|~{3,})/u;

/** @typedef {import("mdast").Nodes} MarkdownNode */

/** @param {string} value */
function cleanText(value) {
  return value
    .replace(/\]\([^)]*(?:\)|$)/gu, " ")
    .replace(/(?:\bhttps?:\/\/|\bwww\.)[^\s<>]+/giu, " ")
    .replace(/[#*0-9]\uFE0F?\u20E3/gu, " ")
    .replace(/[\p{Extended_Pictographic}\p{Regional_Indicator}\p{Emoji_Modifier}\u200D\uFE0E\uFE0F\u20E3]/gu, " ")
    .replace(/[\u{E0020}-\u{E007F}]/gu, "")
    .replace(/[*_#`~\[\]{}|<>\\]/gu, " ");
}

/** @param {string} text */
function pause(text) {
  const trimmed = text.trim();
  return trimmed && !/[.!?…,:;]$/u.test(trimmed) ? `${trimmed}. ` : `${trimmed} `;
}

/** @param {MarkdownNode} node @returns {string} */
function spokenNode(node) {
  switch (node.type) {
    case "code": return " Há um bloco de código na resposta. ";
    case "html":
    case "definition":
    case "thematicBreak": return "";
    case "text":
    case "inlineCode": return cleanText(node.value);
    case "image":
    case "imageReference": return cleanText(node.alt ?? "");
    case "break": return " ";
    default: {
      const content = "children" in node ? node.children.map(spokenNode).join("") : "";
      return ["heading", "paragraph", "listItem"].includes(node.type) ? pause(content) : content;
    }
  }
}

/** @param {string} markdown */
export function prepareSpeech(markdown) {
  return spokenNode(fromMarkdown(markdown)).replace(/\s+/gu, " ").replace(/\s+([.!?,:;])/gu, "$1").trim();
}

/** @param {MarkdownNode} node @param {string} source @param {{start: number, end: number}[]} protectedRanges */
function protectMarkup(node, source, protectedRanges) {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  if (start == null || end == null) return;
  if (atomTypes.has(node.type)) {
    // Markdown parses an unfinished fence as a code node through the end of input.
    const raw = source.slice(start, end);
    const fence = raw.match(fenceStart)?.[0].trim().match(/[`]{3,}|~{3,}/u)?.[0];
    const closedFence = fence && raw.includes("\n")
      && new RegExp(`^[\\s>]*${fence[0]}{${fence.length},}\\s*$`, "u").test(raw.slice(raw.lastIndexOf("\n") + 1));
    protectedRanges.push({
      start,
      end: node.type === "code" && fence && !closedFence ? source.length + 1 : end,
    });
  } else if ("children" in node) {
    for (const child of node.children) protectMarkup(child, source, protectedRanges);
  }
}

/** @param {string} source @param {number} minimum */
function takeBoundary(source, minimum) {
  const tree = fromMarkdown(source);
  const ranges = /** @type {{start: number, end: number}[]} */ ([]);
  protectMarkup(tree, source, ranges);
  const candidates = [...source.matchAll(endOfSentence)].map((match) => match.index + match[0].length);
  if (source.length >= 240) {
    for (const match of source.matchAll(/\s+/gu)) {
      if (match.index >= 180) candidates.push(match.index);
    }
  }
  candidates.sort((a, b) => a - b);
  for (const offset of candidates) {
    if (offset < minimum || ranges.some(({ start, end }) => start < offset && offset < end)) continue;
    let plain = "";
    let start = 0;
    for (const span of ranges) {
      if (span.end > offset) break;
      plain += source.slice(start, span.start);
      start = span.end;
    }
    plain += source.slice(start, offset);
    // Wait for incomplete inline markup and URL fragments at the split point.
    if (/\[[^\]\n]*$|\]\([^)]*$|`[^`\n]*$|(?:\*\*|__)[^*_\n]*$|(?:https?:\/\/|www\.)\S+$/iu.test(plain)) continue;
    return offset;
  }
  return 0;
}

export class SpeechChunks {
  #pending = "";
  #first = true;

  /** @param {string} fragment @returns {string[]} */
  push(fragment) {
    this.#pending += fragment;
    const chunks = [];
    while (this.#pending.length >= (this.#first ? 24 : 75)) {
      if (this.#pending.length < 240 && !/[.!?…\n]/u.test(this.#pending)) break;
      const offset = takeBoundary(this.#pending, this.#first ? 24 : 75);
      if (!offset) break;
      const spoken = prepareSpeech(this.#pending.slice(0, offset));
      this.#pending = this.#pending.slice(offset);
      if (spoken) {
        chunks.push(spoken);
        this.#first = false;
      }
    }
    return chunks;
  }

  /** @returns {string[]} */
  finish() {
    const spoken = prepareSpeech(this.#pending);
    this.#pending = "";
    return spoken ? [spoken] : [];
  }
}
