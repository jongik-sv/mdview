import json

# ---- palette ----
INK   = "#0d1117"; PAPER = "#f6f8fa"
TXTD  = "#e6edf3"; TXTL  = "#1f2328"
MUTD  = "#8b949e"; MUTL  = "#59636e"
A     = "#58a6ff"; AL    = "#0969da"          # accent on dark / on light
CARDD = "#161b22"; CARDL = "#ffffff"
BRDD  = "#30363d"; BRDL  = "#d0d7de"
SERIF = "Georgia, 'Times New Roman', serif"
SANS  = "Instrument Sans, -apple-system, 'Segoe UI', Helvetica, sans-serif"

CARDGRAD_D = {"angle":180,"stops":[{"at":0,"color":"#1b222c"},{"at":1,"color":"#12171f"}]}
SHAD_D = {"y":14,"blur":34,"color":"rgba(0,0,0,0.45)"}
SHAD_L = {"y":14,"blur":34,"color":"rgba(31,35,40,0.10)"}

def T(id,x,y,w,h,html,size,color,weight=400,fam=SANS,align="left",valign="top",lh=1.4,ls=0,fx=None):
    e={"id":id,"type":"text","x":x,"y":y,"w":w,"h":h,"rotation":0,"opacity":1,"html":html,
       "fontSize":size,"fontFamily":fam,"fontWeight":weight,"color":color,"align":align,"valign":valign,"lineHeight":lh,"letterSpacing":ls}
    if fx:e["fx"]=fx
    return e

def R(id,x,y,w,h,fill,radius=0,stroke="none",sw=0,grad=None,shadow=None,opacity=1,strokeStyle=None,fx=None,link=None,rot=0):
    e={"id":id,"type":"shape","shape":"rect","x":x,"y":y,"w":w,"h":h,"rotation":rot,"opacity":opacity,
       "fill":fill,"stroke":stroke,"strokeWidth":sw,"radius":radius}
    if grad:e["fillGradient"]=grad
    if shadow:e["shadow"]=shadow
    if strokeStyle:e["strokeStyle"]=strokeStyle
    if fx:e["fx"]=fx
    if link:e["link"]=link
    return e

def SVG(id,x,y,w,h,asset,opacity=1,fx=None):
    e={"id":id,"type":"svg","x":x,"y":y,"w":w,"h":h,"rotation":0,"opacity":opacity,"asset":asset}
    if fx:e["fx"]=fx
    return e

def line(id,x,y,w,fill,sw=3,style=None,lineEnd=None,frm=None,to=None,fx=None,h=8):
    e={"id":id,"type":"shape","shape":"line","x":x,"y":y,"w":w,"h":h,"rotation":0,"opacity":1,
       "fill":fill,"stroke":"transparent","strokeWidth":sw}
    if style:e["strokeStyle"]=style
    if lineEnd:e["lineEnd"]=lineEnd
    if frm:e["from"]=frm
    if to:e["to"]=to
    if fx:e["fx"]=fx
    return e

KEN = {"ambient":"kenburns","ken":{"dir":"drift","scale":1.06,"duration":34}}

def bokeh(id,x,y,d,op,path,dur):
    return SVG(id,x,y,d,d,"bokeh",opacity=op,fx={"loop":{"type":"motion-path","path":path,"duration":dur}})

# ---- persistent morphing tiles (bento signature) ----
GA={"angle":135,"stops":[{"at":0,"color":"#58a6ff"},{"at":1,"color":"#79c0ff"}]}
GB={"angle":135,"stops":[{"at":0,"color":"#48566a"},{"at":1,"color":"#6a7686"}]}
GC={"angle":135,"stops":[{"at":0,"color":"#eef2f6"},{"at":1,"color":"#d7dde3"}]}
GD={"angle":0,  "stops":[{"at":0,"color":"#121821"},{"at":1,"color":"#1e2732"}]}

def tiles_logo():   # small 2x2 mark, top-left, constant ids -> morph anchor
    return [
        R("tile-d",96,52,13,13,"#161b22",3,grad=GD),
        R("tile-a",113,52,13,13,A,3,grad=GA),
        R("tile-b",96,69,13,13,"#57606a",3,grad=GB),
        R("tile-c",113,69,13,13,"#e6edf3",3,grad=GC),
    ]

