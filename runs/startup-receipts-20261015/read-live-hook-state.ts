const ws = new WebSocket('ws://127.0.0.1:4502');
const timeout = setTimeout(() => { console.log('timeout'); ws.close(); }, 5000);
ws.onopen = () => ws.send(JSON.stringify({id:1,method:'initialize',params:{clientInfo:{name:'loop-startup-diagnostic',version:'1'},capabilities:{experimentalApi:true}}}));
function scan(v: unknown) {
 if (Array.isArray(v)) { for (const x of v) scan(x); }
 else if (v && typeof v === 'object') {
  const d=v as Record<string,unknown>;
  if ('eventName' in d && 'trustStatus' in d) console.log(JSON.stringify(Object.fromEntries(['eventName','enabled','trustStatus'].map(k=>[k,d[k]]))));
  for (const x of Object.values(d)) scan(x);
 }
}
ws.onmessage = event => {
 const d=JSON.parse(String(event.data));
 if (d.id===1) {
  ws.send(JSON.stringify({method:'initialized',params:{}}));
  ws.send(JSON.stringify({id:2,method:'hooks/list',params:{cwds:['/Users/amgad/dev_projects/harness-engineering.worktrees/portfolio-continuation-20261015']}}));
 }
 if (d.id===2) { if(d.error)console.log('hooks/list failed'); else scan(d.result);clearTimeout(timeout);ws.close(); }
};
