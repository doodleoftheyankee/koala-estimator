# Hard rule 1 (docs/accuracy/final/hard-rule-1.txt): compares two renders of the stored quotes made by
# scripts/accuracy/render-stored.ts and sorts each difference: identical, class names only (the two
# review B look changes, flow-B11 and flow-B6), or other. Run with python3 -I.
# Compare two render sets; classify each difference.
# usage: python3 -I hr1check.py <before> <after>
import os, sys, collections
before, after = sys.argv[1], sys.argv[2]
B11 = 'class="inline-flex min-h-12 items-center underline underline-offset-2"'
OLD = 'class="underline underline-offset-2"'
PH_NEW = 'placeholder:text-placeholder'
PH_OLD = 'placeholder:text-ink-3'
files = sorted(os.path.relpath(os.path.join(d, f), before) for d, _, fs in os.walk(before) for f in fs)
afiles = sorted(os.path.relpath(os.path.join(d, f), after) for d, _, fs in os.walk(after) for f in fs)
assert files == afiles, ('file lists differ', set(files) ^ set(afiles))
same = 0; cls = collections.Counter(); other = []
for f in files:
    a = open(os.path.join(before, f), 'rb').read(); b = open(os.path.join(after, f), 'rb').read()
    if a == b: same += 1; continue
    kind = os.path.basename(f).split('-')[0] + ('.' + f.rsplit('.', 1)[1])
    # Only class names may differ, and only these two: the estimator email link's tap-target class
    # (review B flow-B11) and the sign form's placeholder colour token (review B flow-B6).
    if f.endswith('.html'):
        t = b.decode(); used = []
        if B11 in t: t = t.replace(B11, OLD); used.append('B11')
        if PH_NEW in t: t = t.replace(PH_NEW, PH_OLD); used.append('B6')
        if t == a.decode() and used:
            cls[os.path.basename(f) + ' (' + '+'.join(used) + ')'] += 1; continue
    other.append(f)
print(f'files {len(files)}; identical {same}; differ only by the flow-B11 / flow-B6 class names {sum(cls.values())}; other differences {len(other)}')
for k, v in sorted(cls.items()): print(f'  {k}: {v}')
for f in other: print('  OTHER', f)
by_ext = collections.Counter(f.rsplit('.', 1)[1] for f in files)
print('by type:', dict(by_ext))
txt_pdf_email = [f for f in files if f.endswith('.txt') or os.path.basename(f).startswith(('pdf', 'email'))]
print('text, PDF and email files:', len(txt_pdf_email), 'differing:', sum(1 for f in txt_pdf_email if f in other or os.path.basename(f) in cls))