def bg(dark, sid, page, glow_wash, blobs=True):
    txt = "dots-ink" if dark else "dots-paper"
    els=[ SVG(sid+"tex",0,0,1280,720,txt,opacity=1) ]
    if dark:
        els.append(SVG(sid+"grain",0,0,1280,720,"grain",opacity=1))
    els.append(R("glow",0,0,1280,720,"transparent",grad=glow_wash,fx=KEN))
    if blobs:
        els.append(SVG("blobA",860,-190,640,640,"glow-blue",opacity=1,
                       fx={"ambient":"kenburns","ken":{"dir":"drift","scale":1.12,"duration":30}}))
        els.append(SVG("blobB",-230,360,560,560,"glow-soft",opacity=1,
                       fx={"ambient":"kenburns","ken":{"dir":"drift","scale":1.1,"duration":40}}))
    # page number watermark
    wm = "rgba(230,237,243,0.05)" if dark else "rgba(13,17,23,0.05)"
    els.append(T(sid+"wm",760,-40,460,360,"{{page:2}}",300,wm,900,SERIF,"right","top",1.0))
    return els

def chrome(dark, sid, kicker, title):
    txt   = TXTD if dark else TXTL
    mut   = MUTD if dark else MUTL
    acc   = A if dark else AL
    rule  = "rgba(230,237,243,0.12)" if dark else "rgba(13,17,23,0.10)"
    els = tiles_logo()
    els += [
        T(sid+"wordmark",140,54,300,26,"mdview",15,txt,700,SANS,"left","middle",1.1,0.5),
        T(sid+"pg",1024,54,160,26,"{{page:2}} / {{pages}}",13,mut,700,SANS,"right","top",1.25,1.5),
        R(sid+"rule",96,96,1088,1.5,rule),
        T(sid+"kick",96,118,900,24,kicker,15,acc,700,SANS,"left","middle",1.2,3),
        T(sid+"title",92,150,1096,70,title,50,txt,900,SERIF,"left","top",1.03,-0.5),
    ]
    return els

def card(dark):
    return dict(fill=CARDD if dark else CARDL, radius=16,
                stroke=BRDD if dark else BRDL, sw=1,
                grad=CARDGRAD_D if dark else None,
                shadow=SHAD_D if dark else SHAD_L)

def fade(o): return {"enter":"fade-up","order":o}

slides=[]

# ================= S1 COVER (ink) =================
gw1={"angle":135,"stops":[{"at":0,"color":"rgba(88,166,255,0.20)"},{"at":0.55,"color":"rgba(13,17,23,0)"},{"at":1,"color":"rgba(88,166,255,0.10)"}]}
e = bg(True,"s1",1,gw1,blobs=True)
# hero bento formation (right) — tiles morph anchor
e += [
    R("tile-d",812,176,320,320,"#161b22",40,grad=GD,shadow=[{"blur":56,"color":"rgba(88,166,255,0.16)"},{"y":28,"blur":60,"color":"rgba(0,0,0,0.5)"}],fx=fade(1)),
    R("tile-b",848,212,80,248,"#57606a",16,grad=GB,fx=fade(2)),
    R("tile-a",948,212,148,108,A,16,grad=GA,fx=fade(3)),
    R("tile-c",948,332,148,120,"#e6edf3",16,grad=GC,fx=fade(4)),
]
# floating bokeh
e += [
    bokeh("bk1",930,140,44,0.5,"M 0 0 C 21.5 0 39 17.5 39 39 C 39 60.5 21.5 78 0 78 C -21.5 78 -39 60.5 -39 39 C -39 17.5 -21.5 0 0 0",17),
    bokeh("bk2",1180,470,30,0.42,"M 0 0 C -16.5 20.7 -46.7 24.1 -67.5 7.6 C -88.2 -8.9 -91.6 -39.1 -75.1 -59.9 C -58.5 -80.6 -28.3 -84 -7.6 -67.5 C 13.1 -50.9 16.5 -20.7 0 0",14),
    bokeh("bk3",760,520,26,0.34,"M 0 0 C -23 9.5 -49.3 -1.4 -58.8 -24.4 C -68.3 -47.3 -57.4 -73.6 -34.4 -83.1 C -11.5 -92.7 14.8 -81.8 24.4 -58.8 C 33.9 -35.8 23 -9.5 0 0",16),
]
# hero text (left)
e += [
    T("s1kick",96,232,640,30,"NATIVE MARKDOWN VIEWER",18,A,700,SANS,"left","middle",1.1,3,fx=fade(0)),
    T("s1title",90,272,700,300,"The file<br>renders<br>itself.",92,TXTD,900,SERIF,"left","top",1.0,-1,fx={"enter":"fade-up","order":1}),
    T("s1sub",96,584,640,60,"mdview — macOS · Windows.<br>Double-click a <code>.md</code>, it opens instantly.",20,MUTD,400,SANS,"left","top",1.5,0,fx=fade(3)),
    T("s1ver",96,678,640,28,"v0.1.17  ·  Tauri 2 + TypeScript",14,"#6e7681",500,SANS,"left","middle",1.1,1),
]
slides.append({"id":"s1","background":INK,"transition":"none",
    "notes":"mdview — Tauri 2 기반 네이티브 마크다운 뷰어. macOS/Windows. 파일 매니저에서 .md 더블클릭 → 즉시 렌더. 오른쪽 벤토 타일은 다음 슬라이드로 모핑된다.","elements":e})

