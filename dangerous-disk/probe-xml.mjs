import { XMLBuilder, XMLParser } from 'fast-xml-parser';

const builder = new XMLBuilder({
  format: true,
  indentBy: '  ',
  ignoreAttributes: true,
  suppressEmptyNode: false,
  processEntities: true,
});
const parser = new XMLParser({
  ignoreAttributes: true,
  parseTagValue: true,
  trimValues: true,
  processEntities: true,
});

function roundtrip(value) {
  const xml = builder.build({ root: value });
  const parsed = parser.parse(xml);
  const keys = Object.keys(parsed);
  const unwrapped = keys.length === 1 ? parsed[keys[0]] : parsed;
  return unwrapped;
}

const cases = [
  { a: '007' },
  { a: '1.0' },
  { a: 'a\nb' },
  { a: 'hello world' },
  { a: '0' },
  { a: 'NaN' },
  { a: 'Infinity' },
  { a: 'null' },
  { a: '1e5' },
  { a: '-5' },
  { a: '0x10' },
  { a: [[1, 2], [3, 4]] },
  { a: ['x', 'y'] },
  { a: [{ x: 1, y: 'a' }, { x: 2, y: 'b' }] },
  { a: {} },
  { a: { b: {} } },
  { a: [1, 2], b: 'k' },
  { a: 'with"quote' },
  { a: "with'apos" },
  { a: '<tag>' },
  { a: '   ' },
];

for (const c of cases) {
  const out = roundtrip(c);
  const same = JSON.stringify(c) === JSON.stringify(out);
  console.log((same ? 'OK ' : 'XX '), 'IN :', JSON.stringify(c), ' OUT:', JSON.stringify(out));
}
