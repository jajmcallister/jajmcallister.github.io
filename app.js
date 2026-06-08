const v = document.getElementById("v");
const c = document.getElementById("c");
const ctx = c.getContext("2d");

/* =========================
   OFFSCREEN
========================= */
const OW = 320, OH = 240;
let offscreen, offCtx;

/* =========================
   STATE
========================= */
let contourPoints  = null;   // {x,y}[] canvas coords — final outline
let trackedCenter  = null;   // {x,y} offscreen coords
let template       = null;
let sliceGrid      = null;
let sliceColors    = null;
const sliceStep    = 4;
let animLoop       = null;
let tracking       = false;

// Phase: 'idle' | 'center' | 'anchoring' | 'sliced'
let phase = 'idle';

// Anchor points stored as offsets from center in OFFSCREEN coords
// so they move rigidly with the tracked center each frame
let anchorOffsets = [];  // [{dx, dy}] in offscreen px

// Derived each frame from trackedCenter + anchorOffsets → canvas coords for drawing/snapping
let anchorPoints = [];   // [{x, y}] in canvas coords

// Smoothed radii buffer
let historicalRadii = null;

const NUM_RAYS = 72;
const PATCH    = 24;
const SEARCH   = 28;

/* =========================
   CAMERA
========================= */
navigator.mediaDevices.getUserMedia({
    video: { facingMode: "environment", width: { ideal: 1280 }, height: { ideal: 720 } }
}).then(s => { v.srcObject = s; })
.catch(() => setStatus("Camera unavailable"));

v.onloadedmetadata = () => resize();

function resize() {
    const r = c.getBoundingClientRect();
    c.width = r.width; c.height = r.height;
    offscreen = document.createElement("canvas");
    offscreen.width = OW; offscreen.height = OH;
    offCtx = offscreen.getContext("2d", { willReadFrequently: true });
}
window.addEventListener("resize", resize);
setTimeout(resize, 600);

function setStatus(m) { document.getElementById("status").textContent = m; }

/* =========================
   COORD HELPERS
========================= */
function toOff(cx, cy)   { return { x: cx * OW / c.width,  y: cy * OH / c.height }; }
function fromOff(ox, oy) { return { x: ox * c.width / OW,  y: oy * c.height / OH }; }

/* =========================
   REPROJECT ANCHORS
   Called every frame after trackedCenter updates.
   Converts stored offsets back to canvas coords for drawing + snapping.
========================= */
function updateAnchorPoints() {
    anchorPoints = anchorOffsets.map(o => fromOff(
        trackedCenter.x + o.dx,
        trackedCenter.y + o.dy
    ));
}
//    First tap  → set center
//    Next taps  → add edge anchor
// ========================= */
c.addEventListener("pointerdown", e => {
    e.preventDefault();
    const r = c.getBoundingClientRect();
    const src = e.touches ? e.touches[0] : e;
    const cx = src.clientX - r.left;
    const cy = src.clientY - r.top;

    // No center yet → first tap always sets center
    if (phase === 'idle' || !trackedCenter) {
        trackedCenter   = toOff(cx, cy);
        anchorOffsets   = [];
        anchorPoints    = [];
        sliceGrid       = null;
        historicalRadii = null;
        phase = 'center';
        captureTemplate();
        startLoop();
        setStatus("Center set. Now tap points on the edge to refine the outline, then Generate.");
        return;
    }

    // Center already set → all subsequent taps add anchors,
    // UNLESS the tap is within 12px of the red dot (lets you nudge the center)
    const cc = fromOff(trackedCenter.x, trackedCenter.y);
    const dist = Math.hypot(cx - cc.x, cy - cc.y);

    if (dist < 12) {
        trackedCenter   = toOff(cx, cy);
        anchorOffsets   = [];
        anchorPoints    = [];
        sliceGrid       = null;
        historicalRadii = null;
        captureTemplate();
        setStatus("Center re-set. Tap the edge to add anchors.");
        return;
    }

    // Everything else → add edge anchor stored as offset from current center in offscreen coords
    anchorOffsets.push({
        dx: cx * OW / c.width  - trackedCenter.x,
        dy: cy * OH / c.height - trackedCenter.y
    });
    // anchorPoints (canvas coords) will be reprojected each frame in updateAnchorPoints()
    phase = 'anchoring';
    const n = anchorOffsets.length;
    setStatus(`${n} anchor point${n>1?'s':''} placed. Add more or Generate.`);
});