# ================= S2 소개 3 pillars (paper) =================
gw2={"angle":180,"stops":[{"at":0,"color":"rgba(9,105,218,0.06)"},{"at":1,"color":"rgba(88,166,255,0.04)"}]}
e = bg(True,"s2",2,gw2)
e += chrome(True,"s2","// 소개","열자마자 렌더링되는 마크다운 뷰어")
c=card(True)
pill=[("⚡ 즉시","네이티브 앱. 브라우저나 무거운 의존성 없이 곧바로 뜬다."),
      ("🔄 라이브","저장하면 자동 리로드. 편집기 옆에 띄워두기 좋다."),
      ("🐙 GitHub 룩","익숙한 <code>github-markdown-css</code> 스타일 그대로.")]
xs=[96,469,842]
for i,(h,b) in enumerate(pill):
    x=xs[i]
    e.append(R(f"s2c{i}",x,258,341,262,c["fill"],c["radius"],c["stroke"],c["sw"],c["grad"],c["shadow"],fx=fade(i)))
    e.append(T(f"s2h{i}",x+24,292,293,44,h,27,TXTD,700,SANS,"left","middle",1.1))
    e.append(T(f"s2b{i}",x+24,348,293,150,b,18,MUTD,400,SANS,"left","top",1.55))
slides.append({"id":"s2","background":INK,"transition":"morph",
    "notes":"핵심 가치 3가지: 즉시(네이티브), 라이브(자동 리로드), GitHub 룩. 커버의 벤토 타일이 좌상단 로고 마크로 모핑됐다.","elements":e})

# ================= S3 렌더링 엔진 (ink) 4 cards =================
gw3={"angle":20,"stops":[{"at":0,"color":"rgba(88,166,255,0.14)"},{"at":0.6,"color":"rgba(13,17,23,0)"},{"at":1,"color":"rgba(88,166,255,0.10)"}]}
e = bg(True,"s3",3,gw3)
e += chrome(True,"s3","// 렌더링 엔진","GitHub 스타일 · 다이어그램 · 수식")
c=card(True)
feat=[("markdown-it (GFM)","GitHub Flavored Markdown · 체크박스 태스크 리스트"),
      ("Mermaid 다이어그램","<code>```mermaid</code> 코드펜스 → SVG 자동 렌더"),
      ("KaTeX 수식","인라인·블록 LaTeX 수식 렌더링 (v0.1.11+)"),
      ("문법 하이라이트","highlight.js 코드 색상 + GitHub CSS")]
pos=[(96,236),(656,236),(96,416),(656,416)]
for i,(h,b) in enumerate(feat):
    x,y=pos[i]
    e.append(R(f"s3c{i}",x,y,528,150,c["fill"],12,c["stroke"],c["sw"],c["grad"],c["shadow"],fx=fade(i)))
    e.append(T(f"s3h{i}",x+24,y+22,480,32,h,23,A,700,SANS,"left","middle",1.1))
    e.append(T(f"s3b{i}",x+24,y+64,480,70,b,17,MUTD,400,SANS,"left","top",1.5))
