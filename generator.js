/* ============================================================
   GREEN CROSS LABELS — generator logic
   Staff edit DATA ONLY. The label markup/styles are fixed in
   generator.css (.av-* classes). This file never lets staff
   change type, size, color, or layout.
   ============================================================ */
(function(){
  "use strict";

  var STORAGE_KEY = "gcLabels.rows.v2";
  var REQUIRED = ["name","price"];   // trigger errors when blank (Product optional — Item Name is the product)
  var FIELDS = ["store","name","product","description","description2","size","price"];
  var LABELS_PER_SHEET = 9;

  var DEFAULT_STORE = "";

  // ---- data model ----
  var rows = load();
  function blankRow(over){
    var r = {print:false, store:DEFAULT_STORE, name:"", product:"",
             description:"", description2:"", size:"", price:"", status:""};
    if(over) for(var k in over) r[k]=over[k];
    return r;
  }
  function load(){
    try{
      var raw = JSON.parse(localStorage.getItem(STORAGE_KEY));
      if(Array.isArray(raw) && raw.length) return raw.map(function(r){return blankRow(r);});
    }catch(e){}
    // seed sample rows on first run (Brand headline + Item, matching the master template)
    return [
      blankRow({print:true,  name:"Wyld",       product:"Gummies",          description:"Various | 100mg THC", size:"10 Pieces", price:"18"}),
      blankRow({print:true,  name:"Grön",       product:"Mini Bar",         description:"100mg THC",           size:"1 Piece",   price:"8"}),
      blankRow({print:true,  name:"Good Tide",  product:"Rosin Gummies 1:1",description:"Various | 100mg THC", size:"10 Pieces", price:"22"}),
      blankRow({print:false, name:"Hellavated", product:"Cloud Bar",        description:"All-in-One",          size:"1g",        price:"24"})
    ];
  }
  function save(){ try{ localStorage.setItem(STORAGE_KEY, JSON.stringify(rows)); }catch(e){} }

  // ---- helpers ----
  function esc(s){ return String(s==null?"":s).replace(/[&<>"]/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;"}[c];}); }
  function el(html){ var t=document.createElement("template"); t.innerHTML=html.trim(); return t.content.firstChild; }

  // Price -> always a leading $, cents only when needed.
  function formatPrice(raw){
    if(raw==null) return "";
    var s = String(raw).trim();
    if(!s) return "";
    var cleaned = s.replace(/[^0-9.\-]/g,"");
    if(cleaned==="" || isNaN(parseFloat(cleaned))) return "$"+s.replace(/^\$+/,""); // non-numeric: just ensure one $
    var n = parseFloat(cleaned);
    var hasCents = /\.\d/.test(cleaned) && Math.round(n*100)%100!==0;
    var out = hasCents ? n.toFixed(2) : (Math.round(n*100)%100===0 ? String(Math.round(n)) : n.toFixed(2));
    return "$"+out;
  }

  /* ============================================================
     ★ THE LOCKED LABEL — single source of truth for the design.
     Returns a .av-label node. Empty fields collapse gracefully.
     ============================================================ */
  function renderLabel(d){
    var price = formatPrice(d.price);
    var priceHtml = price ? '<span class="cur">$</span>'+esc(price.replace(/^\$/,"")) : "";
    var sizeHtml  = d.size ? '<span class="av-size">'+esc(d.size)+'</span>' : "";
    var node = el(
      '<div class="av-label">'+
        '<div class="av-guides"><div class="trim"></div><div class="safe"></div></div>'+
        ((d.store || d.status) ?
          '<div class="av-pad">'+
            (d.store ? '<div class="av-store">'+esc(d.store)+'</div>' : '')+
            (d.status ? '<span class="av-flag '+esc(d.status)+'">'+(d.status==="special"?"SPECIAL":"NEW")+'</span>' : '')+
          '</div>' : '')+
        '<div class="av-name">'+esc(d.name)+'</div>'+
        '<div class="av-body">'+
          (d.product ? '<div class="av-product">'+esc(d.product)+'</div>' : '')+
          (d.description ? '<div class="av-desc">'+esc(d.description)+'</div>' : '')+
          (d.description2 ? '<div class="av-desc">'+esc(d.description2)+'</div>' : '')+
        '</div>'+
        '<div class="av-footer">'+ sizeHtml +
          (priceHtml ? '<span class="av-price">'+priceHtml+'</span>' : '')+
        '</div>'+
      '</div>'
    );
    // Auto-shrink the NAME so long names never overflow the box (design stays locked, font just fits).
    fitName(node.querySelector(".av-name"));
    return node;
  }

  function fitName(nameEl){
    if(!nameEl) return;
    // run after insertion; deferred via rAF in caller
    nameEl.__fit = true;
  }
  function applyFit(scope){
    // Name stays a FIXED size for visual continuity; it wraps to a 2nd line
    // (anchored at its bottom, so extra lines grow upward) instead of shrinking.
    scope.querySelectorAll(".av-name").forEach(function(n){
      n.style.fontSize = "";
    });
  }
  // 1in = 96 css px at screen baseline (matches our in/pt units pre-scale)
  function inToPx(v){ return v*96; }
  function ptToPx(v){ return v*96/72; }

  // ---- build one print sheet (9 slots) ----
  function buildSheet(items){
    var sheet = el('<div class="av-sheet"><img class="av-template" src="align-template.png" alt=""/><div class="av-grid"></div></div>');
    var grid = sheet.querySelector(".av-grid");
    for(var i=0;i<LABELS_PER_SHEET;i++){
      if(items[i]) grid.appendChild(renderLabel(items[i]));
      else grid.appendChild(el('<div class="av-label empty-slot"><div class="av-guides"><div class="trim"></div><div class="safe"></div></div></div>'));
    }
    return sheet;
  }

  function queuedRows(){ return rows.filter(function(r){return r.print;}); }

  // ---- validation ----
  function validate(){
    var problems = [];
    var q = [];
    rows.forEach(function(r,idx){
      if(!r.print) return;
      var missing = REQUIRED.filter(function(f){return !String(r[f]||"").trim();});
      if(missing.length) problems.push({row:idx+1, name:r.name||"(no name)", missing:missing});
      q.push(r);
    });
    return {queued:q, problems:problems};
  }

  // ================= RENDER: editor table =================
  var dataBody = document.getElementById("dataBody");
  function renderTable(){
    dataBody.innerHTML="";
    rows.forEach(function(r,idx){ dataBody.appendChild(renderRow(r,idx)); });
  }
  function renderRow(r,idx){
    var tr = el('<tr></tr>');
    if(r.print) tr.classList.add("queued");
    // print checkbox
    var tdc = el('<td class="col-print"></td>');
    var wrap = el('<label class="chk-wrap"></label>');
    var chk = el('<input type="checkbox" class="chk"/>');
    chk.checked = !!r.print;
    chk.addEventListener("change",function(){ r.print=chk.checked; tr.classList.toggle("queued",r.print); save(); refreshPreview(); });
    wrap.appendChild(chk); tdc.appendChild(wrap); tr.appendChild(tdc);
    // field cells
    var cells = [
      {f:"store",        ph:"Store",        tag:"input"},
      {f:"name",         ph:"Brand *",      tag:"input"},
      {f:"product",      ph:"Item",         tag:"input"},
      {f:"description",  ph:"Description",  tag:"input"},
      {f:"description2", ph:"Description 2",tag:"input"},
      {f:"size",         ph:"Size",         tag:"input"},
      {f:"price",        ph:"Price *",      tag:"input"}
    ];
    cells.forEach(function(c){
      var td = el('<td class="col-'+c.f+'"></td>');
      var inp = el('<input class="cell-input" type="text"/>');
      inp.value = r[c.f]||"";
      inp.placeholder = c.ph;
      inp.dataset.field = c.f;
      inp.addEventListener("input",function(){ r[c.f]=inp.value; save(); schedulePreview(); td.classList.remove("invalid"); });
      inp.addEventListener("keydown",onCellKey);
      // ── style-guide autocomplete + smart-naming ──
      if(c.f==="name"){                                   // Brand: type-ahead + conform on blur
        inp.setAttribute("list","brandList"); inp.setAttribute("autocomplete","off");
        inp.addEventListener("blur",function(){
          var norm = normalizeBrand(inp.value);
          if(norm !== inp.value){
            inp.value = norm; r.name = norm; save(); schedulePreview();
            td.classList.add("conformed");
            setTimeout(function(){ td.classList.remove("conformed"); }, 1000);
          }
        });
      }
      if(c.f==="size"){ inp.setAttribute("list","sizeList"); inp.setAttribute("autocomplete","off"); }
      td.appendChild(inp); tr.appendChild(td);
    });
    // flag (new / special) — print-time instruction to attach a physical flag
    var tdf = el('<td class="col-flag"></td>');
    var sel = el('<select class="cell-flag"><option value="">—</option><option value="new">NEW</option><option value="special">SPECIAL</option></select>');
    sel.value = r.status || "";
    sel.className = "cell-flag" + (r.status ? " has-"+r.status : "");
    sel.addEventListener("change",function(){ r.status=sel.value; sel.className="cell-flag"+(r.status?" has-"+r.status:""); save(); schedulePreview(); });
    tdf.appendChild(sel); tr.appendChild(tdf);
    // delete
    var tdt = el('<td class="col-tools"></td>');
    var del = el('<button class="row-del" title="Delete row">&times;</button>');
    del.addEventListener("click",function(){ rows.splice(idx,1); if(!rows.length) rows.push(blankRow()); save(); renderTable(); refreshPreview(); });
    tdt.appendChild(del); tr.appendChild(tdt);
    return tr;
  }

  function onCellKey(e){
    var inp=e.target, td=inp.closest("td"), tr=td.parentNode;
    if(e.key==="Enter"){
      e.preventDefault();
      var next = tr.nextElementSibling;
      var colIndex = Array.prototype.indexOf.call(tr.children, td);
      if(!next){ addRow(); next = dataBody.lastElementChild; }
      var target = next.children[colIndex].querySelector(".cell-input");
      if(target) target.focus();
    }
  }

  // ================= RENDER: preview =================
  var sheetsEl = document.getElementById("sheets");
  var statusEl = document.getElementById("previewStatus");
  var valEl = document.getElementById("validation");
  var previewTimer=null;
  function schedulePreview(){ clearTimeout(previewTimer); previewTimer=setTimeout(refreshPreview,180); }

  function refreshPreview(){
    var v = validate();
    // validation banner
    if(v.problems.length){
      valEl.hidden=false; valEl.className="validation warn";
      var li = v.problems.map(function(p){
        return "<li>Row "+p.row+" — <b>"+esc(p.name)+"</b> missing: "+p.missing.map(function(f){return f==="name"?"Brand":f.charAt(0).toUpperCase()+f.slice(1);}).join(", ")+"</li>";
      }).join("");
      valEl.innerHTML = "<b>"+v.problems.length+" queued label"+(v.problems.length>1?"s":"")+" missing required fields</b> (they’re skipped until fixed):<ul>"+li+"</ul>";
    } else valEl.hidden=true;

    var printable = v.queued.filter(function(r){
      return REQUIRED.every(function(f){return String(r[f]||"").trim();});
    });

    sheetsEl.innerHTML="";
    if(!printable.length){
      statusEl.textContent = v.queued.length ? "Fix the rows above to preview." : "No labels queued.";
      sheetsEl.appendChild(emptyState());
      updateZoom();
      return;
    }
    var pages = Math.ceil(printable.length/LABELS_PER_SHEET);
    statusEl.textContent = printable.length+" label"+(printable.length>1?"s":"")+" · "+pages+" sheet"+(pages>1?"s":"")+" · "+(printable.length%9||9)+" on last sheet";
    for(var p=0;p<pages;p++){
      sheetsEl.appendChild(buildSheet(printable.slice(p*9,p*9+9)));
    }
    requestAnimationFrame(function(){ applyFit(sheetsEl); });
    requestAnimationFrame(updateZoom);
    setTimeout(updateZoom, 60);
  }

  function emptyState(){
    var slots=""; for(var i=0;i<9;i++) slots+="<span></span>";
    return el('<div class="empty-state"><div class="es-sheet">'+slots+'</div><p>Check <b>Print</b> on the products you want,<br>then they’ll appear here 9-up.</p></div>');
  }

  // ================= ZOOM / FIT =================
  var zoom = 0; // 0 = fit
  var scrollEl = document.getElementById("previewScroll");
  function updateZoom(){
    var sheet = sheetsEl.querySelector(".av-sheet");
    var scale;
    if(zoom>0){ scale=zoom; document.getElementById("zoomVal").textContent=Math.round(zoom*100)+"%"; }
    else{
      var avail = scrollEl.clientWidth - 40;
      var natural = 8.5*96;
      scale = sheet ? Math.min(1, avail/natural) : 1;
      document.getElementById("zoomVal").textContent="Fit";
    }
    sheetsEl.style.transform = "scale("+scale+")";
    sheetsEl.style.height = "";
    // reserve vertical room so scaled content doesn't clip
    if(sheet){
      var h = sheetsEl.scrollHeight;
      sheetsEl.style.height = (h*scale)+"px";
    }
  }
  document.getElementById("zoomIn").onclick=function(){ zoom=(zoom||fitScale())+0.1; if(zoom>2)zoom=2; updateZoom(); };
  document.getElementById("zoomOut").onclick=function(){ zoom=(zoom||fitScale())-0.1; if(zoom<0.2)zoom=0.2; updateZoom(); };
  function fitScale(){ var avail=scrollEl.clientWidth-40; return Math.min(1, avail/(8.5*96)); }
  window.addEventListener("resize",function(){ if(zoom===0) updateZoom(); });
  if(window.ResizeObserver){ new ResizeObserver(function(){ if(zoom===0) updateZoom(); }).observe(scrollEl); }

  // ================= ACTIONS =================
  function addRow(){ rows.push(blankRow()); save(); renderTable(); }
  document.getElementById("btnAddRow").onclick=function(){ addRow(); dataBody.lastElementChild.querySelector(".cell-input").focus(); };
  document.getElementById("btnAddRow2").onclick=function(){ addRow(); dataBody.lastElementChild.querySelector(".cell-input").focus(); };
  document.getElementById("btnClearQueue").onclick=function(){
    rows.forEach(function(r){r.print=false;}); save(); renderTable(); refreshPreview();
  };

  // guides toggle
  (function(){
    var chk=document.getElementById("guidesChk");
    if(chk) chk.addEventListener("change",function(){ sheetsEl.classList.toggle("show-guides",chk.checked); });
    var tpl=document.getElementById("templateChk");
    if(tpl) tpl.addEventListener("change",function(){ sheetsEl.classList.toggle("show-template",tpl.checked); });
  })();

  document.getElementById("btnGenerate").onclick=function(){
    var v=validate();
    if(!v.queued.length){
      flashError("No labels selected. Check the <b>Print</b> box on at least one product, then try again.");
      return;
    }
    var printable = v.queued.filter(function(r){ return REQUIRED.every(function(f){return String(r[f]||"").trim();}); });
    if(!printable.length){
      flashError("Every queued label is missing required fields (Brand, Price). Fix the highlighted rows.");
      markInvalid(v.problems);
      return;
    }
    // build print root
    var root=document.getElementById("printRoot");
    root.innerHTML="";
    var pages=Math.ceil(printable.length/9);
    for(var p=0;p<pages;p++) root.appendChild(buildSheet(printable.slice(p*9,p*9+9)));
    applyFit(root);
    requestAnimationFrame(function(){ requestAnimationFrame(function(){ window.print(); }); });
  };

  function markInvalid(problems){
    var rowsTr = dataBody.children;
    problems.forEach(function(p){
      var tr = rowsTr[p.row-1]; if(!tr) return;
      p.missing.forEach(function(f){
        var inp=tr.querySelector('.cell-input[data-field="'+f+'"]');
        if(inp) inp.closest("td").classList.add("invalid");
      });
    });
  }
  function flashError(html){
    valEl.hidden=false; valEl.className="validation error"; valEl.innerHTML=html;
    valEl.scrollIntoView===undefined; // never use scrollIntoView
    scrollEl.scrollTop=0;
  }

  // ================= GOOGLE SHEET IMPORT =================
  var SHEET_URL_KEY = "gcLabels.sheetUrl";
  var DEFAULT_SHEET_URL = "https://docs.google.com/spreadsheets/d/1Zy2Og9SrrqX2--FxSFkvTEosrJ6m-DfCGX3h19GzJ0I/edit?usp=sharing";

  var sheetUrlInput = document.getElementById("sheetUrl");
  var importStatus  = document.getElementById("importStatus");
  var btnImport     = document.getElementById("btnImport");

  function getSheetUrl(){ try{ return localStorage.getItem(SHEET_URL_KEY) || DEFAULT_SHEET_URL; }catch(e){ return DEFAULT_SHEET_URL; } }
  if(sheetUrlInput) sheetUrlInput.value = getSheetUrl();

  function setStatus(msg, kind){
    if(!importStatus) return;
    importStatus.textContent = msg || "";
    importStatus.className = "import-status" + (kind ? " "+kind : "");
  }

  // build the gviz CSV endpoint from any Google Sheet link
  function csvEndpoint(url){
    var id  = (url.match(/\/d\/([a-zA-Z0-9-_]+)/) || [])[1];
    if(!id) return null;
    var gid = (url.match(/[#&?]gid=([0-9]+)/) || [])[1];
    var u = "https://docs.google.com/spreadsheets/d/"+id+"/gviz/tq?tqx=out:csv";
    if(gid) u += "&gid="+gid;
    return u;
  }

  // RFC-4180-ish CSV parser (handles quotes, embedded commas/newlines)
  function parseCSV(text){
    var out=[], row=[], cur="", inQ=false, i=0, n=text.length;
    while(i<n){
      var c=text[i];
      if(inQ){
        if(c==='"'){ if(text[i+1]==='"'){ cur+='"'; i+=2; continue; } inQ=false; i++; continue; }
        cur+=c; i++; continue;
      }
      if(c==='"'){ inQ=true; i++; continue; }
      if(c===','){ row.push(cur); cur=""; i++; continue; }
      if(c==='\r'){ i++; continue; }
      if(c==='\n'){ row.push(cur); out.push(row); row=[]; cur=""; i++; continue; }
      cur+=c; i++;
    }
    if(cur.length || row.length){ row.push(cur); out.push(row); }
    return out;
  }

  // map sheet headers -> label fields, tolerant of naming
  var HEADER_ALIASES = {
    print:        ["print","include","queue","on sheet"],
    store:        ["store","location","shop","dispensary","site"],
    // Brand is the big headline on the card (.av-name). Item Name is the line below it.
    name:         ["brand","brand name","maker","producer","vendor"],
    product:      ["item name","item","product name","product","strain","strain name","title"],
    description:  ["description","desc","description 1","desc 1","details","notes","info","line 1"],
    description2: ["description 2","desc 2","description2","desc2","subtitle","secondary","line 2"],
    size:         ["size","weight","net weight","qty","quantity","amount","grams","unit"],
    price:        ["price","cost","msrp","retail","price ($)"],
    status:       ["status","flag","new/special","new or special","card flag"],
    done:         ["done","printed","complete","completed","finished","archived"]
  };
  function normHeader(h){ return String(h==null?"":h).trim().toLowerCase().replace(/[._]/g," ").replace(/\s+/g," "); }
  function mapHeaders(headers){
    var norm = headers.map(normHeader), map={};
    Object.keys(HEADER_ALIASES).forEach(function(field){
      var aliases = HEADER_ALIASES[field], found=-1;
      for(var a=0;a<aliases.length && found<0;a++) found = norm.indexOf(aliases[a]); // exact
      if(found<0){                                                                  // contains
        for(var c=0;c<norm.length && found<0;c++)
          for(var b=0;b<aliases.length;b++) if(norm[c] && norm[c].indexOf(aliases[b])>=0){ found=c; break; }
      }
      if(found>=0) map[field]=found;
    });
    return map;
  }

  // ---- column mapping (persisted as field -> header NAME so it survives reorders) ----
  var MAP_KEY = "gcLabels.colMap.v1";
  var MAP_FIELDS = [
    {f:"name",         label:"Brand",         req:true},
    {f:"product",      label:"Item",          req:false},
    {f:"description",  label:"Description",   req:false},
    {f:"description2", label:"Description 2", req:false},
    {f:"size",         label:"Size",          req:false},
    {f:"price",        label:"Price",         req:true},
    {f:"store",        label:"Store",         req:false},
    {f:"status",       label:"Flag (new/special)", req:false},
    {f:"done",         label:"Done (skip if ✓)", req:false},
    {f:"print",        label:"Print",         req:false}
  ];
  var lastHeaders=null, lastGrid=null;

  function loadSavedMap(){ try{ return JSON.parse(localStorage.getItem(MAP_KEY)) || null; }catch(e){ return null; } }
  function saveSavedMap(m){ try{ localStorage.setItem(MAP_KEY, JSON.stringify(m)); }catch(e){} }

  function headerIndex(headers, name){
    if(name==null || name==="") return -1;
    var t = normHeader(name);
    for(var i=0;i<headers.length;i++) if(normHeader(headers[i])===t) return i;
    return -1;
  }
  // best-guess field -> header NAME, from aliases
  function autoGuessNameMap(headers){
    var idx = mapHeaders(headers), m={};
    Object.keys(idx).forEach(function(f){ m[f] = headers[idx[f]]; });
    return m;
  }
  // merge saved choices (only those whose header still exists) over the auto-guess
  function effectiveNameMap(headers){
    var guess = autoGuessNameMap(headers), saved = loadSavedMap();
    if(saved) Object.keys(saved).forEach(function(f){
      if(saved[f]==="" || headerIndex(headers, saved[f])>=0) guess[f] = saved[f];
    });
    return guess;
  }
  // field -> column index, from a field->name map
  function resolveIdxMap(headers, nameMap){
    var idx={};
    MAP_FIELDS.forEach(function(d){ idx[d.f] = headerIndex(headers, nameMap[d.f]); });
    return idx;
  }

  var DONE_RE = /^(y|yes|true|x|1|done|printed|complete|completed|✓|✔)$/i;
  function buildRowsFromGrid(grid, idxMap){
    var out=[], doneSkipped=0, hasDone = (idxMap.done!=null && idxMap.done>=0), hasPrint = (idxMap.print!=null && idxMap.print>=0);
    for(var i=1;i<grid.length;i++){
      var r=grid[i];
      var get=function(f){ return (idxMap[f]!=null && idxMap[f]>=0) ? String(r[idxMap[f]]==null?"":r[idxMap[f]]).trim() : ""; };
      // skip rows already marked Done in the sheet
      if(hasDone && DONE_RE.test(get("done"))){ if(get("name")||get("price")||get("store")) doneSkipped++; continue; }
      var rawStatus = get("status").toLowerCase();
      var status = /\b(new|green)\b/.test(rawStatus) ? "new" : (/\b(special|red|sale)\b/.test(rawStatus) ? "special" : "");
      var rec = blankRow({
        // imported rows default to Print = ON, unless a Print column says otherwise
        print:        hasPrint ? DONE_RE.test(get("print")) : true,
        store:        get("store"),
        name:         get("name"),
        product:      get("product"),
        description:  get("description"),
        description2: get("description2"),
        size:         get("size"),
        price:        get("price"),
        status:       status
      });
      if(!rec.name && !rec.product && !rec.price && !rec.store) continue; // skip blank lines
      out.push(rec);
    }
    return {rows:out, doneSkipped:doneSkipped, hasDone:hasDone};
  }

  function gidFromUrl(u){ return (String(u).match(/[#&?]gid=([0-9]+)/) || [])[1] || ""; }

  // shared tail: take a raw grid (from GAS JSON or parsed CSV) and load it
  function finishImport(grid, sourceUrl){
    grid = (grid || []).filter(function(r){ return r.some(function(c){ return String(c).trim(); }); });
    if(grid.length < 2) throw new Error("empty");
    lastGrid = grid; lastHeaders = grid[0];
    var nameMap = effectiveNameMap(lastHeaders);
    var idxMap  = resolveIdxMap(lastHeaders, nameMap);
    var built   = buildRowsFromGrid(grid, idxMap);
    var imported = built.rows;
    renderMapPanel(nameMap);
    if(!imported.length){
      if(built.hasDone && built.doneSkipped){ rows=[blankRow()]; save(); renderTable(); refreshPreview();
        setStatus("Nothing new — all "+built.doneSkipped+" sheet row"+(built.doneSkipped>1?"s are":" is")+" already marked Done.", "ok"); return; }
      throw new Error("nomatch");
    }
    rows = imported; save(); renderTable(); refreshPreview();
    var t = new Date().toLocaleTimeString([], {hour:"numeric", minute:"2-digit"});
    var skipMsg = built.doneSkipped ? (" · skipped "+built.doneSkipped+" already-Done") : "";
    setStatus("Imported "+imported.length+" product"+(imported.length>1?"s":"")+skipMsg+" · "+t, "ok");
    markDoneInSheet(sourceUrl, nameMap.done, imported.length);   // write Done back (GAS engine only)
  }

  function doImport(){
    var url = ((sheetUrlInput && sheetUrlInput.value) || "").trim() || DEFAULT_SHEET_URL;
    try{ localStorage.setItem(SHEET_URL_KEY, url); }catch(e){}
    var engine = ((markUrlInput && markUrlInput.value) || loadWebapp()).trim();
    if(btnImport) btnImport.classList.add("loading");
    setStatus("Importing…");
    var p;
    if(engine){
      // read THROUGH the Apps Script engine (Sheet can be private)
      var sep = engine.indexOf("?")<0 ? "?" : "&";
      p = fetch(engine + sep + "gid=" + encodeURIComponent(gidFromUrl(url)), {cache:"no-store"})
        .then(function(res){ if(!res.ok) throw new Error("http-"+res.status); return res.json(); })
        .then(function(data){ if(!data || !data.ok) throw new Error((data && data.error) || "engine"); finishImport(data.grid, url); });
    } else {
      // fall back to the public CSV link (read-only)
      var endpoint = csvEndpoint(url);
      if(!endpoint){ setStatus("Add your Google Sheet link, or an engine URL in ⚙ Sheet settings.", "err"); if(btnImport) btnImport.classList.remove("loading"); return; }
      p = fetch(endpoint, {cache:"no-store"})
        .then(function(res){ if(!res.ok) throw new Error("http-"+res.status); return res.text(); })
        .then(function(text){ if(/^\s*<!?\s*(html|doctype)/i.test(text)) throw new Error("not-public"); finishImport(parseCSV(text), url); });
    }
    p.catch(function(err){
        var m = String(err && err.message || err);
        if(m==="not-public")       setStatus("Can't read the sheet. Either set sharing to “Anyone with the link → Viewer”, or use an Apps Script engine URL in ⚙ Sheet settings.", "err");
        else if(m==="empty")       setStatus("The sheet looks empty — it needs a header row plus data.", "err");
        else if(m==="no-done-column") setStatus("Imported, but the engine couldn't find a “Done” column to filter on.", "err");
        else if(/failed to fetch/i.test(m)) setStatus("Couldn't reach the data source. Check the link / engine URL and its sharing.", "err");
        else if(m==="nomatch")     setStatus("Imported the sheet, but no rows matched. Use “Match columns” below to map the fields.", "err"), lastHeaders && renderMapPanel(effectiveNameMap(lastHeaders));
        else                       setStatus("Import failed ("+m+").", "err");
      })
      .then(function(){ if(btnImport) btnImport.classList.remove("loading"); });
  }
  if(btnImport) btnImport.onclick = doImport;
  if(sheetUrlInput) sheetUrlInput.addEventListener("keydown", function(e){ if(e.key==="Enter"){ e.preventDefault(); doImport(); } });

  // ---- write-back: mark imported rows Done in the sheet (needs an Apps Script web app) ----
  var WEBAPP_KEY = "gcLabels.markDoneUrl";
  var WEBAPP_ON_KEY = "gcLabels.markDoneOn";
  // Team default: the deployed Apps Script data engine. Baked in so staff never
  // have to configure anything — open the page, click Import, and it reads the
  // (private) Sheet through this engine and writes Done back. Override per-machine
  // in ⚙ Sheet settings if needed.
  var DEFAULT_WEBAPP_URL = "https://script.google.com/macros/s/AKfycbwKRfDEz5Rugw-NfFZpEMDawoX-nBCB0rocMdt-KBfcyOf13ZO8D2INQGvHqIzKjVFb/exec";
  var markUrlInput = document.getElementById("markDoneUrl");
  var markToggle   = document.getElementById("markDoneToggle");
  function loadWebapp(){ try{ return localStorage.getItem(WEBAPP_KEY) || DEFAULT_WEBAPP_URL; }catch(e){ return DEFAULT_WEBAPP_URL; } }
  function loadWebappOn(){ try{ return localStorage.getItem(WEBAPP_ON_KEY) !== "0"; }catch(e){ return true; } }
  if(markUrlInput){ markUrlInput.value = loadWebapp();
    markUrlInput.addEventListener("change", function(){ try{ localStorage.setItem(WEBAPP_KEY, markUrlInput.value.trim()); }catch(e){} }); }
  if(markToggle){ markToggle.checked = loadWebappOn();
    markToggle.addEventListener("change", function(){ try{ localStorage.setItem(WEBAPP_ON_KEY, markToggle.checked ? "1" : "0"); }catch(e){} }); }

  function markDoneInSheet(sheetUrl, doneHeader, count){
    var endpoint = ((markUrlInput && markUrlInput.value) || loadWebapp()).trim();
    var on = markToggle ? markToggle.checked : loadWebappOn();
    if(!on || !endpoint) return;                       // no engine configured — read-only mode
    var payload = JSON.stringify({ action:"markDone", gid:gidFromUrl(sheetUrl), doneHeader:(doneHeader||"Done") });
    // text/plain avoids a CORS preflight; the /exec redirect serves CORS-open JSON we can read
    fetch(endpoint, { method:"POST", headers:{ "Content-Type":"text/plain;charset=utf-8" }, body:payload })
      .then(function(res){ return res.json().catch(function(){ return null; }); })
      .then(function(data){
        var cur = importStatus ? importStatus.textContent : "";
        if(data && data.ok) setStatus(cur + " · marked "+(data.marked!=null?data.marked+" ":"")+"Done in sheet ✓", "ok");
        else if(data && data.error) setStatus(cur + " · write-back issue: "+data.error, "err");
        else setStatus(cur + " · marked Done in sheet ✓", "ok");
      })
      .catch(function(){ setStatus("Imported OK, but the write-back call failed. Check the engine URL in ⚙ Sheet settings.", "err"); });
  }

  // ---- mapping panel ----
  var mapPanel = document.getElementById("sheetMap");
  var mapGrid  = document.getElementById("sheetMapGrid");
  function renderMapPanel(nameMap){
    if(!mapPanel || !mapGrid || !lastHeaders) return;
    mapGrid.innerHTML = "";
    MAP_FIELDS.forEach(function(d){
      var row = el('<div class="map-field"></div>');
      row.appendChild(el('<label>'+d.label+(d.req?' <span class="req">*</span>':'')+'</label>'));
      var sel = document.createElement("select");
      sel.dataset.field = d.f;
      var opt0 = document.createElement("option"); opt0.value=""; opt0.textContent="— none —"; sel.appendChild(opt0);
      lastHeaders.forEach(function(h){
        var o=document.createElement("option"); o.value=h; o.textContent=h || "(blank)"; sel.appendChild(o);
      });
      sel.value = (nameMap[d.f]!=null && headerIndex(lastHeaders, nameMap[d.f])>=0) ? nameMap[d.f] : "";
      row.appendChild(sel); mapGrid.appendChild(row);
    });
    mapPanel.hidden = false;
  }
  function currentPanelMap(){
    var m={};
    mapGrid.querySelectorAll("select").forEach(function(s){ m[s.dataset.field] = s.value; });
    return m;
  }
  var btnApplyMap = document.getElementById("btnApplyMap");
  if(btnApplyMap) btnApplyMap.onclick = function(){
    if(!lastGrid){ return; }
    var nameMap = currentPanelMap();
    saveSavedMap(nameMap);
    var built = buildRowsFromGrid(lastGrid, resolveIdxMap(lastHeaders, nameMap));
    var imported = built.rows;
    rows = imported.length ? imported : rows;
    save(); renderTable(); refreshPreview();
    var skipMsg = built.doneSkipped ? (" · skipped "+built.doneSkipped+" Done") : "";
    setStatus(imported.length ? ("Mapping applied · "+imported.length+" product"+(imported.length>1?"s":"")+skipMsg) : "That mapping produced no rows — check your picks.", imported.length?"ok":"err");
  };
  var mapClose = document.getElementById("mapClose");
  if(mapClose) mapClose.onclick = function(){ if(mapPanel) mapPanel.hidden = true; };

  // ================= STYLE GUIDE: autocomplete + smart-naming =================
  // Loads the canonical tag dictionary (style/tags.json) and powers brand
  // type-ahead + on-blur normalization, so cards stay uniform across stores.
  var STYLE = { brands:[], brandNorm:{}, sizes:[] };
  function ensureDatalist(id, values){
    var dl = document.getElementById(id);
    if(!dl){ dl = document.createElement("datalist"); dl.id = id; document.body.appendChild(dl); }
    dl.innerHTML = (values||[]).map(function(v){ return '<option value="'+esc(v)+'"></option>'; }).join("");
  }
  function normalizeBrand(v){
    var s = String(v==null?"":v).trim();
    if(!s) return s;
    var hit = STYLE.brandNorm[s.toLowerCase()];
    return hit || s;   // unknown brands pass through untouched
  }
  function loadStyle(){
    fetch("style/tags.json", {cache:"no-store"})
      .then(function(res){ if(!res.ok) throw 0; return res.json(); })
      .then(function(t){
        STYLE.brands = t.brands || [];
        var m = {};
        STYLE.brands.forEach(function(b){ m[b.toLowerCase()] = b; });          // canonical casing
        var corr = t.brand_corrections || {};
        Object.keys(corr).forEach(function(k){ m[k.toLowerCase()] = corr[k]; }); // known fixes
        STYLE.brandNorm = m;
        var sizes = [], su = t.size_units || {};
        ["weights","counts_packs","other"].forEach(function(k){
          (su[k]||[]).forEach(function(s){ if(sizes.indexOf(s)<0) sizes.push(s); });
        });
        STYLE.sizes = sizes;
        ensureDatalist("brandList", STYLE.brands);
        ensureDatalist("sizeList", STYLE.sizes);
      })
      .catch(function(){ /* dictionary optional — app still works without it */ });
  }

  // ================= INIT =================
  loadStyle();
  renderTable();
  refreshPreview();
  // re-fit once fonts + layout settle (first paint can mis-measure)
  function settle(){ if(zoom===0) requestAnimationFrame(function(){ applyFit(sheetsEl); updateZoom(); }); }
  if(document.fonts && document.fonts.ready) document.fonts.ready.then(settle);
  window.addEventListener("load", settle);
  setTimeout(settle, 250);
})();
