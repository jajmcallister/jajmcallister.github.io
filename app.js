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
let contourPoints = null;   // array of {x,y} in canvas coords — the shape outline
let trackedCenter = null;   // {x,y} in offscreen coords
let template = null;
let sliceGrid = null;
let sliceColors = null;
const sliceStep = 4;
let animLoop = null;
let tracking = false;

const NUM_RAYS = 72;        // rays for contour detection
const PATCH = 24;
const SEARCH = 28;

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
   TAP
========================= */
c.addEventListener("pointerdown", e => {
    e.preventDefault();
    const r = c.getBoundingClientRect();
    const src = e.touches ? e.touches[0] : e;
    const cx = src.clientX - r.left;
    const cy = src.clientY - r.top;

    trackedCenter = toOff(cx, cy);
    sliceGrid = null;
    captureTemplate();
    startLoop();
    setStatus("Tracking shape…");
});

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
   TEMPLATE CAPTURE
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
    template = { data: toGray(d.data, pw, ph), w: pw, h: ph, ox: x0, oy: y0 };
}

/* =========================
   TEMPLATE MATCH (NCC)
========================= */
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
    for (let cy = sy0; cy <= sy1; cy += 2) {
        for (let cx = sx0; cx <= sx1; cx += 2) {
            const px0 = cx - hw, py0 = cy - hh;
            if (px0 < 0 || py0 < 0 || px0+tw > OW || py0+th > OH) continue;
            let sum = 0, ssq = 0, cross = 0;
            for (let j = 0; j < th; j++) for (let i = 0; i < tw; i++) {
                const fv = gray[(py0+j)*OW+(px0+i)];
                const tv = template.data[j*tw+i];
                sum += fv; ssq += fv*fv; cross += fv*tv;
            }
            const n = tw*th, fm = sum/n;
            const score = (cross/n - fm*tMean) / (Math.sqrt(ssq/n - fm*fm) + 1e-6);
            if (score > best) { best = score; bx = cx; by = cy; }
        }
    }
    return best > 0.45 ? { x: bx, y: by } : null;
}

/* =========================
   FREEFORM CONTOUR SCAN
   Cast rays from center, find edge of object via brightness jump.
   Returns array of {x,y} edge points in OFFSCREEN coords.
========================= */
function scanContour(gray, cx, cy) {
    const MAX_R = Math.min(OW, OH) * 0.52;
    const MIN_R = 6;
    const STEP = 1.2;

    // Sample center region to get reference brightness
    let refs = [];
    for (let r = 0; r < MIN_R * 2; r += STEP) {
        for (let a = 0; a < 8; a++) {
            const ang = a / 8 * Math.PI * 2;
            const xi = Math.round(cx + Math.cos(ang) * r);
            const yi = Math.round(cy + Math.sin(ang) * r);
            if (xi >= 0 && xi < OW && yi >= 0 && yi < OH)
                refs.push(gray[yi*OW+xi]);
        }
    }
    if (!refs.length) return null;
    const refMean = refs.reduce((a,b)=>a+b,0)/refs.length;
    const refStd  = Math.sqrt(refs.reduce((a,b)=>a+(b-refMean)**2,0)/refs.length)+1;
    const thresh  = Math.max(16, refStd * 2.2);

    const pts = [];
    for (let a = 0; a < NUM_RAYS; a++) {
        const ang = (a / NUM_RAYS) * Math.PI * 2;
        const cosA = Math.cos(ang), sinA = Math.sin(ang);
        let edgeR = MAX_R;
        let win = [];
        for (let r = MIN_R; r <= MAX_R; r += STEP) {
            const xi = Math.round(cx + cosA*r);
            const yi = Math.round(cy + sinA*r);
            if (xi < 0 || xi >= OW || yi < 0 || yi >= OH) { edgeR = r; break; }
            const b = gray[yi*OW+xi];
            win.push(b); if (win.length > 5) win.shift();
            const avg = win.reduce((a,x)=>a+x,0)/win.length;
            if (Math.abs(avg - refMean) > thresh) { edgeR = r - STEP*2; break; }
        }
        edgeR = Math.max(MIN_R, edgeR);
        pts.push({ x: cx + cosA*edgeR, y: cy + sinA*edgeR });
    }
    return pts;
}

/* =========================
   SMOOTH CONTOUR (moving average over angles)
========================= */
function smoothContour(pts, passes=2) {
    let out = pts.slice();
    const n = out.length;
    for (let p = 0; p < passes; p++) {
        const tmp = out.slice();
        for (let i = 0; i < n; i++) {
            const prev = tmp[(i-1+n)%n], next = tmp[(i+1)%n];
            tmp[i] = { x:(prev.x+out[i].x*2+next.x)/4, y:(prev.y+out[i].y*2+next.y)/4 };
        }
        out = tmp;
    }
    return out;
}