slides.append({"id":"s3","background":INK,"transition":"morph",
    "notes":"렌더링 엔진: markdown-it GFM(태스크리스트), Mermaid SVG, KaTeX 수식, highlight.js 하이라이트.","elements":e})

# ================= S4 라이브 리로드 (paper) flow =================
gw4={"angle":200,"stops":[{"at":0,"color":"rgba(9,105,218,0.06)"},{"at":1,"color":"rgba(88,166,255,0.05)"}]}
e = bg(True,"s4",4,gw4)
e += chrome(True,"s4","// 핵심 · 라이브 리로드","저장하면, 알아서 다시 그린다")
e.append(T("s4sub",92,222,1096,40,"파일을 디스크에서 감시하다, 편집기에서 저장하는 순간 화면이 갱신된다.",20,MUTD,400,SANS,"left","top",1.4))
c=card(True)
nodes=[("✏️ 편집기에서 저장",96,False),("👁️ notify 파일 감시",490,False),("⚡ 즉시 재렌더",884,True)]
for i,(lbl,x,hero) in enumerate(nodes):
    if hero:
        e.append(R(f"s4n{i}",x,318,300,96,"#0d1f30",14,A,1.5,shadow=SHAD_D,fx=fade(i)))
        e.append(T(f"s4t{i}",x,318,300,96,lbl,20,A,700,SANS,"center","middle",1.2))
    else:
        e.append(R(f"s4n{i}",x,318,300,96,c["fill"],14,c["stroke"],c["sw"],c["grad"],SHAD_D,fx=fade(i)))
        e.append(T(f"s4t{i}",x,318,300,96,lbl,20,TXTD,600,SANS,"center","middle",1.2))
e.append(line("s4l1",400,362,84,A,3,None,"arrow"))
e.append(line("s4l2",794,362,84,A,3,None,"arrow"))
e.append(T("s4note",92,466,1096,150,"<b>atomic-save 대응</b> — Zed·VS Code처럼 임시파일로 교체 저장하는 편집기도 정확히 감지.<br><br><b>이중 감시</b> — notify 워처 + 폴링 백업으로 갱신을 놓치지 않는다.",19,MUTD,400,SANS,"left","top",1.6))
slides.append({"id":"s4","background":INK,"transition":"morph",
    "notes":"핵심 기능 라이브 리로드. notify 파일 워처가 저장 순간 재렌더. atomic-save(임시파일 교체)까지 감지, 폴링 백업으로 이중 감시. 화살표가 저장→감시→재렌더 흐름을 잇는다.","elements":e})

# ================= S5 탭 & 소스뷰 (ink) 2 cards =================
gw5={"angle":135,"stops":[{"at":0,"color":"rgba(88,166,255,0.16)"},{"at":0.6,"color":"rgba(13,17,23,0)"},{"at":1,"color":"rgba(88,166,255,0.08)"}]}
e = bg(True,"s5",5,gw5)
e += chrome(True,"s5","// 편집 흐름","여러 문서는 탭으로, 원본은 소스 뷰로")
c=card(True)
two=[("🗂 탭","여러 <code>.md</code>를 한 창에서 탭으로 열기.<br>탭을 드래그해 순서 변경.<br>프로젝트 폴더 밖 문서도 탭에 표시.",96),
     ("📄 소스 뷰","렌더링된 화면과 읽기 전용 원본 사이를 한 번에 토글.<br>원본은 문법 하이라이트로 보여준다.",656)]
for i,(h,b,x) in enumerate(two):
    e.append(R(f"s5c{i}",x,250,528,320,c["fill"],c["radius"],c["stroke"],c["sw"],c["grad"],c["shadow"],fx=fade(i)))
    e.append(T(f"s5h{i}",x+32,284,464,44,h,28,TXTD,700,SANS,"left","middle",1.1))
    e.append(T(f"s5b{i}",x+32,344,464,200,b,19,MUTD,400,SANS,"left","top",1.6))
