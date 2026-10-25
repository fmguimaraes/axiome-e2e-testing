"""AXI-2073 review points 1 and 2 — checks run after verify_bundles.py; appends to ../verification.json."""
import glob, json, os, re, sys
ROOT = sys.argv[1]
WITHHELD = re.compile(r'^- Chart: .* — Chart image withheld — source data excluded from this bundle \(chart [^\s,]{1,8}, (template \S+ \S+|template not recorded)\)$', re.M)
out = []
for d in sorted(glob.glob(os.path.join(ROOT, '*'))):
    ex = os.path.join(d, 'unzipped')
    if not os.path.isdir(ex): continue
    md = open(f'{ex}/report.md', encoding='utf-8').read(); man = json.load(open(f'{ex}/manifest.json'))
    files = [os.path.relpath(os.path.join(dp, f), ex) for dp, _, fs in os.walk(ex) for f in fs]
    pngs = [f for f in files if f.endswith('.png')]; man_pngs = [f['filename'] for f in man['files'] if f['filename'].endswith('.png')]
    chart_lines = [l for l in md.split('\n') if l.startswith('- Chart: ') and not l.startswith('- Chart: none cited')]
    checks = {}
    if man['includeSource']:
        imaged = [l for l in chart_lines if ' — image charts/' in l]
        checks['rp1_true_png_attached_and_listed'] = (all(re.search(r'image (charts/\S+\.png)$', l).group(1) in pngs for l in imaged) and sorted(pngs) == sorted(man_pngs) and not WITHHELD.search(md), {'chart_lines': len(chart_lines), 'pngs': len(pngs)})
    else:
        checks['rp1_false_no_png_withheld_line'] = (not pngs and not man_pngs and '.png' not in md and len(WITHHELD.findall(md)) == len(chart_lines) > 0, {'chart_lines': len(chart_lines), 'withheld_lines': len(WITHHELD.findall(md))})
    checks['rp2_no_exclusion_under_limit'] = ('excludedFiles' not in man and 'Source file not included' not in md, {})
    out.append({'bundle': os.path.basename(d), 'review_points': {k: ('PASS' if v[0] else 'FAIL', v[1]) for k, v in checks.items()}})
a, b = f'{ROOT}/949d5bcf-v3-nosource/unzipped', f'{ROOT}/949d5bcf-v3-nosource-second/unzipped'
diff = [p for p in sorted(os.listdir(a) + [os.path.join('data/runs', x) for x in os.listdir(f'{a}/data/runs')]) if os.path.isfile(f'{a}/{p}') and open(f'{a}/{p}', 'rb').read() != open(f'{b}/{p}', 'rb').read()]
ma, mb = json.load(open(f'{a}/manifest.json')), json.load(open(f'{b}/manifest.json'))
gen = lambda md: [l for l in md.split('\n') if not l.startswith('Generated: ')]
det = {'files_differing': diff, 'manifest_keys_differing': [k for k in ma if ma[k] != mb[k]],
       'report_identical_but_generated_line': gen(open(f'{a}/report.md').read()) == gen(open(f'{b}/report.md').read()),
       'non_report_file_hashes_identical': [f for f in ma['files'] if f['filename'] != 'report.md'] == [f for f in mb['files'] if f['filename'] != 'report.md']}
out.append({'bundle': 'DETERMINISM includeSource=false 949d5bcf-v3-nosource vs second', 'det': det})
path = f'{ROOT}/../verification.json'
existing = json.load(open(path)) if os.path.exists(path) else []
json.dump(existing + out, open(path, 'w'), indent=1, default=str)
for r in out:
    print(r['bundle'], r.get('det') or {k: v[0] for k, v in r['review_points'].items()})
