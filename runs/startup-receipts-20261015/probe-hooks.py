import os,json,pathlib,subprocess,selectors,tempfile,time
root=pathlib.Path(tempfile.mkdtemp(prefix='loop-hook-probe-'))
(root/'config.toml').write_text('model = "gpt-6.1-sol"\n')
(root/'capture.py').write_text('import json,sys,pathlib\nd=json.load(sys.stdin)\npathlib.Path(__file__).with_name("receipt.json").write_text(json.dumps({k:d.get(k) for k in ["hook_event_name","source","cwd"]}))\n')
(root/'hooks.json').write_text(json.dumps({'hooks':{'SessionStart':[{'hooks':[{'type':'command','command':f'/usr/bin/python3 {root}/capture.py'}]}]}}))
env=dict(os.environ,CODEX_HOME=str(root))
p=subprocess.Popen(['codex','app-server','--stdio'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True,env=env,cwd=root)
s=selectors.DefaultSelector();s.register(p.stdout,selectors.EVENT_READ)
def send(d): p.stdin.write(json.dumps(d)+'\n');p.stdin.flush()
def wait(i):
 end=time.monotonic()+15
 while time.monotonic()<end:
  for k,_ in s.select(.2):
   line=k.fileobj.readline()
   if not line:return None
   d=json.loads(line)
   if d.get('id')==i: return d
 return None
try:
 send({'id':1,'method':'initialize','params':{'clientInfo':{'name':'loop-hook-probe','version':'1'},'capabilities':{'experimentalApi':True}}}); a=wait(1);print('initialize',bool(a and 'result' in a))
 send({'method':'initialized','params':{}})
 send({'id':2,'method':'thread/start','params':{'cwd':str(root),'ephemeral':True,'model':'gpt-6.1-sol'}});a=wait(2);print('thread/start',bool(a and 'result' in a),'error',a.get('error') if a else 'timeout')
 send({'id':3,'method':'hooks/list','params':{'cwds':[str(root)]}}); a=wait(3)
 def scan(v):
  if isinstance(v,dict):
   selected={k:x for k,x in v.items() if k in ['eventName','enabled','trusted','needsTrust','managed','trustStatus']}
   if selected: print('hook metadata',selected)
   for x in v.values():scan(x)
  elif isinstance(v,list):
   for x in v:scan(x)
 scan(a)
 time.sleep(1)
 f=root/'receipt.json';print('startup receipt',f.read_text() if f.exists() else 'absent');print('probe directory',root)
finally:
 p.terminate()
 try:p.wait(timeout=5)
 except subprocess.TimeoutExpired:p.kill();p.wait()