slides.append({"id":"s5","background":INK,"transition":"morph",
    "notes":"여러 문서를 탭으로, 드래그로 순서 변경, 폴더 밖 문서도 탭 표시. 소스뷰는 렌더↔읽기전용 원본 토글.","elements":e})

# ================= S6 프로젝트 트리 (paper) =================
gw6={"angle":180,"stops":[{"at":0,"color":"rgba(9,105,218,0.06)"},{"at":1,"color":"rgba(88,166,255,0.04)"}]}
e = bg(True,"s6",6,gw6)
e += chrome(True,"s6","// 프로젝트 모드","폴더를 열면, 파일 트리 사이드바")
e.append(T("s6desc",96,250,500,320,"폴더를 프로젝트로 열면 왼쪽에 파일 트리가 뜬다.<br><br>· <b>.md</b> 파일만 걸러 보여주고, 클릭해 바로 이동<br><br>· <b>.bpmn</b> 파일도 인식 — 트리에서 OS 기본 프로그램으로 열기",20,MUTD,400,SANS,"left","top",1.55,fx=fade(0)))
e.append(R("s6tree",656,232,528,372,CARDD,16,BRDD,1,CARDGRAD_D,SHAD_D,fx=fade(1)))
e.append(R("s6bar",656,232,528,40,"#0d1117",16,"none",0))
e.append(T("s6bart",680,232,480,40,"EXPLORER",12,MUTD,700,SANS,"left","middle",1.1,1.5))
tree="📂 my-project<br>├ 📄 README.md<br>├ 📄 guide.md<br>├ 📂 docs<br>│&nbsp;&nbsp;├ 📄 spec.md<br>│&nbsp;&nbsp;└ 📄 api.md<br>└ 🔷 flow.bpmn"
e.append(T("s6tx",684,292,480,300,"<code>"+tree+"</code>",19,"#c9d1d9",500,SANS,"left","top",1.75))
slides.append({"id":"s6","background":INK,"transition":"morph",
    "notes":"프로젝트 모드: 폴더 열면 파일 트리 사이드바. .md만 필터, 클릭 이동. .bpmn도 인식해 OS 기본 앱으로 연다.","elements":e})

# ================= S7 히스토리 & 외부문서 (ink) 2 cards =================
gw7={"angle":105,"stops":[{"at":0,"color":"rgba(88,166,255,0.14)"},{"at":0.55,"color":"rgba(13,17,23,0)"},{"at":1,"color":"rgba(88,166,255,0.09)"}]}
e = bg(True,"s7",7,gw7)
e += chrome(True,"s7","// 히스토리 · 외부 문서","최근 기록, 그리고 폴더 밖 문서까지")
c=card(True)
two=[("🕘 히스토리","최근 연 <b>파일 / 폴더</b>를 탭으로 구분해 기록.<br>항목별 휴지통으로 하나씩 삭제.<br>사이드바 높이는 자유롭게 조절.",96),
     ("🧭 외부 문서","프로젝트 폴더 밖 <code>.md</code>를 열면 <b>명확히 표시</b>.<br>그 문서의 상위 프로젝트 폴더를 곧바로 열 수 있다.",656)]
for i,(h,b,x) in enumerate(two):
    e.append(R(f"s7c{i}",x,250,528,320,c["fill"],c["radius"],c["stroke"],c["sw"],c["grad"],c["shadow"],fx=fade(i)))
    e.append(T(f"s7h{i}",x+32,284,464,44,h,28,TXTD,700,SANS,"left","middle",1.1))
    e.append(T(f"s7b{i}",x+32,344,464,200,b,19,MUTD,400,SANS,"left","top",1.6))
slides.append({"id":"s7","background":INK,"transition":"morph",
    "notes":"히스토리: 최근 파일/폴더 탭 구분 기록, 항목별 휴지통 삭제, 높이 조절. 외부문서: 폴더 밖 md 명확 표시 + 상위 프로젝트 폴더 열기.","elements":e})

