import { load, dump } from 'js-yaml';
const obj = {};
Object.defineProperty(obj, '__proto__', { value: null, enumerable: true, writable: true, configurable: true });
const y = dump(obj);
console.log('YAML text:', JSON.stringify(y));
const back = load(y);
console.log('parsed own keys:', Object.keys(back ?? {}));
console.log('has __proto__ own:', Object.prototype.hasOwnProperty.call(back ?? {}, '__proto__'));
