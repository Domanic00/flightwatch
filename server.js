const express=require("express"),path=require("path"),crypto=require("crypto"),cookieSession=require("cookie-session");require("dotenv").config();const db=require("./lib/storage");
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

app.get("/api/auth/status",(q,r)=>r.json({protected:protectedMode,authenticated:!protectedMode||!!q.session?.authenticated}));
app.post("/api/auth/login",(q,r)=>{if(!protectedMode){q.session.authenticated=true;return r.json({ok:true})}const a=Buffer.from(String(q.body?.password||"")),b=Buffer.from(String(process.env.APP_PASSWORD));if(a.length!==b.length||!crypto.timingSafeEqual(a,b))return r.status(401).json({error:"Incorrect password."});q.session.authenticated=true;r.json({ok:true})});
app.post("/api/auth/logout",(q,r)=>{q.session=null;r.json({ok:true})});
app.use("/api",(q,r,n)=>{if(q.path.startsWith("/auth/")||q.path==="/health"||q.path.startsWith("/cron/")||!protectedMode||q.session?.authenticated)return n();r.status(401).json({error:"Authentication required."})});

async function explore(origin){
  const p=new URLSearchParams({engine:"google_travel_explore",departure_id:origin,gl:"us",hl:"en",currency:"USD",type:"1",api_key:process.env.SERPAPI_KEY});
  const res=await fetch("https://serpapi.com/search.json?"+p),d=await res.json();
  if(!res.ok||d.error)throw new Error(d.error||"SerpApi failed");
  return d
}
function norm(d,o,i){return{id:`${o}-${d.destination_airport?.code||d.arrival_airport?.code||d.destination_id||i}-${d.start_date||i}`,destination:d.name||"Unknown",country:d.country||"",price:Number(d.flight_price??d.price??0),flightLink:d.link||d.flight_link||null,startDate:d.start_date||null,endDate:d.end_date||null,departureAirport:o,arrivalAirport:d.destination_airport?.code||d.arrival_airport?.code||null,flightDuration:d.flight_duration?Number(d.flight_duration):null,stops:d.number_of_stops??d.stops??null,airline:d.airline||null,hotelPrice:d.hotel_price?Number(d.hotel_price):null}}
async function getDeals(origins=["MCO","MIA"]){
  const rs=await Promise.all(origins.map(explore));let deals=[];
  rs.forEach((x,i)=>deals.push(...(x.destinations||x.flights||[]).map((d,j)=>norm(d,origins[i],j))));
  deals=deals.filter(d=>(d.country||"").trim().toLowerCase()==="united states"&&d.price>0);
  const u=new Map();
  for(const d of deals){const k=`${d.departureAirport}|${d.arrivalAirport||d.destination}|${d.startDate}|${d.endDate}`;if(!u.has(k)||d.price<u.get(k).price)u.set(k,d)}
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

app.get("/api/health",(q,r)=>r.json({ok:true,apiConfigured:!!process.env.SERPAPI_KEY,database:db.usePostgres?"postgres":"local",v:"4.0.0"}));
app.get("/api/deals",async(q,r)=>{try{if(!process.env.SERPAPI_KEY)return r.status(500).json({error:"SERPAPI_KEY is missing."});const req=String(q.query.origin||"BOTH").toUpperCase(),origins=req==="BOTH"?["MCO","MIA"]:["MCO","MIA"].includes(req)?[req]:["MCO","MIA"];const deals=await getDeals(origins);await db.saveSnapshots(deals);r.json({deals,fetchedAt:new Date().toISOString(),source:"Google Travel Explore via SerpApi"})}catch(e){r.status(500).json({error:e.message})}});
app.get("/api/profile",async(q,r)=>r.json(await db.getProfile()));app.put("/api/profile",async(q,r)=>r.json(await db.saveProfile(q.body||{})));
app.get("/api/tracked",async(q,r)=>r.json(await db.getTracked()));app.post("/api/tracked",async(q,r)=>r.json(await db.addTracked(q.body||{})));app.delete("/api/tracked/:id",async(q,r)=>{await db.removeTracked(q.params.id);r.json({ok:true})});
app.get("/api/watchlists",async(q,r)=>r.json(await db.getWatchlists()));app.post("/api/watchlists",async(q,r)=>r.json(await db.addWatchlist(q.body||{})));app.delete("/api/watchlists/:id",async(q,r)=>{await db.removeWatchlist(q.params.id);r.json({ok:true})});
app.get("/api/history",async(q,r)=>r.json(await db.history(q.query.origin||"",String(q.query.destinationCode||"").toUpperCase(),q.query.limit)));
app.get("/api/alerts",async(q,r)=>r.json(await db.getAlerts(q.query.limit||100)));
app.post("/api/alerts/test",async(q,r)=>{try{
  const profile=await db.getProfile(),fake={departureAirport:"MCO",arrivalAirport:"TEST",destination:"FlightWatch Test",price:99,startDate:null,endDate:null,stops:0,flightLink:null},alert={score:"TEST",reason:"Your FlightWatch notification settings are working."};
  const [emailStatus,smsStatus]=await Promise.all([sendEmail(profile,fake,alert),sendSms(profile,fake,alert)]);
  r.json({emailStatus,smsStatus});
}catch(e){r.status(500).json({error:e.message})}});
app.post("/api/monitor/run",async(q,r)=>{try{r.json(await monitoringRun({deliver:false}))}catch(e){r.status(500).json({error:e.message})}});
app.get("/api/status",async(q,r)=>r.json({...await db.status(),apiConfigured:!!process.env.SERPAPI_KEY,protectedMode,emailConfigured:!!process.env.RESEND_API_KEY,smsConfigured:!!(process.env.TWILIO_ACCOUNT_SID&&process.env.TWILIO_AUTH_TOKEN&&process.env.TWILIO_FROM_NUMBER),cronConfigured:!!process.env.CRON_SECRET}));

// Secure endpoint intended for GitHub Actions / Render Cron.
app.post("/api/cron/check",async(q,r)=>{
  try{
    const secret=String(q.get("x-cron-secret")||q.query.secret||"");
    if(!process.env.CRON_SECRET||secret!==process.env.CRON_SECRET)return r.status(401).json({error:"Invalid cron secret."});
    r.json(await monitoringRun({deliver:true}));
  }catch(e){console.error("Automation failed",e);r.status(500).json({error:e.message})}
});

app.use(express.static(path.join(__dirname,"public")));app.get("*",(q,r)=>r.sendFile(path.join(__dirname,"public","index.html")));
db.init().then(()=>app.listen(PORT,()=>console.log(`FlightWatch V4 running at http://localhost:${PORT}`))).catch(e=>{console.error(e);process.exit(1)});
