const express=require("express"),path=require("path"),crypto=require("crypto"),cookieSession=require("cookie-session"),bcrypt=require("bcryptjs");require("dotenv").config();const db=require("./lib/storage");
const app=express(),PORT=process.env.PORT||3000;

app.set("trust proxy", 1);

app.use(express.json());

app.use(cookieSession({
    name:"fw",
    keys:[process.env.SESSION_SECRET||"local-dev-secret"],
    maxAge:2592000000,
    httpOnly:true,
    sameSite:"lax",
    secure:process.env.NODE_ENV==="production"
}));
const protectedMode=Boolean(process.env.APP_PASSWORD);
function isSuperAdmin(q){return q.session?.user?.role==="super_admin"}
function isAdmin(q){return ["admin","super_admin"].includes(q.session?.user?.role)}
app.get("/api/auth/status",(q,r)=>r.json({protected:protectedMode,authenticated:!!q.session?.user,user:q.session?.user||null}));
app.get("/api/auth/me",(q,r)=>r.json({authenticated:!!q.session?.user,user:q.session?.user||null}));
app.post("/api/auth/login",async(q,r)=>{const email=String(q.body?.email||"").trim().toLowerCase(),password=String(q.body?.password||"");const superAdminEmail=String(process.env.SUPER_ADMIN_EMAIL||process.env.ADMIN_EMAIL||"").trim().toLowerCase();
  const masterUsernameOk=!email||email==="admin"||(superAdminEmail&&email===superAdminEmail);
  if(process.env.APP_PASSWORD&&password===process.env.APP_PASSWORD&&masterUsernameOk){
    const adminEmail=superAdminEmail||"admin";
    q.session.user={id:"admin",email:adminEmail,role:"super_admin"};
    await db.audit("login","Super Admin signed in",adminEmail);
    return r.json({ok:true,user:q.session.user})
  }const u=await db.findBetaUserByEmail(email);if(!u||!u.enabled||u.status==="suspended"||u.status==="revoked")return r.status(401).json({error:"Invalid email or password"});if(!u.passwordHash)return r.status(409).json({error:"First-time setup required",setupRequired:true});if(!(await bcrypt.compare(password,u.passwordHash)))return r.status(401).json({error:"Invalid email or password"});q.session.user={id:u.id,email:u.email,role:(u.role==="tester"?"user":(u.role||"user"))};await db.markBetaLogin(u.id);await db.audit("login",`${u.email} signed in`,u.email);r.json({ok:true,user:q.session.user})});
app.post("/api/auth/setup",async(q,r)=>{const email=String(q.body?.email||"").trim().toLowerCase(),password=String(q.body?.password||"");const u=await db.findBetaUserByEmail(email);if(!u||!u.enabled||u.status==="suspended"||u.status==="revoked")return r.status(403).json({error:"This email has not been invited"});if(u.passwordHash)return r.status(409).json({error:"Account already configured"});if(password.length<10)return r.status(400).json({error:"Password must be at least 10 characters"});await db.setBetaPassword(u.id,await bcrypt.hash(password,12));q.session.user={id:u.id,email:u.email,role:(u.role==="tester"?"user":(u.role||"user"))};await db.markBetaLogin(u.id);await db.audit("tester_account_setup",`${email} created a password`,email);r.json({ok:true,user:q.session.user})});
app.post("/api/auth/logout",(q,r)=>{q.session=null;r.json({ok:true})});
app.use("/api",(q,r,n)=>{if(q.path.startsWith("/auth/")||q.path==="/health"||q.path.startsWith("/cron/"))return n();if(!q.session?.user)return r.status(401).json({error:"Authentication required."});if((q.path.startsWith("/admin/")||q.path==="/status")&&!isAdmin(q))return r.status(403).json({error:"Admin only"});n()});

