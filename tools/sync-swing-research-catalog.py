from pathlib import Path
import json
root=Path(__file__).resolve().parents[1]
# Snapshot existing evidence; never manufacture results for the unverified 398-trade version.
summary=json.loads((root/'data/swing-directional-audit-2026-10-17/hybrid-trials/summary.json').read_text())['recipes']
rows=[]
for id,name,recipe,entry in [
 ('RSW-01','BOS LONG + PHEN SHORT','LONG_BOS_D1_SHORT_LOCKED_PHEN','BOS H4 + BTC D1 align LONG; PHEN locked SHORT'),
 ('RSW-02','PHEN Profile LONG + PHEN SHORT','LONG_PHEN_PROFILE_SHORT_LOCKED_PHEN','PHEN profile/structural stop LONG; PHEN locked SHORT')]:
 r=summary[recipe];m=r['stress']
 rows.append(dict(id=id,name=name,recipe=recipe,direction='BOTH',entry=entry,exitPolicy='50% @ 2R → BE next bar → 50% @ 3R',
  evidenceStatus='VERIFIED_HISTORICAL_NOT_LIVE',liveEnabled=False,forwardStatus='NOT_STARTED',
  stress=dict(trades=m['n'],winratePct=m['wr'],profitFactor=m['pf'],cashUsd=m['cash'],drawdownPct=r['stressDrawdownPct']),
  evidence='data/swing-directional-audit-2026-10-17/hybrid-trials/'+recipe+'.json',
  limitations='Posthoc; belum lolos seluruh KPI. Bukan forward/OOS baru.'))
rows.append(dict(id='RSW-03',name='Algo V7 corrected SHORT',recipe='CORRECTED_SHORT_LABELS_2B',direction='SHORT',
 entry='H1 momentum-volume; H4 ADX <25; LIMIT retracement; monthly Ridge',
 exitPolicy='Target riset 2R/3R; bukti lama SINGLE TP 0.8R',evidenceStatus='RR23_PENDING_VERIFICATION',liveEnabled=False,
 forwardStatus='NOT_STARTED',stress=None,evidence='data/audit-antigravity-2026-10-17/corrected-2b-diagnostic.json',
 limitations='755 trade lama memakai TP 0.8R. Klaim 398 trade RR baru belum terverifikasi; tidak ditampilkan sebagai hasil sah.'))
for row in rows:
 row['forwardStatus']='AVAILABLE_ISOLATED_PAPER_WORKER'
 row['executionBinding']='research/swing_forward_paper.py'
 row['forwardStatusEndpoint']='/api/research/swing-paper/status'
payload=dict(schemaVersion=1,mode='RESEARCH_ONLY',initialBalanceUsd=40,riskPriceUsd=1,estimatedCostAllowanceUsd=.2,
 leverage=25,marginMode='CROSS',maxPositions=3,maxDailyLosses=6,liveEnabled=False,strategies=rows)
out=root/'apps/web/src/data/swingResearch.json';out.parent.mkdir(exist_ok=True)
out.write_text(json.dumps(payload,indent=2)+'\n',encoding='utf-8')

(root/'apps/server/src/strategies/researchSwingCatalog.json').write_text(out.read_text(encoding='utf-8'),encoding='utf-8')