/* =========================
   CONVERT CONTOUR: offscreen → canvas
========================= */
function contourToCanvas(offPts) {
    return offPts.map(p => fromOff(p.x, p.y));
}

/* =========================
   POINT-IN-POLYGON (ray cast)
========================= */
function pointInPolygon(px, py, poly) {
    let inside = false;
    for (let i = 0, j = poly.length-1; i < poly.length; j = i++) {
        const xi = poly[i].x, yi = poly[i].y;
        const xj = poly[j].x, yj = poly[j].y;
        if ((yi > py) !== (yj > py) &&
            px < (xj-xi)*(py-yi)/(yj-yi)+xi)
            inside = !inside;
    }
    return inside;
}

/* =========================
   MAIN LOOP
========================= */
function startLoop() {
    tracking = true;
    if (animLoop) cancelAnimationFrame(animLoop);
    loop();
}

function loop() {
    if (!tracking) return;
    animLoop = requestAnimationFrame(loop);
    if (!offCtx || v.readyState < 2) return;

    offCtx.drawImage(v, 0, 0, OW, OH);
    const imgData = offCtx.getImageData(0, 0, OW, OH);
    const gray = toGray(imgData.data, OW, OH);

    // Track center
    const tracked = trackTemplate(gray);
    if (tracked) {
        trackedCenter.x = trackedCenter.x*0.6 + tracked.x*0.4;
        trackedCenter.y = trackedCenter.y*0.6 + tracked.y*0.4;
        if (Math.random() < 0.04) captureTemplate();
    }

    // Scan contour from tracked center
    const rawPts = scanContour(gray, trackedCenter.x, trackedCenter.y);
    if (rawPts) {
        const smoothed = smoothContour(rawPts, 3);
        contourPoints = contourToCanvas(smoothed);
        // Store normalized offscreen contour for slice reprojection
        _offContour = smoothed;
        _offCenter  = { x: trackedCenter.x, y: trackedCenter.y };
    }

    if (sliceGrid) {
        drawSlices();
    } else {
        drawBase();
    }
}

// Stored offscreen contour (for reprojection)
let _offContour = null;
let _offCenter  = null;

/* =========================
   DRAW BASE (just outline)
========================= */
function drawBase() {
    ctx.clearRect(0, 0, c.width, c.height);
    if (!contourPoints || contourPoints.length < 3) return;

    ctx.strokeStyle = "lime";
    ctx.lineWidth = 3;
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(contourPoints[0].x, contourPoints[0].y);
    for (let i = 1; i < contourPoints.length; i++)
        ctx.lineTo(contourPoints[i].x, contourPoints[i].y);
    ctx.closePath();
    ctx.stroke();

    const cc = fromOff(trackedCenter.x, trackedCenter.y);
    ctx.fillStyle = "red";
    ctx.beginPath();
    ctx.arc(cc.x, cc.y, 5, 0, Math.PI*2);
    ctx.fill();
}

/* =========================
   DRAW SLICES (reprojected)
========================= */
function drawSlices() {
    ctx.clearRect(0, 0, c.width, c.height);
    if (!sliceGrid || !contourPoints) return;

    // Reproject: each cell stored as offset from center in offscreen pixels
    // Map through current offscreen center → canvas
    const cc = fromOff(trackedCenter.x, trackedCenter.y);
    const scaleX = c.width / OW;
    const scaleY = c.height / OH;

    ctx.globalAlpha = 0.45;
    for (const cell of sliceGrid) {
        const wx = cc.x + cell.dx * scaleX;
        const wy = cc.y + cell.dy * scaleY;
        ctx.fillStyle = sliceColors[cell.owner];
        ctx.fillRect(wx, wy, sliceStep, sliceStep);
    }

    ctx.globalAlpha = 0.8;
    ctx.strokeStyle = "white";
    ctx.lineWidth = 1.5;
    const gmap = new Map(sliceGrid.map(g => [`${g.gi},${g.gj}`, g]));
    for (const cell of sliceGrid) {
        const r = gmap.get(`${cell.gi+1},${cell.gj}`);
        const d = gmap.get(`${cell.gi},${cell.gj+1}`);
        if ((r && r.owner !== cell.owner) || (d && d.owner !== cell.owner)) {
            const wx = cc.x + cell.dx * scaleX;
            const wy = cc.y + cell.dy * scaleY;
            ctx.strokeRect(wx, wy, sliceStep, sliceStep);
        }
    }

    ctx.globalAlpha = 1.0;
    ctx.strokeStyle = "lime";
    ctx.lineWidth = 3;
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(contourPoints[0].x, contourPoints[0].y);
    for (let i = 1; i < contourPoints.length; i++)
        ctx.lineTo(contourPoints[i].x, contourPoints[i].y);
    ctx.closePath();
    ctx.stroke();

    ctx.fillStyle = "red";
    ctx.beginPath();
    ctx.arc(cc.x, cc.y, 5, 0, Math.PI*2);
    ctx.fill();
}

