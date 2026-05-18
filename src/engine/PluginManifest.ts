import { ABI_VERSION } from './PluginAbi';

export { ABI_VERSION };

export type PluginKind = 'gen' | 'fx';
export type ParamDisplay = 'linear' | 'log' | 'db' | 'hz' | 'percent';

export interface ParamDecl {
  name: string;
  min: number;
  max: number;
  default: number;
  step: number;            // 0 = continuous; >0 = quantized
  unit?: string;
  display: ParamDisplay;
}

export interface PluginUi {
  entry: string;
  width: number;
  height: number;
}

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  abi_version: number;
  kind: PluginKind;
  params: ParamDecl[];
  ui?: PluginUi;
}

function fail(msg: string): never {
  throw new Error(`PluginManifest: ${msg}`);
}

function reqString(obj: Record<string, unknown>, key: string): string {
  const v = obj[key];
  if (typeof v !== 'string' || v.length === 0) fail(`missing or invalid ${key}`);
  return v;
}

function reqNumber(obj: Record<string, unknown>, key: string): number {
  const v = obj[key];
  if (typeof v !== 'number' || !Number.isFinite(v)) fail(`missing or invalid ${key}`);
  return v;
}

const DISPLAYS: readonly ParamDisplay[] = ['linear', 'log', 'db', 'hz', 'percent'];

function parseParam(p: unknown, i: number): ParamDecl {
  if (!p || typeof p !== 'object') fail(`params[${i}] not an object`);
  const o = p as Record<string, unknown>;
  const min = reqNumber(o, 'min');
  const max = reqNumber(o, 'max');
  if (min >= max) fail(`params[${i}]: min (${min}) must be < max (${max})`);
  const def = reqNumber(o, 'default');
  if (def < min || def > max) fail(`params[${i}]: default ${def} outside [${min}, ${max}]`);
  const step = o.step === undefined ? 0 : reqNumber(o, 'step');
  const displayRaw = o.display === undefined ? 'linear' : o.display;
  if (typeof displayRaw !== 'string' || !DISPLAYS.includes(displayRaw as ParamDisplay)) {
    fail(`params[${i}]: invalid display '${String(displayRaw)}'`);
  }
  const display = displayRaw as ParamDisplay;
  const result: ParamDecl = {
    name: reqString(o, 'name'),
    min, max, default: def, step,
    display,
  };
  if (typeof o.unit === 'string') result.unit = o.unit;
  return result;
}

export function parseManifest(raw: unknown): PluginManifest {
  if (!raw || typeof raw !== 'object') fail('not an object');
  const o = raw as Record<string, unknown>;
  const abi = reqNumber(o, 'abi_version');
  if (abi !== ABI_VERSION) fail(`abi_version ${abi} != ${ABI_VERSION}`);
  const kind = reqString(o, 'kind');
  if (kind !== 'gen' && kind !== 'fx') fail(`invalid kind '${kind}'`);
  const paramsRaw = o.params;
  if (!Array.isArray(paramsRaw)) fail('params must be an array');
  const params = paramsRaw.map((p, i) => parseParam(p, i));
  const result: PluginManifest = {
    id: reqString(o, 'id'),
    name: reqString(o, 'name'),
    version: reqString(o, 'version'),
    abi_version: abi,
    kind,
    params,
  };
  if (o.ui !== undefined) {
    if (!o.ui || typeof o.ui !== 'object') fail('ui must be an object');
    const u = o.ui as Record<string, unknown>;
    result.ui = {
      entry: reqString(u, 'entry'),
      width: reqNumber(u, 'width'),
      height: reqNumber(u, 'height'),
    };
  }
  return result;
}
