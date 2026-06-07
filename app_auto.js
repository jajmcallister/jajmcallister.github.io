const v = document.getElementById("v");
const c = document.getElementById("c");
const ctx = c.getContext("2d");

/* =========================
   PIZZA SHAPE STATE
   Instead of a circle, we store a detected ellipse:
   { cx, cy, rx, ry, angle } — angle is the tilt in radians.
   `pizzaContour` holds the raw edge points for drawing.
========================= */
let pizza = null;          // { cx, cy, rx, ry, angle }
let pizzaContour = null;   // array of {x,y} points on the outline

let tracking = false;      // true while auto-detection is running
let trackInterval = null;

/* =========================
   CAMERA
========================= */
navigator.mediaDevices.getUserMedia({
    video: { facingMode: "environment" }
}).then(stream => {
    v.srcObject = stream;
}).catch(err => console.error("Camera error:", err));

v.onloadedmetadata = () => {
    resize();
};

function resize(){
    const r = c.getBoundingClientRect();
    c.width = r.width;
    c.height = r.height;
    drawBase();
}

window.addEventListener("resize", resize);
setTimeout(resize, 500);

/* =========================
   AUTO DETECT — grab a frame from the video, find the pizza blob
========================= */
function detectPizza(){
    if(v.readyState < 2) return;

    // Offscreen canvas to read pixels at a lower resolution (faster)
    const SCALE = 0.25;
    const ow = Math.floor(v.videoWidth  * SCALE) || Math.floor(c.width  * SCALE);
    const oh = Math.floor(v.videoHeight * SCALE) || Math.floor(c.height * SCALE);

    const off = document.createElement("canvas");
    off.width  = ow;
    off.height = oh;
    const octx = off.getContext("2d");
    octx.drawImage(v, 0, 0, ow, oh);

    const imageData = octx.getImageData(0, 0, ow, oh);
    const data = imageData.data;

    // --- STEP 1: find "food-like" pixels ---
    // Pizza tends to be warm (red/yellow/tan) and brighter than a typical table.
    // We build a binary mask: 1 = likely pizza, 0 = background.
    const mask = new Uint8Array(ow * oh);
    let sumX = 0, sumY = 0, count = 0;

    for(let y = 0; y < oh; y++){
        for(let x = 0; x < ow; x++){
            const idx = (y * ow + x) * 4;
            const r = data[idx], g = data[idx+1], b = data[idx+2];

            // Heuristic: warm tone (r > b+20), not too dark, not pure white
            const warm   = r > b + 15 && r > 60;
            const bright = (r + g + b) > 150;
            const notWhite = !(r > 220 && g > 220 && b > 220);

            if(warm && bright && notWhite){
                mask[y * ow + x] = 1;
                sumX += x; sumY += y; count++;
            }
        }
    }

    if(count < ow * oh * 0.03){
        // Not enough warm pixels found — fallback to largest bright blob
        detectByBrightness(data, mask, ow, oh);
        let c2 = 0, s2x = 0, s2y = 0;
        for(let i = 0; i < mask.length; i++) if(mask[i]){ c2++; s2x += i % ow; s2y += Math.floor(i/ow); }
        if(c2 === 0) return;
        count = c2; sumX = s2x; sumY = s2y;
    }

    // --- STEP 2: find centroid ---
    const mcx = sumX / count;
    const mcy = sumY / count;

    // --- STEP 3: fit ellipse via image moments ---
    let m20 = 0, m02 = 0, m11 = 0;
    for(let y = 0; y < oh; y++){
        for(let x = 0; x < ow; x++){
            if(!mask[y * ow + x]) continue;
            const dx = x - mcx, dy = y - mcy;
            m20 += dx * dx;
            m02 += dy * dy;
            m11 += dx * dy;
        }
    }
    m20 /= count; m02 /= count; m11 /= count;

    // Eigenvalues of the covariance matrix → semi-axes
    const common = Math.sqrt((m20 - m02) ** 2 + 4 * m11 * m11);
    const lam1   = (m20 + m02 + common) / 2;
    const lam2   = (m20 + m02 - common) / 2;
    const angle  = 0.5 * Math.atan2(2 * m11, m20 - m02);

    // Scale axes: 2*sqrt(eigenvalue) gives ~1σ; multiply by ~2.2 to reach the crust edge
    const K = 2.2;
    const rawRx = K * Math.sqrt(Math.max(lam1, 0));
    const rawRy = K * Math.sqrt(Math.max(lam2, 0));

    // Scale back up to canvas coordinates
    const SX = c.width  / ow;
    const SY = c.height / oh;
    const scx = mcx * SX;
    const scy = mcy * SY;
    const srx = rawRx * SX;
    const sry = rawRy * SY;

    // Sanity check — must be a reasonably large ellipse
    const minR = Math.min(c.width, c.height) * 0.08;
    const maxR = Math.min(c.width, c.height) * 0.65;
    if(srx < minR || sry < minR || srx > maxR || sry > maxR) return;

    // Smooth-track: blend new detection with previous to reduce jitter
    if(pizza){
        const ALPHA = 0.25;
        pizza.cx    += (scx   - pizza.cx)    * ALPHA;
        pizza.cy    += (scy   - pizza.cy)    * ALPHA;
        pizza.rx    += (srx   - pizza.rx)    * ALPHA;
        pizza.ry    += (sry   - pizza.ry)    * ALPHA;
        pizza.angle += (angle - pizza.angle) * ALPHA;
    } else {
        pizza = { cx: scx, cy: scy, rx: srx, ry: sry, angle };
    }

    buildContour();
    drawBase();
}

