/* =========================================================
   BEYOND PLAYBOOK ─ 共通診断エンジン (diagnose.js)
   ページ側で window.DIAGNOSE_CONFIG を定義してから読み込む。
   レーダー型「弱点(=天井)特定」診断を9LPで共通利用する。

   CONFIG schema:
   {
     lp, service, serviceFull, eyebrow, applyUrl, lineUrl, hubUrl,
     startTitle(html), startLead(html),
     axes: [{key,label}, ...],            // レーダーの軸
     questions: [{axis, title, options:[{label,score}]}],  // score 0..5 (高い=強い)
     bands: [{min, band}],                // 全体平均%による総評 (降順, %)
     verdicts: { <axisKey>: {title, comment(html)} },  // 最弱軸ごとの所見
     ctaTitle, ctaText(html), ctaLabel
   }
   ========================================================= */
(function(){
  var C = window.DIAGNOSE_CONFIG;
  if(!C){ console.error('DIAGNOSE_CONFIG missing'); return; }
  var MAX = 5; // 1問あたり満点

  // ---- UI 構築 ----
  var app = document.getElementById('dg-app');
  app.innerHTML =
    '<div class="dg-progress-top" id="dg-top"></div>'
   +'<header class="dg-header">'
   +  '<a href="'+esc(C.hubUrl||'/')+'" class="dg-brand"><span class="home">Playbook</span><span class="svc">'+esc(C.service)+'</span></a>'
   +  '<a href="'+esc(C.applyUrl)+'" class="dg-back" data-track="dg_header_contact">Contact →</a>'
   +'</header>'
   +'<main class="dg-main">'
   +  '<div class="dg-progress" id="dg-prog"><span class="lbl" id="dg-prog-lbl"></span><div class="bar"><div class="fill" id="dg-prog-fill"></div></div><span class="tmr" id="dg-prog-tmr"></span></div>'
   +  '<div id="dg-screen"></div>'
   +'</main>'
   +'<footer class="dg-footer">'
   +  '<div class="fb">'+esc(C.service)+'</div>'
   +  '<div class="fl"><a href="'+esc(C.hubUrl||'/')+'">BEYOND PLAYBOOK</a> · <a href="'+esc(C.applyUrl)+'">お問合せ</a> · <a href="/privacy/">プライバシー</a></div>'
   +  '<div class="cp">© 2026 BEYOND Holdings 株式会社</div>'
   +'</footer>';

  var $screen = document.getElementById('dg-app').querySelector('#dg-screen');
  var $prog = document.getElementById('dg-prog');
  var $progLbl = document.getElementById('dg-prog-lbl');
  var $progFill = document.getElementById('dg-prog-fill');
  var $progTmr = document.getElementById('dg-prog-tmr');

  var state = { i:0, answers:[] };

  // ---- スタート画面 ----
  function renderStart(){
    $prog.classList.remove('show');
    $screen.innerHTML =
      '<div class="dg-card">'
     +  '<div class="dg-eyebrow">'+esc(C.eyebrow||(C.service+' DIAGNOSIS'))+'</div>'
     +  '<h1 class="dg-start-title">'+(C.startTitle||'')+'</h1>'
     +  '<p class="dg-start-lead">'+(C.startLead||'')+'</p>'
     +  '<div class="dg-meta">'
     +    '<div class="it"><div class="n">'+C.questions.length+'</div><div class="l">設問</div></div>'
     +    '<div class="it"><div class="n">'+estSec()+'<small>秒</small></div><div class="l">所要時間</div></div>'
     +    '<div class="it"><div class="n">0<small>円</small></div><div class="l">完全無料</div></div>'
     +  '</div>'
     +  '<div class="dg-cta-wrap"><button type="button" class="dg-btn" id="dg-start-btn" data-track="dg_start">診断をはじめる →</button></div>'
     +'</div>';
    document.getElementById('dg-start-btn').onclick = start;
  }

  function estSec(){ return Math.max(30, Math.round(C.questions.length*8/10)*10); }

  function start(){
    state = { i:0, answers:[] };
    $prog.classList.add('show');
    track('dg_start_click');
    renderQuestion();
  }

  // ---- 設問画面 ----
  function renderQuestion(){
    var q = C.questions[state.i];
    var axis = axisByKey(q.axis);
    var opts = q.options.map(function(o,idx){
      return '<button type="button" class="dg-opt" data-idx="'+idx+'"><span>'+esc(o.label)+'</span></button>';
    }).join('');
    $screen.innerHTML =
      '<div class="dg-card">'
     +  '<div class="dg-qnum">Question '+(state.i+1)+' / '+C.questions.length+'</div>'
     +  (axis?'<div class="dg-qaxis">'+esc(axis.label)+'</div>':'')
     +  '<h2 class="dg-qtitle">'+esc(q.title)+'</h2>'
     +  '<div class="dg-opts">'+opts+'</div>'
     +'</div>';
    Array.prototype.forEach.call($screen.querySelectorAll('.dg-opt'), function(btn){
      btn.onclick = function(){ select(q, parseInt(btn.getAttribute('data-idx'),10)); };
    });
    var pct = ((state.i)/C.questions.length)*100;
    $progFill.style.width = pct + '%';
    $progLbl.textContent = 'Q ' + (state.i+1) + ' / ' + C.questions.length;
    var remain = (C.questions.length - state.i) * 8;
    $progTmr.textContent = '残り 約' + remain + '秒';
    setTop(pct);
    window.scrollTo({top:0, behavior:'smooth'});
  }

  function select(q, idx){
    state.answers.push({ axis:q.axis, score:q.options[idx].score });
    if(state.i < C.questions.length-1){
      state.i++;
      setTimeout(renderQuestion, 160);
    } else {
      showResult();
    }
  }

  // ---- スコア集計 ----
  function compute(){
    var sum={}, cnt={};
    C.axes.forEach(function(a){ sum[a.key]=0; cnt[a.key]=0; });
    state.answers.forEach(function(a){ if(sum[a.axis]===undefined){sum[a.axis]=0;cnt[a.axis]=0;} sum[a.axis]+=a.score; cnt[a.axis]++; });
    var axisPct = C.axes.map(function(a){
      var max = (cnt[a.key]||0)*MAX;
      var pct = max>0 ? Math.round((sum[a.key]/max)*100) : 0;
      return { key:a.key, label:a.label, pct:pct };
    });
    var weakest = axisPct.slice().sort(function(x,y){ return x.pct - y.pct; })[0];
    var avg = Math.round(axisPct.reduce(function(s,a){return s+a.pct;},0) / axisPct.length);
    return { axisPct:axisPct, weakest:weakest, avg:avg };
  }

  function bandOf(avg){
    var b = (C.bands||[]).slice().sort(function(x,y){return y.min-x.min;});
    for(var i=0;i<b.length;i++){ if(avg>=b[i].min) return b[i].band; }
    return '';
  }

  // ---- 結果画面 ----
  function showResult(){
    var r = compute();
    // 全軸が高い場合は「明確な天井なし=次のギアへ」に切り替え(矛盾回避)
    var strong = (r.avg >= 80 && r.weakest.pct >= 75);
    var vkey = (strong && C.verdicts && C.verdicts._strong) ? '_strong' : r.weakest.key;
    var v = (C.verdicts && C.verdicts[vkey]) || { title:'', comment:'' };
    var highlight = strong ? null : r.weakest.key;
    $progFill.style.width='100%'; $progLbl.textContent='完了'; $progTmr.textContent='お疲れさまでした'; setTop(100);

    $screen.innerHTML =
      '<div class="dg-card">'
     +  '<div class="dg-res-eyebrow">Your Result</div>'
     +  '<h2 class="dg-res-headline">'+(v.title||'')+'</h2>'
     +  '<p class="dg-res-band">'+esc(bandOf(r.avg))+'（総合 '+r.avg+'点）</p>'
     +  radarSVG(r.axisPct, highlight)
     +  '<div class="dg-bars" id="dg-bars">'+barsHTML(r.axisPct, highlight)+'</div>'
     +  '<div class="dg-verdict"><span class="vt">'+(v.title||'')+'</span>'+(v.comment||'')+'</div>'
     +  playsHTML(v)
     +  '<div class="dg-next">'
     +    '<div class="nt">'+esc(v.ctaTitle||C.ctaTitle||'次の一手を、一緒に決めましょう。')+'</div>'
     +    '<p class="np">'+(C.ctaText||'ヒアリングは無料です。診断結果を見ながら、具体的な打ち手をお持ちします。<br><strong>1時間以内に折り返します。</strong>')+'</p>'
     +    '<a href="'+esc(ctaHref(r))+'" class="dg-btn" data-track="dg_apply" data-track-ceiling="'+esc(r.weakest.key)+'">'+esc(C.ctaLabel||'無料で相談する →')+'</a>'
     +    '<div class="dg-sec-actions">'
     +      (C.lineUrl?'<a href="'+esc(C.lineUrl)+'" target="_blank" rel="noopener" class="dg-btn-sec" data-track="dg_line">💬 LINEで相談</a>':'')
     +      '<a href="'+esc(C.hubUrl||'/')+'" class="dg-btn-sec" data-track="dg_hub">PLAYBOOK ↗</a>'
     +    '</div>'
     +    '<button type="button" class="dg-retry" id="dg-retry">もう一度診断する</button>'
     +  '</div>'
     +  '<div class="dg-disclaimer">本診断は簡易セルフチェックです。実際の打ち手は無料ヒアリングで貴社の状況に合わせて設計します。</div>'
     +'</div>';

    // バーをアニメーション
    requestAnimationFrame(function(){
      Array.prototype.forEach.call($screen.querySelectorAll('.dg-bar .bf'), function(el){
        el.style.width = el.getAttribute('data-pct') + '%';
      });
    });
    document.getElementById('dg-retry').onclick = renderStart;

    saveResult(r);
    track('dg_complete', { ceiling:r.weakest.key, avg:r.avg });
    notify(r, strong, highlight);
    window.scrollTo({top:0, behavior:'smooth'});
  }

  // レーダーをPNG化 (LINE通知用) — canvasに直接描画して確実にラスタライズ
  function radarPNG(axisPct, weakKey){
    try{
      if(typeof document==='undefined' || !document.createElement) return null;
      var n=axisPct.length, S=560, pad=104, cx=S/2, cy=S/2+8, R=(S-pad*2)/2;
      var cv=document.createElement('canvas'); cv.width=S; cv.height=S;
      var x=cv.getContext('2d'); if(!x) return null;
      var css=getComputedStyle(document.documentElement);
      var accent=(css.getPropertyValue('--accent')||'#e07c33').trim();
      var accentB=(css.getPropertyValue('--accent-bright')||'#f29a52').trim();
      x.fillStyle='#0d0a0a'; x.fillRect(0,0,S,S);
      function pt(i,f){ var a=-Math.PI/2+i*2*Math.PI/n; return [cx+Math.cos(a)*R*f, cy+Math.sin(a)*R*f]; }
      x.strokeStyle='rgba(255,255,255,0.14)'; x.lineWidth=1;
      [0.25,0.5,0.75,1].forEach(function(f){ x.beginPath(); for(var i=0;i<n;i++){var p=pt(i,f); i?x.lineTo(p[0],p[1]):x.moveTo(p[0],p[1]);} x.closePath(); x.stroke(); });
      for(var i=0;i<n;i++){ var e=pt(i,1); x.beginPath(); x.moveTo(cx,cy); x.lineTo(e[0],e[1]); x.stroke(); }
      x.beginPath(); for(var j=0;j<n;j++){ var f=Math.max(0.05,axisPct[j].pct/100); var p=pt(j,f); j?x.lineTo(p[0],p[1]):x.moveTo(p[0],p[1]); } x.closePath();
      x.fillStyle=hexA(accent,0.30); x.fill(); x.strokeStyle=accentB; x.lineWidth=2.5; x.lineJoin='round'; x.stroke();
      x.textBaseline='middle';
      for(var k=0;k<n;k++){
        var f2=Math.max(0.05,axisPct[k].pct/100); var p2=pt(k,f2); var weak=(axisPct[k].key===weakKey);
        x.beginPath(); x.arc(p2[0],p2[1],weak?6:4.5,0,Math.PI*2); x.fillStyle=weak?'#ffffff':accentB; x.fill();
        if(weak){ x.lineWidth=2; x.strokeStyle=accent; x.stroke(); }
        var lp=pt(k,1.24), ang=-Math.PI/2+k*2*Math.PI/n, cos=Math.cos(ang);
        x.textAlign = Math.abs(cos)<0.3 ? 'center' : (cos>0?'left':'right');
        x.fillStyle = weak?accentB:'rgba(232,229,220,0.88)'; x.font='bold 21px sans-serif';
        x.fillText(axisPct[k].label, lp[0], lp[1]-9);
        x.fillStyle = weak?accentB:'rgba(232,229,220,0.5)'; x.font='16px sans-serif';
        x.fillText(String(axisPct[k].pct), lp[0], lp[1]+14);
      }
      x.textAlign='center'; x.fillStyle=accentB; x.font='bold 18px sans-serif';
      x.fillText(C.chartTitle||((C.service||'')+' 診断'), cx, 30);
      return cv.toDataURL('image/png');
    }catch(e){ return null; }
  }
  function hexA(hex,a){ hex=String(hex).replace('#',''); if(hex.length===3) hex=hex.split('').map(function(c){return c+c;}).join(''); var r=parseInt(hex.slice(0,2),16),g=parseInt(hex.slice(2,4),16),b=parseInt(hex.slice(4,6),16); return 'rgba('+r+','+g+','+b+','+a+')'; }

  function playsHTML(v){
    if(!v.plays || !v.plays.length) return '';
    return '<div class="dg-plays"><div class="dg-plays-h">'+esc(v.playsTitle||'打ち手の例')+'</div><ul>'
      + v.plays.map(function(p){ return '<li>'+esc(p)+'</li>'; }).join('')
      + '</ul><p class="dg-plays-note">※ どれが貴社に効くか・どの順でやるかは、無料ヒアリングで貴社の状況に合わせて設計します。</p></div>';
  }

  // 完了時、結果を裏でPLAYBOOK運営に通知 (匿名・fire-and-forget)。レーダー画像も同送
  function notify(r, strong, highlight){
    try{
      var png = radarPNG(r.axisPct, highlight);          // dataURL or null
      var body = {
        lp:C.lp, service:C.service,
        ceiling:r.weakest.key, ceilingLabel:r.weakest.label,
        avg:r.avg, strong:!!strong,
        axes:r.axisPct.map(function(a){ return { key:a.key, label:a.label, pct:a.pct }; }),
        path:(typeof location!=='undefined'?location.pathname:''),
        ref:(typeof document!=='undefined'?(document.referrer||''):''),
        image: png ? png.split(',')[1] : null            // base64 (prefix除去)
      };
      // 画像はkeepaliveの64KB制限を超えるため通常fetch (結果画面は遷移しないので完了する)
      fetch((C.notifyUrl||'/api/diagnose'), {
        method:'POST', headers:{'Content-Type':'application/json'},
        body:JSON.stringify(body)
      }).catch(function(){});
    }catch(e){}
  }

  function ctaHref(r){
    var u = C.applyUrl || '/apply/';
    var sep = u.indexOf('?')>=0 ? '&' : '?';
    return u + sep + 'ceiling=' + encodeURIComponent(r.weakest.key);
  }

  function barsHTML(axisPct, weakKey){
    return axisPct.map(function(a){
      var weak = a.key===weakKey ? ' weak' : '';
      return '<div class="dg-bar'+weak+'"><div class="bl">'+esc(a.label)+'</div>'
           + '<div class="bt"><div class="bf" data-pct="'+a.pct+'"></div></div>'
           + '<div class="bv">'+a.pct+'</div></div>';
    }).join('');
  }

  // ---- レーダーSVG (n軸 汎用) ----
  function radarSVG(axisPct, weakKey){
    var n = axisPct.length, size=300, cx=size/2, cy=size/2, r=size/2-46;
    function pt(i, frac){
      var ang = -Math.PI/2 + i*2*Math.PI/n;
      return [cx+Math.cos(ang)*r*frac, cy+Math.sin(ang)*r*frac];
    }
    var s = '<svg class="dg-radar" viewBox="0 0 '+size+' '+size+'" role="img" aria-label="診断レーダーチャート">';
    // rings
    [0.25,0.5,0.75,1].forEach(function(f){
      var p=[]; for(var i=0;i<n;i++){var q=pt(i,f);p.push(q[0].toFixed(1)+','+q[1].toFixed(1));}
      s+='<polygon class="ring" points="'+p.join(' ')+'"/>';
    });
    // spokes + labels
    for(var i=0;i<n;i++){
      var edge=pt(i,1); s+='<line class="spoke" x1="'+cx+'" y1="'+cy+'" x2="'+edge[0].toFixed(1)+'" y2="'+edge[1].toFixed(1)+'"/>';
      var lp=pt(i,1.2); var ang=-Math.PI/2 + i*2*Math.PI/n; var cos=Math.cos(ang);
      var anchor = Math.abs(cos)<0.3 ? 'middle' : (cos>0?'start':'end');
      var dy = Math.sin(ang)>0.5 ? 12 : (Math.sin(ang)<-0.5 ? -4 : 4);
      var weak = axisPct[i].key===weakKey ? ' weak' : '';
      s+='<text class="axlabel'+weak+'" x="'+lp[0].toFixed(1)+'" y="'+(lp[1]+dy).toFixed(1)+'" text-anchor="'+anchor+'">'+esc(axisPct[i].label)+'</text>';
      s+='<text class="axval" x="'+lp[0].toFixed(1)+'" y="'+(lp[1]+dy+12).toFixed(1)+'" text-anchor="'+anchor+'">'+axisPct[i].pct+'</text>';
    }
    // data area
    var dp=[]; for(var j=0;j<n;j++){var f=Math.max(0.05,axisPct[j].pct/100);var q=pt(j,f);dp.push(q[0].toFixed(1)+','+q[1].toFixed(1));}
    s+='<polygon class="area" points="'+dp.join(' ')+'"/>';
    for(var k=0;k<n;k++){var f2=Math.max(0.05,axisPct[k].pct/100);var q2=pt(k,f2);var cls=axisPct[k].key===weakKey?'dot-weak':'dot';s+='<circle class="'+cls+'" cx="'+q2[0].toFixed(1)+'" cy="'+q2[1].toFixed(1)+'" r="'+(cls==='dot-weak'?4.5:3.5)+'"/>';}
    s+='</svg>';
    return s;
  }

  // ---- helpers ----
  function axisByKey(k){ for(var i=0;i<C.axes.length;i++){ if(C.axes[i].key===k) return C.axes[i]; } return null; }
  function setTop(pct){ var t=document.getElementById('dg-top'); if(t) t.style.width=pct+'%'; }
  function esc(s){ return String(s==null?'':s).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];}); }
  function saveResult(r){
    try{
      localStorage.setItem(C.lp+'_check_result', JSON.stringify({
        service:C.service, ceiling:r.weakest.key, ceilingLabel:r.weakest.label,
        avg:r.avg, axes:r.axisPct, ts:new Date().toISOString()
      }));
    }catch(e){}
  }
  function track(name, params){
    if(typeof gtag==='function') gtag('event', name, Object.assign({service:C.lp}, params||{}));
  }

  // CTAクリックの汎用トラッキング
  document.addEventListener('click', function(e){
    var el = e.target.closest('[data-track]'); if(!el) return;
    var p={service:C.lp};
    Array.prototype.forEach.call(el.attributes, function(a){
      if(a.name.indexOf('data-track-')===0) p[a.name.slice(11).replace(/-/g,'_')]=a.value;
    });
    track(el.getAttribute('data-track'), p);
  });

  renderStart();
})();
