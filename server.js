const http=require('node:http');
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const dc=require('@gurumnyang/dcinside.js');

const PORT=process.env.PORT||3000;
const ADMIN_KEY=process.env.ADMIN_KEY;
const COUNTDOWN_MS=30000;
const RACE_MS=30000;

let racers=[];
let race=null;

function send(res,status,data){
  res.writeHead(status,{
    'Content-Type':'application/json; charset=utf-8',
    'Cache-Control':'no-store, no-cache, must-revalidate'
  });
  res.end(JSON.stringify(data));
}

function auth(req){
  return ADMIN_KEY && req.headers.authorization==='Bearer '+ADMIN_KEY;
}

function readBody(req){
  return new Promise((resolve,reject)=>{
    let b='';
    req.on('data',c=>{
      b+=c;
      if(b.length>20000){
        reject(Error('요청이 너무 큽니다.'));
        req.destroy();
      }
    });
    req.on('end',()=>{
      try{resolve(JSON.parse(b||'{}'))}
      catch{reject(Error('잘못된 요청'))}
    });
    req.on('error',reject);
  });
}

function dcInfo(raw){
  const u=new URL(raw);
  if(!['gall.dcinside.com','m.dcinside.com'].includes(u.hostname))
    throw Error('디시 게시글 주소만 입력하세요.');

  const m=u.pathname.match(/^\/board\/([^/]+)\/(\d+)/);
  const id=(u.searchParams.get('id')||(m&&m[1])||'').trim();
  const no=(u.searchParams.get('no')||(m&&m[2])||'').trim();

  if(id!=='rescene1')
    throw Error('리센느 갤러리(rescene1) 게시글만 사용할 수 있습니다.');

  if(!/^\d+$/.test(no))
    throw Error('올바른 디시 게시글 주소가 아닙니다.');

  return{id,no};
}

async function getDcPost(id,no){
  let last=null;

  for(const fn of ['getPostLegacy','getPost']){
    try{
      const p=await dc[fn]({
        galleryId:id,
        postNo:no,
        extractImages:false,
        retryCount:2
      });

      const items=Array.isArray(p?.comments?.items)
        ?p.comments.items
        :[];

      const total=Number(
        p?.comments?.totalCount??items.length
      );

      if(p?.comments&&(items.length>0||total===0))
        return p;

      last=Error(fn+'에서 댓글을 읽지 못했습니다.');
    }catch(e){
      last=e;
    }
  }

  throw last||Error('디시 게시글을 불러오지 못했습니다.');
}

async function fetchDcParticipants(rawUrl){
  const {id,no}=dcInfo(rawUrl);
  const post=await getDcPost(id,no);

  const items=Array.isArray(post?.comments?.items)
    ?post.comments.items
    :[];

  const commentCount=Number(
    post?.comments?.totalCount??items.length
  );

  const seen=new Set();
  const list=[];

  for(const c of items){
    const a=c?.author||{};
    const nickname=String(a.nickname||'').trim();
    const uid=String(a.userId||'').trim();
    const ip=String(a.ip||'').trim();

    if(!nickname||nickname==='댓글돌이')
      continue;

    const key=uid
      ?'uid:'+uid
      :ip
        ?'ip:'+ip
        :'nick:'+nickname;

    if(seen.has(key))
      continue;

    seen.add(key);

    list.push({
      nickname,
      identity:key
    });

    if(list.length>=200)
      break;
  }

  if(commentCount>0&&!items.length)
    throw Error('댓글 수는 확인됐지만 작성자 목록을 읽지 못했습니다.');

  if(!list.length&&commentCount>0)
    throw Error('댓글 작성자를 찾지 못했습니다.');

  return{
    list,
    commentCount,
    loadedCount:items.length
  };
}

function seedOf(name){
  let s=0;

  for(const c of String(name))
    s+=c.charCodeAt(0);

  return s;
}

function smoothstep01(x){
  x=Math.max(0,Math.min(1,x));
  return x*x*(3-2*x);
}

