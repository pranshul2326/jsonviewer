import { jsonToYaml, yamlToJson } from './src/lib/converters/yaml.ts';
import { parseJson } from './src/lib/converters/../json-core/parse.ts';
const jsonText = JSON.stringify({ __proto__: null });
console.log('jsonText:', jsonText);
const y = jsonToYaml(jsonText);
console.log('yaml result:', y);
if (y.ok) {
  const back = yamlToJson(y.text);
  console.log('back:', back);
}