async function explore(origin,opts={}){
  const p=new URLSearchParams({engine:"google_travel_explore",departure_id:origin,gl:"us",hl:"en",currency:"USD",type:"1",adults:String(opts.adults||2),travel_class:String(opts.travelClass||1),api_key:process.env.SERPAPI_KEY});
  if(opts.outboundDate)p.set("outbound_date",opts.outboundDate);
  if(opts.returnDate)p.set("return_date",opts.returnDate);
  if(opts.arrivalId)p.set("arrival_id",opts.arrivalId);
  if(opts.stops)p.set("stops",String(opts.stops));
  if(opts.airlines)p.set("include_airlines",opts.airlines);
  if(opts.maxDuration)p.set("max_duration",String(opts.maxDuration));
  const res=await fetch("https://serpapi.com/search.json?"+p),d=await res.json();
  if(!res.ok||d.error)throw new Error(d.error||"SerpApi failed");
  return d
}
function norm(d,o,i){return{id:`${o}-${d.destination_airport?.code||d.arrival_airport?.code||d.destination_id||i}-${d.start_date||i}`,destination:d.name||"Unknown",country:d.country||"",price:Number(d.flight_price??d.price??0),flightLink:d.link||d.flight_link||null,startDate:d.start_date||null,endDate:d.end_date||null,departureAirport:o,arrivalAirport:d.destination_airport?.code||d.arrival_airport?.code||null,flightDuration:d.flight_duration?Number(d.flight_duration):null,stops:d.number_of_stops??d.stops??null,airline:d.airline||null,hotelPrice:d.hotel_price?Number(d.hotel_price):null}}
async function getDeals(origins=["MCO","MIA"],opts={}){
  opts.adults=Math.min(6,Math.max(1,Number(opts.adults)||2));
  const rs=await Promise.all(origins.map(o=>explore(o,opts)));let deals=[];
  rs.forEach((x,i)=>{
    const source=(x.flights&&x.flights.length?x.flights:x.destinations)||[];
    deals.push(...source.map((d,j)=>norm({...d,start_date:d.start_date||x.start_date,end_date:d.end_date||x.end_date},origins[i],j)))
  });
  deals=deals.filter(d=>(d.country||"United States").trim().toLowerCase()==="united states"&&d.price>0);
  const u=new Map();for(const d of deals){const k=`${d.departureAirport}|${d.arrivalAirport||d.destination}|${d.startDate}|${d.endDate}|${d.airline||""}`;if(!u.has(k)||d.price<u.get(k).price)u.set(k,d)}
  return [...u.values()].sort((a,b)=>a.price-b.price)
}

function quietNow(profile){
  if(!profile.quietHoursEnabled)return false;
  const now=new Date(), mins=now.getHours()*60+now.getMinutes();
  const toMin=s=>{const [h,m]=String(s||"00:00").split(":").map(Number);return h*60+m};
  const start=toMin(profile.quietStart),end=toMin(profile.quietEnd);
  return start<=end ? mins>=start&&mins<end : mins>=start||mins<end
}
function scoreDeal(price,stats){
  if(!stats||stats.count<2)return {score:"NEW",reason:"Meets your watchlist price threshold."};
  const avg=stats.avg,low=stats.low,drop=avg>0?(avg-price)/avg:0;
  if(price<=low)return {score:"EXCEPTIONAL",reason:`At or below the lowest price FlightWatch has recorded for this route.`};
  if(drop>=.25)return {score:"GREAT",reason:`${Math.round(drop*100)}% below the recent route average.`};
  if(drop>=.12)return {score:"GOOD",reason:`${Math.round(drop*100)}% below the recent route average.`};
  return {score:"MATCH",reason:"Meets your watchlist price threshold."}
}
function fingerprint(w,d){
  // Same watchlist + route + dates + rounded price = one alert. A new lower/higher qualifying fare can alert later.
  return crypto.createHash("sha256").update([w.id,d.departureAirport,d.arrivalAirport||d.destination,d.startDate||"",d.endDate||"",Math.round(d.price)].join("|")).digest("hex")
}