function calcProgress(name,place,now){
  if(!race)
    return 0;

  if(now<race.startAt)
    return 0;

  const p=Math.min(
    1,
    Math.max(
      0,
      (now-race.startAt)/race.duration
    )
  );

  const t=(now-race.startAt)/1000;
  const seed=seedOf(name);

  if(p>=1){
    return place===1
      ?1.012
      :Math.max(.955,.999-place*.0016);
  }

  let pos=p*.965;

  const chaos=
    Math.sin(t*2.9 + seed*.37)*.030 +
    Math.sin(t*1.7 + seed*.19 + 1.3)*.022 +
    Math.sin(t*4.8 + seed*.083 + .6)*.012;

  pos+=chaos*(
    p<.94
      ?1
      :Math.max(0,(1-p)/.06)
  );

  if(place===1 && p<.96){
    pos-=.020 + Math.sin(t*3.2+seed)*.006;
  }

  if(place>=2 && place<=4 && p>.84 && p<.975){
    const hump=Math.sin(
      ((p-.84)/.135)*Math.PI
    );

    pos+=hump*(
      .026-(place-2)*.004
    );
  }

  if(place===1 && p>=.96){
    const x=(p-.96)/.04;
    pos+=x*x*.070;
  }

  if(place>1 && p>=.96){
    const x=(p-.96)/.04;
    const target=Math.max(
      .955,
      .999-place*.0016
    );

    pos=pos*(1-x)+target*x;
  }

  if(p>=.988){
    const x=(p-.988)/.012;
    const smooth=smoothstep01(x);

    const target=place===1
      ?1.012
      :Math.max(.955,.999-place*.0016);

    pos=pos*(1-smooth)+target*smooth;
  }

  if(p<.988)
    pos=Math.min(pos,.995);

  return Math.max(
    0,
    Math.min(1.012,pos)
  );
}

function publicState(){
  const now=Date.now();

  const base={
    racers:racers.map(r=>({
      nickname:r.nickname,
      id:r.id
    })),
    serverNow:now,
    race:null
  };

  if(!race)
    return base;

  const endAt=
    race.startAt+
    race.duration;

  const phase=
    now<race.startAt
      ?'countdown'
      :now<endAt
        ?'running'
        :'finished';

  base.race={
    phase,
    startAt:race.startAt,
    duration:race.duration,
    endAt
  };

  if(phase==='finished'){
    base.race.winner=
      race.order[0].nickname;

    base.race.order=
      race.order.map((x,i)=>({
        nickname:x.nickname,
        place:i+1
      }));
  }

  return base;
}

function liveState(){
  const now=Date.now();

  if(!race){
    return{
      serverNow:now,
      phase:'idle',
      positions:[]
    };
  }

  const endAt=
    race.startAt+
    race.duration;

  const phase=
    now<race.startAt
      ?'countdown'
      :now<endAt
        ?'running'
        :'finished';

  if(phase==='countdown'){
    return{
      serverNow:now,
      phase,
      startAt:race.startAt,
      duration:race.duration,
      positions:racers.map(r=>({
        nickname:r.nickname,
        progress:0
      }))
    };
  }

  const placeMap=
    new Map(
      race.order.map(
        (x,i)=>[
          x.nickname,
          i+1
        ]
      )
    );

  let positions=
    racers.map(r=>({
      nickname:r.nickname,
      progress:calcProgress(
        r.nickname,
        placeMap.get(r.nickname)||racers.length,
        now
      )
    }));

  positions.sort(
    (a,b)=>
      b.progress-a.progress
  );

  positions=
    positions.map((x,i)=>({
      ...x,
      livePlace:i+1
    }));

  return{
    serverNow:now,
    phase,
    startAt:race.startAt,
    duration:race.duration,
    positions,
    ...(phase==='finished'
      ?{
        winner:race.order[0].nickname,
        order:race.order.map((x,i)=>({
          nickname:x.nickname,
          place:i+1
        }))
      }
      :{})
  };
}

function contentType(f){
  if(f.endsWith('.html'))
    return 'text/html; charset=utf-8';

  if(f.endsWith('.js'))
    return 'text/javascript; charset=utf-8';

  if(f.endsWith('.css'))
    return 'text/css; charset=utf-8';

  if(f.endsWith('.png'))
    return 'image/png';

  if(f.endsWith('.jpg')||f.endsWith('.jpeg'))
    return 'image/jpeg';

  if(f.endsWith('.mp3'))
    return 'audio/mpeg';

  return 'application/octet-stream';
}