/* Fallback: find bright blob if warm-heuristic finds too little */
function detectByBrightness(data, mask, ow, oh){
    let brightnesses = [];
    for(let i = 0; i < ow * oh; i++){
        const r = data[i*4], g = data[i*4+1], b = data[i*4+2];
        brightnesses.push((r + g + b) / 3);
    }
    brightnesses.sort((a,b)=>b-a);
    const thresh = brightnesses[Math.floor(brightnesses.length * 0.25)]; // top 25%
    for(let i = 0; i < ow * oh; i++){
        const r = data[i*4], g = data[i*4+1], b = data[i*4+2];
        if((r + g + b) / 3 >= thresh) mask[i] = 1;
    }
}

/* Build a smooth polygon outline of the ellipse for drawing & inside-test */
function buildContour(){
    if(!pizza) return;
    const SEGS = 128;
    pizzaContour = [];
    for(let i = 0; i < SEGS; i++){
        const t = (i / SEGS) * Math.PI * 2;
        const lx = pizza.rx * Math.cos(t);
        const ly = pizza.ry * Math.sin(t);
        pizzaContour.push({
            x: pizza.cx + lx * Math.cos(pizza.angle) - ly * Math.sin(pizza.angle),
            y: pizza.cy + lx * Math.sin(pizza.angle) + ly * Math.cos(pizza.angle)
        });
    }
}

/* =========================
   TRACK BUTTON
========================= */
function startTracking(){
    if(trackInterval) clearInterval(trackInterval);
    tracking = true;
    pizza = null;
    pizzaContour = null;
    // Run detection every 150 ms while tracking
    trackInterval = setInterval(detectPizza, 150);
    document.getElementById("trackBtn").textContent = "⏹ Stop tracking";
    document.getElementById("trackBtn").onclick = stopTracking;
}

function stopTracking(){
    clearInterval(trackInterval);
    trackInterval = null;
    tracking = false;
    document.getElementById("trackBtn").textContent = "🎯 Detect pizza";
    document.getElementById("trackBtn").onclick = startTracking;
}

// Wire up on page load
window.addEventListener("DOMContentLoaded", () => {
    const btn = document.getElementById("trackBtn");
    if(btn){ btn.onclick = startTracking; }
});

/* =========================
   BASE DRAW — draws the detected ellipse outline
========================= */
function drawBase(){
    ctx.clearRect(0, 0, c.width, c.height);

    if(!pizza || !pizzaContour) {
        // Show a hint while no pizza is detected
        ctx.fillStyle = "rgba(255,255,255,0.5)";
        ctx.font = "16px sans-serif";
        ctx.textAlign = "center";
        ctx.fillText("Point camera at pizza, then tap 🎯 Detect pizza", c.width/2, c.height/2);
        return;
    }

    // Draw the detected ellipse outline
    ctx.strokeStyle = "lime";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(pizzaContour[0].x, pizzaContour[0].y);
    for(let i = 1; i < pizzaContour.length; i++) ctx.lineTo(pizzaContour[i].x, pizzaContour[i].y);
    ctx.closePath();
    ctx.stroke();

    // Center dot
    ctx.fillStyle = "red";
    ctx.beginPath();
    ctx.arc(pizza.cx, pizza.cy, 5, 0, Math.PI * 2);
    ctx.fill();
}

/* =========================
   INSIDE TEST — point-in-ellipse (rotated)
========================= */
function inside(x, y){
    if(!pizza) return false;
    const cos = Math.cos(-pizza.angle);
    const sin = Math.sin(-pizza.angle);
    const dx = x - pizza.cx;
    const dy = y - pizza.cy;
    const lx = cos * dx - sin * dy;
    const ly = sin * dx + cos * dy;
    return (lx / pizza.rx) ** 2 + (ly / pizza.ry) ** 2 <= 1;
}

function randomPointInPizza(){
    // Rejection sample inside the ellipse
    for(let attempt = 0; attempt < 200; attempt++){
        const t = Math.random() * Math.PI * 2;
        const r = Math.sqrt(Math.random()) * 0.85; // slightly inside edge
        const lx = pizza.rx * r * Math.cos(t);
        const ly = pizza.ry * r * Math.sin(t);
        const x = pizza.cx + lx * Math.cos(pizza.angle) - ly * Math.sin(pizza.angle);
        const y = pizza.cy + lx * Math.sin(pizza.angle) + ly * Math.cos(pizza.angle);
        if(inside(x, y)) return { x, y };
    }
    return { x: pizza.cx, y: pizza.cy };
}