# ================= S8 검색·테마·파일연결 (paper) 4 small =================
gw8={"angle":180,"stops":[{"at":0,"color":"rgba(9,105,218,0.06)"},{"at":1,"color":"rgba(88,166,255,0.04)"}]}
e = bg(True,"s8",8,gw8)
e += chrome(True,"s8","// 그 외 편의 · 시스템 통합","검색 · 테마 · 파일 연결")
c=card(True)
small=[("🔎 검색","타이핑 즉시 문서 내 찾기(F3). 매치 하이라이트 + 카운터."),
       ("🌗 테마","시스템 연동 라이트 / 다크. 수동 토글도 가능."),
       ("🔗 파일 연결","<code>.md</code> / <code>.markdown</code> 기본 앱 등록. 더블클릭 오픈."),
       ("⚙️ 편의","최근 파일 메뉴. 파일 경로 복사. 폰트 크기 조절.")]
xs=[96,374,652,930]
for i,(h,b) in enumerate(small):
    x=xs[i]
    e.append(R(f"s8c{i}",x,250,254,300,c["fill"],12,c["stroke"],c["sw"],c["grad"],SHAD_D,fx=fade(i)))
    e.append(T(f"s8h{i}",x+20,280,214,40,h,22,TXTD,700,SANS,"left","middle",1.1))
    e.append(T(f"s8b{i}",x+20,328,214,200,b,16,MUTD,400,SANS,"left","top",1.55))
slides.append({"id":"s8","background":INK,"transition":"morph",
    "notes":"그 외: 문서 내 검색(F3, 하이라이트+카운터), 시스템 연동 라이트/다크, .md/.markdown 기본 앱 등록, 최근 파일·경로 복사·폰트 크기.","elements":e})

# ================= S9 기술 스택 (ink) table =================
gw9={"angle":160,"stops":[{"at":0,"color":"rgba(88,166,255,0.12)"},{"at":1,"color":"rgba(88,166,255,0.06)"}]}
e = bg(True,"s9",9,gw9)
e += chrome(True,"s9","// 기술 스택","한 파일, 네이티브 성능")
rows=[["Layer","Tech"],["Shell","Tauri 2 (Rust)"],["Frontend","TypeScript + Vite 6"],
      ["렌더","markdown-it · highlight.js · mermaid · KaTeX"],["에디터","Monaco Editor (소스 뷰)"],
      ["파일 I/O","Rust 커맨드 + notify 파일 워처"],["플랫폼","macOS · Windows (x64 NSIS)"]]
tbl={"id":"s9tbl","type":"table","x":96,"y":232,"w":1088,"h":392,"rotation":0,"opacity":1,"header":True,
     "columns":[{"w":1},{"w":2.4}],
     "rows":[{"cells":[{"html":r[0]},{"html":r[1]}]} for r in rows],
     "style":{"headerBg":"#161b22","headerColor":TXTD,"zebra":"rgba(88,166,255,0.05)","borderColor":BRDD,
              "borderWidth":1,"cellPadX":22,"cellPadY":13,"fontSize":20,"color":"#c9d1d9","radius":12},
     "shadow":SHAD_D,"fx":fade(0)}
e.append(tbl)
slides.append({"id":"s9","background":INK,"transition":"morph",
    "notes":"기술 스택: Tauri2(Rust) 셸, TS+Vite6, markdown-it·highlight.js·mermaid·KaTeX 렌더, Monaco 소스뷰, notify 워처, macOS·Windows(x64 NSIS).","elements":e})

