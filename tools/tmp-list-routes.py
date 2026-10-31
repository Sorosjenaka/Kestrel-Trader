import re
s = open(r'apps/server/src/app.ts', encoding='utf-8').read()
paths = sorted(set(re.findall(r'app\.(?:get|post|put|delete)\("(/api/[^"?]*)', s)))
print(len(paths))
for p in paths:
    print(p)
