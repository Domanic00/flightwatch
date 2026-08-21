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
  invited_at timestamptz default now(), last_login timestamptz, password_hash text);
ALTER TABLE beta_users ADD COLUMN IF NOT EXISTS password_hash text;
CREATE TABLE IF NOT EXISTS beta_user_profiles(
  user_id bigint primary key references beta_users(id) on delete cascade,
  email text default '',
  phone text default '',
  notify_email boolean default true,
  notify_sms boolean default false,
  quiet_hours_enabled boolean default false,
  quiet_start text default '22:00',
  quiet_end text default '08:00',
  max_price numeric default 150,
  nonstop_only boolean default false,
  updated_at timestamptz default now()
);

ALTER TABLE tracked ADD COLUMN IF NOT EXISTS owner_key text NOT NULL DEFAULT 'admin';
ALTER TABLE tracked ADD COLUMN IF NOT EXISTS group_id bigint;
ALTER TABLE watchlists ADD COLUMN IF NOT EXISTS owner_key text NOT NULL DEFAULT 'admin';
ALTER TABLE watchlists ADD COLUMN IF NOT EXISTS group_id bigint;
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS owner_key text NOT NULL DEFAULT 'admin';
CREATE INDEX IF NOT EXISTS tracked_owner_idx ON tracked(owner_key,created_at desc);
CREATE INDEX IF NOT EXISTS watchlists_owner_idx ON watchlists(owner_key,created_at desc);
CREATE INDEX IF NOT EXISTS alerts_owner_idx ON alerts(owner_key,created_at desc);

CREATE TABLE IF NOT EXISTS groups(
  id bigserial primary key,
  name text not null,
  owner_key text not null,
  created_at timestamptz default now()
);
CREATE TABLE IF NOT EXISTS group_members(
  group_id bigint references groups(id) on delete cascade,
  user_key text not null,
  role text default 'member',
  joined_at timestamptz default now(),
  primary key(group_id,user_key)
);
CREATE TABLE IF NOT EXISTS group_invites(
  id bigserial primary key,
  group_id bigint references groups(id) on delete cascade,
  email text not null,
  token text unique not null,
  status text default 'pending',
  invited_by text not null,
  created_at timestamptz default now(),
  accepted_at timestamptz
);


ALTER TABLE beta_users ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active';
ALTER TABLE beta_users ADD COLUMN IF NOT EXISTS suspended_at timestamptz;
ALTER TABLE beta_users ADD COLUMN IF NOT EXISTS suspension_reason text;
CREATE TABLE IF NOT EXISTS security_events(
 id bigserial primary key,actor_email text,action text not null,target_email text,details jsonb default '{}'::jsonb,created_at timestamptz default now());
