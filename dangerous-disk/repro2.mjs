import { parse as parseLossless, isLosslessNumber } from 'lossless-json';

const cases = ['{"__proto__":1}', '{"__proto__":{"a":2}}', '{"a":{"__proto__":"x"}}'];
for (const c of cases) {
  const v = parseLossless(c);
  console.log('input', c);
  console.log('  typeof', typeof v, 'isLosslessNumber', isLosslessNumber(v));
  console.log('  ownKeys', Object.keys(v ?? {}));
  console.log('  getProto is null?', Object.getPrototypeOf(v) === null);
  console.log('  hasOwn __proto__', Object.prototype.hasOwnProperty.call(v ?? {}, '__proto__'));
  console.log('  getOwnPropertyNames', Object.getOwnPropertyNames(v ?? {}));
}
