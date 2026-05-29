// DRIVE-BACKED data function. Replaces dm_site/netlify/functions/data.mjs when automation
// is live: serves the bundle from a Drive file (refreshed by GitHub Actions hourly/daily)
// so the dashboard self-refreshes WITHOUT any Netlify redeploy.
// Auth gate identical to data.mjs (@openhouse.in Google token). Falls back to bundled
// _data.json if the Drive fetch fails. ~15-min in-memory cache.
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { createSign } from 'node:crypto';

const CLIENT_ID='548383854454-unmiq03djs8rhoqr9ot2747huthok1rj.apps.googleusercontent.com';
const ALLOWED='openhouse.in';
const DRIVE_FILE_ID=process.env.DRIVE_BUNDLE_FILE_ID||''; // set as Netlify env var
let CACHE=null, CACHE_AT=0;
const TTL=15*60*1000;
const j=(o,s)=>new Response(JSON.stringify(o),{status:s,headers:{'content-type':'application/json'}});
const b64=b=>Buffer.from(b).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');

async function saToken(){
  const sa=JSON.parse(readFileSync(new URL('./_sa.json',import.meta.url),'utf8'));
  const now=Math.floor(Date.now()/1000);
  const h=b64(JSON.stringify({alg:'RS256',typ:'JWT'}));
  const c=b64(JSON.stringify({iss:sa.client_email,scope:'https://www.googleapis.com/auth/drive.readonly',
    aud:'https://oauth2.googleapis.com/token',iat:now,exp:now+3600}));
  const s=createSign('RSA-SHA256'); s.update(h+'.'+c);
  const a=`${h}.${c}.${b64(s.sign(sa.private_key))}`;
  const r=await fetch('https://oauth2.googleapis.com/token',{method:'POST',
    headers:{'content-type':'application/x-www-form-urlencoded'},
    body:`grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${a}`});
  return (await r.json()).access_token;
}
async function loadBundleGz(){
  if(CACHE && Date.now()-CACHE_AT<TTL) return CACHE;
  try{
    if(DRIVE_FILE_ID){
      const tok=await saToken();
      const r=await fetch(`https://www.googleapis.com/drive/v3/files/${DRIVE_FILE_ID}?alt=media`,
        {headers:{authorization:'Bearer '+tok}});
      if(r.ok){ const buf=Buffer.from(await r.arrayBuffer());
        // file already stored gzip by pipeline.py
        CACHE=buf; CACHE_AT=Date.now(); return CACHE; }
    }
  }catch(e){/* fall through to baked */}
  CACHE=gzipSync(readFileSync(new URL('./_data.json',import.meta.url))); CACHE_AT=Date.now();
  return CACHE;
}
export default async (req)=>{
  if(req.method!=='POST') return j({error:'Method not allowed'},405);
  let body; try{body=await req.json();}catch{return j({error:'Bad request'},400);}
  const cred=body&&body.credential; if(!cred) return j({error:'Missing credential'},401);
  let t; try{ const r=await fetch('https://oauth2.googleapis.com/tokeninfo?id_token='+encodeURIComponent(cred));
    if(!r.ok) return j({error:'Invalid Google token'},401); t=await r.json(); }
    catch{ return j({error:'Token verification failed'},401); }
  if(t.aud!==CLIENT_ID) return j({error:'Token audience mismatch'},401);
  if(String(t.email_verified)!=='true') return j({error:'Email not verified'},403);
  const dom=String(t.email||'').toLowerCase().split('@')[1]||'';
  if(dom!==ALLOWED && t.hd!==ALLOWED) return j({error:'Access restricted to @openhouse.in accounts'},403);
  const gz=await loadBundleGz();
  return new Response(gz,{status:200,headers:{'content-type':'application/json',
    'content-encoding':'gzip','cache-control':'no-store'}});
};