async function sendEmail(profile,deal,alert){
  if(!profile.notifyEmail||!profile.email)return "not_requested";
  if(!process.env.RESEND_API_KEY)return "not_configured";
  try{
    const res=await fetch("https://api.resend.com/emails",{method:"POST",headers:{"Authorization":`Bearer ${process.env.RESEND_API_KEY}`,"Content-Type":"application/json"},body:JSON.stringify({
      from:process.env.RESEND_FROM||"FlightWatch <onboarding@resend.dev>",
      to:[profile.email],
      subject:`FlightWatch ${alert.score}: ${deal.departureAirport} → ${deal.arrivalAirport||deal.destination} for $${Math.round(deal.price)}`,
      html:`<div style="font-family:Arial,sans-serif;max-width:600px"><h2>✈️ ${alert.score} flight deal</h2><p><strong>${deal.departureAirport} → ${deal.arrivalAirport||deal.destination}</strong> — ${deal.destination}</p><p style="font-size:28px;font-weight:bold">$${Math.round(deal.price)}</p><p>${alert.reason}</p><p>${deal.startDate||"Flexible"} → ${deal.endDate||"Flexible"}${deal.stops===0?" · Nonstop":""}</p>${deal.flightLink?`<p><a href="${deal.flightLink}">View on Google Travel</a></p>`:""}<p style="color:#666;font-size:12px">Always verify final pricing before booking.</p></div>`
    })});
    return res.ok?"sent":`failed_${res.status}`;
  }catch{return "failed"}
}
async function sendSms(profile,deal,alert){
  if(!profile.notifySms||!profile.phone)return "not_requested";
  const sid=process.env.TWILIO_ACCOUNT_SID,token=process.env.TWILIO_AUTH_TOKEN,from=process.env.TWILIO_FROM_NUMBER;
  if(!sid||!token||!from)return "not_configured";
  try{
    const body=new URLSearchParams({To:profile.phone,From:from,Body:`FlightWatch ${alert.score}: ${deal.departureAirport}→${deal.arrivalAirport||deal.destination} $${Math.round(deal.price)}. ${alert.reason}${deal.flightLink?" "+deal.flightLink:""}`});
    const res=await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,{method:"POST",headers:{"Authorization":"Basic "+Buffer.from(`${sid}:${token}`).toString("base64"),"Content-Type":"application/x-www-form-urlencoded"},body});
    return res.ok?"sent":`failed_${res.status}`;
  }catch{return "failed"}
}
async function evaluateWatchlists(deals,{deliver=true}={}){
  const [watchlists,profile]=await Promise.all([db.getWatchlists(),db.getProfile()]);
  const created=[];
  for(const w of watchlists.filter(x=>x.enabled!==false)){
    const matches=deals.filter(d=>
      (w.origin==="BOTH"||d.departureAirport===w.origin) &&
      (w.destinationCode==="ANY"||d.arrivalAirport===w.destinationCode) &&
      d.price<=Number(w.maxPrice) &&
      (!w.nonstopOnly||d.stops===0)
    );
    for(const d of matches){
      const fp=fingerprint(w,d);
      if(await db.alertExists(fp))continue;
      const stats=d.arrivalAirport?await db.routeStats(d.departureAirport,d.arrivalAirport):null;
      const scored=scoreDeal(d.price,stats);
      const alert={
        fingerprint:fp,watchlistId:w.id,watchlistLabel:w.label,origin:d.departureAirport,destinationCode:d.arrivalAirport||"",
        destinationName:d.destination,price:d.price,historicalAvg:stats?.avg||null,historicalLow:stats?.low||null,
        score:scored.score,reason:scored.reason,flightLink:d.flightLink||null,emailStatus:"not_requested",smsStatus:"not_requested"
      };
      const inserted=await db.createAlert(alert); if(!inserted)continue;
      let emailStatus="not_requested",smsStatus="not_requested";
      if(deliver&&!quietNow(profile)){
        [emailStatus,smsStatus]=await Promise.all([sendEmail(profile,d,alert),sendSms(profile,d,alert)]);
      }else if(deliver&&quietNow(profile)){emailStatus=profile.notifyEmail?"quiet_hours":"not_requested";smsStatus=profile.notifySms?"quiet_hours":"not_requested"}
      await db.updateAlertDelivery(fp,emailStatus,smsStatus);
      created.push({...alert,emailStatus,smsStatus});
    }
  }
  return created
}
async function monitoringRun({deliver=true}={}){
  if(!process.env.SERPAPI_KEY)throw new Error("SERPAPI_KEY is missing.");
  const deals=await getDeals(["MCO","MIA"]);
  await db.saveSnapshots(deals);
  const alerts=await evaluateWatchlists(deals,{deliver});
  await db.setMeta("lastAutomationRun",new Date().toISOString());
  return {deals:deals.length,newAlerts:alerts.length,alerts}
}