/* =========================
   GENERATE
========================= */
function generate() {
    if (!contourPoints || contourPoints.length < 3) {
        alert("Tap the center of your object first.");
        return;
    }

    const N = +document.getElementById("n").value;
    const step = sliceStep;
    const poly = contourPoints;

    // Bounding box of contour
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of poly) {
        minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
        maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
    }

    function insidePoly(x, y) { return pointInPolygon(x, y, poly); }

    function randomInPoly() {
        let tries = 0;
        while (tries++ < 200) {
            const x = minX + Math.random()*(maxX-minX);
            const y = minY + Math.random()*(maxY-minY);
            if (insidePoly(x, y)) return {x, y};
        }
        return { x: (minX+maxX)/2, y: (minY+maxY)/2 };
    }

    let sites = Array.from({length:N}, () => randomInPoly());
    let weights = Array.from({length:N}, () => 1.0);
    const colors = Array.from({length:N}, (_,i) => `hsl(${i*360/N},85%,55%)`);
    const loops = 30;

    // Snap center for normalization
    const snapCx = fromOff(trackedCenter.x, trackedCenter.y).x;
    const snapCy = fromOff(trackedCenter.x, trackedCenter.y).y;

    for (let iter = 0; iter < loops; iter++) {
        let accum = Array.from({length:N}, () => ({x:0,y:0,count:0}));
        let total = 0;
        for (let y = Math.floor(minY); y <= Math.ceil(maxY); y += step) {
            for (let x = Math.floor(minX); x <= Math.ceil(maxX); x += step) {
                if (!insidePoly(x,y)) continue;
                total++;
                let best=0, bestD=Infinity;
                for (let i=0;i<N;i++) {
                    const dx=x-sites[i].x, dy=y-sites[i].y;
                    const d=(dx*dx+dy*dy)/weights[i];
                    if(d<bestD){bestD=d;best=i;}
                }
                accum[best].x+=x; accum[best].y+=y; accum[best].count++;
            }
        }
        const target=total/N;
        const temp=Math.max(0,1-(iter/(loops-5)));
        const diagR=Math.hypot(maxX-minX,maxY-minY)*0.25;
        for (let i=0;i<N;i++) {
            if(accum[i].count>0){
                const tcx=accum[i].x/accum[i].count;
                const tcy=accum[i].y/accum[i].count;
                const ang=Math.random()*Math.PI*2;
                const chaos=diagR*temp;
                sites[i].x=sites[i].x+(tcx-sites[i].x)*0.4+Math.cos(ang)*chaos;
                sites[i].y=sites[i].y+(tcy-sites[i].y)*0.4+Math.sin(ang)*chaos;
                if(!insidePoly(sites[i].x,sites[i].y)) sites[i]=randomInPoly();
                weights[i]*=(1+(1-accum[i].count/target)*0.5);
            } else {
                sites[i]=randomInPoly(); weights[i]=1;
            }
        }
    }

    // Final assignment — store cells as offset from snapCenter (in canvas px),
    // also store grid indices for border detection
    const newGrid = [];
    const gmap = new Map();
    let gi = 0;
    for (let y = Math.floor(minY); y <= Math.ceil(maxY); y += step) {
        let gj = 0;
        for (let x = Math.floor(minX); x <= Math.ceil(maxX); x += step) {
            if (insidePoly(x, y)) {
                let best=0, bestD=Infinity;
                for (let i=0;i<N;i++) {
                    const dx=x-sites[i].x, dy=y-sites[i].y;
                    const d=(dx*dx+dy*dy)/weights[i];
                    if(d<bestD){bestD=d;best=i;}
                }
                // dx/dy in offscreen pixels from center (will be scaled back via OW/OH)
                const cell = {
                    dx: (x - snapCx) * OW / c.width,
                    dy: (y - snapCy) * OH / c.height,
                    gi: gj, gj: gi,
                    owner: best
                };
                newGrid.push(cell);
                gmap.set(`${gj},${gi}`, cell);
            }
            gj++;
        }
        gi++;
    }

    sliceGrid = newGrid;
    sliceColors = colors;
    setStatus("Sliced!");
}

setStatus("Tap the centre of your pizza to detect its outline");