/* =========================
   CLEAR ANCHORS
========================= */
function clearAnchors() {
    anchorOffsets   = [];
    anchorPoints    = [];
    historicalRadii = null;
    sliceGrid = null;
    phase = trackedCenter ? 'center' : 'idle';
    setStatus("Anchors cleared. Tap edge to add new ones.");
}

/* =========================
   RESET
========================= */
function resetAll() {
    anchorOffsets   = [];
    anchorPoints    = [];
    trackedCenter   = null;
    historicalRadii = null;
    sliceGrid       = null;
    contourPoints   = null;
    phase = 'idle';
    if (animLoop) cancelAnimationFrame(animLoop);
    tracking = false;
    ctx.clearRect(0, 0, c.width, c.height);
    setStatus("Reset. Tap the centre of your object to begin.");
}

/* =========================
   GRAYSCALE
========================= */
function toGray(data, w, h) {
    const g = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++)
        g[i] = (data[i*4]*77 + data[i*4+1]*150 + data[i*4+2]*29) >> 8;
    return g;
}

/* =========================
   TEMPLATE
========================= */
function captureTemplate() {
    if (!offCtx || v.readyState < 2) return;
    offCtx.drawImage(v, 0, 0, OW, OH);
    const tc = trackedCenter;
    const x0 = Math.max(0, Math.round(tc.x) - PATCH);
    const y0 = Math.max(0, Math.round(tc.y) - PATCH);
    const pw = Math.min(PATCH*2, OW - x0);
    const ph = Math.min(PATCH*2, OH - y0);
    const d = offCtx.getImageData(x0, y0, pw, ph);
    template = { data: toGray(d.data, pw, ph), w: pw, h: ph };
}

function trackTemplate(gray) {
    if (!template) return null;
    const tc = trackedCenter;
    const tw = template.w, th = template.h;
    const hw = Math.floor(tw/2), hh = Math.floor(th/2);
    const sx0 = Math.max(hw, Math.round(tc.x - SEARCH));
    const sy0 = Math.max(hh, Math.round(tc.y - SEARCH));
    const sx1 = Math.min(OW - hw, Math.round(tc.x + SEARCH));
    const sy1 = Math.min(OH - hh, Math.round(tc.y + SEARCH));

    let tMean = 0;
    for (let i = 0; i < template.data.length; i++) tMean += template.data[i];
    tMean /= template.data.length;

    let best = -Infinity, bx = tc.x, by = tc.y;
    for (let cy2 = sy0; cy2 <= sy1; cy2 += 2) {
        for (let cx2 = sx0; cx2 <= sx1; cx2 += 2) {
            const px0 = cx2 - hw, py0 = cy2 - hh;
            if (px0 < 0 || py0 < 0 || px0+tw > OW || py0+th > OH) continue;
            let sum=0, ssq=0, cross=0;
            for (let j=0;j<th;j++) for (let i=0;i<tw;i++) {
                const fv = gray[(py0+j)*OW+(px0+i)];
                const tv = template.data[j*tw+i];
                sum+=fv; ssq+=fv*fv; cross+=fv*tv;
            }
            const n=tw*th, fm=sum/n;
            const score=(cross/n - fm*tMean)/(Math.sqrt(ssq/n - fm*fm)+1e-6);
            if (score > best) { best=score; bx=cx2; by=cy2; }
        }
    }
    return best > 0.45 ? { x: bx, y: by } : null;
}

/* =========================
   ANCHOR → RAY SNAPPING
   Each anchor hard-sets the nearest ray to its exact radius,
   and smoothly pulls neighbouring rays toward it.
========================= */
const ANCHOR_SPREAD = Math.ceil(NUM_RAYS / 12); // ~6 rays either side

