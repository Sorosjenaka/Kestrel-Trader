"""Local verification only: hashes protected files without reading/displaying secrets."""
from pathlib import Path
import hashlib,json
from datetime import datetime,timezone
ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'data/heatmap-strategy-install-2026-10-17'
OUT.mkdir(exist_ok=True)
def sha(p):
 h=hashlib.sha256()
 with p.open('rb') as f:
  for chunk in iter(lambda:f.read(1024*1024),b''):h.update(chunk)
 return h.hexdigest()
baseline=json.loads((ROOT/'data/repair/baseline/immutable-hashes.json').read_text())
protected={p:sha(ROOT/p)==value for p,value in baseline.items()}
web=json.loads((ROOT/'apps/web/src/data/swingResearch.json').read_text())
server=json.loads((ROOT/'apps/server/src/strategies/researchSwingCatalog.json').read_text())
assert web==server and len(web['strategies'])==3
assert not web['liveEnabled'] and all(not s['liveEnabled'] for s in web['strategies'])
assert web['strategies'][2]['stress'] is None
assert all(protected.values()),'Protected file changed from existing baseline'
paths=[
 'apps/web/src/pages/HeatmapPage.tsx','apps/web/src/pages/BacktestPage.tsx',
 'apps/web/src/lib/heatmapBuffer.ts','apps/web/src/lib/heatmapBuffer.test.ts',
 'apps/web/src/lib/publicDepth.ts','apps/web/src/lib/publicDepth.test.ts',
 'apps/web/src/lib/publicLiquidations.ts','apps/web/src/lib/publicLiquidations.test.ts',
 'apps/web/src/components/SwingResearchPanel.tsx','apps/web/src/components/SwingResearchPanel.test.tsx',
 'apps/web/src/data/swingResearch.json','apps/server/src/strategies/researchSwingCatalog.json',
 'apps/server/src/strategies/swing/researchExitPolicy.ts','apps/server/src/strategies/swing/swingLevels.ts',
 'apps/server/src/config/setupEngine.ts','apps/server/src/exec/plannedEntry.ts',
 'apps/server/src/exec/positionSupervisor.ts','apps/server/src/backtest/historicalReplay.ts',
 'apps/server/src/backtest/backtestEngine.ts','apps/server/src/strategies/setupStrategies.ts',
 'apps/server/src/strategies/strategyCatalog.ts','apps/server/src/app.ts',
 'apps/server/tests/researchSwingCatalog.test.ts','apps/server/tests/swingRr23Policy.test.ts',
 'apps/server/tests/positionSupervisor.test.ts','apps/server/tests/ladderExit.test.ts',
 'apps/server/tests/swingBreakoutSetup.test.ts','tools/sync-swing-research-catalog.py',
 'tools/verify-heatmap-swing-install.py',
 'apps/server/src/learning/executionMistakes.ts','apps/server/src/learning/postMortemEvaluator.ts',
 'apps/server/tests/executionMistakes.test.ts','apps/server/tests/postMortemEvaluator.test.ts']
whitespace={p:[i for i,line in enumerate((ROOT/p).read_text(encoding='utf-8').splitlines(),1) if line.rstrip()!=line] for p in paths}
# Existing whitespace is reported, never cleaned incidentally.
evidence={s['id']:sha(ROOT/s['evidence']) for s in web['strategies']}
result=dict(atUtc=datetime.now(timezone.utc).isoformat(),protectedUnchanged=protected,
 catalogCopiesEqual=True,strategies=3,liveEnabled=False,forwardPaper='NOT_STARTED',
 vpsDeployed=False,sourceHashes={p:sha(ROOT/p) for p in paths},evidenceHashes=evidence,
 whitespaceFindings={p:lines for p,lines in whitespace.items() if lines})
(OUT/'verification.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps({k:result[k] for k in ['protectedUnchanged','catalogCopiesEqual','strategies','liveEnabled','vpsDeployed','whitespaceFindings']}))
