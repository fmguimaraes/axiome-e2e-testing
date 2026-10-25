import hashlib, json, os, re, sys, glob
ROOT = sys.argv[1]
res = {}
def sha(b): return hashlib.sha256(b).hexdigest()
def recompute(md):
    kept = [l for l in md.split('\n') if not l.startswith('Generated: ') and not l.startswith('Report SHA-256: ')]
    return sha('\n'.join(kept).encode('utf-8'))
PAT = re.compile(r'minio|s3://|localhost|127\.0\.0\.1|amazonaws|\.s3\.|bucket|storage[_ ]?key|secret|password|token|api[_-]?key|BEGIN [A-Z ]*PRIVATE|AKIA[0-9A-Z]{8,}|axiome-[a-z-]+:\d+|https?://|@[a-z0-9.-]+\.(com|io|org)|/home/|/tmp/|file://', re.I)
out = []
for d in sorted(glob.glob(os.path.join(ROOT, '*'))):
    name = os.path.basename(d); ex = os.path.join(d, 'unzipped')
    if not os.path.isdir(ex): continue
    r = {'bundle': name, 'checks': {}}
    md = open(f'{ex}/report.md', 'rb').read().decode('utf-8'); man = json.load(open(f'{ex}/manifest.json'))
    files = [os.path.relpath(os.path.join(dp, f), ex) for dp, _, fs in os.walk(ex) for f in fs]
    mf = {f['filename']: f['sha256'] for f in man['files']}
    bad = []
    for f in files:
        if f == 'manifest.json': continue
        h = 'sha256:' + sha(open(f'{ex}/{f}', 'rb').read())
        if mf.get(f) != h: bad.append(f)
    missing = [f for f in mf if not os.path.exists(f'{ex}/{f}')]
    extra = [f for f in files if f != 'manifest.json' and f not in mf]
    r['checks']['manifest_sha_match'] = (not bad and not missing and not extra, {'mismatch': bad, 'missing': missing, 'unlisted': extra, 'n_files': len(mf)})
    rh = recompute(md); stated = re.search(r'^Report SHA-256: sha256:([0-9a-f]{64})$', md, re.M)
    r['checks']['report_hash_recompute'] = (bool(stated) and stated.group(1) == rh, {'stated': stated and stated.group(1), 'recomputed': rh, 'manifest_reportSha256': man.get('reportSha256')})
    r['checks']['manifest_reportSha_eq_stated'] = (man.get('reportSha256') == 'sha256:' + (stated.group(1) if stated else ''), {})
    r['checks']['manifest_report_md_hash'] = (mf.get('report.md') == 'sha256:' + sha(md.encode('utf-8')), {})
    # raw file hash
    raws = re.findall(r'Raw file SHA-256: sha256:([0-9a-f]{64})([^\n]*)', md)
    srcs = [f for f in files if f.startswith('data/source/')]
    rd = []
    for h, tail in raws:
        m = re.search(r'attached file (\S+)', tail)
        if m and os.path.exists(f'{ex}/{m.group(1)}'):
            rd.append((m.group(1), sha(open(f'{ex}/{m.group(1)}', 'rb').read()) == h))
        else: rd.append((tail.strip()[:80], None))
    inc = man.get('includeSource')
    if inc:
        r['checks']['source_sha_eq_rawFileHash'] = (len(rd) > 0 and all(v for _, v in rd) and len(srcs) > 0, {'raw_hashes_in_report': len(raws), 'detail': rd, 'source_files': srcs})
    else:
        csvc = [f for f in files if f.startswith('data/charts/')]
        r['checks']['no_source_no_chart_csv'] = (not srcs and not csvc and man.get('containsSourceData') is False and 'not included' in md, {'source': srcs, 'chart_csv': csvc, 'containsSourceData': man.get('containsSourceData')})
    hits = []
    for f in ['report.md', 'manifest.json']:
        for i, line in enumerate(open(f'{ex}/{f}', encoding='utf-8').read().split('\n'), 1):
            for m in PAT.finditer(line): hits.append((f, i, m.group(0), line.strip()[:160]))
    r['checks']['nfr4_grep'] = (not hits, {'hits': hits})
    out.append(r)
# determinism
a = f'{ROOT}/949d5bcf-v3/unzipped'; b = f'{ROOT}/949d5bcf-v3-second/unzipped'
diffs = []
for dp, _, fs in os.walk(a):
    for f in fs:
        p = os.path.relpath(os.path.join(dp, f), a)
        x = open(f'{a}/{p}', 'rb').read(); y = open(f'{b}/{p}', 'rb').read()
        if x != y: diffs.append(p)
la = open(f'{a}/report.md').read().split('\n'); lb = open(f'{b}/report.md').read().split('\n')
rd = [(x[:40]) for x, y in zip(la, lb) if x != y]
ma = json.load(open(f'{a}/manifest.json')); mb = json.load(open(f'{b}/manifest.json'))
mdiff = [k for k in ma if ma[k] != mb[k]]
det = {'files_differing': diffs, 'report_lines_differing': rd, 'manifest_keys_differing': mdiff,
       'manifest_file_hashes_differing': [x['filename'] for x, y in zip(ma['files'], mb['files']) if x != y]}
out.append({'bundle': 'DETERMINISM 949d5bcf-v3 vs second', 'det': det})
json.dump(out, open(f'{ROOT}/../verification.json', 'w'), indent=1, default=str)
for r in out:
    if 'det' in r: print(r['bundle'], r['det']); continue
    print(r['bundle'], {k: ('PASS' if v[0] else 'FAIL') for k, v in r['checks'].items()})