function anchorRadiiInOffscreen(cx, cy) {
    return anchorPoints.map(a => {
        const ox = a.x * OW / c.width;
        const oy = a.y * OH / c.height;
        const dx = ox - cx, dy = oy - cy;
        const ang = Math.atan2(dy, dx);
        const normAng = ang < 0 ? ang + Math.PI*2 : ang;
        const rayIdx = normAng / (Math.PI*2) * NUM_RAYS;
        return { rayIdx, r: Math.hypot(dx, dy) };
    });
}

// Modifies radii in place; returns anchorMask (0=free, 1=fully anchored)
function applyAnchorsToRadii(radii, anchorData) {
    const mask = new Float32Array(NUM_RAYS);
    if (!anchorData.length) return mask;
    for (const anc of anchorData) {
        for (let k = -ANCHOR_SPREAD; k <= ANCHOR_SPREAD; k++) {
            const idx = ((Math.round(anc.rayIdx) + k) % NUM_RAYS + NUM_RAYS) % NUM_RAYS;
            const w = 1 - Math.abs(k) / (ANCHOR_SPREAD + 1); // 1 at centre, tapers to 0
            if (w > mask[idx]) {
                mask[idx] = w;
                radii[idx] = radii[idx] * (1 - w) + anc.r * w;
            }
        }
    }
    return mask;
}

/* =========================
   CONTOUR SCAN
========================= */
function scanContour(gray, cx, cy) {
    const MAX_R = Math.min(OW, OH) * 0.52;
    const MIN_R = 20;
    const STEP  = 2.0;

    let refs = [];
    for (let r=0; r<MIN_R*0.8; r+=STEP) {
        for (let a=0; a<8; a++) {
            const ang = a/8*Math.PI*2;
            const xi = Math.round(cx+Math.cos(ang)*r);
            const yi = Math.round(cy+Math.sin(ang)*r);
            if (xi>=0&&xi<OW&&yi>=0&&yi<OH) refs.push(gray[yi*OW+xi]);
        }
    }
    if (!refs.length) return null;
    const refMean = refs.reduce((a,b)=>a+b,0)/refs.length;
    const THRESHOLD = 35;

    const rawRadii = new Float32Array(NUM_RAYS);
    for (let a=0; a<NUM_RAYS; a++) {
        const ang  = (a/NUM_RAYS)*Math.PI*2;
        const cosA = Math.cos(ang), sinA = Math.sin(ang);
        let edgeR  = MAX_R;
        let streak = 0;
        for (let r=MIN_R; r<=MAX_R; r+=STEP) {
            const xi = Math.round(cx+cosA*r);
            const yi = Math.round(cy+sinA*r);
            if (xi<0||xi>=OW||yi<0||yi>=OH) { edgeR=r; break; }
            if (Math.abs(gray[yi*OW+xi]-refMean)>THRESHOLD) {
                if (++streak>=4) { edgeR=r-STEP*4; break; }
            } else { streak=0; }
        }
        rawRadii[a] = Math.max(MIN_R, edgeR);
    }

    // Spatial median filter
    const kSize = 5;
    const spatialRadii = new Float32Array(NUM_RAYS);
    for (let i=0; i<NUM_RAYS; i++) {
        const nb = [];
        for (let k=-kSize; k<=kSize; k++) nb.push(rawRadii[(i+k+NUM_RAYS)%NUM_RAYS]);
        nb.sort((a,b)=>a-b);
        spatialRadii[i] = nb[kSize];
    }

    // Apply user anchor snapping BEFORE temporal smoothing
    const anchorData = anchorRadiiInOffscreen(cx, cy);
    const anchorMask = applyAnchorsToRadii(spatialRadii, anchorData);

    // Temporal damping — anchored rays skip damping entirely (instant response)
    if (!historicalRadii) {
        historicalRadii = new Float32Array(spatialRadii);
    } else {
        const blend = anchorData.length > 0 ? 0.08 : 0.05;
        for (let i=0; i<NUM_RAYS; i++) {
            if (anchorMask[i] > 0.5) {
                historicalRadii[i] = spatialRadii[i];
            } else {
                historicalRadii[i] = historicalRadii[i]*(1-blend) + spatialRadii[i]*blend;
            }
        }
    }

    // Circularity regulariser — pull each free ray toward the mean radius.
    // Mean is computed only from unanchored rays so anchors don't distort it.
    // Anchored rays are fully exempt — they keep their exact snapped value.
    const CIRCLE_PULL = 0.72;
    let meanSum = 0, meanCount = 0;
    for (let i=0; i<NUM_RAYS; i++) {
        const w = anchorMask ? anchorMask[i] : 0;
        if (w < 0.5) { meanSum += historicalRadii[i]; meanCount++; }
    }
    const meanR = meanCount > 0 ? meanSum / meanCount : historicalRadii.reduce((s,r)=>s+r,0)/NUM_RAYS;
    for (let i=0; i<NUM_RAYS; i++) {
        const exemption = anchorMask ? anchorMask[i] : 0;
        if (exemption >= 0.5) continue; // anchored ray — do not touch
        const pull = CIRCLE_PULL * (1 - exemption);
        historicalRadii[i] = historicalRadii[i] * (1 - pull) + meanR * pull;
    }

    // Re-apply anchors a final time so the regulariser can never pull them off their pins
    applyAnchorsToRadii(historicalRadii, anchorData);

    const pts = [];
    for (let a=0; a<NUM_RAYS; a++) {
        const ang = (a/NUM_RAYS)*Math.PI*2;
        pts.push({
            x: cx + Math.cos(ang)*historicalRadii[a],
            y: cy + Math.sin(ang)*historicalRadii[a]
        });
    }
    return pts;
}