/* =========================
   MAIN VORONOI CVT (WITH SIMULATED ANNEALING AREA EQUALIZATION)
   — UNTOUCHED except randomPointInCircle → randomPointInPizza
========================= */
function generate(){
    if(!pizza){
        alert("Detect a pizza first — tap 🎯 Detect pizza");
        return;
    }

    const N = +document.getElementById("n").value;
    const step = 4;

    // 1. INIT SEEDS
    let sites = Array.from({length:N}, () => randomPointInPizza());
    let weights = Array.from({length:N}, () => 1.0);

    const colors = Array.from(
        {length:N},
        (_,i) => `hsl(${i*360/N}, 85%, 55%)`
    );

    // 2. ANNEALED CAPACITY-CONSTRAINED LLOYD RELAXATION LOOP
    const loops = 30;

    for(let iter=0; iter<loops; iter++){

        let accum = Array.from({length:N}, () => ({ x:0, y:0, count:0 }));
        let totalCount = 0;

        for(let y=0; y<c.height; y+=step){
            for(let x=0; x<c.width; x+=step){
                if(!inside(x,y)) continue;

                totalCount++;
                let best = 0;
                let bestD = Infinity;

                for(let i=0; i<N; i++){
                    const dx = x - sites[i].x;
                    const dy = y - sites[i].y;
                    const d = (dx*dx + dy*dy) / weights[i];

                    if(d < bestD){
                        bestD = d;
                        best = i;
                    }
                }

                accum[best].x += x;
                accum[best].y += y;
                accum[best].count++;
            }
        }

        const targetCountPerCell = totalCount / N;
        const temperature = Math.max(0, 1.0 - (iter / (loops - 5)));

        for(let i=0; i<N; i++){
            if(accum[i].count > 0){
                const trueCenterX = accum[i].x / accum[i].count;
                const trueCenterY = accum[i].y / accum[i].count;

                const chaosScale = Math.min(pizza.rx, pizza.ry) * 0.45 * temperature;
                const randomAngle = Math.random() * Math.PI * 2;
                const chaosX = Math.cos(randomAngle) * chaosScale;
                const chaosY = Math.sin(randomAngle) * chaosScale;

                const rate = 0.25;
                sites[i].x = sites[i].x + (trueCenterX - sites[i].x) * rate + chaosX;
                sites[i].y = sites[i].y + (trueCenterY - sites[i].y) * rate + chaosY;

                if(!inside(sites[i].x, sites[i].y)){
                    sites[i] = randomPointInPizza();
                }

                const sizeRatio = accum[i].count / targetCountPerCell;
                const correctionForce = 0.35 + (1.0 - temperature) * 0.4;
                weights[i] *= (1.0 + (1.0 - sizeRatio) * correctionForce);
            } else {
                sites[i] = randomPointInPizza();
                weights[i] = 1.0;
            }
        }
    }

    // 3. FINAL REGION ASSIGNMENT
    let grid = [];
    for(let y=0; y<c.height; y+=step){
        for(let x=0; x<c.width; x+=step){
            if(!inside(x,y)) continue;

            let best = 0;
            let bestD = Infinity;

            for(let i=0; i<N; i++){
                const dx = x - sites[i].x;
                const dy = y - sites[i].y;
                const d = (dx*dx + dy*dy) / weights[i];

                if(d < bestD){
                    bestD = d;
                    best = i;
                }
            }
            grid.push({x, y, owner:best});
        }
    }

    draw(grid, colors, step);
}

/* =========================
   RENDER — UNTOUCHED except circle redrawn as ellipse contour
========================= */
function draw(grid, colors, step){
    ctx.clearRect(0, 0, c.width, c.height);

    ctx.globalAlpha = 0.45;
    for(const cell of grid){
        ctx.fillStyle = colors[cell.owner];
        ctx.fillRect(cell.x, cell.y, step, step);
    }

    ctx.globalAlpha = 0.8;
    ctx.strokeStyle = "white";
    ctx.lineWidth = 2;

    for(const cell of grid){
        const checkPoints = [
            {x: cell.x + step, y: cell.y},
            {x: cell.x, y: cell.y + step}
        ];
        for(const pt of checkPoints){
            if(inside(pt.x, pt.y)){
                const neighbor = grid.find(g => g.x === pt.x && g.y === pt.y);
                if(neighbor && neighbor.owner !== cell.owner){
                    ctx.strokeRect(cell.x, cell.y, step, step);
                }
            }
        }
    }

    // Redraw ellipse outline and center dot on top
    ctx.globalAlpha = 1.0;
    ctx.strokeStyle = "lime";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(pizzaContour[0].x, pizzaContour[0].y);
    for(let i = 1; i < pizzaContour.length; i++) ctx.lineTo(pizzaContour[i].x, pizzaContour[i].y);
    ctx.closePath();
    ctx.stroke();

    ctx.fillStyle = "red";
    ctx.beginPath();
    ctx.arc(pizza.cx, pizza.cy, 5, 0, Math.PI * 2);
    ctx.fill();
}