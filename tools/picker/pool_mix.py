import re,json,sys
src,lst,lo,hi=sys.argv[1:5]
L={}
for l in open(lst):
  i,rest=l.split(' ',1); L[rest.split('|')[-1].strip()]=i
best={}
for l in open(src):
  l=re.sub(r'\s+',' ',l.strip())
  if any(w in l for w in ('shaky','thin','never met')): continue
  g,lab=l.split(' || ✓ ')
  t=g[:5]
  if not (lo<=t<hi): continue
  m=re.search(r'^(.*) @([\d.]+) — (\d+)/(\d+) \| h2h (\d+)/(\d+) last 2y',lab)
  if not m: continue
  label,odds,h,n,hr,hn=m.groups(); r=int(h)/int(n)
  game=re.sub(r'^\d\d:\d\d ','',g); game=re.sub(r' \([^)]*\)$','',game)
  eid=L.get(game)
  if not eid: continue
  # Owner's rule (1 Nov): prefer results and balanced unders over overs.
  kind='result' if re.match(r'^(Double chance|Win|Draw no bet)',label) else 'under' if 'Under' in label else 'over'
  key=r+{'result':0.04,'under':0.03,'over':0}[kind]
  if game not in best or key>best[game]['key']:
    best[game]=dict(key=key,t=t,game=game,eid=eid,label=label,odds=float(odds),r=r,h=f'{h}/{n}',h2h=f'{hr}/{hn}',kind=kind)
out=sorted(best.values(),key=lambda x:x['t'])
for x in out: x.pop('key')
json.dump(out,open('pool.json','w'),indent=0)
print(len(out), {k:sum(1 for x in out if x['kind']==k) for k in ('result','under','over')})