/* =========================
   FOURIER SMOOTH
   More harmonics when anchors define the shape (preserves corners)
========================= */
function smoothContour(pts) {
    const n = pts.length;
    const harmonics = anchorPoints.length >= 3 ? 5 : 3;
    const out = new Array(n);
    for (let i=0; i<n; i++) {
        let rx=0, ry=0;
        for (let h=0; h<harmonics; h++) {
            let csx=0,snx=0,csy=0,sny=0;
            for (let j=0; j<n; j++) {
                const ang=(h*j/n)*Math.PI*2;
                const cc=Math.cos(ang), ss=Math.sin(ang);
                csx+=pts[j].x*cc; snx+=pts[j].x*ss;
                csy+=pts[j].y*cc; sny+=pts[j].y*ss;
            }
            const ta=(h*i/n)*Math.PI*2;
            const amp = h===0 ? 1/n : 2/n;
            rx+=(csx*Math.cos(ta)+snx*Math.sin(ta))*amp;
            ry+=(csy*Math.cos(ta)+sny*Math.sin(ta))*amp;
        }
        out[i]={x:rx,y:ry};
    }
    return out;
}

function contourToCanvas(offPts) {
    return offPts.map(p => fromOff(p.x, p.y));
}

/* =========================
   POINT-IN-POLYGON
========================= */
function pointInPolygon(px, py, poly) {
    let inside=false;
    for (let i=0,j=poly.length-1; i<poly.length; j=i++) {
        const xi=poly[i].x,yi=poly[i].y,xj=poly[j].x,yj=poly[j].y;
        if ((yi>py)!==(yj>py) && px<(xj-xi)*(py-yi)/(yj-yi)+xi)
            inside=!inside;
    }
    return inside;
}

/* =========================
   MAIN LOOP
========================= */
function startLoop() {
    tracking=true;
    if (animLoop) cancelAnimationFrame(animLoop);
    loop();
}

let _offCenter = null;

function loop() {
    if (!tracking) return;
    animLoop = requestAnimationFrame(loop);
    if (!offCtx||v.readyState<2) return;

    offCtx.drawImage(v,0,0,OW,OH);
    const gray = toGray(offCtx.getImageData(0,0,OW,OH).data, OW, OH);

    const tracked = trackTemplate(gray);
    if (tracked) {
        trackedCenter.x = trackedCenter.x*0.6 + tracked.x*0.4;
        trackedCenter.y = trackedCenter.y*0.6 + tracked.y*0.4;
        if (Math.random()<0.04) captureTemplate();
    }

    // Reproject anchors to follow the tracked center
    updateAnchorPoints();

    const rawPts = scanContour(gray, trackedCenter.x, trackedCenter.y);
    if (rawPts) {
        const smoothed = smoothContour(rawPts);
        contourPoints = contourToCanvas(smoothed);
        _offCenter = { x: trackedCenter.x, y: trackedCenter.y };
    }

    sliceGrid ? drawSlices() : drawBase();
}

