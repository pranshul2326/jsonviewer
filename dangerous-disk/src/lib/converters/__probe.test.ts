import { test } from 'vitest';
import { writeFileSync } from 'node:fs';
import { jsonToCsv, csvToJson } from './csv';

function rt(json: string) {
  const csv = jsonToCsv(json);
  if (!csv.ok) return { stage: 'toCsv', err: csv.error };
  const back = csvToJson(csv.text);
  if (!back.ok) return { stage: 'toJson', err: back.error, csv: csv.text };
  return { csv: csv.text, json: back.text };
}

test('probe-csv', () => {
  const cases = [
    '[{"k":"x","a":null}]',
    '[{"k":"x","a":""}]',
    '[{"k":"x","a":"true"}]',
    '[{"k":"x","a":"123"}]',
    '[{"k":"x","a":"hi, there"}]',
    '[{"k":"x","a":"line\\nbreak"}]',
    '[{"k":"x","a":"quote\\"q"}]',
    '[{"k":"x","a":"café Ω"}]',
    '[{"k":"x","a":"  spaced  "}]',
    '[{"k":"x","a":"0"}]',
    '[{"k":"x","a":"-5.5"}]',
    '[{"k":"x","a":"hello world"}]',
    '[{"k":"x","a":"a\\tb"}]',
    '[{"k":1.5,"a":"NaN"}]',
    '[{"k":"x","a":9007199254740991}]',
  ];
  const out: string[] = [];
  for (const c of cases) {
    out.push('IN : ' + c);
    out.push('OUT: ' + JSON.stringify(rt(c)));
    out.push('---');
  }
  writeFileSync('/tmp/csv_probe.txt', out.join('\n'));
});
