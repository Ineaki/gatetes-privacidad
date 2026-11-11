// PowerShell 5 commonly writes UTF-8 JSON with a leading BOM.
export function stripBom(text) { return String(text).replace(/^\uFEFF/, ''); }
export function parseJsonText(text, label = 'JSON') {
  try { return JSON.parse(stripBom(text)); }
  catch (error) { throw Error(`${label}: invalid JSON (${error.message})`); }
}