/* =========================
   DRAW BASE
========================= */
function drawBase() {
    ctx.clearRect(0,0,c.width,c.height);
    if (!contourPoints||contourPoints.length<3) return;

    // Outline
    ctx.strokeStyle="lime"; ctx.lineWidth=3; ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(contourPoints[0].x, contourPoints[0].y);
    for (let i=1;i<contourPoints.length;i++) ctx.lineTo(contourPoints[i].x,contourPoints[i].y);
    ctx.closePath(); ctx.stroke();

    drawAnchorsAndCenter();
}

/* =========================
   DRAW SLICES
========================= */
function drawSlices() {
    ctx.clearRect(0,0,c.width,c.height);
    if (!sliceGrid||!contourPoints) return;

    const cc = fromOff(trackedCenter.x, trackedCenter.y);
    const scaleX = c.width/OW, scaleY = c.height/OH;

    ctx.globalAlpha=0.45;
    for (const cell of sliceGrid) {
        ctx.fillStyle=sliceColors[cell.owner];
        ctx.fillRect(cc.x+cell.dx*scaleX, cc.y+cell.dy*scaleY, sliceStep, sliceStep);
    }

    ctx.globalAlpha=0.8;
    ctx.strokeStyle="white"; ctx.lineWidth=1.5;
    const gmap = new Map(sliceGrid.map(g=>[`${g.gi},${g.gj}`,g]));
    for (const cell of sliceGrid) {
        const r=gmap.get(`${cell.gi+1},${cell.gj}`);
        const d=gmap.get(`${cell.gi},${cell.gj+1}`);
        if ((r&&r.owner!==cell.owner)||(d&&d.owner!==cell.owner))
            ctx.strokeRect(cc.x+cell.dx*scaleX, cc.y+cell.dy*scaleY, sliceStep, sliceStep);
    }

    ctx.globalAlpha=1.0;
    ctx.strokeStyle="lime"; ctx.lineWidth=3; ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(contourPoints[0].x,contourPoints[0].y);
    for (let i=1;i<contourPoints.length;i++) ctx.lineTo(contourPoints[i].x,contourPoints[i].y);
    ctx.closePath(); ctx.stroke();

    drawAnchorsAndCenter();
}

/* =========================
   DRAW ANCHORS + CENTER DOT
========================= */
function drawAnchorsAndCenter() {
    const cc = fromOff(trackedCenter.x, trackedCenter.y);

    // Center dot
    ctx.fillStyle="red";
    ctx.beginPath(); ctx.arc(cc.x,cc.y,5,0,Math.PI*2); ctx.fill();

    // Anchor dots with number labels
    for (let i=0; i<anchorPoints.length; i++) {
        const a = anchorPoints[i];

        // Outer ring
        ctx.strokeStyle="white"; ctx.lineWidth=2;
        ctx.beginPath(); ctx.arc(a.x,a.y,9,0,Math.PI*2); ctx.stroke();

        // Filled dot
        ctx.fillStyle="orange";
        ctx.beginPath(); ctx.arc(a.x,a.y,6,0,Math.PI*2); ctx.fill();

        // Number
        ctx.fillStyle="white";
        ctx.font="bold 9px sans-serif";
        ctx.textAlign="center";
        ctx.textBaseline="middle";
        ctx.fillText(i+1, a.x, a.y);
    }

    // Draw lines from center to each anchor (guide)
    if (anchorPoints.length) {
        ctx.strokeStyle="rgba(255,165,0,0.35)";
        ctx.lineWidth=1;
        ctx.setLineDash([3,3]);
        for (const a of anchorPoints) {
            ctx.beginPath();
            ctx.moveTo(cc.x,cc.y);
            ctx.lineTo(a.x,a.y);
            ctx.stroke();
        }
        ctx.setLineDash([]);
    }
}

