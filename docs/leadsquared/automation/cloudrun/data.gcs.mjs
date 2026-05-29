// GCS-backed Netlify data function. Replaces dm_site/netlify/functions/data.mjs once
// Cloud Run is live. Auth gate identical (@openhouse.in Google token). Fetches the
// PRIVATE GCS bundle object via the bundled _sa.json (JWT->token), 15-min cache,
// gzip passthrough. Falls back to baked _data.json on any failure. No Netlify redeploy
// needed for data refresh — Cloud Run updates the GCS object hourly/daily.
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { createSign } from 'node:crypto';
const CLIENT_ID='548383854454-unmiq03djs8rhoqr9ot2747huthok1rj.apps.googleusercontent.com';
const ALLOWED='openhouse.in';
const BUCKET=process.env.GCS_BUCKET||'';
const OBJ=process.env.GCS_BUNDLE_OBJECT||'dm_bundle.json.gz';
let CACHE=null,AT=0; const TTL=15*60*1000;
const j=(o,s)=>new Response(JSON.stringify(o),{status:s,headers:{'content-type':'application/json'}});
const b64=b=>Buffer.from(b).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
async function saTok(){
  const sa=JSON.parse(readFileSync(new URL('./_sa.json',import.meta.url),'utf8'));
  const n=Math.floor(Date.now()/1000);
  const h=b64(JSON.stringify({alg:'RS256',typ:'JWT'}));
  const c=b64(JSON.stringify({iss:sa.client_email,scope:'https://www.googleapis.com/auth/devstorage.read_only',
    aud:'https://oauth2.googleapis.com/token',iat:n,exp:n+3600}));
  const s=createSign('RSA-SHA256');s.update(h+'.'+c);
  const a=`${h}.${c}.${b64(s.sign(sa.private_key))}`;
  const r=await fetch('https://oauth2.googleapis.com/token',{method:'POST',
    headers:{'content-type':'application/x-www-form-urlencoded'},
    body:`grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${a}`});
  return (await r.json()).access_token;
}
async function bundleGz(){
  if(CACHE&&Date.now()-AT<TTL)return CACHE;
  try{
    if(BUCKET){
      const tok=await saTok();
      const u=`https://storage.googleapis.com/storage/v1/b/${BUCKET}/o/${encodeURIComponent(OBJ)}?alt=media`;
      const r=await fetch(u,{headers:{authorization:'Bearer '+tok}});
      if(r.ok){ CACHE=Buffer.from(await r.arrayBuffer()); AT=Date.now(); return CACHE; }
    }
  }catch(e){/* fall back */}
  CACHE=gzipSync(readFileSync(new URL('./_data.json',import.meta.url))); AT=Date.now(); return CACHE;
}
export default async (req)=>{
  if(req.method!=='POST')return j({error:'Method not allowed'},405);
  let b;try{b=await req.json();}catch{return j({error:'Bad request'},400);}
  const cred=b&&b.credential; if(!cred)return j({error:'Missing credential'},401);
  let t;try{const r=await fetch('https://oauth2.googleapis.com/tokeninfo?id_token='+encodeURIComponent(cred));
    if(!r.ok)return j({error:'Invalid Google token'},401);t=await r.json();}
    catch{return j({error:'Token verification failed'},401);}
  if(t.aud!==CLIENT_ID)return j({error:'Token audience mismatch'},401);
  if(String(t.email_verified)!=='true')return j({error:'Email not verified'},403);
  const dom=String(t.email||'').toLowerCase().split('@')[1]||'';
  if(dom!==ALLOWED&&t.hd!==ALLOWED)return j({error:'Access restricted to @openhouse.in accounts'},403);
  const gz=await bundleGz();
  return new Response(gz,{status:200,headers:{'content-type':'application/json',
    'content-encoding':'gzip','cache-control':'no-store'}});
};