const server=
http.createServer(
async(req,res)=>{

  const u=
    new URL(
      req.url,
      'http://localhost'
    );

  if(
    req.method==='GET'&&
    u.pathname==='/api/state'
  ){
    return send(
      res,
      200,
      publicState()
    );
  }

  if(
    req.method==='GET'&&
    u.pathname==='/api/live'
  ){
    return send(
      res,
      200,
      liveState()
    );
  }

  if(
    req.method==='POST'&&
    u.pathname==='/api/join'
  ){
    return send(
      res,
      403,
      {error:'직접 참가 등록은 비활성화되었습니다.'}
    );
  }

  if(
    req.method==='POST'&&
    u.pathname==='/api/admin/import'
  ){
    if(!auth(req))
      return send(
        res,
        401,
        {error:'운영자 인증 실패'}
      );

    if(race)
      return send(
        res,
        409,
        {error:'레이스 예약/시작 후에는 불러올 수 없습니다.'}
      );

    try{
      const b=
        await readBody(req);

      const r=
        await fetchDcParticipants(
          String(b.url||'')
        );

      racers=
        r.list.map(
          (x,id)=>({
            nickname:x.nickname,
            id
          })
        );

      return send(
        res,
        200,
        {
          ok:true,
          count:racers.length,
          commentCount:r.commentCount,
          loadedCount:r.loadedCount,
          duplicatesRemoved:
            Math.max(
              0,
              r.loadedCount-racers.length
            )
        }
      );
    }catch(e){
      return send(
        res,
        400,
        {
          error:
            e?.message||
            '댓글 불러오기 실패'
        }
      );
    }
  }

  if(
    req.method==='POST'&&
    u.pathname==='/api/admin/start'
  ){
    if(!auth(req))
      return send(
        res,
        401,
        {error:'운영자 인증 실패'}
      );

    if(race)
      return send(
        res,
        409,
        {error:'레이스가 이미 예약되었거나 시작됐습니다.'}
      );

    if(!racers.length)
      return send(
        res,
        400,
        {error:'참가자가 없습니다.'}
      );

    const order=[...racers];

    for(
      let i=order.length-1;
      i>0;
      i--
    ){
      const j=
        crypto.randomInt(i+1);

      [order[i],order[j]]=
        [order[j],order[i]];
    }

    race={
      createdAt:Date.now(),
      startAt:
        Date.now()+
        COUNTDOWN_MS,
      duration:RACE_MS,
      order
    };

    return send(
      res,
      200,
      {
        ok:true,
        startAt:race.startAt,
        countdownMs:COUNTDOWN_MS,
        duration:RACE_MS
      }
    );
  }

  if(
    req.method==='POST'&&
    u.pathname==='/api/admin/reset'
  ){
    if(!auth(req))
      return send(
        res,
        401,
        {error:'운영자 인증 실패'}
      );

    racers=[];
    race=null;

    return send(
      res,
      200,
      {ok:true}
    );
  }

  if(req.method==='GET'){
    let rel;

    if(u.pathname==='/')
      rel='index.html';
    else if(
      u.pathname==='/admin'||
      u.pathname==='/admin/'
    )
      rel='admin.html';
    else
      rel=path.basename(
        u.pathname
      );

    const f=
      path.join(
        __dirname,
        'public',
        rel
      );

    return fs.readFile(
      f,
      (e,d)=>{
        if(e){
          res.writeHead(404);
          return res.end('Not found');
        }

        res.writeHead(
          200,
          {
            'Content-Type':
              contentType(f),
            'Cache-Control':
              f.endsWith('.html')
                ?'no-store'
                :'public, max-age=3600'
          }
        );

        res.end(d);
      }
    );
  }

  return send(
    res,
    405,
    {error:'허용되지 않은 요청'}
  );
}
);

server.listen(
  PORT,
  ()=>{
    console.log(
      'Galvent Race running on '+PORT
    );
  }
);
