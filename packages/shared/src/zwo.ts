import { XMLParser } from 'fast-xml-parser';
import { WorkoutSchema, type Step, type Workout } from './workout.js';

export class ZwoParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZwoParseError';
  }
}

/**
 * One node of fast-xml-parser's preserveOrder output:
 * `{ tagName: [childNodes], ':@': { '@_attr': value } }`. Children are always
 * arrays and text content appears as `{ '#text': string }` entries, so same-
 * named siblings stay separate nodes and document order is preserved exactly
 * as written in the XML.
 */
type XmlNode = Record<string, unknown>;

function isNode(value: unknown): value is XmlNode {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The element tag a node carries (the single key besides ':@'). */
function tagNameOf(node: XmlNode): string {
  for (const key of Object.keys(node)) {
    if (key !== ':@') return key;
  }
  return '';
}

/** Direct child nodes of an element, in document order. */
function childrenOf(node: XmlNode): XmlNode[] {
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) return value.filter(isNode);
  }
  return [];
}

/** First direct child element with the given tag. */
function findChild(parent: XmlNode, tag: string): XmlNode | undefined {
  return childrenOf(parent).find((child) => tagNameOf(child) === tag);
}

/** First element with the given tag anywhere under nodes, depth-first. */
function findElement(nodes: XmlNode[], tag: string): XmlNode | undefined {
  for (const node of nodes) {
    if (tagNameOf(node) === tag) return node;
    const found = findElement(childrenOf(node), tag);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** Concatenated text of the first direct child element with the given tag. */
function textOfChild(parent: XmlNode, tag: string): string {
  const child = findChild(parent, tag);
  if (child === undefined) return '';
  let text = '';
  for (const part of childrenOf(child)) {
    const value = part['#text'];
    if (typeof value === 'string') text += value;
  }
  return text;
}

/** Read a numeric attribute; NaN when absent or non-numeric. */
function attrNum(el: XmlNode, name: string): number {
  const attrs = isNode(el[':@']) ? el[':@'] : null;
  const raw = attrs !== null ? attrs[`@_${name}`] : undefined;
  return typeof raw === 'number' ? raw : Number(raw);
}

/**
 * Duration attributes may carry float noise from the Zwift editor
 * (e.g. Duration="180.00002"); round to whole seconds. Power fractions are
 * intentionally left unrounded.
 */
function attrSeconds(el: XmlNode, name: string): number {
  const seconds = attrNum(el, name);
  return Number.isFinite(seconds) ? Math.round(seconds) : seconds;
}

const SUPPORTED_TAGS: Record<string, true> = {
  SteadyState: true,
  Warmup: true,
  Cooldown: true,
  Ramp: true,
  IntervalsT: true,
  FreeRide: true,
};

function elementToStep(tag: string, el: XmlNode): Step | null {
  switch (tag) {
    case 'SteadyState': {
      const seconds = attrSeconds(el, 'Duration');
      const targetPctFtp = attrNum(el, 'Power');
      if (!Number.isFinite(seconds) || !Number.isFinite(targetPctFtp)) return null;
      return { kind: 'steady', seconds, targetPctFtp };
    }
    // Warmup/Cooldown/Ramp all map literally: PowerLow -> fromPctFtp, PowerHigh -> toPctFtp.
    case 'Warmup':
    case 'Cooldown':
    case 'Ramp': {
      const seconds = attrSeconds(el, 'Duration');
      const fromPctFtp = attrNum(el, 'PowerLow');
      const toPctFtp = attrNum(el, 'PowerHigh');
      if (!Number.isFinite(seconds) || !Number.isFinite(fromPctFtp) || !Number.isFinite(toPctFtp)) {
        return null;
      }
      return { kind: 'ramp', seconds, fromPctFtp, toPctFtp };
    }
    case 'IntervalsT': {
      const repeats = attrNum(el, 'Repeat') || 1;
      const onSeconds = attrSeconds(el, 'OnDuration');
      const offSeconds = attrSeconds(el, 'OffDuration');
      const onPower = attrNum(el, 'OnPower');
      const offPower = attrNum(el, 'OffPower');
      if (
        !Number.isFinite(onSeconds) ||
        !Number.isFinite(offSeconds) ||
        !Number.isFinite(onPower) ||
        !Number.isFinite(offPower)
      ) {
        return null;
      }
      return {
        kind: 'interval',
        repeats,
        on: { seconds: onSeconds, targetPctFtp: onPower },
        off: { seconds: offSeconds, targetPctFtp: offPower },
      };
    }
    case 'FreeRide': {
      const seconds = attrSeconds(el, 'Duration');
      if (!Number.isFinite(seconds)) return null;
      return { kind: 'free', seconds };
    }
    default:
      return null;
  }
}

/**
 * Consume the <workout> children in document order, mapping supported tags
 * to steps. In preserveOrder output each child is the element node itself:
 * `{ tagName: [childNodes], ':@': { '@_attr': value } }`.
 */
function parseWorkoutElements(workoutNode: XmlNode): Step[] {
  const steps: Step[] = [];
  const unsupported: string[] = [];
  for (const child of childrenOf(workoutNode)) {
    const tag = tagNameOf(child);
    if (tag === '#text') continue;
    if (SUPPORTED_TAGS[tag] !== true) {
      unsupported.push(tag);
      continue;
    }
    const step = elementToStep(tag, child);
    if (step === null) {
      throw new ZwoParseError(`Malformed <${tag}> element: missing or non-numeric required attributes`);
    }
    steps.push(step);
  }
  if (steps.length === 0) {
    throw new ZwoParseError(
      unsupported.length > 0
        ? `No supported workout elements in ZWO file (unsupported: ${unsupported.join(', ')})`
        : 'No supported workout elements in ZWO file',
    );
  }
  return steps;
}

function parseTags(tagsNode: XmlNode | undefined): string[] {
  if (tagsNode === undefined) return [];
  const tags: string[] = [];
  for (const child of childrenOf(tagsNode)) {
    if (tagNameOf(child) !== 'tag') continue;
    const attrs = isNode(child[':@']) ? child[':@'] : null;
    const name = attrs !== null ? attrs['@_name'] : undefined;
    // String() coercion keeps numeric-looking tags (<tag name="2024"/>) that
    // parseAttributeValue turned into numbers.
    if (name === undefined) continue;
    const text = String(name);
    if (text.length > 0) tags.push(text);
  }
  return tags;
}

function slugify(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug.length > 0 ? slug : 'workout';
}

/** FNV-1a 32-bit hash of a string (browser-safe — no node builtins). */
function fnv1a32(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Parse a Zwift .zwo workout file into our internal Workout format.
 * Elements are consumed in document order; power attributes are FTP
 * fractions (0.0-1.5+) stored as-is while durations are rounded to whole
 * seconds. Unsupported elements are skipped; ZwoParseError is thrown when
 * no supported element exists or the XML has no <workout> node. The result
 * is always WorkoutSchema-valid (schema parse throws on invalid files).
 */
export function parseZwo(xml: string): Workout {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    parseAttributeValue: true,
    parseTagValue: false,
    preserveOrder: true,
  });
  let doc: unknown;
  try {
    doc = parser.parse(xml);
  } catch (err) {
    throw new ZwoParseError(`Invalid ZWO XML: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!Array.isArray(doc)) {
    throw new ZwoParseError('No <workout> node found in ZWO XML');
  }

  const first = doc.length > 0 ? doc[0] : null;
  const root = findElement(doc, 'workout_file') ?? (isNode(first) ? first : null);
  const rawName = root !== null ? textOfChild(root, 'name') : '';
  const name = rawName.length > 0 ? rawName : 'Imported Workout';
  const description = root !== null ? textOfChild(root, 'description') : '';
  const tags = root !== null ? parseTags(findChild(root, 'tags')) : [];

  const workoutNode = findElement(doc, 'workout');
  if (workoutNode === undefined) {
    throw new ZwoParseError('No <workout> node found in ZWO XML');
  }

  const id = `${slugify(name)}-${fnv1a32(xml).toString(16).padStart(8, '0')}`;
  return WorkoutSchema.parse({ id, name, description, tags, steps: parseWorkoutElements(workoutNode) });
}