app.get("/api/health",(q,r)=>r.json({ok:true,apiConfigured:!!process.env.SERPAPI_KEY,database:db.usePostgres?"postgres":"local",v:"6.0.1"}));
app.get("/api/deals",async(q,r)=>{try{
 if(!process.env.SERPAPI_KEY)return r.status(500).json({error:"SERPAPI_KEY is missing."});
 const req=String(q.query.origin||"BOTH").toUpperCase(),origins=req==="BOTH"?["MCO","MIA"]:(["MCO","MIA"].includes(req)?[req]:["MCO","MIA"]);
 const opts={adults:q.query.adults,travelClass:q.query.travelClass||1,outboundDate:q.query.outboundDate||"",returnDate:q.query.returnDate||"",arrivalId:String(q.query.arrivalId||"").toUpperCase(),stops:q.query.stops||"",airlines:String(q.query.airlines||"").toUpperCase(),maxDuration:q.query.maxDuration||""};
 if((opts.outboundDate&&!opts.returnDate)||(!opts.outboundDate&&opts.returnDate))return r.status(400).json({error:"For round trips, choose both departure and return dates."});
 const deals=await getDeals(origins,opts);await db.saveSnapshots(deals);r.json({deals,fetchedAt:new Date().toISOString(),source:"Google Travel Explore via SerpApi"});
}catch(e){await db.logError({service:"SerpApi",code:"SEARCH_FAILED",message:e.message,details:e.stack||""});r.status(500).json({error:e.message})}});

app.get("/api/tracked",async(q,r)=>r.json(await db.getTracked(q.session.user)));
app.post("/api/tracked",async(q,r)=>r.json(await db.addTracked(q.body||{},q.session.user)));
app.delete("/api/tracked/:id",async(q,r)=>{await db.removeTracked(q.params.id,q.session.user);r.json({ok:true})});
app.get("/api/profile",async(q,r)=>r.json(await db.getUserProfile(q.session.user)));
app.put("/api/profile",async(q,r)=>r.json(await db.saveUserProfile(q.session.user,q.body||{})));
app.get("/api/watchlists",async(q,r)=>r.json(await db.getWatchlists(q.session.user)));
app.post("/api/watchlists",async(q,r)=>r.json(await db.addWatchlist(q.body||{},q.session.user)));
app.delete("/api/watchlists/:id",async(q,r)=>{await db.removeWatchlist(q.params.id,q.session.user);r.json({ok:true})});
app.get("/api/history",async(q,r)=>r.json(await db.history(q.query.origin||"",String(q.query.destinationCode||"").toUpperCase(),q.query.limit)));
app.get("/api/alerts",async(q,r)=>r.json(await db.getAlerts(q.query.limit||100,q.session.user)));
app.post("/api/alerts/test",async(q,r)=>{try{
 const profile=await db.getUserProfile(q.session.user),fake={departureAirport:"MCO",arrivalAirport:"TEST",destination:"FlightWatch Test",price:99,startDate:null,endDate:null,stops:0,flightLink:null},alert={score:"TEST",reason:"Your FlightWatch notification settings are working."};
 const [emailStatus,smsStatus]=await Promise.all([sendEmail(profile,fake,alert),sendSms(profile,fake,alert)]);r.json({emailStatus,smsStatus});
}catch(e){r.status(500).json({error:e.message})}});
app.post("/api/monitor/run",async(q,r)=>{try{const x=await monitoringRun({deliver:false});await db.audit("manual_monitor_run",JSON.stringify({deals:x.deals,newAlerts:x.newAlerts}),q.session.user.email);r.json(x)}catch(e){await db.logError({service:"Monitor",code:"RUN_FAILED",message:e.message,details:e.stack||""});r.status(500).json({error:e.message})}});

