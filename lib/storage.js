const fs=require("fs"),path=require("path"); const {Pool}=require("pg");
const usePostgres=Boolean(process.env.DATABASE_URL); let pool=null;
const dataDir=path.join(__dirname,"..",".data"), dataFile=path.join(dataDir,"flightwatch.json");
const blank=()=>({
  profile:{email:"",phone:"",notifyEmail:true,notifySms:false,quietHoursEnabled:false,quietStart:"22:00",quietEnd:"08:00",maxPrice:150,nonstopOnly:false},
  tracked:[],watchlists:[],snapshots:[],alerts:[],meta:{lastFlightCheck:null,lastAutomationRun:null}
});
function ensure(){if(!fs.existsSync(dataDir))fs.mkdirSync(dataDir,{recursive:true});if(!fs.existsSync(dataFile))fs.writeFileSync(dataFile,JSON.stringify(blank(),null,2))}
function read(){ensure();try{const d=JSON.parse(fs.readFileSync(dataFile,"utf8"));return {...blank(),...d,profile:{...blank().profile,...(d.profile||{})},meta:{...blank().meta,...(d.meta||{})},alerts:d.alerts||[]}}catch{return blank()}}
function write(d){ensure();fs.writeFileSync(dataFile,JSON.stringify(d,null,2))}
async function init(){if(!usePostgres){ensure();return} pool=new Pool({connectionString:process.env.DATABASE_URL,ssl:{rejectUnauthorized:false}});
await pool.query(`
CREATE TABLE IF NOT EXISTS profile(
  id int primary key,email text default '',phone text default '',notify_email boolean default true,notify_sms boolean default false,
  quiet_hours_enabled boolean default false,quiet_start text default '22:00',quiet_end text default '08:00',
  max_price numeric default 150,nonstop_only boolean default false,updated_at timestamptz default now());
INSERT INTO profile(id) VALUES(1) ON CONFLICT(id) DO NOTHING;

CREATE TABLE IF NOT EXISTS tracked(
  id text primary key,origin text,destination_code text,destination_name text,start_date text,end_date text,airline text,
  created_at timestamptz default now());

CREATE TABLE IF NOT EXISTS watchlists(
  id text primary key,label text,origin text,destination_code text,destination_name text,max_price numeric,
  nonstop_only boolean default false,enabled boolean default true,created_at timestamptz default now());

CREATE TABLE IF NOT EXISTS snapshots(
  id bigserial primary key,deal_key text,origin text,destination_code text,destination_name text,start_date text,end_date text,
  airline text,stops int,duration_minutes int,price numeric,captured_at timestamptz default now());
CREATE INDEX IF NOT EXISTS snapshots_route_idx ON snapshots(origin,destination_code,captured_at);

CREATE TABLE IF NOT EXISTS alerts(
  id bigserial primary key,
  fingerprint text unique not null,
  watchlist_id text,
  watchlist_label text,
  origin text,
  destination_code text,
  destination_name text,
  price numeric,
  historical_avg numeric,
  historical_low numeric,
  score text,
  reason text,
  email_status text default 'not_requested',
  sms_status text default 'not_requested',
  flight_link text,
  created_at timestamptz default now()
);
CREATE INDEX IF NOT EXISTS alerts_created_idx ON alerts(created_at desc);

CREATE TABLE IF NOT EXISTS app_errors(
  id bigserial primary key, fingerprint text unique not null, service text, code text, message text,
  details text, status text default 'open', occurrence_count int default 1,
  first_seen timestamptz default now(), last_seen timestamptz default now(), resolved_at timestamptz);
CREATE INDEX IF NOT EXISTS app_errors_status_idx ON app_errors(status,last_seen desc);
CREATE TABLE IF NOT EXISTS audit_log(
  id bigserial primary key, action text not null, actor text default 'admin', details text,
  created_at timestamptz default now());
CREATE TABLE IF NOT EXISTS beta_users(
  id bigserial primary key, email text unique not null, role text default 'tester', enabled boolean default true,
  invited_at timestamptz default now(), last_login timestamptz);
CREATE TABLE IF NOT EXISTS app_meta(key text primary key,value text);
`)}
const pRow=r=>({email:r.email||"",phone:r.phone||"",notifyEmail:r.notify_email,notifySms:r.notify_sms,quietHoursEnabled:r.quiet_hours_enabled,quietStart:r.quiet_start,quietEnd:r.quiet_end,maxPrice:Number(r.max_price||150),nonstopOnly:r.nonstop_only});
async function getProfile(){if(!usePostgres)return read().profile;return pRow((await pool.query("select * from profile where id=1")).rows[0])}
async function saveProfile(p){const x={email:String(p.email||"").trim(),phone:String(p.phone||"").trim(),notifyEmail:!!p.notifyEmail,notifySms:!!p.notifySms,quietHoursEnabled:!!p.quietHoursEnabled,quietStart:p.quietStart||"22:00",quietEnd:p.quietEnd||"08:00",maxPrice:Math.max(1,Number(p.maxPrice||150)),nonstopOnly:!!p.nonstopOnly};if(!usePostgres){let d=read();d.profile=x;write(d);return x}const r=await pool.query(`update profile set email=$1,phone=$2,notify_email=$3,notify_sms=$4,quiet_hours_enabled=$5,quiet_start=$6,quiet_end=$7,max_price=$8,nonstop_only=$9,updated_at=now() where id=1 returning *`,[x.email,x.phone,x.notifyEmail,x.notifySms,x.quietHoursEnabled,x.quietStart,x.quietEnd,x.maxPrice,x.nonstopOnly]);return pRow(r.rows[0])}
async function getTracked(){if(!usePostgres)return read().tracked;return (await pool.query("select * from tracked order by created_at desc")).rows.map(r=>({id:r.id,departureAirport:r.origin,arrivalAirport:r.destination_code,destination:r.destination_name,startDate:r.start_date,endDate:r.end_date,airline:r.airline}))}
async function addTracked(x){const d={id:String(x.id),departureAirport:x.departureAirport||"",arrivalAirport:x.arrivalAirport||"",destination:x.destination||"",startDate:x.startDate||null,endDate:x.endDate||null,airline:x.airline||""};if(!usePostgres){let a=read();a.tracked=[d,...a.tracked.filter(v=>v.id!==d.id)];write(a);return d}await pool.query(`insert into tracked(id,origin,destination_code,destination_name,start_date,end_date,airline) values($1,$2,$3,$4,$5,$6,$7) on conflict(id) do nothing`,[d.id,d.departureAirport,d.arrivalAirport,d.destination,d.startDate,d.endDate,d.airline]);return d}
async function removeTracked(id){if(!usePostgres){let d=read();d.tracked=d.tracked.filter(x=>x.id!==id);write(d);return}await pool.query("delete from tracked where id=$1",[id])}
async function getWatchlists(){if(!usePostgres)return read().watchlists;return (await pool.query("select * from watchlists order by created_at desc")).rows.map(r=>({id:r.id,label:r.label,origin:r.origin,destinationCode:r.destination_code,destinationName:r.destination_name,maxPrice:Number(r.max_price),nonstopOnly:r.nonstop_only,enabled:r.enabled}))}
async function addWatchlist(w){const x={id:`watch-${Date.now()}-${Math.random().toString(16).slice(2)}`,label:String(w.label||"My watchlist"),origin:["MCO","MIA","BOTH"].includes(w.origin)?w.origin:"BOTH",destinationCode:String(w.destinationCode||"ANY").toUpperCase(),destinationName:String(w.destinationName||""),maxPrice:Math.max(1,Number(w.maxPrice||150)),nonstopOnly:!!w.nonstopOnly,enabled:true};if(!usePostgres){let d=read();d.watchlists.unshift(x);write(d);return x}await pool.query(`insert into watchlists(id,label,origin,destination_code,destination_name,max_price,nonstop_only,enabled) values($1,$2,$3,$4,$5,$6,$7,true)`,[x.id,x.label,x.origin,x.destinationCode,x.destinationName,x.maxPrice,x.nonstopOnly]);return x}
async function removeWatchlist(id){if(!usePostgres){let d=read();d.watchlists=d.watchlists.filter(x=>x.id!==id);write(d);return}await pool.query("delete from watchlists where id=$1",[id])}
async function saveSnapshots(deals){
  if(!deals.length)return; const now=new Date().toISOString();
  if(!usePostgres){let d=read();for(const x of deals)d.snapshots.push({origin:x.departureAirport,destinationCode:x.arrivalAirport||"",destinationName:x.destination||"",startDate:x.startDate||null,endDate:x.endDate||null,airline:x.airline||"",stops:x.stops??null,durationMinutes:x.flightDuration??null,price:Number(x.price),capturedAt:now});d.snapshots=d.snapshots.slice(-20000);d.meta.lastFlightCheck=now;write(d);return}
  const c=await pool.connect();try{await c.query("begin");for(const x of deals)await c.query(`insert into snapshots(deal_key,origin,destination_code,destination_name,start_date,end_date,airline,stops,duration_minutes,price) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[`${x.departureAirport}|${x.arrivalAirport||x.destination}|${x.startDate||""}|${x.endDate||""}`,x.departureAirport,x.arrivalAirport||"",x.destination||"",x.startDate||null,x.endDate||null,x.airline||"",x.stops??null,x.flightDuration??null,x.price]);await c.query(`insert into app_meta(key,value) values('lastFlightCheck',$1) on conflict(key) do update set value=excluded.value`,[now]);await c.query("commit")}catch(e){await c.query("rollback");throw e}finally{c.release()}
}
async function history(o,d,l=300){if(!usePostgres)return read().snapshots.filter(x=>(!o||x.origin===o)&&(!d||x.destinationCode===d)).slice(-l);return (await pool.query(`select origin,destination_code as "destinationCode",destination_name as "destinationName",start_date as "startDate",end_date as "endDate",airline,stops,duration_minutes as "durationMinutes",price,captured_at as "capturedAt" from snapshots where origin=$1 and destination_code=$2 order by captured_at asc limit $3`,[o,d,Math.min(1000,Number(l)||300)])).rows.map(x=>({...x,price:Number(x.price)}))}
async function routeStats(origin,destinationCode){
  if(!usePostgres){const rows=read().snapshots.filter(x=>x.origin===origin&&x.destinationCode===destinationCode);if(!rows.length)return null;const p=rows.map(x=>Number(x.price));return{count:p.length,avg:p.reduce((a,b)=>a+b,0)/p.length,low:Math.min(...p),high:Math.max(...p)}}
  const r=(await pool.query(`select count(*)::int count,avg(price)::numeric avg,min(price)::numeric low,max(price)::numeric high from snapshots where origin=$1 and destination_code=$2 and captured_at>now()-interval '90 days'`,[origin,destinationCode])).rows[0];if(!r||!r.count)return null;return{count:r.count,avg:Number(r.avg),low:Number(r.low),high:Number(r.high)}
}
async function alertExists(fingerprint){if(!usePostgres)return read().alerts.some(a=>a.fingerprint===fingerprint);return (await pool.query("select 1 from alerts where fingerprint=$1 limit 1",[fingerprint])).rowCount>0}
async function createAlert(a){
  const row={...a,createdAt:new Date().toISOString()};
  if(!usePostgres){let d=read();if(d.alerts.some(x=>x.fingerprint===a.fingerprint))return null;d.alerts.unshift(row);d.alerts=d.alerts.slice(0,1000);write(d);return row}
  const {rows}=await pool.query(`insert into alerts(fingerprint,watchlist_id,watchlist_label,origin,destination_code,destination_name,price,historical_avg,historical_low,score,reason,email_status,sms_status,flight_link)
  values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) on conflict(fingerprint) do nothing returning *`,
  [a.fingerprint,a.watchlistId,a.watchlistLabel,a.origin,a.destinationCode,a.destinationName,a.price,a.historicalAvg,a.historicalLow,a.score,a.reason,a.emailStatus||"not_requested",a.smsStatus||"not_requested",a.flightLink||null]);
  return rows[0]||null
}
async function updateAlertDelivery(fingerprint,emailStatus,smsStatus){if(!usePostgres){let d=read(),a=d.alerts.find(x=>x.fingerprint===fingerprint);if(a){a.emailStatus=emailStatus;a.smsStatus=smsStatus;write(d)}return}await pool.query("update alerts set email_status=$2,sms_status=$3 where fingerprint=$1",[fingerprint,emailStatus,smsStatus])}
async function getAlerts(limit=100){
  limit=Math.min(500,Math.max(1,Number(limit)||100));
  if(!usePostgres)return read().alerts.slice(0,limit);
  return (await pool.query(`select fingerprint,watchlist_id as "watchlistId",watchlist_label as "watchlistLabel",origin,destination_code as "destinationCode",destination_name as "destinationName",price,historical_avg as "historicalAvg",historical_low as "historicalLow",score,reason,email_status as "emailStatus",sms_status as "smsStatus",flight_link as "flightLink",created_at as "createdAt" from alerts order by created_at desc limit $1`,[limit])).rows.map(x=>({...x,price:Number(x.price),historicalAvg:x.historicalAvg?Number(x.historicalAvg):null,historicalLow:x.historicalLow?Number(x.historicalLow):null}))
}
async function setMeta(key,value){if(!usePostgres){let d=read();d.meta[key]=value;write(d);return}await pool.query(`insert into app_meta(key,value) values($1,$2) on conflict(key) do update set value=excluded.value`,[key,String(value)])}
async function status(){
  if(!usePostgres){let d=read();return{database:"Local JSON",lastFlightCheck:d.meta.lastFlightCheck,lastAutomationRun:d.meta.lastAutomationRun,snapshots:d.snapshots.length,tracked:d.tracked.length,watchlists:d.watchlists.length,alerts:d.alerts.length}}
  const [s,t,w,a,m1,m2]=await Promise.all([pool.query("select count(*)::int c from snapshots"),pool.query("select count(*)::int c from tracked"),pool.query("select count(*)::int c from watchlists"),pool.query("select count(*)::int c from alerts"),pool.query("select value from app_meta where key='lastFlightCheck'"),pool.query("select value from app_meta where key='lastAutomationRun'")]);
  return{database:"PostgreSQL",lastFlightCheck:m1.rows[0]?.value||null,lastAutomationRun:m2.rows[0]?.value||null,snapshots:s.rows[0].c,tracked:t.rows[0].c,watchlists:w.rows[0].c,alerts:a.rows[0].c}
}

async function logError(e){
  const x={service:String(e.service||"app"),code:String(e.code||"UNKNOWN"),message:String(e.message||"Unknown error"),details:String(e.details||"")};
  const fingerprint=`${x.service}|${x.code}|${x.message}`.slice(0,900);
  if(!usePostgres){let d=read();d.errors=d.errors||[];let row=d.errors.find(v=>v.fingerprint===fingerprint);if(row){row.occurrenceCount=(row.occurrenceCount||1)+1;row.lastSeen=new Date().toISOString();row.details=x.details;row.status="open"}else d.errors.unshift({...x,fingerprint,status:"open",occurrenceCount:1,firstSeen:new Date().toISOString(),lastSeen:new Date().toISOString()});write(d);return}
  await pool.query(`insert into app_errors(fingerprint,service,code,message,details) values($1,$2,$3,$4,$5)
  on conflict(fingerprint) do update set occurrence_count=app_errors.occurrence_count+1,last_seen=now(),details=excluded.details,status='open',resolved_at=null`,
  [fingerprint,x.service,x.code,x.message,x.details]);
}
async function getErrors(limit=100){limit=Math.min(500,Math.max(1,Number(limit)||100));if(!usePostgres)return (read().errors||[]).slice(0,limit);return (await pool.query(`select id,fingerprint,service,code,message,details,status,occurrence_count as "occurrenceCount",first_seen as "firstSeen",last_seen as "lastSeen",resolved_at as "resolvedAt" from app_errors order by case when status='open' then 0 else 1 end,last_seen desc limit $1`,[limit])).rows}
async function setErrorStatus(id,status){status=["open","acknowledged","resolved"].includes(status)?status:"open";if(!usePostgres){let d=read(),x=(d.errors||[]).find(v=>String(v.id)===String(id)||v.fingerprint===id);if(x)x.status=status;write(d);return}await pool.query(`update app_errors set status=$2,resolved_at=case when $2='resolved' then now() else null end where id=$1`,[id,status])}
async function audit(action,details="",actor="admin"){if(!usePostgres){let d=read();d.audit=d.audit||[];d.audit.unshift({action,details,actor,createdAt:new Date().toISOString()});write(d);return}await pool.query("insert into audit_log(action,actor,details) values($1,$2,$3)",[action,actor,String(details||"")])}
async function getAudit(limit=100){limit=Math.min(500,Math.max(1,Number(limit)||100));if(!usePostgres)return (read().audit||[]).slice(0,limit);return (await pool.query(`select id,action,actor,details,created_at as "createdAt" from audit_log order by created_at desc limit $1`,[limit])).rows}
async function getBetaUsers(){if(!usePostgres)return read().betaUsers||[];return (await pool.query(`select id,email,role,enabled,invited_at as "invitedAt",last_login as "lastLogin" from beta_users order by invited_at desc`)).rows}
async function addBetaUser(email,role="tester"){email=String(email||"").trim().toLowerCase();if(!email||!email.includes("@"))throw new Error("Valid email required");if(!usePostgres){let d=read();d.betaUsers=d.betaUsers||[];if(!d.betaUsers.some(x=>x.email===email))d.betaUsers.unshift({id:Date.now(),email,role,enabled:true,invitedAt:new Date().toISOString()});write(d);return}await pool.query(`insert into beta_users(email,role) values($1,$2) on conflict(email) do update set enabled=true,role=excluded.role`,[email,role])}
async function removeBetaUser(id){if(!usePostgres){let d=read();d.betaUsers=(d.betaUsers||[]).filter(x=>String(x.id)!==String(id));write(d);return}await pool.query("delete from beta_users where id=$1",[id])}

module.exports={init,logError,getErrors,setErrorStatus,audit,getAudit,getBetaUsers,addBetaUser,removeBetaUser,usePostgres,getProfile,saveProfile,getTracked,addTracked,removeTracked,getWatchlists,addWatchlist,removeWatchlist,saveSnapshots,history,routeStats,alertExists,createAlert,updateAlertDelivery,getAlerts,setMeta,status};