CREATE INDEX IF NOT EXISTS security_events_created_idx ON security_events(created_at desc);
CREATE TABLE IF NOT EXISTS app_meta(key text primary key,value text);
`)}
const pRow=r=>({email:r.email||"",phone:r.phone||"",notifyEmail:r.notify_email,notifySms:r.notify_sms,quietHoursEnabled:r.quiet_hours_enabled,quietStart:r.quiet_start,quietEnd:r.quiet_end,maxPrice:Number(r.max_price||150),nonstopOnly:r.nonstop_only});
async function getProfile(){if(!usePostgres)return read().profile;return pRow((await pool.query("select * from profile where id=1")).rows[0])}
async function saveProfile(p){const x={email:String(p.email||"").trim(),phone:String(p.phone||"").trim(),notifyEmail:!!p.notifyEmail,notifySms:!!p.notifySms,quietHoursEnabled:!!p.quietHoursEnabled,quietStart:p.quietStart||"22:00",quietEnd:p.quietEnd||"08:00",maxPrice:Math.max(1,Number(p.maxPrice||150)),nonstopOnly:!!p.nonstopOnly};if(!usePostgres){let d=read();d.profile=x;write(d);return x}const r=await pool.query(`update profile set email=$1,phone=$2,notify_email=$3,notify_sms=$4,quiet_hours_enabled=$5,quiet_start=$6,quiet_end=$7,max_price=$8,nonstop_only=$9,updated_at=now() where id=1 returning *`,[x.email,x.phone,x.notifyEmail,x.notifySms,x.quietHoursEnabled,x.quietStart,x.quietEnd,x.maxPrice,x.nonstopOnly]);return pRow(r.rows[0])}
async function getTrackedLegacy(){if(!usePostgres)return read().tracked;return (await pool.query("select * from tracked order by created_at desc")).rows.map(r=>({id:r.id,departureAirport:r.origin,arrivalAirport:r.destination_code,destination:r.destination_name,startDate:r.start_date,endDate:r.end_date,airline:r.airline}))}
async function addTrackedLegacy(x){const d={id:String(x.id),departureAirport:x.departureAirport||"",arrivalAirport:x.arrivalAirport||"",destination:x.destination||"",startDate:x.startDate||null,endDate:x.endDate||null,airline:x.airline||""};if(!usePostgres){let a=read();a.tracked=[d,...a.tracked.filter(v=>v.id!==d.id)];write(a);return d}await pool.query(`insert into tracked(id,origin,destination_code,destination_name,start_date,end_date,airline) values($1,$2,$3,$4,$5,$6,$7) on conflict(id) do nothing`,[d.id,d.departureAirport,d.arrivalAirport,d.destination,d.startDate,d.endDate,d.airline]);return d}
async function removeTrackedLegacy(id){if(!usePostgres){let d=read();d.tracked=d.tracked.filter(x=>x.id!==id);write(d);return}await pool.query("delete from tracked where id=$1",[id])}
async function getWatchlistsLegacy(){if(!usePostgres)return read().watchlists;return (await pool.query("select * from watchlists order by created_at desc")).rows.map(r=>({id:r.id,label:r.label,origin:r.origin,destinationCode:r.destination_code,destinationName:r.destination_name,maxPrice:Number(r.max_price),nonstopOnly:r.nonstop_only,enabled:r.enabled}))}
async function addWatchlistLegacy(w){const x={id:`watch-${Date.now()}-${Math.random().toString(16).slice(2)}`,label:String(w.label||"My watchlist"),origin:["MCO","MIA","BOTH"].includes(w.origin)?w.origin:"BOTH",destinationCode:String(w.destinationCode||"ANY").toUpperCase(),destinationName:String(w.destinationName||""),maxPrice:Math.max(1,Number(w.maxPrice||150)),nonstopOnly:!!w.nonstopOnly,enabled:true};if(!usePostgres){let d=read();d.watchlists.unshift(x);write(d);return x}await pool.query(`insert into watchlists(id,label,origin,destination_code,destination_name,max_price,nonstop_only,enabled) values($1,$2,$3,$4,$5,$6,$7,true)`,[x.id,x.label,x.origin,x.destinationCode,x.destinationName,x.maxPrice,x.nonstopOnly]);return x}
async function removeWatchlistLegacy(id){if(!usePostgres){let d=read();d.watchlists=d.watchlists.filter(x=>x.id!==id);write(d);return}await pool.query("delete from watchlists where id=$1",[id])}
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
async function getAlertsLegacy(limit=100){
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


async function findBetaUserByEmail(email){email=String(email||"").trim().toLowerCase();if(!usePostgres)return (read().betaUsers||[]).find(x=>x.email===email)||null;return (await pool.query(`select id,email,role,enabled,status,password_hash as "passwordHash",last_login as "lastLogin" from beta_users where email=$1 limit 1`,[email])).rows[0]||null}
async function setBetaPassword(id,hash){if(!usePostgres){let d=read(),u=(d.betaUsers||[]).find(x=>String(x.id)===String(id));if(u)u.passwordHash=hash;write(d);return}await pool.query("update beta_users set password_hash=$2 where id=$1",[id,hash])}
async function markBetaLogin(id){if(!usePostgres){let d=read(),u=(d.betaUsers||[]).find(x=>String(x.id)===String(id));if(u)u.lastLogin=new Date().toISOString();write(d);return}await pool.query("update beta_users set last_login=now() where id=$1",[id])}


async function getUserProfile(user){
  if(!user || ["admin","super_admin"].includes(user.role)) return getProfile();
  if(!usePostgres){
    let d=read(); d.userProfiles=d.userProfiles||{};
    return d.userProfiles[String(user.id)] || {
      email:user.email||"",phone:"",notifyEmail:true,notifySms:false,quietHoursEnabled:false,
      quietStart:"22:00",quietEnd:"08:00",maxPrice:150,nonstopOnly:false
    };
  }
  const {rows}=await pool.query(`select email,phone,notify_email,notify_sms,quiet_hours_enabled,quiet_start,quiet_end,max_price,nonstop_only from beta_user_profiles where user_id=$1`,[user.id]);
  if(!rows.length)return {email:user.email||"",phone:"",notifyEmail:true,notifySms:false,quietHoursEnabled:false,quietStart:"22:00",quietEnd:"08:00",maxPrice:150,nonstopOnly:false};
  return pRow(rows[0]);
}
async function saveUserProfile(user,p){
  if(!user || ["admin","super_admin"].includes(user.role)) return saveProfile(p);
  const x={email:user.email||String(p.email||"").trim(),phone:String(p.phone||"").trim(),notifyEmail:!!p.notifyEmail,notifySms:!!p.notifySms,quietHoursEnabled:!!p.quietHoursEnabled,quietStart:p.quietStart||"22:00",quietEnd:p.quietEnd||"08:00",maxPrice:Math.max(1,Number(p.maxPrice||150)),nonstopOnly:!!p.nonstopOnly};
  if(!usePostgres){
    let d=read(); d.userProfiles=d.userProfiles||{}; d.userProfiles[String(user.id)]=x; write(d); return x;
  }
  const {rows}=await pool.query(`insert into beta_user_profiles(user_id,email,phone,notify_email,notify_sms,quiet_hours_enabled,quiet_start,quiet_end,max_price,nonstop_only)
    values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
    on conflict(user_id) do update set email=excluded.email,phone=excluded.phone,notify_email=excluded.notify_email,notify_sms=excluded.notify_sms,
    quiet_hours_enabled=excluded.quiet_hours_enabled,quiet_start=excluded.quiet_start,quiet_end=excluded.quiet_end,max_price=excluded.max_price,
    nonstop_only=excluded.nonstop_only,updated_at=now()
    returning email,phone,notify_email,notify_sms,quiet_hours_enabled,quiet_start,quiet_end,max_price,nonstop_only`,
    [user.id,x.email,x.phone,x.notifyEmail,x.notifySms,x.quietHoursEnabled,x.quietStart,x.quietEnd,x.maxPrice,x.nonstopOnly]);
  return pRow(rows[0]);
}


const ownerKey=u=>["admin","super_admin"].includes(u?.role)?"admin":String(u?.id||"anonymous");
async function groupIdsFor(user){
  const key=ownerKey(user); if(!usePostgres)return [];
  return (await pool.query("select group_id from group_members where user_key=$1",[key])).rows.map(r=>Number(r.group_id));
}
async function getTracked(user){
  const key=ownerKey(user);
  if(!usePostgres){let d=read();return (d.tracked||[]).filter(x=>(x.ownerKey||"admin")===key)}
  const gids=await groupIdsFor(user);
  const {rows}=await pool.query(`select * from tracked where owner_key=$1 or (group_id is not null and group_id=any($2::bigint[])) order by created_at desc`,[key,gids]);
  return rows.map(r=>({id:r.id,departureAirport:r.origin,arrivalAirport:r.destination_code,destination:r.destination_name,startDate:r.start_date,endDate:r.end_date,airline:r.airline,groupId:r.group_id?Number(r.group_id):null,shared:r.owner_key!==key}))
}
async function addTracked(x,user){
  const key=ownerKey(user),gid=x.groupId?Number(x.groupId):null;
  const d={id:String(x.id),departureAirport:x.departureAirport||"",arrivalAirport:x.arrivalAirport||"",destination:x.destination||"",startDate:x.startDate||null,endDate:x.endDate||null,airline:x.airline||"",ownerKey:key,groupId:gid};
  if(!usePostgres){let a=read();a.tracked=[d,...(a.tracked||[]).filter(v=>!(v.id===d.id&&(v.ownerKey||"admin")===key))];write(a);return d}
  const scopedId=`${key}:${gid||"private"}:${d.id}`;
  await pool.query(`insert into tracked(id,origin,destination_code,destination_name,start_date,end_date,airline,owner_key,group_id) values($1,$2,$3,$4,$5,$6,$7,$8,$9) on conflict(id) do nothing`,[scopedId,d.departureAirport,d.arrivalAirport,d.destination,d.startDate,d.endDate,d.airline,key,gid]);d.id=scopedId;return d
}
async function removeTracked(id,user){
  const key=ownerKey(user);if(!usePostgres){let d=read();d.tracked=(d.tracked||[]).filter(x=>!(x.id===id&&(x.ownerKey||"admin")===key));write(d);return}
  await pool.query("delete from tracked where id=$1 and owner_key=$2",[id,key])
}
async function getWatchlists(user){
  const key=ownerKey(user);
  if(!usePostgres){return (read().watchlists||[]).filter(x=>(x.ownerKey||"admin")===key)}
  const gids=await groupIdsFor(user);
  const {rows}=await pool.query(`select * from watchlists where owner_key=$1 or (group_id is not null and group_id=any($2::bigint[])) order by created_at desc`,[key,gids]);
  return rows.map(r=>({id:r.id,label:r.label,origin:r.origin,destinationCode:r.destination_code,destinationName:r.destination_name,maxPrice:Number(r.max_price),nonstopOnly:r.nonstop_only,enabled:r.enabled,groupId:r.group_id?Number(r.group_id):null,shared:r.owner_key!==key}))
}
async function addWatchlist(w,user){
  const key=ownerKey(user),gid=w.groupId?Number(w.groupId):null;
  const x={id:`watch-${key}-${Date.now()}-${Math.random().toString(16).slice(2)}`,label:String(w.label||"My watchlist"),origin:["MCO","MIA","BOTH"].includes(w.origin)?w.origin:"BOTH",destinationCode:String(w.destinationCode||"ANY").toUpperCase(),destinationName:String(w.destinationName||""),maxPrice:Math.max(1,Number(w.maxPrice||150)),nonstopOnly:!!w.nonstopOnly,enabled:true,groupId:gid};
  if(!usePostgres){let d=read();d.watchlists=d.watchlists||[];d.watchlists.unshift({...x,ownerKey:key});write(d);return x}
  await pool.query(`insert into watchlists(id,label,origin,destination_code,destination_name,max_price,nonstop_only,enabled,owner_key,group_id) values($1,$2,$3,$4,$5,$6,$7,true,$8,$9)`,[x.id,x.label,x.origin,x.destinationCode,x.destinationName,x.maxPrice,x.nonstopOnly,key,gid]);return x
}
async function removeWatchlist(id,user){const key=ownerKey(user);if(!usePostgres){let d=read();d.watchlists=(d.watchlists||[]).filter(x=>!(x.id===id&&(x.ownerKey||"admin")===key));write(d);return}await pool.query("delete from watchlists where id=$1 and owner_key=$2",[id,key])}
async function getAlerts(limit=100,user){
  limit=Math.min(500,Math.max(1,Number(limit)||100));const key=ownerKey(user);
  if(!usePostgres)return (read().alerts||[]).filter(x=>(x.ownerKey||"admin")===key).slice(0,limit);
  return (await pool.query(`select fingerprint,watchlist_id as "watchlistId",watchlist_label as "watchlistLabel",origin,destination_code as "destinationCode",destination_name as "destinationName",price,historical_avg as "historicalAvg",historical_low as "historicalLow",score,reason,email_status as "emailStatus",sms_status as "smsStatus",flight_link as "flightLink",created_at as "createdAt" from alerts where owner_key=$2 order by created_at desc limit $1`,[limit,key])).rows.map(x=>({...x,price:Number(x.price),historicalAvg:x.historicalAvg?Number(x.historicalAvg):null,historicalLow:x.historicalLow?Number(x.historicalLow):null}))
}
async function getGroups(user){
  const key=ownerKey(user);if(!usePostgres)return [];
  return (await pool.query(`select g.id,g.name,g.owner_key as "ownerKey",gm.role,(select count(*)::int from group_members m where m.group_id=g.id) members from groups g join group_members gm on gm.group_id=g.id where gm.user_key=$1 order by g.created_at desc`,[key])).rows
}
async function createGroup(name,user){
  const key=ownerKey(user);name=String(name||"").trim();if(!name)throw new Error("Group name required");if(!usePostgres)throw new Error("Groups require PostgreSQL");
  const c=await pool.connect();try{await c.query("begin");const g=(await c.query("insert into groups(name,owner_key) values($1,$2) returning id,name",[name,key])).rows[0];await c.query("insert into group_members(group_id,user_key,role) values($1,$2,'owner')",[g.id,key]);await c.query("commit");return g}catch(e){await c.query("rollback");throw e}finally{c.release()}
}
async function inviteToGroup(groupId,email,user){
  const key=ownerKey(user);email=String(email||"").trim().toLowerCase();if(!email.includes("@"))throw new Error("Valid email required");
  const own=(await pool.query("select 1 from group_members where group_id=$1 and user_key=$2 and role='owner'",[groupId,key])).rowCount;if(!own)throw new Error("Only the group owner can invite");
  const token=require("crypto").randomBytes(18).toString("hex");const row=(await pool.query("insert into group_invites(group_id,email,token,invited_by) values($1,$2,$3,$4) returning id,token",[groupId,email,token,key])).rows[0];return row
}
async function getGroupInvites(user){
  if(["admin","super_admin"].includes(user?.role))return [];
  const email=String(user?.email||"").toLowerCase();if(!email)return [];
  return (await pool.query(`select i.id,i.group_id as "groupId",g.name,i.token from group_invites i join groups g on g.id=i.group_id where lower(i.email)=$1 and i.status='pending' order by i.created_at desc`,[email])).rows
}
async function acceptGroupInvite(token,user){
  const key=ownerKey(user),email=String(user?.email||"").toLowerCase();const c=await pool.connect();try{await c.query("begin");const i=(await c.query("select * from group_invites where token=$1 and status='pending' for update",[token])).rows[0];if(!i||String(i.email).toLowerCase()!==email)throw new Error("Invite not valid for this account");await c.query("insert into group_members(group_id,user_key,role) values($1,$2,'member') on conflict do nothing",[i.group_id,key]);await c.query("update group_invites set status='accepted',accepted_at=now() where id=$1",[i.id]);await c.query("commit");return {ok:true}}catch(e){await c.query("rollback");throw e}finally{c.release()}
}


async function bootstrapSuperAdmin(email){
 email=String(email||"").trim().toLowerCase();if(!email||!usePostgres)return;
 await pool.query("update beta_users set role='super_admin',status='active',enabled=true where lower(email)=lower($1)",[email]);
}
async function securityEvent(actor,action,targetEmail="",details={}){
 if(!usePostgres)return;
 await pool.query("insert into security_events(actor_email,action,target_email,details) values($1,$2,$3,$4::jsonb)",[actor?.email||"system",action,targetEmail||null,JSON.stringify(details||{})]);
}
async function listManagedUsers(){
 if(!usePostgres)return read().betaUsers||[];
 return (await pool.query(`select id,email,role,enabled,status,invited_at as "invitedAt",last_login as "lastLogin",suspended_at as "suspendedAt",suspension_reason as "suspensionReason" from beta_users order by invited_at desc`)).rows;
}
async function setManagedUserRole(id,role,actor){
 role=String(role||"").toLowerCase();if(!["user","admin","super_admin"].includes(role))throw new Error("Invalid role");
 const old=(await pool.query("select id,email,role from beta_users where id=$1",[id])).rows[0];if(!old)throw new Error("Account not found");
 const row=(await pool.query("update beta_users set role=$2 where id=$1 returning id,email,role,enabled,status",[id,role])).rows[0];
 await securityEvent(actor,"role_changed",row.email,{from:old.role,to:role});return row;
}
async function setManagedUserStatus(id,status,reason,actor){
 if(!["active","suspended","revoked"].includes(status))throw new Error("Invalid status");
 const old=(await pool.query("select id,email,role,status from beta_users where id=$1",[id])).rows[0];if(!old)throw new Error("Account not found");
 if(String(old.email).toLowerCase()===String(actor?.email||"").toLowerCase())throw new Error("You cannot suspend or revoke your own account");
 const row=(await pool.query(`update beta_users set status=$2,enabled=$3,suspended_at=case when $2='suspended' then now() else null end,suspension_reason=case when $2='suspended' then $4 else null end where id=$1 returning id,email,role,enabled,status`,[id,status,status==="active",String(reason||"").slice(0,500)])).rows[0];
 await securityEvent(actor,"account_status_changed",row.email,{from:old.status||"active",to:status,reason:String(reason||"").slice(0,500)});return row;
}
async function getSecurityEvents(limit=200){
 if(!usePostgres)return [];
 limit=Math.min(500,Math.max(1,Number(limit)||200));
 return (await pool.query(`select id,actor_email as "actorEmail",action,target_email as "targetEmail",details,created_at as "createdAt" from security_events order by created_at desc limit $1`,[limit])).rows;
}

module.exports={init,bootstrapSuperAdmin,securityEvent,listManagedUsers,setManagedUserRole,setManagedUserStatus,getSecurityEvents,getGroups,createGroup,inviteToGroup,getGroupInvites,acceptGroupInvite,getUserProfile,saveUserProfile,findBetaUserByEmail,setBetaPassword,markBetaLogin,logError,getErrors,setErrorStatus,audit,getAudit,getBetaUsers,addBetaUser,removeBetaUser,usePostgres,getProfile,saveProfile,getTracked,addTracked,removeTracked,getWatchlists,addWatchlist,removeWatchlist,saveSnapshots,history,routeStats,alertExists,createAlert,updateAlertDelivery,getAlerts,setMeta,status};