app.get("/api/groups",async(q,r)=>r.json({groups:await db.getGroups(q.session.user),invites:await db.getGroupInvites(q.session.user)}));
app.post("/api/groups",async(q,r)=>{try{const g=await db.createGroup(q.body?.name,q.session.user);await db.audit("group_created",g.name,q.session.user.email);r.json(g)}catch(e){r.status(400).json({error:e.message})}});
app.post("/api/groups/:id/invite",async(q,r)=>{try{const x=await db.inviteToGroup(q.params.id,q.body?.email,q.session.user);await db.audit("group_invite_sent",q.body?.email,q.session.user.email);r.json({ok:true,inviteId:x.id})}catch(e){r.status(400).json({error:e.message})}});
app.post("/api/groups/accept",async(q,r)=>{try{r.json(await db.acceptGroupInvite(q.body?.token,q.session.user))}catch(e){r.status(400).json({error:e.message})}});

app.get("/api/super/users",async(q,r)=>{if(!isSuperAdmin(q))return r.status(403).json({error:"Super Admin only"});r.json({users:await db.listManagedUsers()})});
app.patch("/api/super/users/:id/role",async(q,r)=>{if(!isSuperAdmin(q))return r.status(403).json({error:"Super Admin only"});try{r.json(await db.setManagedUserRole(q.params.id,q.body?.role,q.session.user))}catch(e){r.status(400).json({error:e.message})}});
app.patch("/api/super/users/:id/status",async(q,r)=>{if(!isSuperAdmin(q))return r.status(403).json({error:"Super Admin only"});try{r.json(await db.setManagedUserStatus(q.params.id,q.body?.status,q.body?.reason,q.session.user))}catch(e){r.status(400).json({error:e.message})}});
app.get("/api/super/events",async(q,r)=>{if(!isSuperAdmin(q))return r.status(403).json({error:"Super Admin only"});r.json({events:await db.getSecurityEvents(q.query.limit||200)})});

app.get("/api/admin/errors",async(q,r)=>r.json(await db.getErrors(q.query.limit||100)));
app.patch("/api/admin/errors/:id",async(q,r)=>{await db.setErrorStatus(q.params.id,q.body?.status);await db.audit("error_status_changed",`${q.params.id} → ${q.body?.status}`,q.session.user.email);r.json({ok:true})});
app.get("/api/admin/audit",async(q,r)=>r.json(await db.getAudit(q.query.limit||100)));
app.get("/api/admin/users",async(q,r)=>r.json(await db.getBetaUsers()));
app.post("/api/admin/users",async(q,r)=>{try{await db.addBetaUser(q.body?.email,q.body?.role||"user");await db.audit("user_added",q.body?.email||"",q.session.user.email);r.json({ok:true})}catch(e){r.status(400).json({error:e.message})}});
app.delete("/api/admin/users/:id",async(q,r)=>{await db.removeBetaUser(q.params.id);await db.audit("user_removed",q.params.id,q.session.user.email);r.json({ok:true})});

app.get("/api/status",async(q,r)=>r.json({...await db.status(),apiConfigured:!!process.env.SERPAPI_KEY,protectedMode,emailConfigured:!!process.env.RESEND_API_KEY,smsConfigured:!!(process.env.TWILIO_ACCOUNT_SID&&process.env.TWILIO_AUTH_TOKEN&&process.env.TWILIO_FROM_NUMBER),cronConfigured:!!process.env.CRON_SECRET}));
app.post("/api/cron/check",async(q,r)=>{try{
 const secret=String(q.get("x-cron-secret")||q.query.secret||"");if(!process.env.CRON_SECRET||secret!==process.env.CRON_SECRET)return r.status(401).json({error:"Invalid cron secret."});
 r.json(await monitoringRun({deliver:true}));
}catch(e){console.error("Automation failed",e);r.status(500).json({error:e.message})}});

app.use(express.static(path.join(__dirname,"public")));
app.get("*",(q,r)=>r.sendFile(path.join(__dirname,"public","index.html")));
db.init().then(async()=>{
 await db.bootstrapSuperAdmin(process.env.SUPER_ADMIN_EMAIL||process.env.ADMIN_EMAIL||"");
 app.listen(PORT,()=>console.log(`FlightWatch V6.0.1 running at http://localhost:${PORT}`));
}).catch(e=>{console.error(e);process.exit(1)});
