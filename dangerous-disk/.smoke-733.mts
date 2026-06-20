import { jsonToXml, xmlToJson } from './src/lib/converters/xml';
import { jsonToCsv, csvToJson } from './src/lib/converters/csv';

const j = JSON.stringify({ a: 1, b: { c: 'x & y' }, list: [1, 2, 3] });
const xml = jsonToXml(j);
console.log('jsonToXml:', xml);
if (xml.ok) console.log('xmlToJson:', xmlToJson(xml.text));

const arr = JSON.stringify([{ a: 1, b: 'p' }, { a: 2, b: 'q' }]);
const csv = jsonToCsv(arr);
console.log('jsonToCsv ok:', csv);
if (csv.ok) console.log('csvToJson:', csvToJson(csv.text));

console.log('non-array:', jsonToCsv('{"a":1}'));
console.log('non-uniform:', jsonToCsv('[{"a":1},{"a":1,"b":2}]'));
console.log('element-not-object:', jsonToCsv('[{"a":1}, 5]'));
console.log('empty-array:', jsonToCsv('[]'));
console.log('invalid-json:', jsonToCsv('{bad'));