/* =========================
   GENERATE
========================= */
function generate() {
    if (!contourPoints||contourPoints.length<3) {
        alert("Tap the centre of your object first."); return;
    }

    const N    = +document.getElementById("n").value;
    const step = sliceStep;
    const poly = contourPoints;

    let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
    for (const p of poly) {
        minX=Math.min(minX,p.x); minY=Math.min(minY,p.y);
        maxX=Math.max(maxX,p.x); maxY=Math.max(maxY,p.y);
    }

    function insidePoly(x,y) { return pointInPolygon(x,y,poly); }
    function randomInPoly() {
        for (let t=0;t<200;t++) {
            const x=minX+Math.random()*(maxX-minX);
            const y=minY+Math.random()*(maxY-minY);
            if (insidePoly(x,y)) return {x,y};
        }
        return {x:(minX+maxX)/2,y:(minY+maxY)/2};
    }

    let sites  = Array.from({length:N},()=>randomInPoly());
    let weights= Array.from({length:N},()=>1.0);
    const colors=Array.from({length:N},(_,i)=>`hsl(${i*360/N},85%,55%)`);

    const snapCx = fromOff(trackedCenter.x,trackedCenter.y).x;
    const snapCy = fromOff(trackedCenter.x,trackedCenter.y).y;

    for (let iter=0;iter<30;iter++) {
        let accum=Array.from({length:N},()=>({x:0,y:0,count:0}));
        let total=0;
        for (let y=Math.floor(minY);y<=Math.ceil(maxY);y+=step) {
            for (let x=Math.floor(minX);x<=Math.ceil(maxX);x+=step) {
                if (!insidePoly(x,y)) continue;
                total++;
                let best=0,bestD=Infinity;
                for (let i=0;i<N;i++) {
                    const dx=x-sites[i].x,dy=y-sites[i].y;
                    const d=(dx*dx+dy*dy)/weights[i];
                    if(d<bestD){bestD=d;best=i;}
                }
                accum[best].x+=x;accum[best].y+=y;accum[best].count++;
            }
        }
        const target=total/N;
        const temp=Math.max(0,1-(iter/25));
        const diagR=Math.hypot(maxX-minX,maxY-minY)*0.25;
        for (let i=0;i<N;i++) {
            if(accum[i].count>0){
                const tcx=accum[i].x/accum[i].count,tcy=accum[i].y/accum[i].count;
                const ang=Math.random()*Math.PI*2;
                sites[i].x=sites[i].x+(tcx-sites[i].x)*0.4+Math.cos(ang)*diagR*temp;
                sites[i].y=sites[i].y+(tcy-sites[i].y)*0.4+Math.sin(ang)*diagR*temp;
                if(!insidePoly(sites[i].x,sites[i].y)) sites[i]=randomInPoly();
                weights[i]*=(1+(1-accum[i].count/target)*0.5);
            } else { sites[i]=randomInPoly(); weights[i]=1; }
        }
    }

    const newGrid=[];
    const gmap=new Map();
    let gi=0;
    for (let y=Math.floor(minY);y<=Math.ceil(maxY);y+=step) {
        let gj=0;
        for (let x=Math.floor(minX);x<=Math.ceil(maxX);x+=step) {
            if (insidePoly(x,y)) {
                let best=0,bestD=Infinity;
                for (let i=0;i<N;i++) {
                    const dx=x-sites[i].x,dy=y-sites[i].y;
                    const d=(dx*dx+dy*dy)/weights[i];
                    if(d<bestD){bestD=d;best=i;}
                }
                const cell={dx:(x-snapCx)*OW/c.width,dy:(y-snapCy)*OH/c.height,gi:gj,gj:gi,owner:best};
                newGrid.push(cell);
                gmap.set(`${gj},${gi}`,cell);
            }
            gj++;
        }
        gi++;
    }

    sliceGrid=newGrid;
    sliceColors=colors;
    phase='sliced';
    setStatus(`Sliced into ${N} parts!`);
}

setStatus("Tap the centre of your object to begin");
