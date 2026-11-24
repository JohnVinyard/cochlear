// Validates codec/examples/*.json against the JSON schemas in this directory
// (`yarn test-codec`). The Rust decoder validates too; this keeps the schemas
// honest.
const Ajv = require('ajv/dist/2020').default;
const fs = require('node:fs');
const path = require('node:path');

const schemaDir = __dirname;
const examplesDir = path.join(__dirname, '..', 'examples');
const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

const ajv = new Ajv({ allErrors: true, strict: false });
for (const f of fs.readdirSync(schemaDir).filter((f) => f.endsWith('.schema.json'))) {
    ajv.addSchema(read(path.join(schemaDir, f)), f);
}
const validate = ajv.getSchema('document.schema.json');

let failed = 0;
for (const f of fs.readdirSync(examplesDir).filter((f) => f.endsWith('.json'))) {
    if (validate(read(path.join(examplesDir, f)))) {
        console.log(`ok    ${f}`);
    } else {
        failed++;
        console.log(`FAIL  ${f}`);
        for (const e of validate.errors.slice(0, 10)) console.log(`      ${e.instancePath} ${e.message}`);
    }
}

// the schemas must reject typos in known nodes and un-namespaced extension types, but let
// unknown (reverse-DNS) extension types and references through
const doc = (root, extra = {}) => ({ format: 'cochlea-codec', version: '0.2', ...extra, root });
const checks = [
    [false, 'a typo', doc({ type: 'sampler', url: 'x', gian: 1 })],
    [false, 'an extension type without a namespace', doc({ type: 'theremin' })],
    [true, 'a namespaced extension type', doc({ type: 'org.example.theremin', anything: 1 })],
    [true, 'references', doc({ $ref: '#/defs/a', label: 'a' }, { defs: { a: { type: 'sampler', url: { $ref: '#/defs/u' } }, u: 'x' } })],
    [false, 'a parameter next to a reference', doc({ $ref: '#/defs/a', gain: 1 }, { defs: { a: {} } })],
];
for (const [valid, what, d] of checks) {
    if (validate(d) !== valid) {
        failed++;
        console.log(`FAIL  the schemas should ${valid ? 'accept' : 'reject'} ${what}`);
    }
}
process.exit(failed ? 1 : 0);
