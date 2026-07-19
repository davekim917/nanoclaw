import { basename, extname } from 'node:path';

import { readVerifiedSource } from './discovery.js';

export interface GraphNode {
  id: string;
  type: string;
  name: string;
  sourcePath: string;
  line?: number;
  properties?: Record<string, unknown>;
}

export interface GraphEdge {
  id: string;
  type: string;
  source: string;
  target: string;
  sourcePath: string;
  line?: number;
  properties?: Record<string, unknown>;
}

export interface StructuralExtraction {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

interface DiscoveredSourceLike {
  id: string;
  workgroupId: string;
  relativePath: string;
  absolutePath: string;
  kind: 'code' | 'document' | 'conversation' | 'structured' | 'image' | 'media';
  bytes: number;
  mtimeMs: number;
  sha256: string;
  state: 'pending' | 'indexed' | 'metadata_only' | 'quarantined' | 'failed' | 'deleted';
  stateReason?: string;
  metadata?: Record<string, unknown>;
}

function nodeId(sourcePath: string, type: string, name: string): string {
  return `${sourcePath}#${type}:${name}`;
}

function edgeId(sourcePath: string, type: string, source: string, target: string, line?: number): string {
  return `${sourcePath}#${type}:${source}->${target}${line ? `:${line}` : ''}`;
}

function addNode(nodes: GraphNode[], node: GraphNode): GraphNode {
  const existing = nodes.find((candidate) => candidate.id === node.id);
  if (existing) {
    if (existing.properties?.referenced === true && node.properties?.referenced !== true) {
      Object.assign(existing, node);
    }
    return existing;
  }
  nodes.push(node);
  return node;
}

function addEdge(edges: GraphEdge[], edge: Omit<GraphEdge, 'id'>): void {
  const complete = { ...edge, id: edgeId(edge.sourcePath, edge.type, edge.source, edge.target, edge.line) };
  if (!edges.some((candidate) => candidate.id === complete.id)) edges.push(complete);
}

function cleanLookmlValue(value: string): string {
  return value.trim().replace(/^['"`]|['"`,;]+$/g, '');
}

function sqlReferences(sql: string): string[] {
  const references = new Set<string>();
  for (const match of sql.matchAll(/\b(?:from|join)\s+([`"]?[A-Za-z_][\w$.-]*(?:\.[A-Za-z_][\w$.-]*)?[`"]?)/gi)) {
    const candidate = cleanLookmlValue(match[1]);
    if (candidate && !candidate.includes('${')) references.add(candidate);
  }
  return [...references];
}

export function extractLookml(contents: string, sourcePath: string): StructuralExtraction {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const fileName = basename(sourcePath);
  const modelName = fileName.replace(/\.model\.lkml$/i, '').replace(/\.lkml$/i, '');
  const model = addNode(nodes, {
    id: nodeId(sourcePath, 'model', modelName),
    type: 'model',
    name: modelName,
    sourcePath,
    line: 1,
  });

  let currentView: GraphNode | undefined;
  let currentExplore: GraphNode | undefined;
  const lines = contents.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const line = lines[index];
    let lineOwner: GraphNode | undefined;

    for (const match of line.matchAll(/\binclude\s*:\s*["']([^"']+)["']/gi)) {
      const include = addNode(nodes, {
        id: nodeId(sourcePath, 'include', match[1]),
        type: 'include',
        name: match[1],
        sourcePath,
        line: lineNumber,
      });
      addEdge(edges, { type: 'includes', source: model.id, target: include.id, sourcePath, line: lineNumber });
    }

    const exploreMatch = /\bexplore\s*:\s*([\w.-]+)/i.exec(line);
    if (exploreMatch) {
      currentExplore = addNode(nodes, {
        id: nodeId(sourcePath, 'explore', exploreMatch[1]),
        type: 'explore',
        name: exploreMatch[1],
        sourcePath,
        line: lineNumber,
      });
      lineOwner = currentExplore;
      addEdge(edges, { type: 'contains', source: model.id, target: currentExplore.id, sourcePath, line: lineNumber });
    }

    const viewMatch = /\bview\s*:\s*([\w.-]+)/i.exec(line);
    if (viewMatch) {
      currentView = addNode(nodes, {
        id: nodeId(sourcePath, 'view', viewMatch[1]),
        type: 'view',
        name: viewMatch[1],
        sourcePath,
        line: lineNumber,
      });
      lineOwner = currentView;
      addEdge(edges, { type: 'contains', source: model.id, target: currentView.id, sourcePath, line: lineNumber });
    }

    for (const match of line.matchAll(/\bjoin\s*:\s*([\w.-]+)/gi)) {
      const joinedView = addNode(nodes, {
        id: nodeId(sourcePath, 'view', match[1]),
        type: 'view',
        name: match[1],
        sourcePath,
        line: lineNumber,
        properties: { referenced: true },
      });
      const owner = currentExplore ?? model;
      addEdge(edges, { type: 'joins', source: owner.id, target: joinedView.id, sourcePath, line: lineNumber });
    }

    for (const match of line.matchAll(/\bdimension(?:_group)?\s*:\s*([\w.-]+)/gi)) {
      const dimension = addNode(nodes, {
        id: nodeId(sourcePath, 'dimension', match[1]),
        type: 'dimension',
        name: match[1],
        sourcePath,
        line: lineNumber,
      });
      lineOwner = dimension;
      addEdge(edges, {
        type: 'contains',
        source: (currentView ?? model).id,
        target: dimension.id,
        sourcePath,
        line: lineNumber,
      });
    }

    for (const match of line.matchAll(/\bmeasure\s*:\s*([\w.-]+)/gi)) {
      const measure = addNode(nodes, {
        id: nodeId(sourcePath, 'measure', match[1]),
        type: 'measure',
        name: match[1],
        sourcePath,
        line: lineNumber,
      });
      lineOwner = measure;
      addEdge(edges, {
        type: 'contains',
        source: (currentView ?? model).id,
        target: measure.id,
        sourcePath,
        line: lineNumber,
      });
    }

    if (/\bderived_table\s*:/i.test(line)) {
      const name = currentView?.name ?? `${modelName}:${lineNumber}`;
      const derivedTable = addNode(nodes, {
        id: nodeId(sourcePath, 'derived_table', name),
        type: 'derived_table',
        name,
        sourcePath,
        line: lineNumber,
      });
      lineOwner = derivedTable;
      addEdge(edges, {
        type: 'contains',
        source: (currentView ?? model).id,
        target: derivedTable.id,
        sourcePath,
        line: lineNumber,
      });
    }

    for (const match of line.matchAll(/\bsql_table_name\s*:\s*([^;\s}]+)/gi)) {
      const name = cleanLookmlValue(match[1]);
      const sqlTable = addNode(nodes, {
        id: nodeId(sourcePath, 'sql_table', name),
        type: 'sql_table',
        name,
        sourcePath,
        line: lineNumber,
      });
      addEdge(edges, {
        type: 'depends_on',
        source: (currentView ?? model).id,
        target: sqlTable.id,
        sourcePath,
        line: lineNumber,
      });
    }

    for (const name of sqlReferences(line)) {
      const sqlTable = addNode(nodes, {
        id: nodeId(sourcePath, 'sql_table', name),
        type: 'sql_table',
        name,
        sourcePath,
        line: lineNumber,
      });
      addEdge(edges, {
        type: 'depends_on',
        source: (currentView ?? currentExplore ?? model).id,
        target: sqlTable.id,
        sourcePath,
        line: lineNumber,
      });
    }

    for (const match of line.matchAll(/\$\{([A-Za-z_][\w.-]*)\.([A-Za-z_][\w.-]*)\}/g)) {
      if (match[1].toUpperCase() === 'TABLE') continue;
      const referencedView = addNode(nodes, {
        id: nodeId(sourcePath, 'view', match[1]),
        type: 'view',
        name: match[1],
        sourcePath,
        line: lineNumber,
        properties: { referenced: true },
      });
      addEdge(edges, {
        type: 'references',
        source: (lineOwner ?? currentView ?? currentExplore ?? model).id,
        target: referencedView.id,
        sourcePath,
        line: lineNumber,
        properties: { field: match[2] },
      });
    }
  }

  return { nodes, edges };
}

type InferredType = 'null' | 'boolean' | 'integer' | 'number' | 'date' | 'datetime' | 'string';

export interface DelimitedSummary {
  headers: string[];
  rowCount: number;
  types: Record<string, InferredType>;
  sampleRows: string[][];
  semanticText: string;
}

function parseDelimited(contents: string, delimiter: string): string[][] {
  if (delimiter.length !== 1) throw new Error('delimiter must be one character');
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < contents.length; index += 1) {
    const character = contents[index];
    if (character === '"') {
      if (quoted && contents[index + 1] === '"') {
        field += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
      continue;
    }
    if (character === delimiter && !quoted) {
      row.push(field);
      field = '';
      continue;
    }
    if ((character === '\n' || character === '\r') && !quoted) {
      if (character === '\r' && contents[index + 1] === '\n') index += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      continue;
    }
    field += character;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function inferValue(value: string): InferredType {
  const trimmed = value.trim();
  if (!trimmed || /^(?:null|na|n\/a)$/i.test(trimmed)) return 'null';
  if (/^(?:true|false)$/i.test(trimmed)) return 'boolean';
  if (/^[+-]?\d+$/.test(trimmed)) return 'integer';
  if (/^[+-]?(?:\d+\.\d*|\d*\.\d+)(?:e[+-]?\d+)?$/i.test(trimmed)) return 'number';
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return 'date';
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?$/.test(trimmed)) {
    return 'datetime';
  }
  return 'string';
}

function mergeTypes(types: InferredType[]): InferredType {
  const material = new Set(types.filter((type) => type !== 'null'));
  if (material.size === 0) return 'null';
  if (material.size === 1) return [...material][0];
  if ([...material].every((type) => type === 'integer' || type === 'number')) return 'number';
  return 'string';
}

function truncateUtf8(text: string, maxBytes: number): string {
  const encoded = Buffer.from(text);
  if (encoded.length <= maxBytes) return text;
  return encoded
    .subarray(0, maxBytes)
    .toString('utf8')
    .replace(/\uFFFD$/, '');
}

export function summarizeDelimited(contents: string, delimiter: ',' | '\t' = ','): DelimitedSummary {
  const rows = parseDelimited(contents, delimiter);
  const headers = (rows.shift() ?? []).map((header, index) => header.trim() || `column_${index + 1}`);
  const dataRows = rows.filter((row) => row.some((value) => value.length > 0));
  const inferenceRows = dataRows.slice(0, 100);
  const types = Object.fromEntries(
    headers.map((header, column) => [header, mergeTypes(inferenceRows.map((row) => inferValue(row[column] ?? '')))]),
  );
  const sampleRows: string[][] = [];
  let sampleBytes = 0;
  for (const row of dataRows.slice(0, 100)) {
    const normalized = row.map((value) => value.replace(/[\r\n]+/g, ' '));
    const rowBytes = Buffer.byteLength(normalized.join(delimiter)) + 1;
    if (sampleBytes + rowBytes > 256 * 1024) break;
    sampleRows.push(normalized);
    sampleBytes += rowBytes;
  }
  const semantic = [
    `Columns: ${headers.map((header) => `${header} (${types[header]})`).join(', ')}`,
    `Row count: ${dataRows.length}`,
    'Sample:',
    headers.join(delimiter),
    ...sampleRows.map((row) => row.join(delimiter)),
  ].join('\n');
  return {
    headers,
    rowCount: dataRows.length,
    types,
    sampleRows,
    semanticText: truncateUtf8(semantic, 256 * 1024),
  };
}

export interface JsonSummary {
  schema: JsonSchemaSummary;
  semanticText: string;
}

export interface JsonSchemaSummary {
  type: string;
  keys?: Record<string, JsonSchemaSummary>;
  items?: JsonSchemaSummary[];
  representativeValues?: unknown[];
  truncated?: boolean;
}

interface JsonSummaryBudget {
  keys: number;
  values: number;
}

function summarizeJsonValue(value: unknown, depth: number, budget: JsonSummaryBudget): JsonSchemaSummary {
  if (value === null) return { type: 'null', representativeValues: [null] };
  if (Array.isArray(value)) {
    const samples: JsonSchemaSummary[] = [];
    for (const item of value.slice(0, 3)) samples.push(summarizeJsonValue(item, depth + 1, budget));
    return { type: 'array', items: samples, truncated: value.length > samples.length };
  }
  if (typeof value === 'object') {
    if (depth >= 6) return { type: 'object', truncated: true };
    const keys: Record<string, JsonSchemaSummary> = {};
    const entries = Object.entries(value as Record<string, unknown>);
    for (const [key, child] of entries) {
      if (budget.keys <= 0) break;
      budget.keys -= 1;
      keys[key] = summarizeJsonValue(child, depth + 1, budget);
    }
    return { type: 'object', keys, truncated: entries.length > Object.keys(keys).length };
  }
  const type = typeof value;
  if (budget.values <= 0) return { type, truncated: true };
  budget.values -= 1;
  const representative = typeof value === 'string' ? truncateUtf8(value, 120) : value;
  return { type, representativeValues: [representative] };
}

export function summarizeJson(contents: string): JsonSummary {
  const parsed: unknown = JSON.parse(contents);
  const schema = summarizeJsonValue(parsed, 0, { keys: 200, values: 100 });
  return { schema, semanticText: truncateUtf8(JSON.stringify(schema, null, 2), 256 * 1024) };
}

export interface RedactionResult {
  text: string;
  redactionCount: number;
}

const SECRET_ASSIGNMENT =
  /^(\s*(?:["']?(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|private[_-]?key|secret[_-]?access[_-]?key|password|passwd|token|secret)["']?\s*[:=]\s*))(["']?)(.*?)(\2)(\s*[,;]?\s*)$/i;
const INLINE_QUOTED_SECRET =
  /(["']?(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|private[_-]?key|secret[_-]?access[_-]?key|password|passwd|token|secret)["']?\s*[:=]\s*)(["'])([^"'\r\n]{12,})(\2)/gi;

export function redactHighConfidenceSecrets(contents: string): RedactionResult {
  let redactionCount = 0;
  let text = contents.replace(/-----BEGIN [^-\r\n]+-----[\s\S]*?-----END [^-\r\n]+-----/g, () => {
    redactionCount += 1;
    return '[REDACTED PEM BLOCK]';
  });
  text = text.replace(INLINE_QUOTED_SECRET, (match, prefix: string, quote: string, value: string) => {
    if (value === '[REDACTED]') return match;
    redactionCount += 1;
    return `${prefix}${quote}[REDACTED]${quote}`;
  });
  text = text
    .split(/(\r?\n)/)
    .map((line) => {
      if (/^\r?\n$/.test(line)) return line;
      const match = SECRET_ASSIGNMENT.exec(line);
      if (!match) return line;
      const value = match[3].trim();
      const highConfidence =
        value.length >= 12 || /^(?:sk-|gh[oprsu]_|xox[baprs]-|AKIA|AIza|eyJ[A-Za-z0-9_-]*\.)/.test(value);
      if (!highConfidence || value === '[REDACTED]') return line;
      redactionCount += 1;
      return `${match[1]}${match[2]}[REDACTED]${match[4]}${match[5]}`;
    })
    .join('');
  return { text, redactionCount };
}

export interface ChunkTextOptions {
  maxSegments?: number;
  maxAggregateBytes?: number;
  maxSegmentBytes?: number;
}

function splitOversizeText(text: string, maxBytes: number): string[] {
  const pieces: string[] = [];
  let remaining = text;
  while (remaining && pieces.length < 100) {
    const piece = truncateUtf8(remaining, maxBytes);
    if (!piece) break;
    pieces.push(piece);
    remaining = remaining.slice(piece.length).trimStart();
  }
  return pieces;
}

export function chunkText(contents: string, options: ChunkTextOptions = {}): string[] {
  const maxSegments = options.maxSegments ?? 10;
  const maxAggregateBytes = options.maxAggregateBytes ?? 256 * 1024;
  const maxSegmentBytes = options.maxSegmentBytes ?? Math.min(32 * 1024, maxAggregateBytes);
  if (maxSegments < 1 || maxAggregateBytes < 1 || maxSegmentBytes < 1) return [];

  const blocks = contents
    .replace(/\r\n/g, '\n')
    .split(/\n(?=#{1,6}\s)|\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean)
    .flatMap((block) => splitOversizeText(block, maxSegmentBytes));
  const segments: string[] = [];
  let current = '';
  let usedBytes = 0;

  function commit(): boolean {
    if (!current) return true;
    const remaining = maxAggregateBytes - usedBytes;
    if (remaining <= 0 || segments.length >= maxSegments) return false;
    const bounded = truncateUtf8(current, remaining);
    if (!bounded) return false;
    segments.push(bounded);
    usedBytes += Buffer.byteLength(bounded);
    current = '';
    return usedBytes < maxAggregateBytes && segments.length < maxSegments;
  }

  for (const block of blocks) {
    const candidate = current ? `${current}\n\n${block}` : block;
    if (Buffer.byteLength(candidate) <= maxSegmentBytes) {
      current = candidate;
      continue;
    }
    if (!commit()) break;
    current = block;
  }
  commit();
  return segments;
}

export interface PreprocessedSource {
  sourceId: string;
  semanticSegments: string[];
  nodes: GraphNode[];
  edges: GraphEdge[];
  redactionCount: number;
  metadata: Record<string, unknown>;
  binary: boolean;
}

const BINARY_EXTENSIONS = new Set([
  '.aac',
  '.avi',
  '.docx',
  '.flac',
  '.gif',
  '.heic',
  '.jpeg',
  '.jpg',
  '.m4a',
  '.m4v',
  '.mkv',
  '.mov',
  '.mp3',
  '.mp4',
  '.mpeg',
  '.mpg',
  '.oga',
  '.ogg',
  '.opus',
  '.pdf',
  '.png',
  '.tif',
  '.tiff',
  '.wav',
  '.webm',
  '.webp',
  '.wma',
  '.wmv',
  '.xlsx',
]);

export async function preprocessDiscoveredSource(source: DiscoveredSourceLike): Promise<PreprocessedSource> {
  const extension = extname(source.relativePath).toLowerCase();
  const baseMetadata = {
    relativePath: source.relativePath,
    kind: source.kind,
    bytes: source.bytes,
    sha256: source.sha256,
    state: source.state,
    ...(source.stateReason ? { stateReason: source.stateReason } : {}),
  };
  if (
    source.state === 'metadata_only' ||
    source.state === 'quarantined' ||
    source.state === 'failed' ||
    source.state === 'deleted'
  ) {
    return {
      sourceId: source.id,
      semanticSegments: [],
      nodes: [],
      edges: [],
      redactionCount: 0,
      metadata: baseMetadata,
      binary: BINARY_EXTENSIONS.has(extension),
    };
  }
  if (BINARY_EXTENSIONS.has(extension)) {
    return {
      sourceId: source.id,
      semanticSegments: [],
      nodes: [],
      edges: [],
      redactionCount: 0,
      metadata: { ...baseMetadata, requiresBinaryExtractor: true },
      binary: true,
    };
  }

  const raw = (await readVerifiedSource(source, 10 * 1024 * 1024)).toString('utf8');
  const redacted = redactHighConfidenceSecrets(raw);
  let semanticText = redacted.text;
  let nodes: GraphNode[] = [];
  let edges: GraphEdge[] = [];
  const metadata: Record<string, unknown> = { ...baseMetadata };

  if (extension === '.lkml') {
    const extraction = extractLookml(redacted.text, source.relativePath);
    nodes = extraction.nodes;
    edges = extraction.edges;
  } else if (extension === '.csv' || extension === '.tsv') {
    const summary = summarizeDelimited(redacted.text, extension === '.tsv' ? '\t' : ',');
    semanticText = summary.semanticText;
    metadata.headers = summary.headers;
    metadata.rowCount = summary.rowCount;
    metadata.types = summary.types;
  } else if (extension === '.json') {
    const summary = summarizeJson(redacted.text);
    semanticText = summary.semanticText;
    metadata.schema = summary.schema;
  }

  return {
    sourceId: source.id,
    semanticSegments: chunkText(semanticText),
    nodes,
    edges,
    redactionCount: redacted.redactionCount,
    metadata,
    binary: false,
  };
}
