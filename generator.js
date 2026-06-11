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

  // ================= RENDER: editor (two-row product blocks) =================
  var dataBody = document.getElementById("dataBody");
  function renderTable(){
    dataBody.innerHTML="";
    var queued = 0;
    rows.forEach(function(r,idx){
      if(r.print && queued>0 && queued%LABELS_PER_SHEET===0){      // sheet break every 9 print-checked cards
        dataBody.appendChild(el('<div class="erow-divider"><span>Sheet '+(queued/LABELS_PER_SHEET+1)+'</span></div>'));
      }
      dataBody.appendChild(renderRow(r,idx));
      if(r.print) queued++;
    });
  }
  function flashInput(inp){ if(inp){ inp.classList.add("conformed"); setTimeout(function(){ inp.classList.remove("conformed"); }, 1000); } }
  // one editable field + its autocomplete / smart-naming / cascade hooks
  function makeField(r, f, ph, cls, inputs){
    var inp = el('<input class="ef '+cls+'" type="text"/>');
    inp.value = r[f]||""; inp.placeholder = ph; inp.dataset.field = f;
    inputs[f] = inp;
    inp.addEventListener("input", function(){ r[f]=inp.value; save(); schedulePreview(); inp.classList.remove("invalid"); });
    inp.addEventListener("keydown", onCellKey);
    if(f==="name"){                                       // Brand: type-ahead + conform on blur
      inp.setAttribute("list","brandList"); inp.setAttribute("autocomplete","off");
      inp.addEventListener("blur", function(){
        var norm = normalizeBrand(inp.value);
        if(norm !== inp.value){ inp.value = norm; r.name = norm; save(); schedulePreview(); flashInput(inp); }
      });
    }
    if(f==="product"){                                    // Item: options filtered to the brand
      inp.setAttribute("list","itemList"); inp.setAttribute("autocomplete","off");
      inp.addEventListener("focus", function(){ ensureDatalist("itemList", productsFor(normalizeBrand(r.name))); });
      inp.addEventListener("change", function(){ cascadeFill(r, inputs, "product"); });
      inp.addEventListener("blur",   function(){ cascadeFill(r, inputs, "product"); });
    }
    if(f==="size"){                                       // Size: options filtered to brand+item; sets price
      inp.setAttribute("list","sizeList"); inp.setAttribute("autocomplete","off");
      inp.addEventListener("focus", function(){
        var vs = variantsFor(normalizeBrand(r.name), (r.product||"").trim());
        ensureDatalist("sizeList", vs.length ? uniq(vs.map(function(v){ return v.size; })) : STYLE.sizes);
      });
      inp.addEventListener("change", function(){ cascadeFill(r, inputs, "size"); });
      inp.addEventListener("blur",   function(){ cascadeFill(r, inputs, "size"); });
    }
    return inp;
  }
  function renderRow(r, idx){
    var block = el('<div class="erow" data-idx="'+idx+'"></div>');
    if(r.print) block.classList.add("queued");
    var inputs = {};
    // print checkbox
    var chk = el('<input type="checkbox" class="ef-print"/>'); chk.checked = !!r.print;
    chk.addEventListener("change", function(){ r.print=chk.checked; save(); renderTable(); refreshPreview(); });
    var check = el('<label class="erow-check" title="Print this card"></label>'); check.appendChild(chk);
    // line 1 (the card essentials): brand · item · size · $price
    var l1 = el('<div class="erow-l1"></div>');
    l1.appendChild(makeField(r,"name","Brand *","ef-brand",inputs));
    l1.appendChild(makeField(r,"product","Item","ef-item",inputs));
    l1.appendChild(makeField(r,"size","Size","ef-size",inputs));
    var priceWrap = el('<div class="ef-price-wrap"><span class="ef-price-sign">$</span></div>');
    priceWrap.appendChild(makeField(r,"price","","ef-price",inputs));
    l1.appendChild(priceWrap);
    // flag (placed second-to-last on line 2)
    var sel = el('<select class="ef-flag"><option value="">— flag —</option><option value="new">NEW</option><option value="special">SPECIAL</option></select>');
    sel.value = r.status||""; sel.className = "ef-flag"+(r.status?" has-"+r.status:"");
    sel.addEventListener("change", function(){ r.status=sel.value; sel.className="ef-flag"+(r.status?" has-"+r.status:""); save(); schedulePreview(); });
    // line 2: description · description 2 · flag · store (store last)
    var l2 = el('<div class="erow-l2"></div>');
    l2.appendChild(makeField(r,"description","Description","ef-desc",inputs));
    l2.appendChild(makeField(r,"description2","Description 2","ef-desc2",inputs));
    l2.appendChild(sel);
    l2.appendChild(makeField(r,"store","Store","ef-store",inputs));
    var fields = el('<div class="erow-fields"></div>'); fields.appendChild(l1); fields.appendChild(l2);
    var del = el('<button class="erow-del" title="Delete card">&times;</button>');
    del.addEventListener("click", function(){ var i=rows.indexOf(r); if(i>=0) rows.splice(i,1); if(!rows.length) rows.push(blankRow()); save(); renderTable(); refreshPreview(); });
    var main = el('<div class="erow-main"></div>');
    main.appendChild(check); main.appendChild(fields); main.appendChild(del);
    block.appendChild(main);
    return block;
  }

  function onCellKey(e){
    if(e.key!=="Enter") return;                            // Enter → same field, next card (Tab still moves across fields)
    e.preventDefault();
    var inp=e.target, f=inp.dataset.field, block=inp.closest(".erow");
    var next=block && block.nextElementSibling;
    while(next && !next.classList.contains("erow")) next=next.nextElementSibling;  // skip sheet dividers
    if(!next){ addRow(); next=dataBody.lastElementChild; }
    var target=next && next.querySelector('.ef[data-field="'+f+'"]');
    if(target) target.focus();
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
  document.getElementById("btnAddRow").onclick=function(){ addRow(); var f=dataBody.lastElementChild.querySelector(".ef-brand"); if(f) f.focus(); };
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
    var printed = printable.slice();
    setTimeout(function(){
      window.print();
      offerClearPrinted(printed);    // after the print dialog closes, offer to clear them from the queue
    }, 80);
  };

  // After printing, offer to remove the printed cards from the queue (confirmed,
  // so a cancelled print dialog never loses cards). Matches the print-queue model.
  function offerClearPrinted(printed){
    if(!printed || !printed.length) return;
    valEl.hidden=false; valEl.className="validation info";
    valEl.innerHTML = '<b>Sent '+printed.length+' card'+(printed.length>1?'s':'')+' to print.</b> '+
      '<span class="val-q">Clear them from the queue?</span> '+
      '<button class="btn btn-soft" id="btnClearPrinted">Clear printed</button> '+
      '<button class="btn btn-ghost" id="btnKeepPrinted">Keep</button>';
    document.getElementById("btnClearPrinted").onclick=function(){
      var qids = printed.map(function(r){ return r.qid; }).filter(Boolean);
      rows = rows.filter(function(r){ return printed.indexOf(r)<0; });
      if(!rows.length) rows.push(blankRow());
      save(); renderTable(); refreshPreview(); valEl.hidden=true;
      if(qids.length){                                  // also clear them from the shared queue
        var url = engineUrl();
        if(url) fetch(url, { method:"POST", headers:{ "Content-Type":"text/plain;charset=utf-8" },
          body:JSON.stringify({ action:"queueRemove", ids:qids }) }).then(function(){ refreshQueueCount(); }).catch(function(){});
      }
    };
    document.getElementById("btnKeepPrinted").onclick=function(){ valEl.hidden=true; };
  }

  function markInvalid(problems){
    problems.forEach(function(p){
      var block = dataBody.querySelector('.erow[data-idx="'+(p.row-1)+'"]'); if(!block) return;
      p.missing.forEach(function(f){
        var inp = block.querySelector('.ef[data-field="'+f+'"]');
        if(inp) inp.classList.add("invalid");
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
  var STYLE = { brands:[], brandNorm:{}, sizes:[], catalog:{}, catalogIndex:[], liveIndex:[], liveReady:false };
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
  function uniq(a){ var o=[]; (a||[]).forEach(function(x){ if(x && o.indexOf(x)<0) o.push(x); }); return o; }
  function productsFor(brand){ var b = STYLE.catalog[brand]; return b ? Object.keys(b) : []; }
  function variantsFor(brand, product){ var b = STYLE.catalog[brand]; return (b && b[product]) ? b[product] : []; }
  function flashCell(inp){ if(inp){ inp.classList.add("conformed"); setTimeout(function(){ inp.classList.remove("conformed"); }, 1000); } }

  // Cascade: once Brand+Item (and Size) narrow to a known card, auto-fill size/price/desc.
  function cascadeFill(r, inputs, stage){
    var brand = normalizeBrand(r.name), product = (r.product||"").trim();
    var variants = variantsFor(brand, product);
    if(!variants.length) return;
    var touched = [];
    function set(f, val, onlyIfEmpty){
      if(!val || !inputs[f]) return;
      if(onlyIfEmpty && (inputs[f].value||"").trim()) return;
      if((inputs[f].value||"") === String(val)) return;
      inputs[f].value = val; r[f] = String(val); touched.push(f);
    }
    if(stage === "product"){
      if(variants.length === 1){                       // unique item → fill it all
        set("size", variants[0].size); set("price", variants[0].price); set("description", variants[0].desc, true);
      } else {                                          // many sizes → fill price only if they all share one
        var prices = uniq(variants.map(function(v){ return v.price; }));
        if(prices.length === 1) set("price", prices[0]);
      }
    } else {                                            // stage === "size" → resolve price for the chosen size
      var size = (r.size||"").trim();
      var match = variants.filter(function(v){ return v.size === size; });
      if(match.length){ set("price", match[0].price); set("description", match[0].desc, true); }
    }
    if(touched.length){ save(); schedulePreview(); touched.forEach(function(f){ flashCell(inputs[f]); }); }
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
    fetch("style/catalog.json", {cache:"no-store"})
      .then(function(res){ if(!res.ok) throw 0; return res.json(); })
      .then(function(c){ STYLE.catalog = c || {}; buildIndex(); })
      .catch(function(){ /* catalog optional */ });
  }

  // ===== CARD BUILDER — search → conformed card =====
  // ----- OTD pricing + category system (Settings — GLOBAL, shared via the engine) -----
  var CONFIG_KEY = "gcLabels.config.v1";   // local cache of the shared config
  // Editable label sections (the 10 core + custom ones the team adds).
  var DEFAULT_SECTIONS = ["EDIBLE","BEVERAGE","VAPE","DISPOSABLE","EXTRACT","PRE ROLLS","TINCTURES","TOPICALS","ACCESSORIES","BRANDS","Blunts","Joint Pack"];
  // Keyword rules on the PRODUCT NAME — checked first, override the category map.
  var DEFAULT_CATRULES = [
    {kw:"AIO", section:"DISPOSABLE"}, {kw:"Disposable", section:"DISPOSABLE"},
    {kw:"Joint Pack", section:"Joint Pack"}, {kw:"Blunt", section:"Blunts"}
  ];
  var AUTO_CATMAP = {
    "Edible (Solid)":"EDIBLE","Edible (Liquid)":"BEVERAGE","Capsule":"EDIBLE","CBD Products":"EDIBLE",
    "Inhalable Cannabinoid w/ Non-Cannabis Additives":"VAPE",
    "Extract (Liquid)":"EXTRACT","Extract (Solid)":"EXTRACT","Concentrate":"EXTRACT",
    "Infused Pre-roll":"PRE ROLLS","Pre-Roll Pack":"PRE ROLLS","1g Pre-Roll":"PRE ROLLS","Blunts":"PRE ROLLS",
    "Tincture":"TINCTURES","Topical":"TOPICALS",
    "Paraphernalia":"ACCESSORIES","Paraphernalia Accessories":"ACCESSORIES","Paraphernalia Electronics":"ACCESSORIES",
    "Paraphernalia Pipe":"ACCESSORIES","Paraphernalia Bong":"ACCESSORIES","Paraphernalia Bubbler":"ACCESSORIES",
    "Apparel":"BRANDS","Non Cannabinoid CPG":"BRANDS"
  };
  function lsGet(k,d){ try{ var v=JSON.parse(localStorage.getItem(k)); return v==null?d:v; }catch(e){ return d; } }
  function lsSet(k,v){ try{ localStorage.setItem(k, JSON.stringify(v)); }catch(e){} }
  // Load from local cache, migrating any older per-key storage.
  var _c = lsGet(CONFIG_KEY, null) || {
    otd: localStorage.getItem("gcLabels.otd.v1")==="1",
    sections: lsGet("gcLabels.sections.v1", null),
    catMap: lsGet("gcLabels.catMap.v1", null),
    rules: lsGet("gcLabels.catRules.v1", null)
  };
  var OTD_ON      = !!_c.otd;
  var SECTIONS    = (Array.isArray(_c.sections) && _c.sections.length) ? _c.sections : DEFAULT_SECTIONS.slice();
  var USER_CATMAP = (_c.catMap && typeof _c.catMap === "object") ? _c.catMap : {};
  var CAT_RULES   = Array.isArray(_c.rules) ? _c.rules : DEFAULT_CATRULES.slice();
  function currentConfig(){ return { otd:OTD_ON, sections:SECTIONS, catMap:USER_CATMAP, rules:CAT_RULES }; }
  var _cfgTimer = null;
  function pushConfig(){                 // persist locally + to the shared engine store (debounced)
    lsSet(CONFIG_KEY, currentConfig());
    var url = (typeof loadWebapp === "function") ? (loadWebapp()||"").trim() : "";
    if(!url) return;
    clearTimeout(_cfgTimer);
    _cfgTimer = setTimeout(function(){
      fetch(url, { method:"POST", headers:{ "Content-Type":"text/plain;charset=utf-8" },
        body: JSON.stringify({ action:"saveConfig", config: currentConfig() }) }).catch(function(){});
    }, 500);
  }
  // all the Settings save hooks funnel to one global push
  function saveOtd(){ pushConfig(); }
  function saveSections(){ pushConfig(); }
  function saveRules(){ pushConfig(); }
  function saveCatMap(){ pushConfig(); }
  function applyConfig(c){
    if(!c) return false;
    if(typeof c.otd === "boolean") OTD_ON = c.otd;
    if(Array.isArray(c.sections) && c.sections.length) SECTIONS = c.sections;
    if(c.catMap && typeof c.catMap === "object") USER_CATMAP = c.catMap;
    if(Array.isArray(c.rules)) CAT_RULES = c.rules;
    return true;
  }
  function fetchConfigGlobal(){          // adopt the shared config on load
    var url = (typeof loadWebapp === "function") ? (loadWebapp()||"").trim() : "";
    if(!url) return;
    var sep = url.indexOf("?")<0 ? "?" : "&";
    fetch(url+sep+"action=getConfig", {cache:"no-store"}).then(function(r){ return r.json(); })
      .then(function(d){
        if(d && d.ok && d.config && applyConfig(d.config)){
          lsSet(CONFIG_KEY, currentConfig());
          var ot = document.getElementById("otdToggle"); if(ot) ot.checked = OTD_ON;
          buildSettingsUI(); rebuildLive();
        } else if(d && d.ok && !d.config){
          pushConfig();   // no shared config yet — seed it from this device's settings
        }
      }).catch(function(){});
  }
  function catMapFor(cat){ if(!cat) return ""; if(USER_CATMAP[cat]!=null) return USER_CATMAP[cat]; return AUTO_CATMAP[cat]||""; }
  // Resolve a product's house section: keyword rules (by product name) win, then the category map.
  function houseCategoryFor(it){
    var name = String(it.name||"").toLowerCase();
    for(var i=0;i<CAT_RULES.length;i++){
      var kw = String(CAT_RULES[i].kw||"").trim().toLowerCase();
      if(kw && name.indexOf(kw)>=0) return CAT_RULES[i].section;
    }
    return catMapFor(it.category||"");
  }

  // Conform a raw Dutchie inventory item into house Brand/Item/Desc/Size/Price.
  // First-pass heuristics — brand+price are exact; item/size/desc are best-effort.
  function conformDutchie(it){
    var brand = normalizeBrand(it.brand||"");
    var name  = String(it.name||"").replace(/^\$[\d.]+\s*\|\s*/, "");   // strip accessory "$10.00 | "
    var parts = name.split(/\s*\|\s*/);
    if(parts.length>1){                                                 // drop trailing SKU-like code
      var last = parts[parts.length-1];
      if(last.indexOf(" ")<0 && /\d/.test(last) && /^[A-Za-z0-9\-\/"']+$/.test(last) && !/mg|:/.test(last)) parts.pop();
    }
    if(parts.length>1 && normalizeBrand(parts[parts.length-1])===brand) parts.pop(); // bulk "Strain | Brand"
    var main = parts[0]||"", hay = name;
    var size="", mPack=hay.match(/(\d+)\s*(pk|pack)\b/i), mPc=hay.match(/(\d+)\s*(pc|pcs|ct|pieces?)\b/i), mWt=hay.match(/(\d*\.?\d+)\s*(g|oz|ml)\b/i);
    if(mPack)        size = mPack[1]+" Pack";
    else if(mPc)     size = mPc[1]+(mPc[1]==="1"?" Piece":" Pieces");
    else if(mWt)     size = mWt[1]+mWt[2].toLowerCase();
    else if(it.unitWeight && it.unitWeightUnit) size = String(it.unitWeight)+String(it.unitWeightUnit);
    else if(/^(Paraphernalia|Apparel)/i.test(it.category||"")) size = "Each";
    var pot   = (hay.match(/\d+(?::\d+)*\s*mg(?:\s*:\s*\d+\s*mg)*/i)||[""])[0].replace(/\s+/g,"");
    var ratio = (hay.match(/\b\d+:\d+(?::\d+)*\b/)||[""])[0];
    var item  = main.replace(/\b\d+\s*(pk|pack|pc|pcs|ct|pieces?)\b/ig,"").replace(/\b\d*\.?\d+\s*(g|oz|ml)\b/ig,"").replace(/\s{2,}/g," ").trim();
    var bits=[]; if(it.strainType) bits.push(it.strainType); if(ratio && item.indexOf(ratio)<0) bits.push(ratio); if(pot) bits.push(pot);
    var price = it.price, n = parseFloat(price);
    if(OTD_ON && !isNaN(n)) price = Math.round(n * 1.2);          // OTD: +20%, round to nearest $
    var house = houseCategoryFor(it);                             // keyword rules → category map
    return { brand:brand, item:item||main, desc:bits.join(" | "), size:size, price:String(price||""), category:house||(it.category||""), store:it.store||"" };
  }
  function idxEntry(o, hay){ o.hay = String(hay).toLowerCase(); return o; }
  function buildIndex(){    // static (template) catalog → searchable index
    var idx = [];
    Object.keys(STYLE.catalog).forEach(function(brand){
      var prods = STYLE.catalog[brand];
      Object.keys(prods).forEach(function(item){
        prods[item].forEach(function(v){
          idx.push(idxEntry({ brand:brand, item:item, desc:v.desc||"", size:v.size||"", price:v.price||"", category:v.category||"", store:"" },
            brand+" "+item+" "+(v.desc||"")+" "+(v.size||"")+" "+(v.category||"")));
        });
      });
    });
    STYLE.catalogIndex = idx;
  }
  function buildLiveIndex(items){   // live Dutchie inventory → conformed searchable index
    STYLE.liveIndex = (items||[]).map(function(it){
      var c = conformDutchie(it);
      return idxEntry({ brand:c.brand, item:c.item, desc:c.desc, size:c.size, price:c.price, category:c.category, store:c.store },
        (it.brand+" "+it.name+" "+(it.category||"")));
    });
  }
  // Re-conform live data (after OTD / category-map changes) and refresh open results.
  function rebuildLive(){
    if(STYLE.liveRaw && STYLE.liveRaw.length) buildLiveIndex(STYLE.liveRaw);
    if(typeof cbSearch !== "undefined" && cbSearch && cbSearch.value){
      cbMatches = cbRun(cbSearch.value); cbRender();
    }
  }
  function sectionOptions(cur){
    return '<option value="">— none —</option>' + SECTIONS.map(function(h){
      return '<option value="'+esc(h)+'"'+(h===cur?' selected':'')+'>'+esc(h)+'</option>'; }).join("");
  }
  function buildSettingsUI(){ buildSectionsUI(); buildRulesUI(); buildCatMapUI(); }

  // Editable list of label sections (core 10 + custom).
  function buildSectionsUI(){
    var wrap = document.getElementById("sectionsList");
    if(!wrap) return;
    wrap.innerHTML = SECTIONS.map(function(s,i){
      return '<span class="chip">'+esc(s)+'<button class="chip-x" data-i="'+i+'" title="Remove">&times;</button></span>';
    }).join("");
    wrap.querySelectorAll(".chip-x").forEach(function(b){
      b.addEventListener("click", function(){ SECTIONS.splice(+b.dataset.i,1); saveSections(); buildSettingsUI(); rebuildLive(); });
    });
  }
  // Keyword rules (product name → section), checked before the category map.
  function buildRulesUI(){
    var wrap = document.getElementById("rulesList");
    if(!wrap) return;
    wrap.innerHTML = CAT_RULES.map(function(r,i){
      return '<div class="rule-row">'+
        '<span class="rule-if">if name contains</span>'+
        '<input class="rule-kw" data-i="'+i+'" value="'+esc(r.kw||"")+'" placeholder="e.g. AIO"/>'+
        '<span class="rule-arrow">→</span>'+
        '<select class="rule-sec" data-i="'+i+'">'+sectionOptions(r.section)+'</select>'+
        '<button class="chip-x" data-i="'+i+'" title="Remove rule">&times;</button>'+
      '</div>';
    }).join("");
    wrap.querySelectorAll(".rule-kw").forEach(function(inp){
      inp.addEventListener("change", function(){ CAT_RULES[+inp.dataset.i].kw = inp.value; saveRules(); rebuildLive(); });
    });
    wrap.querySelectorAll(".rule-sec").forEach(function(sel){
      sel.addEventListener("change", function(){ CAT_RULES[+sel.dataset.i].section = sel.value; saveRules(); rebuildLive(); });
    });
    wrap.querySelectorAll(".chip-x").forEach(function(b){
      b.addEventListener("click", function(){ CAT_RULES.splice(+b.dataset.i,1); saveRules(); buildRulesUI(); rebuildLive(); });
    });
  }
  // Build the Settings category-map UI from the distinct Dutchie categories in live data.
  function buildCatMapUI(){
    var grid = document.getElementById("catMapGrid");
    if(!grid) return;
    var seen = {};
    (STYLE.liveRaw||[]).forEach(function(it){ if(it.category) seen[it.category] = true; });
    var list = Object.keys(seen).sort();
    if(!list.length){ grid.innerHTML = '<div class="set-note">Loads once live inventory is fetched…</div>'; return; }
    grid.innerHTML = list.map(function(cat){
      return '<div class="catmap-row-cat" title="'+esc(cat)+'">'+esc(cat)+'</div><select data-cat="'+esc(cat)+'">'+sectionOptions(catMapFor(cat))+'</select>';
    }).join("");
    grid.querySelectorAll("select").forEach(function(sel){
      sel.addEventListener("change", function(){ USER_CATMAP[sel.dataset.cat] = sel.value; saveCatMap(USER_CATMAP); rebuildLive(); });
    });
  }
  function activeIndex(){ return (STYLE.liveReady && STYLE.liveIndex && STYLE.liveIndex.length) ? STYLE.liveIndex : (STYLE.catalogIndex||[]); }
  function cbRun(q){
    q = String(q||"").trim().toLowerCase();
    if(!q) return [];
    var toks = q.split(/\s+/), scored = [];
    activeIndex().forEach(function(e){
      var s = 0, ok = true;
      for(var i=0;i<toks.length;i++){
        var t = toks[i], at = e.hay.indexOf(t);
        if(at < 0){ ok = false; break; }
        s += (e.brand.toLowerCase().indexOf(t)>=0 ? 3 : 1) + (at===0 ? 1 : 0);
      }
      if(ok) scored.push({ e:e, s:s });
    });
    scored.sort(function(a,b){ return b.s - a.s; });
    return scored.map(function(x){ return x.e; });   // all matches (results list scrolls)
  }

  var cbSearch  = document.getElementById("cbSearch");
  var cbResults = document.getElementById("cbResults");
  var cbMatches = [], CB_GROUPS = [], CB_EXPANDED = {};

  // Generic "base item" (product noun) — drop the leading flavor/strain words.
  function baseItem(item){
    var w = String(item||"").trim().split(/\s+/);
    if(!w.length) return item||"";
    if(w.length>=2 && /^(pack|roll|aio|bar)$/i.test(w[w.length-1])) return w.slice(-2).join(" ");
    return w[w.length-1];
  }
  // Collapse flavor variants: group matches by brand + base item + size + price + section.
  function cbGroupMatches(){
    var groups = [], byKey = {};
    cbMatches.forEach(function(e){
      var base = baseItem(e.item), key = e.brand+"|"+base+"|"+e.size+"|"+e.price+"|"+e.category;
      if(!byKey[key]){ byKey[key] = { key:key, base:base, items:[] }; groups.push(byKey[key]); }
      byKey[key].items.push(e);
    });
    return groups;
  }
  function itemRowHtml(e, gi, ci, cls){
    var meta = [e.desc, e.size, e.category].filter(Boolean).join(" · ");
    var gutter = (cls === "cb-child") ? "" : '<span class="cb-spacer"></span>';   // align brand/meta past the chevron
    return '<div class="cb-item '+cls+'" data-g="'+gi+'" data-c="'+ci+'">'+ gutter +
      '<div class="cb-body">'+
        '<div class="cb-row1"><span class="cb-main">'+esc(e.brand)+' · '+esc(e.item)+'</span>'+
          (e.price ? '<span class="cb-price">$'+esc(e.price)+'</span>' : '')+'</div>'+
        (meta ? '<div class="cb-row2">'+esc(meta)+'</div>' : '')+
      '</div>'+
    '</div>';
  }
  function cbRender(){
    if(!cbResults) return;
    if(!cbMatches.length){
      cbResults.innerHTML = '<div class="cb-empty">No match — refine your search, or add a blank row below.</div>';
      cbResults.hidden = false; return;
    }
    CB_GROUPS = cbGroupMatches();
    cbResults.innerHTML = CB_GROUPS.map(function(g, gi){
      if(g.items.length === 1) return itemRowHtml(g.items[0], gi, 0, "cb-single");
      var e0 = g.items[0];
      var commonDesc = g.items.every(function(x){ return x.desc === e0.desc; }) ? e0.desc : "";
      var meta = [commonDesc, e0.size, e0.category].filter(Boolean).join(" · ");
      var expanded = !!CB_EXPANDED[g.key];
      var out = '<div class="cb-item cb-parent'+(expanded?" expanded":"")+'" data-g="'+gi+'" data-c="-1">'+
        '<button class="cb-chev" data-g="'+gi+'" title="Show flavors">&#9656;</button>'+
        '<div class="cb-body">'+
          '<div class="cb-row1"><span class="cb-main">'+esc(e0.brand)+' · '+esc(g.base)+'</span>'+
            '<span class="cb-count" data-g="'+gi+'" title="'+g.items.length+' flavors collapse into this card">'+g.items.length+'</span>'+
            (e0.price ? '<span class="cb-price">$'+esc(e0.price)+'</span>' : '')+'</div>'+
          (meta ? '<div class="cb-row2">'+esc(meta)+'</div>' : '')+
        '</div>'+
      '</div>';
      if(expanded) out += g.items.map(function(e, ci){ return itemRowHtml(e, gi, ci, "cb-child"); }).join("");
      return out;
    }).join("");
    cbResults.hidden = false;
  }
  function cbAdd(e){
    if(!e) return;
    rows.push(blankRow({ print:true, name:e.brand, product:e.item, description:e.desc, size:e.size, price:e.price, store:e.store||"" }));
    save(); renderTable(); refreshPreview();
    if(cbSearch) cbSearch.value = "";
    cbMatches = []; CB_GROUPS = []; CB_EXPANDED = {}; if(cbResults) cbResults.hidden = true;
    var tr = dataBody.lastElementChild;
    if(tr){ tr.classList.add("row-added"); setTimeout(function(){ tr.classList.remove("row-added"); }, 1300);
      tr.scrollIntoView({block:"nearest"}); }
  }
  function cbAddGeneric(g){   // the collapsed parent → a generic, flavor-free card
    if(!g) return;
    var e0 = g.items[0];
    var commonDesc = g.items.every(function(x){ return x.desc === e0.desc; }) ? e0.desc : "";
    cbAdd({ brand:e0.brand, item:g.base, desc:commonDesc, size:e0.size, price:e0.price, category:e0.category, store:e0.store });
  }
  function cbActivate(){    // Enter → add the top result (generic if grouped, else the single item)
    var g = CB_GROUPS[0]; if(!g) return;
    if(g.items.length > 1) cbAddGeneric(g); else cbAdd(g.items[0]);
  }
  if(cbSearch){
    cbSearch.addEventListener("input", function(){ cbMatches = cbRun(cbSearch.value); cbRender(); });
    cbSearch.addEventListener("focus", function(){ if(cbSearch.value){ cbMatches = cbRun(cbSearch.value); cbRender(); } });
    cbSearch.addEventListener("blur",  function(){ setTimeout(function(){ if(cbResults) cbResults.hidden = true; }, 160); });
    cbSearch.addEventListener("keydown", function(ev){
      if(ev.key === "Enter"){ ev.preventDefault(); cbActivate(); }
      else if(ev.key === "Escape"){ cbMatches = []; if(cbResults) cbResults.hidden = true; }
    });
  }
  if(cbResults){
    cbResults.addEventListener("mousedown", function(ev){
      var toggle = ev.target.closest(".cb-chev, .cb-count");   // chevron or count pill → reveal flavors
      if(toggle){ ev.preventDefault(); var gt = CB_GROUPS[+toggle.dataset.g]; if(gt){ CB_EXPANDED[gt.key] = !CB_EXPANDED[gt.key]; cbRender(); } return; }
      var row = ev.target.closest(".cb-item"); if(!row) return;
      ev.preventDefault();
      var g = CB_GROUPS[+row.dataset.g], ci = +row.dataset.c; if(!g) return;
      if(ci === -1) cbAddGeneric(g); else cbAdd(g.items[ci]);
    });
  }

  // ----- live inventory: store picker + fetch through the engine -----
  var cbStore = document.getElementById("cbStore");
  var cbSource = document.getElementById("cbSource");
  var STORES_FALLBACK = ["Center","Portland Rd","Hillsboro","Bend","River Rd","Commercial"];
  function setSource(msg, kind){ if(cbSource){ cbSource.textContent = msg||""; cbSource.className = "cb-source"+(kind?" "+kind:""); } }
  function engineUrl(){ return (loadWebapp()||"").trim(); }
  function fetchLive(store){
    var url = engineUrl();
    if(!url){ STYLE.liveReady=false; setSource("Template prices — set an engine URL in ⚙ Sheet settings for live inventory", "tpl"); return; }
    STYLE.liveReady = false; setSource("Loading "+store+" inventory…", "load");
    var sep = url.indexOf("?")<0 ? "?" : "&";
    fetch(url+sep+"action=liveCatalog&store="+encodeURIComponent(store), {cache:"no-store"})
      .then(function(r){ return r.json(); })
      .then(function(d){ if(!d || !d.ok) throw 0; STYLE.liveRaw = d.items || []; buildLiveIndex(STYLE.liveRaw); STYLE.liveReady = true;
        buildCatMapUI();
        setSource("● Live · "+store+" · "+(d.count||0)+" in-stock products"+(OTD_ON?" · OTD":""), "live");
        if(cbSearch && cbSearch.value){ cbMatches = cbRun(cbSearch.value); cbRender(); } })
      .catch(function(){ STYLE.liveReady = false; setSource("Couldn't load live inventory — using template prices", "tpl"); });
  }
  function populateStores(){
    if(!cbStore) return;
    var fill = function(list){ cbStore.innerHTML = list.map(function(s){ return '<option>'+esc(s)+'</option>'; }).join(""); fetchLive(cbStore.value); };
    var url = engineUrl();
    if(!url){ fill(STORES_FALLBACK); return; }
    var sep = url.indexOf("?")<0 ? "?" : "&";
    fetch(url+sep+"action=stores", {cache:"no-store"}).then(function(r){ return r.json(); })
      .then(function(d){ fill(d && d.ok && d.stores && d.stores.length ? d.stores : STORES_FALLBACK); })
      .catch(function(){ fill(STORES_FALLBACK); });
  }
  if(cbStore) cbStore.addEventListener("change", function(){ fetchLive(cbStore.value); });

  // ----- Settings modal -----
  var settingsModal = document.getElementById("settingsModal");
  var btnSettings   = document.getElementById("btnSettings");
  var settingsClose = document.getElementById("settingsClose");
  function openSettings(){ if(settingsModal){ buildSettingsUI(); settingsModal.hidden = false; } }
  function closeSettings(){ if(settingsModal) settingsModal.hidden = true; }
  if(btnSettings)   btnSettings.onclick = openSettings;
  if(settingsClose) settingsClose.onclick = closeSettings;
  if(settingsModal) settingsModal.addEventListener("mousedown", function(ev){ if(ev.target===settingsModal) closeSettings(); });
  document.addEventListener("keydown", function(ev){ if(ev.key==="Escape" && settingsModal && !settingsModal.hidden) closeSettings(); });
  // add a label section
  var newSection = document.getElementById("newSection"), addSection = document.getElementById("addSection");
  function doAddSection(){
    var v = (newSection && newSection.value || "").trim();
    if(v && SECTIONS.indexOf(v)<0){ SECTIONS.push(v); saveSections(); buildSettingsUI(); rebuildLive(); }
    if(newSection) newSection.value = "";
  }
  if(addSection) addSection.onclick = doAddSection;
  if(newSection) newSection.addEventListener("keydown", function(ev){ if(ev.key==="Enter"){ ev.preventDefault(); doAddSection(); } });
  // add a keyword rule
  var addRule = document.getElementById("addRule");
  if(addRule) addRule.onclick = function(){ CAT_RULES.push({ kw:"", section:"" }); saveRules(); buildRulesUI(); };
  var otdToggle = document.getElementById("otdToggle");
  if(otdToggle){
    otdToggle.checked = OTD_ON;
    otdToggle.addEventListener("change", function(){
      OTD_ON = otdToggle.checked; saveOtd(OTD_ON); rebuildLive();
      if(STYLE.liveReady && cbStore) setSource("● Live · "+cbStore.value+" · "+((STYLE.liveRaw||[]).length)+" in-stock products"+(OTD_ON?" · OTD":""), "live");
    });
  }

  // ----- Shared print queue: submit · load · clear -----
  var queueStrip = document.getElementById("queueStrip");
  var queueInfo  = document.getElementById("queueInfo");
  var btnLoadQueue = document.getElementById("btnLoadQueue");
  function showQueue(html, hasItems){
    if(queueInfo) queueInfo.innerHTML = html;
    if(queueStrip) queueStrip.hidden = false;
    if(btnLoadQueue) btnLoadQueue.style.display = hasItems ? "" : "none";
  }
  function refreshQueueCount(){
    var url = engineUrl(); if(!url){ if(queueStrip) queueStrip.hidden = true; return; }
    var sep = url.indexOf("?")<0 ? "?" : "&";
    fetch(url+sep+"action=getQueue", {cache:"no-store"}).then(function(r){ return r.json(); })
      .then(function(d){ if(!d || !d.ok) return; var n=(d.queue||[]).length;
        showQueue(n ? ("<b>"+n+"</b> card"+(n>1?"s":"")+" waiting in the shared queue") : "Shared queue is empty", n>0);
      }).catch(function(){});
  }
  function submitToQueue(){
    var url = engineUrl(); if(!url){ flashError("No engine configured — set the data engine URL in ⚙ Settings."); return; }
    var v = validate();
    var cards = v.queued.filter(function(r){ return REQUIRED.every(function(f){ return String(r[f]||"").trim(); }); });
    if(!cards.length){ flashError("Check <b>Print</b> on at least one complete card (Brand + Price) to submit."); return; }
    var payload = cards.map(function(r){ return { brand:r.name, item:r.product, desc:r.description, desc2:r.description2, size:r.size, price:r.price, store:r.store, status:r.status }; });
    fetch(url, { method:"POST", headers:{ "Content-Type":"text/plain;charset=utf-8" }, body:JSON.stringify({ action:"submitCards", by:"", cards:payload }) })
      .then(function(r){ return r.json(); }).then(function(d){
        if(d && d.ok){
          rows = rows.filter(function(r){ return cards.indexOf(r)<0; }); if(!rows.length) rows.push(blankRow());
          save(); renderTable(); refreshPreview();
          showQueue("<b>Submitted "+d.added+"</b> · "+d.count+" now waiting", d.count>0);
        } else flashError("Submit failed.");
      }).catch(function(){ flashError("Submit failed — check your connection."); });
  }
  function loadQueue(){
    var url = engineUrl(); if(!url) return;
    var sep = url.indexOf("?")<0 ? "?" : "&";
    fetch(url+sep+"action=getQueue", {cache:"no-store"}).then(function(r){ return r.json(); })
      .then(function(d){ if(!d || !d.ok) return;
        var have={}; rows.forEach(function(r){ if(r.qid) have[r.qid]=true; });
        var added=0;
        (d.queue||[]).forEach(function(e){ if(have[e.id]) return; var c=e.card||{};
          rows.push(blankRow({ print:true, name:c.brand||"", product:c.item||"", description:c.desc||"", description2:c.desc2||"", size:c.size||"", price:c.price||"", store:c.store||"", status:c.status||"", qid:e.id })); added++; });
        save(); renderTable(); refreshPreview();
        showQueue(added ? ("Loaded <b>"+added+"</b> from the queue") : "Already loaded — nothing new", (d.queue||[]).length>0);
      }).catch(function(){});
  }
  var btnSubmitQueue = document.getElementById("btnSubmitQueue"); if(btnSubmitQueue) btnSubmitQueue.onclick = submitToQueue;
  if(btnLoadQueue) btnLoadQueue.onclick = loadQueue;

  // ----- New-in-Dutchie products that need a tag -----
  var NEW_PRODUCTS = [];
  var newprodStrip = document.getElementById("newprodStrip");
  var newprodInfo  = document.getElementById("newprodInfo");
  var newprodList  = document.getElementById("newprodList");
  function refreshNewProducts(){
    var url = engineUrl(); if(!url) return;
    var sep = url.indexOf("?")<0 ? "?" : "&";
    fetch(url+sep+"action=newProducts", {cache:"no-store"}).then(function(r){ return r.json(); })
      .then(function(d){ if(!d || !d.ok) return;
        NEW_PRODUCTS = d.products || [];
        var n = NEW_PRODUCTS.length;
        if(n>0 && newprodStrip){ newprodInfo.innerHTML = "<b>"+n+"</b> new product"+(n>1?"s":"")+" in Dutchie need"+(n>1?"":"s")+" a tag"; newprodStrip.hidden = false; }
        else if(newprodStrip){ newprodStrip.hidden = true; if(newprodList) newprodList.hidden = true; }
      }).catch(function(){});
  }
  function renderNewProductsList(){
    if(!newprodList) return;
    newprodList.innerHTML = NEW_PRODUCTS.length ? NEW_PRODUCTS.map(function(p,i){
      return '<div class="np-row" data-i="'+i+'">'+
        '<span class="np-text"><b>'+esc(normalizeBrand(p.brand||""))+'</b> · '+esc(p.name||"")+
          (p.category ? ' <span class="np-cat">'+esc(p.category)+'</span>' : '')+'</span>'+
        '<button class="btn btn-soft np-find" data-i="'+i+'" title="Find in live inventory to build a card">Find</button>'+
        '<button class="np-dismiss" data-i="'+i+'" title="Dismiss — already handled">&times;</button>'+
      '</div>';
    }).join("") : '<div class="np-empty">All caught up — no new products waiting.</div>';
    newprodList.hidden = false;
  }
  function ackNewProduct(p){
    var url = engineUrl();
    if(url) fetch(url, { method:"POST", headers:{ "Content-Type":"text/plain;charset=utf-8" },
      body:JSON.stringify({ action:"ackProducts", ids:[p.id] }) }).catch(function(){});
    NEW_PRODUCTS = NEW_PRODUCTS.filter(function(x){ return x.id !== p.id; });
    renderNewProductsList(); refreshNewProducts();
  }
  var btnReviewNew = document.getElementById("btnReviewNew");
  if(btnReviewNew) btnReviewNew.onclick = function(){
    if(newprodList && !newprodList.hidden){ newprodList.hidden = true; return; }
    renderNewProductsList();
  };
  if(newprodList) newprodList.addEventListener("click", function(ev){
    var find = ev.target.closest(".np-find"), dis = ev.target.closest(".np-dismiss");
    if(find){ var p = NEW_PRODUCTS[+find.dataset.i]; if(p && cbSearch){ cbSearch.value = p.name||""; cbSearch.focus(); cbMatches = cbRun(cbSearch.value); cbRender(); } return; }
    if(dis){ var p2 = NEW_PRODUCTS[+dis.dataset.i]; if(p2) ackNewProduct(p2); }
  });

  // ================= INIT =================
  // Role mode: ?role=employee = submit-only employee app. Default = full Tawny app.
  var ROLE = (new URLSearchParams(location.search).get("role") || "").toLowerCase();
  if(ROLE === "employee"){
    document.body.classList.add("mode-employee");
    var sub = document.querySelector(".editor-sub");
    if(sub) sub.innerHTML = "Find a product, build your price-tag request, then <b>Submit</b> — it goes to the print queue for the team to print.";
    var sq = document.getElementById("btnSubmitQueue");
    if(sq){ sq.className = "btn btn-primary"; sq.textContent = "Submit request"; }
  }

  loadStyle();
  fetchConfigGlobal();   // adopt the shared (global) settings
  populateStores();
  refreshQueueCount();
  refreshNewProducts();
  setInterval(refreshQueueCount, 30000);   // keep the shared-queue count fresh
  setInterval(refreshNewProducts, 120000);
  renderTable();
  refreshPreview();
  // re-fit once fonts + layout settle (first paint can mis-measure)
  function settle(){ if(zoom===0) requestAnimationFrame(function(){ applyFit(sheetsEl); updateZoom(); }); }
  if(document.fonts && document.fonts.ready) document.fonts.ready.then(settle);
  window.addEventListener("load", settle);
  setTimeout(settle, 250);
})();
