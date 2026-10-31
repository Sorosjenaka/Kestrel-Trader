"""Independent local snapshots; never reads credential values or changes running state."""
import ast,hashlib,json,sys,urllib.request
from pathlib import Path
from datetime import datetime,timezone
ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT/'research'))
from swing_paper_wallet import reconcile
OUT=ROOT/'data/swing-paper-install-2026-10-18';OUT.mkdir(exist_ok=True)
def sha(p):
 h=hashlib.sha256()
 with p.open('rb') as f:
  for chunk in iter(lambda:f.read(1024*1024),b''):h.update(chunk)
 return h.hexdigest()
baseline=json.loads((ROOT/'data/repair/baseline/immutable-hashes.json').read_text())
protected={p:sha(ROOT/p)==h for p,h in baseline.items()};assert all(protected.values())
seed=json.loads((ROOT/'research/swing_paper_algo_seed.json').read_text())
review=json.loads((ROOT/seed['source']).read_text())
assert seed['model']==review['monthlyModels']['CORRECTED_SHORT_LABELS_2B'][str(seed['trainedBefore'])]
assert seed['model']['longLabels']==0 and seed['model']['labels']==2264
universe=json.loads((ROOT/'research/swing_paper_universe.json').read_text())
assert universe['sourceSha256']==sha(ROOT/universe['source'])
assert len(universe['symbols'])==len(set(universe['symbols']))==38
web=json.loads((ROOT/'apps/web/src/data/swingResearch.json').read_text())
server=json.loads((ROOT/'apps/server/src/strategies/researchSwingCatalog.json').read_text());assert web==server
assert all(s['executionBinding']=='research/swing_forward_paper.py' and not s['liveEnabled'] for s in web['strategies'])
with urllib.request.urlopen('http://127.0.0.1:8791/status',timeout=5) as response:status=json.load(response)
assert status['mode']=='ISOLATED_PAPER_ONLY' and status['running'] and not status['liveEnabled']
assert status['lastCycleAt'] and status['evaluatedSymbols']>0
state=json.loads((ROOT/'data/swing-paper-runtime/forward-wallet.json').read_text());reconcile(state)
assert state['createdAt']==status['createdAt'] and state['initialBalance']==40
assert all(0<p['riskUsd']<=1+1e-8 for p in state['pending']+state['positions']+state['closed'])
(OUT/'status-snapshot.json').write_text(json.dumps(status,indent=2)+'\n')
(OUT/'wallet-snapshot.json').write_text(json.dumps(state,indent=2)+'\n')
files=['research/swing_forward_paper.py','research/swing_paper_signals.py','research/swing_paper_wallet.py',
 'research/swing_paper_algo_seed.json','research/swing_paper_universe.json','research/test_swing_forward_paper.py',
 'tools/run-swing-research-paper.mjs','tools/sync-swing-research-catalog.py','tools/verify-swing-paper-install.py',
 'apps/web/src/components/SwingPaperPanel.tsx','apps/web/src/components/SwingPaperPanel.test.tsx',
 'apps/web/src/components/SwingResearchPanel.tsx','apps/web/src/pages/BacktestPage.tsx','apps/web/vite.config.ts',
 'apps/server/src/app.ts','apps/server/tests/researchSwingCatalog.test.ts','apps/web/src/data/swingResearch.json',
 'apps/server/src/strategies/researchSwingCatalog.json','package.json']
for p in files:
 if p.endswith('.py'):ast.parse((ROOT/p).read_text())
whitespace={p:[i for i,l in enumerate((ROOT/p).read_text().splitlines(),1) if l.rstrip()!=l] for p in files}
result=dict(atUtc=datetime.now(timezone.utc).isoformat(),protectedUnchanged=protected,catalogCopiesEqual=True,
 seedMatchesCorrectedAudit=True,approvedUniverse=38,sourceHashes={p:sha(ROOT/p) for p in files},
 paperStatus=dict(running=status['running'],createdAt=status['createdAt'],lastCycleAt=status['lastCycleAt'],
   evaluatedSymbols=status['evaluatedSymbols'],cashUsd=status['cashUsd'],equityUsd=status['equityUsd'],
   actualClosedTrades=status['metrics']['trades'],pending=len(status['pending']),open=len(status['positions']),errors=status['errors']),
 walletSnapshotSha256=sha(OUT/'wallet-snapshot.json'),statusSnapshotSha256=sha(OUT/'status-snapshot.json'),
 liveEnabled=False,vpsDeployed=False,activeWalletIsMutableNotHashFrozen=True,
 whitespaceFindings={p:v for p,v in whitespace.items() if v})
(OUT/'verification.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps({k:result[k] for k in ['protectedUnchanged','seedMatchesCorrectedAudit','approvedUniverse','paperStatus','liveEnabled','vpsDeployed']}))