# ================= S10 마무리 (ink) reform =================
gw10={"angle":0,"stops":[{"at":0,"color":"rgba(88,166,255,0.16)"},{"at":0.55,"color":"rgba(13,17,23,0)"},{"at":1,"color":"rgba(88,166,255,0.12)"}]}
e = bg(True,"s10",10,gw10,blobs=True)
# tiles reform into a centered bento mark
e += [
    R("tile-d",500,120,280,280,"#161b22",52,grad=GD,shadow=[{"blur":56,"color":"rgba(88,166,255,0.18)"},{"y":28,"blur":60,"color":"rgba(0,0,0,0.5)"}]),
    R("tile-b",532,152,70,216,"#57606a",14,grad=GB),
    R("tile-a",618,152,130,96,A,14,grad=GA),
    R("tile-c",618,264,130,104,"#e6edf3",14,grad=GC),
]
e += [
    bokeh("bk10a",404,140,44,0.5,"M 0 0 C 21.5 0 39 17.5 39 39 C 39 60.5 21.5 78 0 78 C -21.5 78 -39 60.5 -39 39 C -39 17.5 -21.5 0 0 0",17),
    bokeh("bk10b",872,372,32,0.34,"M 0 0 C -31.5 -10.2 -48.8 -44.1 -38.5 -75.6 C -28.3 -107.1 5.6 -124.4 37.1 -114.1 C 68.6 -103.9 85.8 -70 75.6 -38.5 C 65.4 -7 31.5 10.2 0 0",20),
]
e += [
    T("s10kick",340,452,600,24,"FAST · NATIVE · ALWAYS FRESH",13,A,700,SANS,"center","top",1.25,4),
    T("s10title",240,484,800,104,"Make it yours.",88,TXTD,900,SERIF,"center","top",1.02,-1,fx={"ambient":"kenburns","ken":{"dir":"out","scale":1.05,"duration":2.6}}),
    T("s10sub",290,600,700,28,"빠르고, 네이티브하고, 늘 최신인 마크다운 뷰어",17,MUTD,400,SANS,"center","top",1.25),
    T("s10ver",96,672,1088,24,"v0.1.17  ·  macOS · Windows",13,"#6e7681",500,SANS,"center","middle",1.1),
]
slides.append({"id":"s10","background":INK,"transition":"morph",
    "notes":"마무리 — 벤토 타일이 중앙 로고로 재조립(북엔드 모핑). 빠르고 네이티브하고 늘 최신인 마크다운 뷰어. v0.1.17.","elements":e})

# ---- decorative assets (self-authored, blue-themed) ----
assets={
 "grain":'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720" preserveAspectRatio="none"><filter id="g"><feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" stitchTiles="stitch"/><feColorMatrix type="matrix" values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 0.04 0"/></filter><rect width="1280" height="720" filter="url(#g)"/></svg>',
 "dots-ink":'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720" preserveAspectRatio="none"><defs><pattern id="d" width="28" height="28" patternUnits="userSpaceOnUse"><circle cx="1.5" cy="1.5" r="1.4" fill="#FFFFFF" opacity="0.06"/></pattern></defs><rect width="1280" height="720" fill="url(#d)"/></svg>',
 "dots-paper":'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720" preserveAspectRatio="none"><defs><pattern id="d" width="28" height="28" patternUnits="userSpaceOnUse"><circle cx="1.5" cy="1.5" r="1.4" fill="#1f2328" opacity="0.06"/></pattern></defs><rect width="1280" height="720" fill="url(#d)"/></svg>',
 "glow-blue":'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 600"><defs><radialGradient id="g"><stop offset="0" stop-color="#58a6ff" stop-opacity="0.22"/><stop offset="0.55" stop-color="#58a6ff" stop-opacity="0.06"/><stop offset="1" stop-color="#58a6ff" stop-opacity="0"/></radialGradient></defs><circle cx="300" cy="300" r="300" fill="url(#g)"/></svg>',
 "glow-soft":'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 600"><defs><radialGradient id="g"><stop offset="0" stop-color="#a5d0ff" stop-opacity="0.12"/><stop offset="0.55" stop-color="#a5d0ff" stop-opacity="0.04"/><stop offset="1" stop-color="#a5d0ff" stop-opacity="0"/></radialGradient></defs><circle cx="300" cy="300" r="300" fill="url(#g)"/></svg>',
 "bokeh":'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 80"><defs><filter id="b" x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur stdDeviation="7"/></filter></defs><circle cx="40" cy="40" r="21" fill="#79c0ff" filter="url(#b)"/></svg>',
}

doc={"format":"bento/slides","version":1,"title":"mdview — 기능 정리",
     "size":{"width":1280,"height":720},
     "theme":{"background":INK,"color":TXTD,"accent":A,"fontFamily":SANS,
              "chartPalette":[A,"#57606a","#79c0ff","#8b949e"]},
     "meta":{"author":"mdview","company":"mdview","subject":"네이티브 마크다운 뷰어","event":"v0.1.17"},
     "slides":slides,"assets":assets}

json.dump(doc,open("mdview_doc.json","w",encoding="utf-8"),ensure_ascii=False,indent=1)
print("slides",len(slides),"| assets",list(assets))
print("s1 els",len(slides[0]["elements"]),"| s3 els",len(slides[2]["elements"]))
