"""AXI-2073 review gate — the transport ceiling, checked on downloaded bundles; appends to ../verification.json.

For each bundle: the base64-encoded size of the downloaded zip (ceil(n/3)*4) is
within the 96 MiB ceiling, no `over_transport_limit` exclusion is recorded,
and report.md has no transport line. Report sizes use MiB labels (no " MB").
"""
import glob, json, math, os, sys
ROOT = sys.argv[1]
CEILING = 96 * 1024 * 1024  # AUDIT_BUNDLE_TRANSPORT_MAX_ENCODED_BYTES
out = []
for d in sorted(glob.glob(os.path.join(ROOT, '*'))):
    zips = glob.glob(os.path.join(d, '*.zip'))
    ex = os.path.join(d, 'unzipped')
    if not zips or not os.path.isdir(ex): continue
    size = os.path.getsize(zips[0]); encoded = math.ceil(size / 3) * 4
    md = open(f'{ex}/report.md', encoding='utf-8').read(); man = json.load(open(f'{ex}/manifest.json'))
    reasons = [e['reason'] for e in man.get('excludedFiles', [])]
    checks = {
        'encoded_within_ceiling': (encoded <= CEILING, {'zip_bytes': size, 'encoded_bytes': encoded, 'ceiling': CEILING}),
        'no_transport_exclusion': ('over_transport_limit' not in reasons and 'transport size limit' not in md, {'reasons': reasons}),
        'no_decimal_mb_label': (' MB' not in md, {}),
    }
    out.append({'bundle': os.path.basename(d), 'transport': {k: ('PASS' if v[0] else 'FAIL', v[1]) for k, v in checks.items()}})
path = f'{ROOT}/../verification.json'
existing = json.load(open(path)) if os.path.exists(path) else []
json.dump(existing + out, open(path, 'w'), indent=1, default=str)
for r in out:
    print(r['bundle'], {k: v[0] for k, v in r['transport'].items()}, r['transport']['encoded_within_ceiling'][1]['encoded_bytes'])
